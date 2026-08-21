-- CRITICAL FIX (security audit): `tenants_insert_public` and
-- `registration_requests_insert_public` granted INSERT to the anon role
-- with essentially no ownership check (`with_check: true` on tenants;
-- `status in ('pending','approved')` on registration_requests) — anyone
-- with the public anon key (shipped in the client bundle by design) could
-- POST directly to Supabase's REST API and insert arbitrary rows into
-- either table, completely bypassing signup and email verification.
--
-- api/send-verification-email.js now does both inserts itself, server-side,
-- with the service-role client (which bypasses RLS entirely) right after
-- creating the Supabase Auth user — so the client never needs to insert
-- into these tables directly anymore. src/App.jsx's handleSignup() no
-- longer does its own db.from('registration_requests'/'tenants').insert().
--
-- Already applied to the live project — verified first with a real
-- end-to-end signup test against the new server-side insert path (which
-- also needed supabase-grant-service-role-access.sql; service_role had no
-- grants on these tables at all until that ran), then confirmed the
-- direct-REST-API exploit this fixes now gets rejected with a genuine RLS
-- violation instead of succeeding.

drop policy if exists "tenants_insert_public" on public.tenants;
drop policy if exists "registration_requests_insert_public" on public.registration_requests;
