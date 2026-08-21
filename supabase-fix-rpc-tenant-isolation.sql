-- =========================================================================
-- Ragwa POS — Fix cross-tenant authorization bypass in SECURITY DEFINER RPCs
-- شغّل هذا مرة وحدة بـ Supabase Dashboard → SQL Editor → New Query → Run.
-- =========================================================================
-- next_doc_number() / apply_customer_payment() / adjust_supplier_balance()
-- (supabase-rls-and-integrity.sql) and zatca_record_invoice_result()
-- (supabase-zatca-phase2-scaffold.sql) are all SECURITY DEFINER — they run
-- with the function owner's privileges and bypass RLS entirely (that's the
-- whole point: RLS alone can't do an atomic balance-checked UPDATE). Every
-- one of them takes p_tenant_id as a plain parameter and never checks it
-- against the caller's actual identity.
--
-- Since these are called from the browser via the public anon-key client
-- (supabase.rpc(...) — see src/App.jsx), any authenticated tenant can call
-- them directly (devtools console, curl with their own JWT — no need to go
-- through the app UI at all) with ANOTHER tenant's uuid as p_tenant_id and:
--   - apply_customer_payment: add/remove wallet balance or forgive debt on
--     ANY OTHER shop's customers
--   - adjust_supplier_balance: inflate/erase ANY OTHER shop's supplier debt
--   - next_doc_number: burn/desync ANY OTHER shop's invoice/receipt numbering
--   - zatca_record_invoice_result: corrupt ANY OTHER shop's ZATCA compliance
--     counters
-- This is exactly the class of bug api/_auth.js's verifyTenantSession()
-- already closed for the ZATCA serverless endpoints — this migration closes
-- the equivalent gap in these four Postgres functions.
--
-- Fix: tenants.id IS the tenant owner's auth.uid() (see PROJECT_REFERENCE.md
-- §10), so each function now refuses to run unless p_tenant_id = auth.uid().
-- Legitimate callers are unaffected — the app always passes the signed-in
-- user's own id (see App.jsx `tenantId` — set from auth.getUser()).
--
-- Safe to run multiple times (CREATE OR REPLACE).
-- =========================================================================

create or replace function next_doc_number(p_tenant_id uuid, p_doc_type text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
begin
  if p_tenant_id is distinct from auth.uid() then
    raise exception 'not_authorized';
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
  if p_tenant_id is distinct from auth.uid() then
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
  if p_tenant_id is distinct from auth.uid() then
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
  if p_tenant_id is distinct from auth.uid() then
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
