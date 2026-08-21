-- Same issue as supabase-close-anon-signup-inserts.sql, different table:
-- `sales_inquiries_insert_public` granted INSERT to anon/authenticated
-- with `with_check: true` — completely unconditional. Anyone with the
-- public anon key could POST directly to Supabase's REST API and flood
-- this table, no rate limit, no bot check, bypassing the contact form
-- entirely (the 1.5s client-side cooldown in submitContact() was never a
-- real defense against that).
--
-- api/submit-contact.js now does this insert itself, server-side, with
-- the service-role client, and adds real protection (rate limit, honeypot,
-- minimum-fill-time) before it does. src/App.jsx's submitContact() no
-- longer inserts into sales_inquiries directly.
--
-- Run this ONLY after api/submit-contact.js is deployed and a real
-- submission through it has been verified working — dropping this first
-- would break the contact form for anyone still hitting old client code.

drop policy if exists "sales_inquiries_insert_public" on public.sales_inquiries;
