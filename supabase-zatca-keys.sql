-- =========================================================================
-- Ragwa POS — ZATCA Phase 2 real key material columns (run once in Supabase
-- Dashboard → SQL Editor → New Query → Run).
-- =========================================================================
-- Additive only. Adds storage for the real secp256k1 key pair + CSR that
-- api/zatca-generate-keys.js generates server-side:
--   - encrypted_private_key: AES-256-GCM ciphertext, only ever decrypted
--     inside a Vercel serverless function (never sent to the browser).
--   - public_key: not secret, safe to read from the client for display.
--   - csr: the PKCS#10 CSR PEM the owner submits to ZATCA's Fatoora portal
--     to get their real Compliance OTP/CSID; not secret either.
-- No RLS/GRANT changes needed — the existing zatca_configurations policies
-- (tenant_id = auth.uid()) already cover these new columns, and only the
-- service-role-authenticated serverless function ever writes them.
-- =========================================================================

alter table zatca_configurations add column if not exists encrypted_private_key text;
alter table zatca_configurations add column if not exists public_key text;
alter table zatca_configurations add column if not exists csr text;
