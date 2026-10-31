-- =========================================================================
-- Ragwa POS — plans & subscriptions (free trial / annual by bank transfer)
-- Safe to run more than once. Backward compatible with the code on `main`:
-- every new column is nullable/defaulted, so tenants that exist today
-- (plan is null) are never restricted.
-- Rollback: supabase-subscriptions-rollback.sql
-- =========================================================================

alter table tenants add column if not exists plan text check (plan is null or plan in ('trial', 'annual'));
alter table tenants add column if not exists subscription_ends_at timestamptz;

alter table registration_requests add column if not exists plan text not null default 'trial' check (plan in ('trial', 'annual'));

-- Where customers wire the annual fee. Readable by everyone (platform_config
-- select is already open) because it is meant to be shown to payers.
alter table platform_config add column if not exists bank_name text not null default '';
alter table platform_config add column if not exists bank_beneficiary text not null default '';
alter table platform_config add column if not exists bank_iban text not null default '';
alter table platform_config add column if not exists bank_qr_url text not null default '';

create table if not exists payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null default 'annual' check (plan in ('annual')),
  amount numeric(10,2) not null default 350 check (amount > 0),
  receipt_path text not null,
  receipt_name text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text not null default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists payment_requests_user_idx on payment_requests (user_id, created_at desc);
create index if not exists payment_requests_status_idx on payment_requests (status);

alter table payment_requests enable row level security;

-- A user files and reads only their own requests; only the admin decides.
drop policy if exists payment_requests_select on payment_requests;
create policy payment_requests_select on payment_requests for select to authenticated
  using (user_id = (select auth.uid()) or is_admin());
drop policy if exists payment_requests_insert on payment_requests;
create policy payment_requests_insert on payment_requests for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending' and decided_at is null);
drop policy if exists payment_requests_update on payment_requests;
create policy payment_requests_update on payment_requests for update to authenticated
  using (is_admin()) with check (is_admin());
drop policy if exists payment_requests_delete on payment_requests;
create policy payment_requests_delete on payment_requests for delete to authenticated
  using (is_admin());

-- New tables get no grants in this project; RLS above does the filtering.
grant select, insert, update, delete on table payment_requests to authenticated;
grant select, insert, update, delete on table payment_requests to service_role;

-- A branch login cannot read its owner's tenants row (RLS), yet the whole
-- shop shares one subscription, so the app asks this function instead.
create or replace function my_subscription()
returns table (plan text, subscription_ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select t.plan, t.subscription_ends_at from tenants t where t.id = my_tenant_id();
$$;
revoke execute on function my_subscription() from anon, public;
grant execute on function my_subscription() to authenticated;
