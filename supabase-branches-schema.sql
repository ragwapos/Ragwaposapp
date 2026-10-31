-- =========================================================================
-- Ragwa POS — Multi-branch support, phase A (schema only, invisible)
-- شغّل هذا مرة وحدة بـ Supabase Dashboard → SQL Editor → New Query → Run.
-- =========================================================================
-- A branch is a layer INSIDE one tenant (shop). Customers, wallets,
-- products, prices and suppliers stay shared at the tenant level; sales
-- (invoices), wallet movements, purchases and expenses belong to a branch.
--
-- Backward compatible by design: the code currently on `main` knows nothing
-- about branches and keeps inserting rows without branch_id. A BEFORE INSERT
-- trigger fills those with the tenant's main branch (number 1), so nothing
-- that already works changes. Every tenant gets one main branch, created
-- here for existing tenants and by trigger for future ones.
--
-- Invoice numbering: next_doc_number() is untouched. The main branch keeps
-- its existing doc types ('INV', 'DLV'); branch N>1 uses 'B<N>:INV' /
-- 'B<N>:DLV' as the doc_counters key, and the app prefixes the code
-- ('B2-INV-1001'). Receipts/top-ups/payments/POs stay tenant-wide.
--
-- Rollback: supabase-branches-rollback.sql
-- Safe to run multiple times.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) branches
-- -------------------------------------------------------------------------
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number integer not null check (number >= 1),
  name text not null check (length(btrim(name)) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number),
  -- target for the (tenant_id, branch_id) composite foreign keys below, so a
  -- row can never point at ANOTHER tenant's branch
  unique (tenant_id, id)
);

alter table branches enable row level security;
revoke all on branches from anon;
-- Table privileges (RLS below decides which rows): owners read/rename, creation is via
-- create_branch(), clients never delete. Without these the table is unreadable.
grant select, update on table branches to authenticated;
grant select, insert, update, delete on table branches to service_role;

drop policy if exists branches_select on branches;
create policy branches_select on branches for select
  using (tenant_id = auth.uid() or is_admin());

-- Rename / archive by the owner. number and tenant_id are frozen by the
-- guard trigger below. There is deliberately NO insert policy (branches are
-- created through create_branch(), which assigns the number atomically) and
-- no delete policy for tenants (a branch is archived, never deleted).
drop policy if exists branches_update on branches;
create policy branches_update on branches for update
  using (tenant_id = auth.uid())
  with check (tenant_id = auth.uid());

drop policy if exists branches_admin_delete on branches;
create policy branches_admin_delete on branches for delete
  using (is_admin());

create or replace function guard_branch_update()
returns trigger
language plpgsql
as $$
begin
  if new.tenant_id is distinct from old.tenant_id or new.number is distinct from old.number then
    raise exception 'branch_immutable';
  end if;
  if old.number = 1 and new.status = 'archived' then
    raise exception 'main_branch_cannot_be_archived';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_branch_update on branches;
create trigger guard_branch_update before update on branches
  for each row execute function guard_branch_update();

-- -------------------------------------------------------------------------
-- 2) main branch per tenant (existing + future)
-- -------------------------------------------------------------------------
create or replace function ensure_main_branch(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from branches where tenant_id = p_tenant_id and number = 1;
  if v_id is null then
    insert into branches (tenant_id, number, name)
    values (p_tenant_id, 1, 'الفرع الرئيسي')
    on conflict (tenant_id, number) do nothing;
    select id into v_id from branches where tenant_id = p_tenant_id and number = 1;
  end if;
  return v_id;
end;
$$;

-- Only the trigger functions below (SECURITY DEFINER) may call this; it must
-- never be callable from the browser with someone else's tenant id.
revoke all on function ensure_main_branch(uuid) from public, anon, authenticated;

insert into branches (tenant_id, number, name)
select id, 1, 'الفرع الرئيسي' from tenants
on conflict (tenant_id, number) do nothing;

create or replace function tenants_create_main_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform ensure_main_branch(new.id);
  return new;
end;
$$;

drop trigger if exists tenants_create_main_branch on tenants;
create trigger tenants_create_main_branch after insert on tenants
  for each row execute function tenants_create_main_branch();

-- -------------------------------------------------------------------------
-- 3) create_branch(): the owner adds a branch; number assigned atomically
-- -------------------------------------------------------------------------
create or replace function create_branch(p_name text default null)
returns branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := auth.uid();
  v_number integer;
  v_row branches;
begin
  if v_tenant is null or not exists (select 1 from tenants where id = v_tenant) then
    raise exception 'not_authorized';
  end if;

  -- serialise concurrent adds for the same tenant
  perform 1 from tenants where id = v_tenant for update;
  perform ensure_main_branch(v_tenant);

  select coalesce(max(number), 0) + 1 into v_number from branches where tenant_id = v_tenant;
  insert into branches (tenant_id, number, name)
  values (v_tenant, v_number, coalesce(nullif(btrim(p_name), ''), 'فرع ' || v_number))
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_branch(text) from public, anon;
grant execute on function create_branch(text) to authenticated;

-- -------------------------------------------------------------------------
-- 4) branch_id on the per-branch tables
-- -------------------------------------------------------------------------
alter table invoices add column if not exists branch_id uuid;
alter table customer_transactions add column if not exists branch_id uuid;
alter table purchases add column if not exists branch_id uuid;
alter table expenses add column if not exists branch_id uuid;

-- Back-fill existing rows with the tenant's main branch WITHOUT touching
-- their updated_at (the generic updated_at triggers are paused meanwhile).
alter table invoices disable trigger update_invoices_updated_at;
alter table customer_transactions disable trigger update_customer_transactions_updated_at;
alter table purchases disable trigger update_purchases_updated_at;
alter table expenses disable trigger update_expenses_updated_at;

update invoices x set branch_id = b.id from branches b
  where b.tenant_id = x.tenant_id and b.number = 1 and x.branch_id is null;
update customer_transactions x set branch_id = b.id from branches b
  where b.tenant_id = x.tenant_id and b.number = 1 and x.branch_id is null;
update purchases x set branch_id = b.id from branches b
  where b.tenant_id = x.tenant_id and b.number = 1 and x.branch_id is null;
update expenses x set branch_id = b.id from branches b
  where b.tenant_id = x.tenant_id and b.number = 1 and x.branch_id is null;

alter table invoices enable trigger update_invoices_updated_at;
alter table customer_transactions enable trigger update_customer_transactions_updated_at;
alter table purchases enable trigger update_purchases_updated_at;
alter table expenses enable trigger update_expenses_updated_at;

alter table invoices alter column branch_id set not null;
alter table customer_transactions alter column branch_id set not null;
alter table purchases alter column branch_id set not null;
alter table expenses alter column branch_id set not null;

do $$
declare
  t text;
begin
  foreach t in array array['invoices', 'customer_transactions', 'purchases', 'expenses'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_branch_fkey') then
      execute format(
        'alter table %I add constraint %I foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete restrict',
        t, t || '_branch_fkey');
    end if;
  end loop;
end $$;

create index if not exists invoices_tenant_branch_created_idx on invoices (tenant_id, branch_id, created_at desc);
create index if not exists customer_transactions_tenant_branch_created_idx on customer_transactions (tenant_id, branch_id, created_at desc);
create index if not exists purchases_tenant_branch_created_idx on purchases (tenant_id, branch_id, created_at desc);
create index if not exists expenses_tenant_branch_created_idx on expenses (tenant_id, branch_id, created_at desc);

-- -------------------------------------------------------------------------
-- 5) fill / protect branch_id
--    INSERT without a branch_id (old client code) -> main branch.
--    INSERT into an archived branch -> rejected.
--    UPDATE can never move a row to another branch.
-- -------------------------------------------------------------------------
create or replace function set_row_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op = 'INSERT' then
    if new.branch_id is null then
      new.branch_id := ensure_main_branch(new.tenant_id);
    else
      select status into v_status from branches
        where id = new.branch_id and tenant_id = new.tenant_id;
      if v_status = 'archived' then
        raise exception 'branch_archived';
      end if;
    end if;
  elsif new.branch_id is distinct from old.branch_id then
    raise exception 'branch_immutable';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['invoices', 'customer_transactions', 'purchases', 'expenses'] loop
    execute format('drop trigger if exists set_row_branch on %I', t);
    execute format(
      'create trigger set_row_branch before insert or update on %I for each row execute function set_row_branch()', t);
  end loop;
end $$;
