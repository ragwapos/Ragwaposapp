-- =========================================================================
-- Ragwa POS — a pay-later (Credit / On Account) invoice can't be handed
-- over until it is paid, and every payment is settled against its own
-- invoice. Apply to staging first, then to production BEFORE merging the
-- code that uses it. Rollback: supabase-credit-invoice-payment-rollback.sql
-- =========================================================================
-- 1) invoices.credit_due = what is still owed on THIS invoice. Set by the
--    database when the invoice is created (from its own payment method /
--    split), never from what the browser sends, and frozen on any later
--    update except through pay_invoice_credit() below.
-- 2) An invoice with credit_due > 0 can't be closed or have more pieces
--    marked Delivered.
-- 3) pay_invoice_credit() pays (all or part of) one invoice: locks it,
--    lowers its credit_due, the customer's debt (and wallet, for a wallet
--    payment) and records a debt_payment linked to the invoice, all in one
--    transaction.
-- 4) A customer's debt can never drop below the total still owed on their
--    invoices, so invoice debt can only be paid through its own invoice.
--    Debt with no invoice (a wallet top-up on credit) stays payable from
--    the customer record as before.
-- Existing invoices start at credit_due = 0; their open balances are set
-- separately, per environment (old payments were never tied to invoices).
-- =========================================================================

alter table invoices add column if not exists credit_due numeric(12,2) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_credit_due_check') then
    alter table invoices add constraint invoices_credit_due_check check (credit_due >= 0);
  end if;
end $$;

alter table customer_transactions add column if not exists invoice_id uuid references invoices(id) on delete set null;
create index if not exists customer_transactions_invoice_id_idx on customer_transactions(invoice_id) where invoice_id is not null;

-- The pay-later part of an invoice: all of it for Credit, the Credit share
-- of a split, nothing otherwise.
create or replace function invoice_credit_portion(p_pay_method text, p_split jsonb, p_total numeric) returns numeric
language sql immutable set search_path = public as $$
  select round(greatest(0, least(coalesce(p_total, 0),
    case
      when p_pay_method = 'Credit (On Account)' then coalesce(p_total, 0)
      when p_pay_method = 'Split' and jsonb_typeof(p_split) = 'array' then coalesce((
        select sum(case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric else 0 end)
        from jsonb_array_elements(p_split) e where e->>'method' = 'Credit (On Account)'), 0)
      else 0
    end)), 2)
$$;

create or replace function invoice_delivered_count(p_items jsonb) returns integer
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_items) = 'array'
    then (select count(*)::int from jsonb_array_elements(p_items) e where e->>'status' = 'Delivered')
    else 0 end
$$;

revoke execute on function invoice_credit_portion(text, jsonb, numeric) from public, anon;
revoke execute on function invoice_delivered_count(jsonb) from public, anon;
grant execute on function invoice_credit_portion(text, jsonb, numeric) to authenticated, service_role;
grant execute on function invoice_delivered_count(jsonb) to authenticated, service_role;

create or replace function invoices_credit_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.credit_due := invoice_credit_portion(new.pay_method, new.split_payments, new.total);
    return new;
  end if;
  -- Only pay_invoice_credit() (which sets this flag for its own update)
  -- may change what is owed.
  if coalesce(current_setting('ragwa.credit_write', true), '') <> 'on' then
    new.credit_due := old.credit_due;
  end if;
  if new.credit_due > 0 and (
       (new.closed and not coalesce(old.closed, false))
       or invoice_delivered_count(new.items) > invoice_delivered_count(old.items)) then
    raise exception 'credit_unpaid' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists invoices_credit_guard on invoices;
create trigger invoices_credit_guard
  before insert or update on invoices
  for each row execute function invoices_credit_guard();

-- Security definer: a branch login only sees its own branch's invoices, but
-- the customer's debt covers invoices from every branch.
create or replace function customers_debt_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_linked numeric;
begin
  if new.debt < old.debt then
    select coalesce(sum(i.credit_due), 0) into v_linked
    from invoices i where i.tenant_id = new.tenant_id and i.customer_id = new.id;
    if new.debt < v_linked - 0.005 then
      raise exception 'debt_linked_to_invoices' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke execute on function customers_debt_guard() from public, anon;

drop trigger if exists customers_debt_guard on customers;
create trigger customers_debt_guard
  before update of debt on customers
  for each row execute function customers_debt_guard();

-- p_payments: [{ "method": "Cash" | "External Network" | "Wallet Balance", "amount": n }, ...]
-- (one or two different methods, total > 0 and not above what is owed).
create or replace function pay_invoice_credit(p_invoice_id uuid, p_payments jsonb)
returns table(credit_due numeric, wallet_balance numeric, debt numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := my_tenant_id();
  v_branch uuid := my_branch_id();
  v_inv invoices;
  v_pay jsonb;
  v_method text;
  v_amount numeric;
  v_methods text[] := '{}';
  v_total numeric := 0;
  v_wallet_part numeric := 0;
  v_wallet numeric;
  v_debt numeric;
begin
  if v_tenant is null then raise exception 'not_authorized'; end if;

  select * into v_inv from invoices i
  where i.id = p_invoice_id and i.tenant_id = v_tenant and (v_branch is null or i.branch_id = v_branch)
  for update;
  if not found or v_inv.customer_id is null then raise exception 'not_authorized'; end if;
  if v_inv.credit_due <= 0 then raise exception 'already_paid'; end if;

  if jsonb_typeof(p_payments) is distinct from 'array'
     or jsonb_array_length(p_payments) not between 1 and 2 then
    raise exception 'amount_mismatch';
  end if;
  for v_pay in select * from jsonb_array_elements(p_payments) loop
    v_method := v_pay->>'method';
    if v_method is null or v_method not in ('Cash', 'External Network', 'Wallet Balance') or v_method = any(v_methods) then
      raise exception 'invalid_method';
    end if;
    if jsonb_typeof(v_pay->'amount') is distinct from 'number' then raise exception 'amount_mismatch'; end if;
    v_amount := round((v_pay->>'amount')::numeric, 2);
    if v_amount <= 0 then raise exception 'amount_mismatch'; end if;
    v_methods := v_methods || v_method;
    v_total := v_total + v_amount;
    if v_method = 'Wallet Balance' then v_wallet_part := v_wallet_part + v_amount; end if;
  end loop;
  if v_total > v_inv.credit_due then raise exception 'amount_mismatch'; end if;

  select c.wallet_balance, c.debt into v_wallet, v_debt from customers c
  where c.tenant_id = v_tenant and c.id = v_inv.customer_id
  for update;
  if not found then raise exception 'not_authorized'; end if;
  if v_debt < v_total then raise exception 'debt_mismatch'; end if;
  if v_wallet < v_wallet_part then raise exception 'insufficient_balance'; end if;

  -- The invoice first, so the customer's debt guard sees the lower amount owed.
  perform set_config('ragwa.credit_write', 'on', true);
  update invoices i set credit_due = i.credit_due - v_total where i.id = v_inv.id;
  perform set_config('ragwa.credit_write', 'off', true);

  update customers c set wallet_balance = c.wallet_balance - v_wallet_part, debt = c.debt - v_total
  where c.tenant_id = v_tenant and c.id = v_inv.customer_id
  returning c.wallet_balance, c.debt into v_wallet, v_debt;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    insert into customer_transactions (tenant_id, customer_id, type, code, paid_amount, pay_method, notes, date, branch_id, invoice_id)
    values (v_tenant, v_inv.customer_id, 'debt_payment', 'PMT-' || next_doc_number(v_tenant, 'PMT'),
            round((v_pay->>'amount')::numeric, 2), v_pay->>'method', v_inv.code, now(), v_inv.branch_id, v_inv.id);
  end loop;

  return query select v_inv.credit_due - v_total, v_wallet, v_debt;
end $$;
revoke execute on function pay_invoice_credit(uuid, jsonb) from public, anon;
grant execute on function pay_invoice_credit(uuid, jsonb) to authenticated, service_role;
