import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';
import { checkRateLimit } from './_rateLimit.js';

// Server-side replacement for the old client-side "sha256Hex(pin) === stored"
// check (ownerPassword / sectionLocks in App.jsx) -- see audit §4.1 and
// supabase-owner-pin-hardening.sql. The hash/salt for a tenant's PINs never
// leave this file: every response below is { success, error? } only.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SCOPES = new Set(['master', 'customers', 'inventory', 'purchases', 'promotions', 'reports']);
const SCRYPT_KEYLEN = 64;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isPin(v) {
  return typeof v === 'string' && /^\d{4}$/.test(v);
}

function newSaltHex() {
  return crypto.randomBytes(16).toString('hex');
}

function scryptHex(pin, saltHex) {
  return crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
}

function legacySha256Hex(pin) {
  return crypto.createHash('sha256').update(pin, 'utf8').digest('hex');
}

// Fixed-length hex digests either way (scrypt: SCRYPT_KEYLEN*2, sha256: 64) --
// timingSafeEqual requires equal-length buffers, which both call sites here
// always provide.
function hexEquals(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getCredRow(tenantId, scope) {
  const { data, error } = await supabaseAdmin
    .from('owner_pin_credentials')
    .select('pin_hash, pin_salt, failed_attempts, locked_until')
    .eq('tenant_id', tenantId)
    .eq('scope', scope)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function recordFailure(tenantId, scope, row) {
  const failedAttempts = (row?.failed_attempts || 0) + 1;
  const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
  await supabaseAdmin
    .from('owner_pin_credentials')
    .update({ failed_attempts: lockedUntil ? 0 : failedAttempts, locked_until: lockedUntil, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('scope', scope);
}

async function recordSuccess(tenantId, scope) {
  await supabaseAdmin
    .from('owner_pin_credentials')
    .update({ failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('scope', scope);
}

async function upsertCredential(tenantId, scope, pin) {
  const pin_salt = newSaltHex();
  const pin_hash = scryptHex(pin, pin_salt);
  const { error } = await supabaseAdmin
    .from('owner_pin_credentials')
    .upsert({ tenant_id: tenantId, scope, pin_hash, pin_salt, failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,scope' });
  if (error) throw error;
}

// tenant_settings read used two different ways below (legacy-hash lookup,
// legacy-clear patch) -- fetched once per request and reused, instead of
// two separate SELECTs, to cut round-trips on the migration path.
async function getTenantSettingsRow(tenantId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_settings')
    .select('owner_password, section_locks')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Pure lookup against an already-fetched row -- owner_password for 'master',
// section_locks[scope] otherwise. No query of its own.
function extractLegacyHash(tsRow, scope) {
  if (!tsRow) return null;
  return scope === 'master' ? tsRow.owner_password || null : tsRow.section_locks?.[scope] || null;
}

// Single combined write: clears the now-migrated legacy value (if tsRow is
// given -- callers with nothing to clear, e.g. a brand-new set_master, pass
// null) and syncs owner_pin_set/locked_sections from owner_pin_credentials
// (the source of truth) in the same round-trip.
async function finalizeTenantSettings(tenantId, tsRow, migratedScope) {
  const patch = {};
  if (tsRow) {
    if (migratedScope === 'master') {
      patch.owner_password = null;
    } else if (tsRow.section_locks && migratedScope in tsRow.section_locks) {
      const next = { ...tsRow.section_locks };
      delete next[migratedScope];
      patch.section_locks = next;
    }
  }
  const { data: rows, error } = await supabaseAdmin
    .from('owner_pin_credentials')
    .select('scope')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  const scopes = (rows || []).map((r) => r.scope);
  patch.owner_pin_set = scopes.includes('master');
  patch.locked_sections = scopes.filter((s) => s !== 'master');
  await supabaseAdmin.from('tenant_settings').update(patch).eq('tenant_id', tenantId);
}

// Core check shared by the public "verify" action and the master-PIN
// re-check inside set_section/disable_section. Handles the new
// owner_pin_credentials path, falling back to (and silently migrating) the
// legacy tenant_settings hash on first successful match.
async function verifyScope(tenantId, scope, pin) {
  const row = await getCredRow(tenantId, scope);

  if (row) {
    if (row.locked_until && new Date(row.locked_until) > new Date()) return { success: false, error: 'locked' };
    const ok = hexEquals(scryptHex(pin, row.pin_salt), row.pin_hash);
    if (ok) { await recordSuccess(tenantId, scope); return { success: true }; }
    await recordFailure(tenantId, scope, row);
    return { success: false, error: 'wrong_pin' };
  }

  const tsRow = await getTenantSettingsRow(tenantId);
  const legacyHash = extractLegacyHash(tsRow, scope);
  if (!legacyHash) return { success: false, error: 'not_set' };
  if (!hexEquals(legacySha256Hex(pin), legacyHash)) return { success: false, error: 'wrong_pin' };

  // Correct on the legacy hash -- migrate silently now that we've actually
  // seen the real PIN (a stored SHA-256 digest can't be reversed to get it).
  await upsertCredential(tenantId, scope, pin);
  await finalizeTenantSettings(tenantId, tsRow, scope);
  return { success: true };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  const { action, scope, pin, masterPin, newPin } = req.body || {};

  try {
    const { data: { user: caller }, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !caller) return res.status(401).json({ success: false, error: 'invalid_token' });
    const tenantId = caller.id;

    if (action === 'verify') {
      if (!SCOPES.has(scope) || !isPin(pin)) return res.status(400).json({ success: false, error: 'invalid_request' });
      if (!(await checkRateLimit(res, 'pin-verify', `${tenantId}:${scope}`, 5, '1 m'))) return;
      return res.status(200).json(await verifyScope(tenantId, scope, pin));
    }

    if (action === 'set_master') {
      if (!isPin(pin)) return res.status(400).json({ success: false, error: 'invalid_request' });
      if (!(await checkRateLimit(res, 'pin-manage', `${tenantId}:master`, 10, '1 m'))) return;
      const [existingRow, tsRow] = await Promise.all([getCredRow(tenantId, 'master'), getTenantSettingsRow(tenantId)]);
      if (existingRow || extractLegacyHash(tsRow, 'master')) return res.status(409).json({ success: false, error: 'already_set' });
      await upsertCredential(tenantId, 'master', pin);
      await finalizeTenantSettings(tenantId, null, 'master');
      return res.status(200).json({ success: true });
    }

    if (action === 'set_section' || action === 'disable_section') {
      if (!SCOPES.has(scope) || scope === 'master' || !isPin(masterPin)) return res.status(400).json({ success: false, error: 'invalid_request' });
      if (action === 'set_section' && !isPin(newPin)) return res.status(400).json({ success: false, error: 'invalid_request' });
      if (!(await checkRateLimit(res, 'pin-manage', `${tenantId}:${scope}`, 10, '1 m'))) return;

      const masterCheck = await verifyScope(tenantId, 'master', masterPin);
      if (!masterCheck.success) return res.status(403).json({ success: false, error: 'master_pin_invalid' });

      const tsRow = await getTenantSettingsRow(tenantId);
      if (action === 'set_section') {
        await upsertCredential(tenantId, scope, newPin);
      } else {
        await supabaseAdmin.from('owner_pin_credentials').delete().eq('tenant_id', tenantId).eq('scope', scope);
      }
      await finalizeTenantSettings(tenantId, tsRow, scope);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (e) {
    console.error('verify-pin error', e);
    Sentry.captureException(e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
