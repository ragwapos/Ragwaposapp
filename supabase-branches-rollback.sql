-- =========================================================================
-- Ragwa POS — ROLLBACK for the multi-branch work (phase A, and C when added)
-- شغّل هذا فقط لو بغيت ترجع النظام لما قبل الفروع. يحذف كل ما أضافته
-- supabase-branches-schema.sql (والحسابات إن كانت مرحلة C مطبّقة).
-- بيانات الفواتير والعملاء نفسها لا تُمس؛ فقط عمود/جداول الفروع تُحذف.
-- النسخة الكاملة المأخوذة قبل البدء موجودة بمخطط backup_20261031.
-- =========================================================================

-- Phase D objects (supabase-branches-phase-d.sql): discounts per branch, branch PIN
-- state, wallet usage. Branch-specific discounts are DELETED here because the old
-- one-active-discount-per-shop constraint cannot represent them; the policies this
-- phase changed (promotions, purchases, expenses, expense_categories, suppliers,
-- storage "tenant or admin can read own documents") are restored by the policy
-- block below from backup_20261031._policies (that also undoes phase C's policies;
-- re-run supabase-branches-accounts.sql afterwards if phase C should stay).
drop trigger if exists check_promo_overlap on promotions;
drop function if exists check_promo_overlap();
delete from promotions where branch_id is not null;
alter table promotions drop constraint if exists promotions_branch_fkey;
alter table promotions drop column if exists branch_id;
alter table promotions add constraint no_overlapping_active_promos exclude using gist (tenant_id with =, period with &&) where (active);
alter table branches drop column if exists pin_set;
alter table branches drop column if exists locked_sections;
alter table invoices drop column if exists wallet_used;
delete from owner_pin_credentials where scope like 'b:%';

-- Phase C objects (no-ops if phase C was never applied). Policies/functions
-- changed by phase C must be restored from backup_20261031._policies and
-- backup_20261031._functions (see the restore notes at the bottom).
drop table if exists branch_members cascade;
drop function if exists my_tenant_id() cascade;
drop function if exists my_branch_id() cascade;

-- Phase A objects
do $$
declare t text;
begin
  foreach t in array array['invoices', 'customer_transactions', 'purchases', 'expenses'] loop
    execute format('drop trigger if exists set_row_branch on %I', t);
    execute format('alter table %I drop constraint if exists %I', t, t || '_branch_fkey');
    execute format('drop index if exists %I', t || '_tenant_branch_created_idx');
    execute format('alter table %I drop column if exists branch_id', t);
  end loop;
end $$;

drop trigger if exists tenants_create_main_branch on tenants;
drop function if exists tenants_create_main_branch();
drop function if exists set_row_branch();
drop function if exists create_branch(text);
drop function if exists ensure_main_branch(uuid);
drop table if exists branches cascade;
drop function if exists guard_branch_update();

-- doc_counters rows for extra branches use doc_type like 'B2:INV'; remove them.
delete from doc_counters where doc_type like 'B%:%';

-- -------------------------------------------------------------------------
-- Restore notes (only needed if phase C changed RLS/functions):
--   select policyname, tablename, cmd, qual, with_check
--     from backup_20261031._policies;       -- original policies, verbatim
--   select def from backup_20261031._functions
--     where proname in ('next_doc_number','apply_customer_payment',
--                       'adjust_supplier_balance','zatca_record_invoice_result');
-- Re-run each def to restore the original function bodies.
-- -------------------------------------------------------------------------

-- Restore the original (pre-branches) policies verbatim from the backup. Run only
-- when rolling back phases C/D; it recreates nothing that did not exist before.
-- do $$
-- declare r record;
-- begin
--   for r in select b.tablename, b.policyname, b.cmd, b.qual, b.with_check
--            from backup_20261031._policies b
--            join pg_policies p on p.schemaname = b.schemaname and p.tablename = b.tablename and p.policyname = b.policyname
--            where b.schemaname in ('public', 'storage')
--   loop
--     if r.cmd = 'INSERT' then
--       execute format('alter policy %I on %s.%I with check (%s)', r.policyname, (select schemaname from pg_policies where policyname = r.policyname and tablename = r.tablename limit 1), r.tablename, r.with_check);
--     else
--       execute format('alter policy %I on %s.%I using (%s)', r.policyname, (select schemaname from pg_policies where policyname = r.policyname and tablename = r.tablename limit 1), r.tablename, r.qual);
--     end if;
--   end loop;
-- end $$;
