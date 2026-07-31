-- =========================================================================
-- Ragwa POS — ZATCA Phase 2 integration SCAFFOLD (run once in Supabase
-- Dashboard → SQL Editor → New Query → Run).
-- =========================================================================
-- Purely additive: two new tables + one new RPC, nothing here touches any
-- existing table, policy, or column. The feature itself defaults to OFF
-- (zatca_configurations.is_enabled = false) and every new invoice created
-- while it's off behaves exactly as before — this migration only creates
-- the storage the (currently simulated, no live ZATCA API calls yet)
-- Settings → ZATCA panel and invoice hook read/write to.
-- =========================================================================

create table if not exists zatca_configurations (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  is_enabled boolean not null default false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  certificate_status text not null default 'PENDING'
    check (certificate_status in ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED')),
  certificate_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,
  invoices_cleared_count integer not null default 0,
  invoices_reported_count integer not null default 0,
  failed_invoices integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table zatca_configurations enable row level security;

drop policy if exists zatca_configurations_select on zatca_configurations;
create policy zatca_configurations_select on zatca_configurations for select
  using (tenant_id = auth.uid());
drop policy if exists zatca_configurations_insert on zatca_configurations;
create policy zatca_configurations_insert on zatca_configurations for insert
  to authenticated with check (tenant_id = auth.uid());
drop policy if exists zatca_configurations_update on zatca_configurations;
create policy zatca_configurations_update on zatca_configurations for update
  to authenticated using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
drop policy if exists zatca_configurations_delete on zatca_configurations;
create policy zatca_configurations_delete on zatca_configurations for delete
  to authenticated using (tenant_id = auth.uid());

create table if not exists zatca_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  uuid text not null,
  invoice_hash text not null,
  status text not null default 'CLEARED'
    check (status in ('DRAFT', 'SIGNED', 'CLEARED', 'REPORTED', 'REJECTED', 'FAILED')),
  qr_payload text,
  submitted_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz not null default now()
);

alter table zatca_invoices enable row level security;

drop policy if exists zatca_invoices_select on zatca_invoices;
create policy zatca_invoices_select on zatca_invoices for select
  using (tenant_id = auth.uid());
drop policy if exists zatca_invoices_insert on zatca_invoices;
create policy zatca_invoices_insert on zatca_invoices for insert
  to authenticated with check (tenant_id = auth.uid());

create index if not exists zatca_invoices_invoice_id_idx on zatca_invoices (invoice_id);
create index if not exists zatca_invoices_tenant_id_idx on zatca_invoices (tenant_id);

-- Atomic stat bump (SECURITY DEFINER, same pattern as next_doc_number() /
-- apply_customer_payment() in supabase-rls-and-integrity.sql) so two
-- invoices "clearing" at once can't clobber each other's count.
create or replace function zatca_record_invoice_result(p_tenant_id uuid, p_status text)
returns void
language sql
security definer
set search_path = public
as $$
  update zatca_configurations
  set
    invoices_cleared_count = invoices_cleared_count + (case when p_status = 'CLEARED' then 1 else 0 end),
    invoices_reported_count = invoices_reported_count + (case when p_status = 'REPORTED' then 1 else 0 end),
    failed_invoices = failed_invoices + (case when p_status = 'FAILED' then 1 else 0 end),
    last_sync_at = now(),
    updated_at = now()
  where tenant_id = p_tenant_id;
$$;

grant execute on function zatca_record_invoice_result(uuid, text) to authenticated;

-- RLS alone isn't enough — Postgres checks table-level GRANTs first, and a
-- freshly created table has none for anon/authenticated by default (same
-- gap supabase-grant-fix.sql closed for every other table in this project).
-- Without this, every read/write here fails with "permission denied for
-- table zatca_configurations" before RLS is ever evaluated.
grant select, insert, update, delete on zatca_configurations, zatca_invoices to anon, authenticated;

-- Without this, subscribeToRow/subscribeToTable's initial one-time load
-- still works, but the panel never hears about its OWN write landing —
-- enableZatca()'s optimistic setZatcaConfig() call covers this tab, but a
-- second tab/device wouldn't see it change until a full refresh.
alter publication supabase_realtime add table zatca_configurations, zatca_invoices;
