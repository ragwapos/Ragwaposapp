import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';
import { checkRateLimit } from './_rateLimit.js';

// Owner-only management of branch logins (supabase-branches-accounts.sql).
// A branch account is a Supabase auth user that belongs to ONE branch of the
// owner's tenant; the database (RLS) decides what it can see, this endpoint
// only creates / resets / (de)activates it. It needs the service-role key
// (auth.admin), so the caller is verified here first: only the tenant owner
// (a user whose id IS a tenants row) can manage that tenant's branch accounts
// -- never a branch account itself, never anyone for another tenant.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Branch logins use a synthetic address on a domain the platform controls.
// Nothing is ever mailed to it (email_confirm is set at creation), and the
// login page maps a bare username to it, so staff just type the username.
const BRANCH_EMAIL_DOMAIN = 'branches.ragwapos.com';
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BAN_FOREVER = '876000h';

function newPassword() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

function usernameFor(branchNumber, attempt) {
  const suffix = crypto.randomBytes(3).toString('hex').slice(0, 3 + attempt);
  return `b${branchNumber}.${suffix}`;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  const { action, branchId, status } = req.body || {};
  if (!['create', 'reset_password', 'set_status'].includes(action) || typeof branchId !== 'string') {
    return res.status(400).json({ success: false, error: 'invalid_request' });
  }

  try {
    const { data: { user: caller }, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !caller) return res.status(401).json({ success: false, error: 'invalid_token' });
    const tenantId = caller.id;

    if (!(await checkRateLimit(res, 'branch-accounts', tenantId, 20, '1 m'))) return;

    // Only the owner: the caller's id must itself be a tenant.
    const { data: tenantRow, error: tenantErr } = await supabaseAdmin.from('tenants').select('id').eq('id', tenantId).maybeSingle();
    if (tenantErr) throw tenantErr;
    if (!tenantRow) return res.status(403).json({ success: false, error: 'not_authorized' });

    // The branch must belong to the caller's own tenant.
    const { data: branch, error: branchErr } = await supabaseAdmin
      .from('branches').select('id, number, status').eq('id', branchId).eq('tenant_id', tenantId).maybeSingle();
    if (branchErr) throw branchErr;
    if (!branch) return res.status(404).json({ success: false, error: 'branch_not_found' });

    const { data: member, error: memberErr } = await supabaseAdmin
      .from('branch_members').select('user_id, username, active').eq('branch_id', branch.id).maybeSingle();
    if (memberErr) throw memberErr;

    if (action === 'create') {
      if (member) return res.status(409).json({ success: false, error: 'account_exists' });
      if (branch.status !== 'active') return res.status(409).json({ success: false, error: 'branch_archived' });

      const password = newPassword();
      let created = null;
      let username = null;
      for (let attempt = 0; attempt < 4 && !created; attempt++) {
        username = usernameFor(branch.number, attempt);
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: `${username}@${BRANCH_EMAIL_DOMAIN}`, password, email_confirm: true,
          user_metadata: { branch_account: true },
        });
        if (!error) created = data.user;
        else if (!/already|registered|exists/i.test(error.message || '')) throw error;
      }
      if (!created) return res.status(500).json({ success: false, error: 'username_unavailable' });

      const { error: insertErr } = await supabaseAdmin.from('branch_members').insert({
        user_id: created.id, tenant_id: tenantId, branch_id: branch.id, username, active: true,
      });
      if (insertErr) {
        // Don't leave an orphaned login behind if the link row failed.
        try { await supabaseAdmin.auth.admin.deleteUser(created.id); } catch { /* best effort */ }
        throw insertErr;
      }
      return res.status(200).json({ success: true, username, password });
    }

    if (action === 'reset_password') {
      if (!member) return res.status(404).json({ success: false, error: 'account_not_found' });
      const password = newPassword();
      const { error } = await supabaseAdmin.auth.admin.updateUserById(member.user_id, { password });
      if (error) throw error;
      return res.status(200).json({ success: true, username: member.username, password });
    }

    // set_status: archive / restore the branch AND its login in one place
    // (a branch may not have a login yet, in which case only the branch changes).
    if (!['active', 'archived'].includes(status)) return res.status(400).json({ success: false, error: 'invalid_request' });
    const { error: updErr } = await supabaseAdmin.from('branches').update({ status }).eq('id', branch.id).eq('tenant_id', tenantId);
    if (updErr) {
      if (/main_branch_cannot_be_archived/.test(updErr.message || '')) return res.status(409).json({ success: false, error: 'main_branch' });
      throw updErr;
    }
    if (member) {
      // Banning stops new sign-ins right away; branch_members.active (kept in
      // step by a trigger) already makes an existing token see nothing.
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(member.user_id, { ban_duration: status === 'archived' ? BAN_FOREVER : 'none' });
      if (banErr) throw banErr;
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('branch-accounts error', e);
    Sentry.captureException(e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
}
