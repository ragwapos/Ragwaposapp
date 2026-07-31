-- =========================================================================
-- Ragwa POS — adds tax-exempt fields to suppliers (run once in Supabase
-- Dashboard → SQL Editor → New Query → Run).
-- =========================================================================
-- Lets the owner flag a supplier as tax-exempt with its own exemption
-- number, distinct from the existing tax_number column (which marks a
-- supplier as standard-rated/VAT-reclaimable). Purchases from a supplier
-- with tax_exempt = true AND a non-empty exemption_number now count toward
-- the Tax Return's "Exempt purchases" box (#5) on the purchases side.
-- A supplier with neither tax_number nor exemption_number stays recorded
-- in the system/reports as before, just excluded from the tax return.
-- =========================================================================

alter table suppliers add column if not exists tax_exempt boolean not null default false;
alter table suppliers add column if not exists exemption_number text;
