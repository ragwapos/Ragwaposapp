-- Low-risk, purely additive/cleanup fixes from the pre-deployment security
-- audit — safe to run any time, no behavior change for real usage:
--
-- 1) Three foreign-key columns had no covering index (customer_transactions
--    .customer_id, expenses.category_id, products.category_id) — every
--    query joining/filtering through them was a sequential scan.
-- 2) is_admin() had no pinned search_path — Supabase's linter flags any
--    SECURITY DEFINER function without one (function_search_path_mutable).
-- 3) registration_requests/sales_inquiries each had a leftover policy from
--    before is_admin()/platform_admins existed, hardcoding
--    auth.jwt()->>'email' = 'ragwapos@gmail.com'. Confirmed redundant —
--    registration_requests_select/sales_inquiries_select/_update already
--    grant the exact same access via is_admin(), and platform_admins
--    already contains that email's real user_id — before dropping these.
--
-- Already applied to the live Supabase project. Run once in the SQL editor.

create index if not exists customer_transactions_tenant_customer_idx
  on public.customer_transactions (tenant_id, customer_id);
create index if not exists expenses_category_id_idx
  on public.expenses (category_id);
create index if not exists products_category_id_idx
  on public.products (category_id);

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

drop policy if exists "Admin can see all" on public.registration_requests;
drop policy if exists "Admin can see all inquiries" on public.sales_inquiries;
drop policy if exists "Admin can update all inquiries" on public.sales_inquiries;
