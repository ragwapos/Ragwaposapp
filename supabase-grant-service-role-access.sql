-- Discovered while deploying the signup-RLS fix (supabase-close-anon-
-- signup-inserts.sql): the `service_role` Postgres role — the one every
-- api/*.js function authenticates as via SUPABASE_SERVICE_ROLE_KEY,
-- specifically so it can bypass RLS for legitimate server-side writes —
-- had ZERO table-level SELECT/INSERT/UPDATE/DELETE grants on every table
-- in the schema EXCEPT zatca_configurations and zatca_invoices (those two
-- happened to get granted correctly at some point; nothing else ever did).
--
-- This is a plain Postgres GRANT, unrelated to RLS — service_role bypasses
-- RLS but still needs the underlying table grant to touch a table at all.
-- It sat invisible because no server-side code had ever tried to write to
-- `registration_requests`/`tenants`/`platform_config` before — the first
-- attempt (moving the signup writes server-side) failed with
-- "permission denied for table platform_config" (Postgres code 42501)
-- until this ran. Already applied to the live project.

grant select, insert, update, delete on all tables in schema public to service_role;

-- So the next table created doesn't silently repeat this gap.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
