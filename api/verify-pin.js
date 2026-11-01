import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from './_supabaseConfig.js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';
import { checkRateLimit } from './_rateLimit.js';
import { extractLegacyHash, finalizeTenantSettings, getCredRow, getTenantSettingsRow, isPin, upsertCredential, verifyScope } from './_ownerPin.js';

// Server-side replacement for the old client-side "sha256Hex(pin) === stored"
// check (ownerPassword / sectionLocks in App.jsx) -- see audit §4.1 and
// supabase-owner-pin-hardening.sql. The hash/salt for a tenant's PINs never
// leave the server: every response below is { success, error? } only.
const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SCOPES = new Set(['master', 'customers', 'inventory', 'purchases', 'promotions', 'reports']);

// A branch account (supabase-branches-accounts.sql) belongs to its owner's
// tenant but never touches the owner's PINs. It has its own PINs, kept in the
// same owner_pin_credentials table under the scope 'b:<branchId>:<scope>'.
async function resolveTenant(userId) {
  const { data, error } = await supabaseAdmin.from('branch_members').select('tenant_id, branch_id').eq('user_id', userId).eq('active', true).maybeSingle();
  // 42P01: table not created yet (this code deployed before the SQL ran) -> plain owner.
  if (error && error.code !== '42P01') throw error;
  return data
    ? { tenantId: data.tenant_id, branchId: data.branch_id, isBranchAccount: true }
    : { tenantId: userId, branchId: null, isBranchAccount: false };
}

// ---- branch manager PINs (a branch account's own lock on customers, purchases/expenses, discounts and reports) ----
const BRANCH_SCOPES = new Set(['master', 'customers', 'purchases', 'promotions', 'reports']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const branchScope = (branchId, scope) => `b:${branchId}:${scope}`;

// owner_pin_credentials is the source of truth; branches.pin_set /
// locked_sections mirror it for the client (same idea as finalizeTenantSettings).
async function finalizeBranch(tenantId, branchId) {
  const prefix = `b:${branchId}:`;
  const { data: rows, error } = await supabaseAdmin.from('owner_pin_credentials').select('scope').eq('tenant_id', tenantId).like('scope', `${prefix}%`);
  if (error) throw error;
  const scopes = (rows || []).map((r) => r.scope.slice(prefix.length));
  const { error: updErr } = await supabaseAdmin.from('branches')
    .update({ pin_set: scopes.includes('master'), locked_sections: scopes.filter((x) => x !== 'master') })
    .eq('id', branchId).eq('tenant_id', tenantId);
  if (updErr) throw updErr;
}

// The branch is taken from branch_members (never from the request), and the
// owner's own PINs are deliberately NOT accepted here: letting a shared branch
// login try the owner's master PIN would let staff burn its failed-attempt
// counter (locking the owner out) or brute-force it. If a branch PIN is lost,
// the owner resets it with reset_branch_pin below.
async function handleBranchAccount(res, { tenantId, branchId, action, scope, pin, masterPin, newPin }) {
  if (action === 'verify') {
    if (!BRANCH_SCOPES.has(scope) || !isPin(pin)) return res.status(400).json({ success: false, error: 'invalid_request' });
    if (!(await checkRateLimit(res, 'pin-verify', `${tenantId}:${branchId}:${scope}`, 5, '1 m'))) return;
    return res.status(200).json(await verifyScope(tenantId, branchScope(branchId, scope), pin));
  }

  if (action === 'set_master') {
    if (!isPin(pin)) return res.status(400).json({ success: false, error: 'invalid_request' });
    if (!(await checkRateLimit(res, 'pin-manage', `${tenantId}:${branchId}:master`, 10, '1 m'))) return;
    if (await getCredRow(tenantId, branchScope(branchId, 'master'))) return res.status(409).json({ success: false, error: 'already_set' });
    await upsertCredential(tenantId, branchScope(branchId, 'master'), pin);
    await finalizeBranch(tenantId, branchId);
    return res.status(200).json({ success: true });
  }

  if (action === 'set_section' || action === 'disable_section') {
    if (!BRANCH_SCOPES.has(scope) || scope === 'master' || !isPin(masterPin)) return res.status(400).json({ success: false, error: 'invalid_request' });
    if (action === 'set_section' && !isPin(newPin)) return res.status(400).json({ success: false, error: 'invalid_request' });
    if (!(await checkRateLimit(res, 'pin-manage', `${tenantId}:${branchId}:${scope}`, 10, '1 m'))) return;
    const masterCheck = await verifyScope(tenantId, branchScope(branchId, 'master'), masterPin);
    if (!masterCheck.success) return res.status(403).json({ success: false, error: 'master_pin_invalid' });
    if (action === 'set_section') {
      await upsertCredential(tenantId, branchScope(branchId, scope), newPin);
    } else {
      await supabaseAdmin.from('owner_pin_credentials').delete().eq('tenant_id', tenantId).eq('scope', branchScope(branchId, scope));
    }
    await finalizeBranch(tenantId, branchId);
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'invalid_action' });
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  const { action, scope, pin, masterPin, newPin, branchId: targetBranchId } = req.body || {};

  try {
    const { data: { user: caller }, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !caller) return res.status(401).json({ success: false, error: 'invalid_token' });
    const { tenantId, branchId, isBranchAccount } = await resolveTenant(caller.id);
    if (isBranchAccount) return handleBranchAccount(res, { tenantId, branchId, action, scope, pin, masterPin, newPin });

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

    // Owner-only: clear a branch manager's PINs (forgotten PIN, or a branch login
    // that set its PIN before the manager could). Needs the owner's master PIN.
    if (action === 'reset_branch_pin') {
      if (typeof targetBranchId !== 'string' || !UUID_RE.test(targetBranchId) || !isPin(masterPin)) return res.status(400).json({ success: false, error: 'invalid_request' });
      if (!(await checkRateLimit(res, 'pin-manage', `${tenantId}:reset-branch`, 10, '1 m'))) return;
      const masterCheck = await verifyScope(tenantId, 'master', masterPin);
      if (!masterCheck.success) return res.status(403).json({ success: false, error: 'master_pin_invalid' });
      const { data: ownBranch, error: branchErr } = await supabaseAdmin.from('branches').select('id').eq('id', targetBranchId).eq('tenant_id', tenantId).maybeSingle();
      if (branchErr) throw branchErr;
      if (!ownBranch) return res.status(404).json({ success: false, error: 'branch_not_found' });
      await supabaseAdmin.from('owner_pin_credentials').delete().eq('tenant_id', tenantId).like('scope', `b:${targetBranchId}:%`);
      await finalizeBranch(tenantId, targetBranchId);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (e) {
    console.error('verify-pin error', e);
    Sentry.captureException(e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
