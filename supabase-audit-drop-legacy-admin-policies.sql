-- Security audit finding: several tables carried a leftover admin-access
-- policy that checked a hardcoded email (auth.jwt()->>'email' = 'ragwapos@gmail.com')
-- *alongside* the newer, table-standard `... OR is_admin()` policies. Since
-- Postgres OR's all matching RLS policies together, the hardcoded-email
-- policy was pure dead weight while that email stayed in platform_admins —
-- but it also meant revoking that account via the admin-sync "revoke" flow
-- (which only removes the platform_admins row) would NOT actually revoke
-- this policy's access, since it re-checks the JWT email directly instead
-- of the platform_admins table `is_admin()` reads from. Confirmed via the
-- live database (2026-08-23) that ragwapos@gmail.com is already a
-- platform_admins member, so is_admin() already grants everything these
-- policies granted — dropping them is a pure no-op for current behavior
-- and closes the inconsistent-revocation gap.
--
-- Applied directly against the live Supabase project on 2026-08-23; this
-- file documents that change for the repo (matching the pattern already
-- used by supabase-fix-rpc-tenant-isolation.sql).

DROP POLICY IF EXISTS "Admin can see all categories" ON public.categories;
DROP POLICY IF EXISTS "Admin can see all customers" ON public.customers;
DROP POLICY IF EXISTS "Admin can see all expense_categories" ON public.expense_categories;
DROP POLICY IF EXISTS "Admin can see all expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admin can see all invoices" ON public.invoices;
DROP POLICY IF EXISTS "Admin can update all invoices" ON public.invoices;
DROP POLICY IF EXISTS "Admin can see all products" ON public.products;
DROP POLICY IF EXISTS "Admin can see all purchases" ON public.purchases;
DROP POLICY IF EXISTS "Admin can see all tenant_settings" ON public.tenant_settings;
DROP POLICY IF EXISTS "Admin can update all tenant_settings" ON public.tenant_settings;

-- Second finding: the invoice-pdfs and tenant-documents storage buckets had
-- no file_size_limit/allowed_mime_types set, meaning the only enforcement
-- of upload size/type was the client-side check in App.jsx's
-- validateUploadedFile() — explicitly commented there as "not a real
-- security boundary" since it trusts the browser-reported MIME type. This
-- sets real server-side limits matching the app's own client-side
-- constants (MAX_ATTACHMENT_BYTES = 5MB, ALLOWED_ATTACHMENT_TYPES).

UPDATE storage.buckets SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['application/pdf','image/png','image/jpeg']
WHERE id = 'invoice-pdfs';

UPDATE storage.buckets SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','application/pdf']
WHERE id = 'tenant-documents';
