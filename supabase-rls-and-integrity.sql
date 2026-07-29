-- =========================================================================
-- Ragwa POS — Data-integrity fixes (run once in Supabase SQL editor)
-- =========================================================================
-- Fixes three real bugs found in src/App.jsx:
--   1) Invoice/receipt/PO numbers were generated from `array.length` in the
--      browser — two terminals (or two fast clicks) can compute the same
--      length and mint duplicate codes. next_doc_number() below hands out a
--      real atomic sequence per tenant/doc-type.
--   2) Wallet balance / customer debt / supplier balance were read into a
--      JS variable, changed, then written back as an ABSOLUTE value — two
--      concurrent operations against the same customer/supplier can both
--      read the same starting balance and the second write silently
--      overwrites (loses) the first. apply_customer_payment() and
--      adjust_supplier_balance() below do a single atomic UPDATE with the
--      balance check built into the WHERE clause instead.
--   3) CHECK constraints as a last line of defense so a balance can never
--      go negative even from a path that bypasses the RPCs above.
--
-- Safe to run multiple times (uses IF NOT EXISTS / CREATE OR REPLACE).
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) Atomic sequential document numbers (RCT-/TOP-/PMT-/INV-/DLV-/PO-)
-- -------------------------------------------------------------------------
create table if not exists doc_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  doc_type text not null,
  value integer not null,
  primary key (tenant_id, doc_type)
);

alter table doc_counters enable row level security;

drop policy if exists doc_counters_select on doc_counters;
create policy doc_counters_select on doc_counters for select
  using (tenant_id = auth.uid());
-- No insert/update/delete policy on purpose — only next_doc_number() (a
-- SECURITY DEFINER function, so it bypasses RLS) is allowed to write here.

create or replace function next_doc_number(p_tenant_id uuid, p_doc_type text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
begin
  insert into doc_counters (tenant_id, doc_type, value)
  values (p_tenant_id, p_doc_type, 1001)
  on conflict (tenant_id, doc_type)
  do update set value = doc_counters.value + 1
  returning value into v_value;
  return v_value;
end;
$$;

grant execute on function next_doc_number(uuid, text) to authenticated;

-- -------------------------------------------------------------------------
-- 2) Atomic customer wallet/debt updates
-- Every wallet-balance / debt change in the app (top-up, POS payment,
-- wallet deduction on a split sale, debt settlement) becomes ONE call to
-- this function with a DELTA (not an absolute new value). The UPDATE's
-- WHERE clause re-checks both balances atomically at write time, so a
-- concurrent conflicting change is rejected instead of silently lost.
-- -------------------------------------------------------------------------
create or replace function apply_customer_payment(
  p_tenant_id uuid,
  p_customer_id bigint,
  p_wallet_delta numeric,
  p_debt_delta numeric
)
returns table (wallet_balance numeric, debt numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet numeric;
  v_debt numeric;
begin
  -- Table alias + explicit qualification on every reference is required
  -- here: RETURNS TABLE(wallet_balance, debt) above implicitly declares
  -- PL/pgSQL variables with those exact names, which otherwise collide
  -- with the customers.wallet_balance/debt columns ("column reference is
  -- ambiguous", SQLSTATE 42702) everywhere but the SET target itself.
  update customers c
  set wallet_balance = c.wallet_balance + p_wallet_delta,
      debt = c.debt + p_debt_delta
  where c.tenant_id = p_tenant_id
    and c.id = p_customer_id
    and c.wallet_balance + p_wallet_delta >= 0
    and c.debt + p_debt_delta >= 0
  returning c.wallet_balance, c.debt into v_wallet, v_debt;

  if v_wallet is null then
    raise exception 'insufficient_balance';
  end if;

  return query select v_wallet, v_debt;
end;
$$;

grant execute on function apply_customer_payment(uuid, bigint, numeric, numeric) to authenticated;

-- -------------------------------------------------------------------------
-- 3) Atomic supplier balance updates (purchases on credit + paying them down)
-- -------------------------------------------------------------------------
create or replace function adjust_supplier_balance(
  p_tenant_id uuid,
  p_supplier_id uuid,
  p_delta numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  update suppliers
  set balance = balance + p_delta
  where tenant_id = p_tenant_id
    and id = p_supplier_id
    and balance + p_delta >= 0
  returning suppliers.balance into v_balance;

  if v_balance is null then
    raise exception 'insufficient_balance';
  end if;

  return v_balance;
end;
$$;

grant execute on function adjust_supplier_balance(uuid, uuid, numeric) to authenticated;

-- -------------------------------------------------------------------------
-- 4) Defense-in-depth: balances can never go negative, even via a path that
--    doesn't go through the RPCs above (e.g. a future direct .update() call).
-- -------------------------------------------------------------------------
alter table customers drop constraint if exists customers_wallet_balance_non_negative;
alter table customers add constraint customers_wallet_balance_non_negative check (wallet_balance >= 0);

alter table customers drop constraint if exists customers_debt_non_negative;
alter table customers add constraint customers_debt_non_negative check (debt >= 0);

alter table suppliers drop constraint if exists suppliers_balance_non_negative;
alter table suppliers add constraint suppliers_balance_non_negative check (balance >= 0);
