-- =========================================================================
-- Ragwa POS — Multi-branch support, phase D
-- شغّل هذا بعد supabase-branches-accounts.sql، مرة وحدة.
-- =========================================================================
-- * Discounts per branch (promotions.branch_id; null = every branch). The old
--   "one active discount per shop at a time" exclusion constraint becomes a
--   scope-aware trigger: an all-branches discount conflicts with every branch,
--   two different branches' discounts never conflict.
-- * Branch accounts get purchases / expenses (own branch only), can add
--   expense categories and suppliers, and can adjust supplier balances.
-- * branches.pin_set / locked_sections: the branch manager's own PIN lock state
--   (written only by api/verify-pin.js with the service-role key).
-- * invoices.wallet_used: how much of an invoice was paid from the customer's
--   wallet, so a branch can see wallet consumption (revenue itself is still
--   recognised at top-up, unchanged).
-- * The owner can read files uploaded by their branch accounts.
-- Rollback: supabase-branches-rollback.sql. Safe to run multiple times.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) promotions per branch
-- -------------------------------------------------------------------------
alter table promotions add column if not exists branch_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'promotions_branch_fkey') then
    alter table promotions add constraint promotions_branch_fkey
      foreign key (tenant_id, branch_id) references branches (tenant_id, id) on delete restrict;
  end if;
end $$;

alter table promotions drop constraint if exists no_overlapping_active_promos;

-- Same error code as the exclusion constraint it replaces (23P01), so callers
-- see the failure they always have. `period` is a generated column and is not
-- yet computed inside a BEFORE trigger, so the range is rebuilt from the dates.
create or replace function check_promo_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.active is not true then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('promo:' || new.tenant_id::text));
  if exists (
    select 1 from promotions p
    where p.tenant_id = new.tenant_id
      and p.id <> new.id
      and p.active
      and p.period && tstzrange(new.start_date, new.end_date, '[]')
      and (p.branch_id is null or new.branch_id is null or p.branch_id = new.branch_id)
  ) then
    raise exception 'conflicting key value violates exclusion constraint "no_overlapping_active_promos"' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists check_promo_overlap on promotions;
create trigger check_promo_overlap before insert or update on promotions
  for each row execute function check_promo_overlap();

-- A branch account reads its own branch's and the all-branches discounts, and
-- writes only its own branch's. The owner keeps full access.
alter policy promotions_select on promotions using (
  ((tenant_id = (select my_tenant_id()))
    and ((select my_branch_id()) is null or branch_id is null or branch_id = (select my_branch_id())))
  or is_admin());
alter policy promotions_insert on promotions with check (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));
alter policy promotions_update on promotions using (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));
alter policy promotions_delete on promotions using (
  ((tenant_id = (select my_tenant_id()))
    and ((select my_branch_id()) is null or branch_id = (select my_branch_id())))
  or is_admin());

-- -------------------------------------------------------------------------
-- 2) purchases / expenses for branch accounts (own branch only)
-- -------------------------------------------------------------------------
alter policy purchases_insert on purchases with check (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));
alter policy purchases_update on purchases using (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));
alter policy expenses_insert on expenses with check (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));
alter policy expenses_update on expenses using (
  (tenant_id = (select my_tenant_id()))
  and ((select my_branch_id()) is null or branch_id = (select my_branch_id())));

-- shared lookups a purchase / expense needs; edit and delete stay owner-only
alter policy expense_categories_insert on expense_categories with check (tenant_id = (select my_tenant_id()));
alter policy suppliers_insert on suppliers with check (tenant_id = (select my_tenant_id()));

create or replace function adjust_supplier_balance(p_tenant_id uuid, p_supplier_id uuid, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_tenant_id is distinct from my_tenant_id() then
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

-- Attachments are uploaded under the uploader's own uid folder, so a purchase
-- attachment added by a branch account lives in that account's folder; the
-- owner must be able to open it.
alter policy "tenant or admin can read own documents" on storage.objects using (
  bucket_id = 'tenant-documents'
  and (
    (storage.foldername(name))[1] = (auth.uid())::text
    or is_admin()
    or (storage.foldername(name))[1] in (select bm.user_id::text from public.branch_members bm where bm.tenant_id = auth.uid())
  ));

-- -------------------------------------------------------------------------
-- 3) branch manager PIN state + wallet usage on invoices
-- -------------------------------------------------------------------------
alter table branches add column if not exists pin_set boolean not null default false;
alter table branches add column if not exists locked_sections jsonb not null default '[]'::jsonb;
alter table invoices add column if not exists wallet_used numeric check (wallet_used is null or wallet_used >= 0);
