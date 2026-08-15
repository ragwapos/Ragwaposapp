-- Adds the optional 1-9 keyboard-shortcut assignment for POS products
-- (Products form → "إضافة وصول سريع للمنتج"). Null means no shortcut —
-- explicit assignment only, nothing is auto-picked. Run once in the
-- Supabase SQL editor.

alter table products add column if not exists quick_access_key smallint;
