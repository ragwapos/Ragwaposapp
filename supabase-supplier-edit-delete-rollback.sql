-- Rollback for supabase-supplier-edit-delete.sql. Only run together with
-- reverting the app code that reads these columns. Archived suppliers come
-- back into the list once the column is gone.
drop trigger if exists purchases_supplier_snapshot on purchases;
drop function if exists purchases_supplier_snapshot();
alter table purchases drop constraint if exists purchases_supplier_vat_class_check;
alter table purchases drop column if exists supplier_vat_class;
alter table purchases drop column if exists supplier_tax_number;
alter table purchases drop column if exists supplier_name;
drop function if exists supplier_vat_class(suppliers);
alter table suppliers drop column if exists archived;
