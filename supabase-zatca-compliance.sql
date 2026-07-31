-- =========================================================================
-- Ragwa POS — ZATCA Compliance CSID storage (run once in Supabase Dashboard
-- → SQL Editor → New Query → Run).
-- =========================================================================
-- Additive only. Stores what ZATCA's real Compliance CSID API returns once
-- api/zatca-request-compliance-csid.js actually calls it successfully:
--   - certificate_request_id: ZATCA's own tracking ID for this request.
--   - compliance_certificate: the X.509 cert ZATCA issues (base64,
--     "binarySecurityToken" in their response) — not secret.
--   - encrypted_compliance_secret: AES-256-GCM ciphertext of ZATCA's
--     compliance API secret, used as the Basic Auth password on every
--     subsequent Compliance Invoice / Production CSID call. Only ever
--     decrypted inside a Vercel serverless function, same as the private
--     key in supabase-zatca-keys.sql.
-- =========================================================================

alter table zatca_configurations add column if not exists certificate_request_id text;
alter table zatca_configurations add column if not exists compliance_certificate text;
alter table zatca_configurations add column if not exists encrypted_compliance_secret text;
