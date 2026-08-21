import { createClient } from '@supabase/supabase-js';
import { verifyTenantSession } from './_auth.js';
import { checkRateLimit } from './_rateLimit.js';

// Server-side only, same pattern as the other api/zatca-*.js files.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ZATCA's Fatoora sandbox/simulation base — set ZATCA_API_BASE_URL to
// override (e.g. once the tenant is production-onboarded; ZATCA uses a
// different host/path for production than for sandbox/simulation).
//
// !! This entire file is the one piece of the ZATCA pipeline that CANNOT be
// verified without a real ZATCA sandbox account (per the "no, not yet"
// answer that shaped this whole build). The endpoint path, header names
// (OTP / Accept-Version), and response field names (requestID /
// binarySecurityToken / secret) below are reconstructed from ZATCA's
// published Compliance CSID documentation from memory, not confirmed
// against a live call. Everything upstream of this file — the CSR, the
// key pair, the UBL invoice XML, the ECDSA signing, the Phase 2 QR — has
// been independently verified with OpenSSL and noble's own crypto. This
// file is what actually needs testing against a real ZATCA account before
// relying on it; if it 400s/404s once real credentials exist, the fix is
// almost certainly here, not upstream.
const ZATCA_API_BASE = process.env.ZATCA_API_BASE_URL || 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';

async function importAesKey() {
  const raw = process.env.ZATCA_ENCRYPTION_KEY;
  if (!raw) throw new Error('ZATCA_ENCRYPTION_KEY is not configured');
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Uint8Array.from(raw.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : Uint8Array.from(Buffer.from(raw, 'base64'));
  if (bytes.length !== 32) throw new Error('ZATCA_ENCRYPTION_KEY must decode to exactly 32 bytes');
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptSecret(plaintext) {
  const { webcrypto } = await import('node:crypto');
  const key = await importAesKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${Buffer.from(iv).toString('hex')}:${Buffer.from(ciphertext).toString('hex')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { tenantId, otp } = req.body || {};
  if (!tenantId || !otp) return res.status(400).json({ success: false, error: 'tenantId and otp are required' });
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, error: 'invalid_otp' });

  const authResult = await verifyTenantSession(req, supabaseAdmin, tenantId);
  if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error });

  // otp is a bare 6-digit code (1M possibilities) checked against ZATCA's
  // real API — without a limit here, an authenticated tenant session could
  // brute-force it. A generous-but-bounded cap also protects against
  // hammering ZATCA's actual compliance endpoint, which this is a one-time
  // onboarding step against, not a per-sale action.
  if (!(await checkRateLimit(res, 'zatca-request-compliance-csid', tenantId, 10, '1 h'))) return;

  try {
    const { data: config, error: cfgErr } = await supabaseAdmin
      .from('zatca_configurations')
      .select('csr')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (cfgErr) throw cfgErr;
    if (!config?.csr) throw new Error('no_csr — generate a CSR first');

    const csrBase64 = Buffer.from(config.csr).toString('base64');

    const zatcaRes = await fetch(`${ZATCA_API_BASE}/compliance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        OTP: otp,
        'Accept-Version': 'V2',
      },
      body: JSON.stringify({ csr: csrBase64 }),
    });
    const zatcaText = await zatcaRes.text();
    let zatcaData = null;
    try { zatcaData = JSON.parse(zatcaText); } catch { /* non-JSON error body */ }

    if (!zatcaRes.ok) {
      // Capped — this is the raw upstream ZATCA response body, and it's
      // both stored and returned straight to the client; no reason to let
      // an unusually large/unexpected error body through uncapped.
      const message = `ZATCA compliance request failed (HTTP ${zatcaRes.status}): ${(zatcaData ? JSON.stringify(zatcaData) : zatcaText).slice(0, 500)}`;
      await supabaseAdmin.from('zatca_configurations').update({
        last_error_at: new Date().toISOString(),
        last_error_message: message,
      }).eq('tenant_id', tenantId);
      return res.status(200).json({ success: false, error: message });
    }

    const { requestID, binarySecurityToken, secret } = zatcaData || {};
    if (!binarySecurityToken || !secret) {
      throw new Error(`Unexpected ZATCA response shape: ${zatcaText.slice(0, 300)}`);
    }

    const encryptedSecret = await encryptSecret(secret);
    const { error: updErr } = await supabaseAdmin.from('zatca_configurations').update({
      certificate_status: 'ACTIVE',
      certificate_request_id: requestID != null ? String(requestID) : null,
      compliance_certificate: binarySecurityToken,
      encrypted_compliance_secret: encryptedSecret,
      is_enabled: true,
      enabled_at: new Date().toISOString(),
      certificate_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      last_error_message: null,
    }).eq('tenant_id', tenantId);
    if (updErr) throw updErr;

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('zatca-request-compliance-csid error', e);
    return res.status(200).json({ success: false, error: e.message || String(e) });
  }
}
