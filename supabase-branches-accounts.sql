-- =========================================================================
-- Ragwa POS — Multi-branch support, phase C (branch accounts + real isolation)
-- شغّل هذا بعد supabase-branches-schema.sql، مرة وحدة، بـ Supabase SQL Editor.
-- =========================================================================
-- One shared login per branch (a Supabase auth user) that belongs to ONE
-- tenant and ONE branch. The database, not the UI, decides what it can see:
--   * the owner (auth.uid() = tenant id) keeps exactly today's access;
--   * a branch account sees only its own branch's invoices / wallet movements /
--     purchases / expenses, the tenant's shared data (customers, products,
--     categories, ...) read-only, and can create invoices + customers and take
--     wallet payments for its own branch;
--   * everything else (catalog, suppliers, promotions, settings, ZATCA keys,
--     other branches' rows) is owner-only.
--
-- Existing policies are ALTERED in place (same names, same `OR is_admin()`
-- shape) by swapping `tenant_id = auth.uid()` for `tenant_id = my_tenant_id()`
-- plus the owner/branch condition, so the owner path cannot drift.
-- The original policies and function bodies are saved in
-- backup_20261031._policies / _functions; rollback: supabase-branches-rollback.sql
-- Safe to run multiple times.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) branch_members: which auth user belongs to which branch
-- -------------------------------------------------------------------------
create table if not exists branch_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null,
  branch_id uuid not null,
  username text not null unique check (username = lower(username) and length(username) between 3 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (branch_id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete cascade
);

alter table branch_members enable row level security;
revoke all on branch_members from anon;

drop policy if exists branch_members_select on branch_members;
create policy branch_members_select on branch_members for select
  using (tenant_id = auth.uid() or user_id = auth.uid() or is_admin());
-- No insert/update/delete policy on purpose: accounts are created, reset and
-- (de)activated only by api/branch-accounts.js with the service-role key.

-- -------------------------------------------------------------------------
-- 2) who am I? (tenant + branch of the calling user)
-- -------------------------------------------------------------------------
-- An owner has no branch_members row: my_tenant_id() = auth.uid(), my_branch_id()
-- is null. A deactivated branch account falls back to its own user id, which
-- matches no tenant, so it sees nothing even with a still-valid token.
create or replace function my_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select tenant_id from branch_members where user_id = auth.uid() and active), auth.uid());
$$;

create or replace function my_branch_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select branch_id from branch_members where user_id = auth.uid() and active;
$$;

revoke all on function my_tenant_id() from public;
revoke all on function my_branch_id() from public;
grant execute on function my_tenant_id() to anon, authenticated, service_role;
grant execute on function my_branch_id() to anon, authenticated, service_role;

-- keep the account's active flag in step with its branch (archive/restore)
create or replace function sync_branch_member_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    update branch_members set active = (new.status = 'active') where branch_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_branch_member_active on branches;
create trigger sync_branch_member_active after update on branches
  for each row execute function sync_branch_member_active();

-- -------------------------------------------------------------------------
-- 3) policies: rewrite the existing ones in place
-- -------------------------------------------------------------------------
do $$
declare
  r record;
  v_kind text;
  v_inner text;
  v_qual text;
  v_check text;
  v_catalog text[] := array['addons', 'categories', 'service_types', 'products', 'promotions', 'suppliers', 'expense_categories', 'tenant_settings'];
  v_tables text[] := array['addons', 'categories', 'service_types', 'products', 'promotions', 'suppliers', 'expense_categories', 'tenant_settings',
                           'branches', 'customers', 'invoices', 'customer_transactions', 'purchases', 'expenses', 'zatca_configurations', 'zatca_invoices'];
  v_count integer := 0;
begin
  for r in
    select policyname, tablename, cmd, qual, with_check from pg_policies
    where schemaname = 'public' and tablename = any (v_tables)
      and (coalesce(qual, '') like '%(tenant_id = auth.uid())%' or coalesce(with_check, '') like '%(tenant_id = auth.uid())%')
  loop
    v_kind := case
      when r.tablename = 'zatca_configurations' then 'owner'
      when r.tablename in ('invoices', 'customer_transactions', 'purchases', 'expenses') then
        case when r.cmd = 'SELECT' then 'branch'
             when r.tablename in ('purchases', 'expenses') then 'owner'
             when r.cmd in ('INSERT', 'UPDATE') then 'branch'
             else 'owner' end
      when r.tablename = 'customers' then case when r.cmd = 'DELETE' then 'owner' else 'tenant' end
      when r.tablename = 'zatca_invoices' then 'tenant'
      when r.tablename = 'branches' then case when r.cmd = 'SELECT' then 'tenant' else 'owner' end
      when r.tablename = any (v_catalog) then case when r.cmd = 'SELECT' then 'tenant' else 'owner' end
      else null end;
    continue when v_kind is null;

    v_inner := case v_kind
      when 'tenant' then '(tenant_id = (select my_tenant_id()))'
      when 'owner' then '((tenant_id = (select my_tenant_id())) and ((select my_branch_id()) is null))'
      else '((tenant_id = (select my_tenant_id())) and (((select my_branch_id()) is null) or (branch_id = (select my_branch_id()))))'
    end;
    v_qual := replace(r.qual, '(tenant_id = auth.uid())', v_inner);
    v_check := replace(r.with_check, '(tenant_id = auth.uid())', v_inner);

    if r.cmd = 'INSERT' then
      execute format('alter policy %I on public.%I with check (%s)', r.policyname, r.tablename, v_check);
    elsif r.cmd = 'UPDATE' then
      if v_check is null then
        execute format('alter policy %I on public.%I using (%s)', r.policyname, r.tablename, v_qual);
      else
        execute format('alter policy %I on public.%I using (%s) with check (%s)', r.policyname, r.tablename, v_qual, v_check);
      end if;
    else
      execute format('alter policy %I on public.%I using (%s)', r.policyname, r.tablename, v_qual);
    end if;
    v_count := v_count + 1;
  end loop;
  raise notice 'branch policies rewritten: %', v_count;
end $$;

-- -------------------------------------------------------------------------
-- 4) the SECURITY DEFINER functions: authorise against my_tenant_id()
-- -------------------------------------------------------------------------
create or replace function next_doc_number(p_tenant_id uuid, p_doc_type text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
  v_branch_number integer;
begin
  if p_tenant_id is distinct from my_tenant_id() then
    raise exception 'not_authorized';
  end if;

  -- A branch account may only draw numbers for its own branch's invoice
  -- counters ('INV'/'DLV' belong to the main branch, 'B<N>:INV' to branch N);
  -- tenant-wide types (RCT, TOP, PMT, PO) are open to it.
  if my_branch_id() is not null then
    select number into v_branch_number from branches where id = my_branch_id();
    if p_doc_type in ('INV', 'DLV') then
      if v_branch_number <> 1 then raise exception 'not_authorized'; end if;
    elsif p_doc_type ~ '^B[0-9]+:' then
      if split_part(p_doc_type, ':', 1) <> 'B' || v_branch_number then raise exception 'not_authorized'; end if;
    end if;
  end if;

  insert into doc_counters (tenant_id, doc_type, value)
  values (p_tenant_id, p_doc_type, 1001)
  on conflict (tenant_id, doc_type)
  do update set value = doc_counters.value + 1
  returning value into v_value;
  return v_value;
end;
$$;

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
  if p_tenant_id is distinct from my_tenant_id() then
    raise exception 'not_authorized';
  end if;

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
  -- suppliers are owner-only: a branch account may not touch their balances
  if p_tenant_id is distinct from my_tenant_id() or my_branch_id() is not null then
    raise exception 'not_authorized';
  end if;

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

create or replace function zatca_record_invoice_result(p_tenant_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ZATCA configuration is owner-only
  if p_tenant_id is distinct from my_tenant_id() or my_branch_id() is not null then
    raise exception 'not_authorized';
  end if;

  update zatca_configurations
  set
    invoices_cleared_count = invoices_cleared_count + (case when p_status = 'CLEARED' then 1 else 0 end),
    invoices_reported_count = invoices_reported_count + (case when p_status = 'REPORTED' then 1 else 0 end),
    failed_invoices = failed_invoices + (case when p_status = 'FAILED' then 1 else 0 end),
    last_sync_at = now(),
    updated_at = now()
  where tenant_id = p_tenant_id;
end;
$$;
