-- "تذكير باستلام الطلب" (pickup reminder) — WhatsApp message #3 + its send log.
--
-- Additive only: three new tenant_settings columns (with defaults) and one new
-- table. Nothing existing is altered or dropped, and code that doesn't know
-- these columns keeps working (it never names them).
--
-- ORDER MATTERS: the dashboard's settings save names the three new columns, so
-- this file must be applied to a database BEFORE code that includes the
-- pickup-reminder feature runs against it. Otherwise every settings save fails
-- with "column not found". Applied to staging 2026-11-14; apply to production
-- before merging the feature into main.
--
-- Rollback: supabase-pickup-reminders-rollback.sql

-- 1) Settings, same shape as the "order ready" message (enabled + template),
--    plus the days after "ready" on which a reminder falls due.
alter table public.tenant_settings
  add column if not exists pickup_reminder_enabled boolean not null default false,
  add column if not exists pickup_reminder_template text,
  add column if not exists pickup_reminder_days jsonb not null default '[7, 20, 30, 60]'::jsonb;

-- 2) One row per reminder stage of an order: 'sent' when the employee sent it,
--    'skipped' for an older stage that a later one replaced. The unique
--    constraint is what stops the same stage being sent twice. Rows are never
--    updated or deleted from the app (no UPDATE/DELETE grant or policy below).
create table if not exists public.pickup_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  reminder_day integer not null check (reminder_day > 0),
  status text not null check (status in ('sent', 'skipped')),
  customer_id integer,
  customer_name text,
  phone text,
  message text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint pickup_reminders_invoice_day_key unique (invoice_id, reminder_day)
);

create index if not exists pickup_reminders_tenant_created_idx
  on public.pickup_reminders (tenant_id, created_at desc);

alter table public.pickup_reminders enable row level security;

-- New tables in this project get no usable grants by default (see
-- PROJECT_REFERENCE.md §29), and anon must never reach this one.
revoke all on public.pickup_reminders from anon, authenticated;
grant select, insert on public.pickup_reminders to authenticated;
grant all on public.pickup_reminders to service_role;

-- Same tenant/branch rule as invoices: the owner sees the whole shop, a branch
-- login only its own branch.
drop policy if exists pickup_reminders_select on public.pickup_reminders;
create policy pickup_reminders_select on public.pickup_reminders
  for select to authenticated
  using (
    (tenant_id = (select public.my_tenant_id())
      and ((select public.my_branch_id()) is null or branch_id = (select public.my_branch_id())))
    or public.is_admin()
  );

-- The invoice must be one the caller can itself read (so, its own tenant's):
-- without that, a shop could log a row against another shop's invoice id and
-- the unique constraint would then block that shop's real reminder.
drop policy if exists pickup_reminders_insert on public.pickup_reminders;
create policy pickup_reminders_insert on public.pickup_reminders
  for insert to authenticated
  with check (
    tenant_id = (select public.my_tenant_id())
    and ((select public.my_branch_id()) is null or branch_id = (select public.my_branch_id()))
    and exists (
      select 1 from public.invoices i
      where i.id = pickup_reminders.invoice_id
        and i.tenant_id = pickup_reminders.tenant_id
        and i.branch_id is not distinct from pickup_reminders.branch_id
    )
  );
