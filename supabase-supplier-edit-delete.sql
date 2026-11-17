-- =========================================================================
-- Ragwa POS — supplier edit/delete without touching past purchases.
-- Apply to staging first, then to production BEFORE merging the code that
-- reads these columns. Rollback: supabase-supplier-edit-delete-rollback.sql
-- =========================================================================
-- 1) Each purchase keeps its own copy of the supplier's name, tax number and
--    VAT class (standard / exempt / none) as they were when it was recorded,
--    so editing a supplier later only affects NEW purchases and past tax
--    returns never change. The copy is filled by a trigger from the
--    suppliers table itself, never from what the browser sends, and a
--    purchase can only point at an active supplier of the same shop.
-- 2) Deleting a supplier archives it (purchases reference it with
--    ON DELETE RESTRICT): hidden from the suppliers list and the purchase
--    form, while its purchases stay in reports and the tax return.
-- =========================================================================

alter table suppliers add column if not exists archived boolean not null default false;

alter table purchases add column if not exists supplier_name text not null default '';
alter table purchases add column if not exists supplier_tax_number text not null default '';
alter table purchases add column if not exists supplier_vat_class text not null default 'none';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchases_supplier_vat_class_check') then
    alter table purchases add constraint purchases_supplier_vat_class_check
      check (supplier_vat_class in ('standard', 'exempt', 'none'));
  end if;
end $$;

-- Same rule the tax return used until now: a tax number = standard-rated;
-- otherwise flagged exempt WITH an exemption number = exempt; else none.
create or replace function supplier_vat_class(s suppliers) returns text
language sql immutable set search_path = public as $$
  select case
    when coalesce(btrim(s.tax_number), '') <> '' then 'standard'
    when s.tax_exempt and coalesce(btrim(s.exemption_number), '') <> '' then 'exempt'
    else 'none' end
$$;
revoke execute on function supplier_vat_class(suppliers) from public, anon;
grant execute on function supplier_vat_class(suppliers) to authenticated, service_role;

-- Backfill existing purchases from their supplier as it is today, so every
-- current total stays exactly the same.
update purchases p set
  supplier_name = s.company,
  supplier_tax_number = coalesce(btrim(s.tax_number), ''),
  supplier_vat_class = supplier_vat_class(s)
from suppliers s
where s.id = p.supplier_id;

create or replace function purchases_supplier_snapshot() returns trigger
language plpgsql set search_path = public as $$
declare s suppliers;
begin
  if tg_op = 'UPDATE' and new.supplier_id = old.supplier_id then
    -- The copy is frozen: an update can't rewrite it.
    new.supplier_name := old.supplier_name;
    new.supplier_tax_number := old.supplier_tax_number;
    new.supplier_vat_class := old.supplier_vat_class;
    return new;
  end if;
  select * into s from suppliers where id = new.supplier_id and tenant_id = new.tenant_id;
  if not found then
    raise exception 'supplier not found for this shop' using errcode = '23503';
  end if;
  if s.archived then
    raise exception 'supplier is deleted' using errcode = '23514';
  end if;
  new.supplier_name := s.company;
  new.supplier_tax_number := coalesce(btrim(s.tax_number), '');
  new.supplier_vat_class := supplier_vat_class(s);
  return new;
end $$;

drop trigger if exists purchases_supplier_snapshot on purchases;
create trigger purchases_supplier_snapshot
  before insert or update on purchases
  for each row execute function purchases_supplier_snapshot();
