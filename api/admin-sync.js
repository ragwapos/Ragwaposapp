import { createClient } from '@supabase/supabase-js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';

// platform_admins is what RLS's is_admin() actually checks (see is_admin()
// in Postgres: `select exists (select 1 from platform_admins where user_id =
// auth.uid())`) — it's the real privilege table, locked down with RLS
// enabled and zero policies, so no client session (not even an already-
// admin one) can write to it directly. platform_config.admin_emails is a
// separate, client-writable array used only for the UI allow-list (which
// email gets routed to the admin dashboard) and to bootstrap this table.
// Whenever those two fall out of sync — an email sits in admin_emails but
// has no matching row here — that admin can see the dashboard (client-side
// gate passes) but every actual write (maintenance toggle, sales-inquiry
// status, etc.) silently fails RLS, since is_admin() is false for them.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  const { action, targetEmail } = req.body || {};
  if (!['ensure', 'revoke'].includes(action)) return res.status(400).json({ success: false, error: 'invalid_action' });

  try {
    const { data: { user: caller }, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !caller) return res.status(401).json({ success: false, error: 'invalid_token' });

    if (action === 'ensure') {
      // Self-heal, called right after admin sign-in — mirrors the existing
      // ensurePlatformConfig() pattern. Only ever grants what admin_emails
      // (already RLS-gated to real admins for writes) already lists, so this
      // can't be used to escalate anyone beyond that.
      const { data: cfg, error: cfgErr } = await supabaseAdmin.from('platform_config').select('admin_emails').eq('id', true).maybeSingle();
      if (cfgErr) throw cfgErr;
      const allowed = (cfg?.admin_emails || []).includes((caller.email || '').toLowerCase());
      if (!allowed) return res.status(403).json({ success: false, error: 'not_an_admin' });
      const { error: insErr } = await supabaseAdmin.from('platform_admins').upsert({ user_id: caller.id }, { onConflict: 'user_id' });
      if (insErr) throw insErr;
      return res.status(200).json({ success: true });
    }

    // action === 'revoke': caller must already be a real admin (present in
    // platform_admins, not just admin_emails) before they can revoke anyone.
    const { data: callerRow } = await supabaseAdmin.from('platform_admins').select('user_id').eq('user_id', caller.id).maybeSingle();
    if (!callerRow) return res.status(403).json({ success: false, error: 'not_an_admin' });
    if (!targetEmail) return res.status(400).json({ success: false, error: 'targetEmail is required' });

    const { data: targetUsers, error: lookupErr } = await supabaseAdmin.schema('auth').from('users').select('id').eq('email', targetEmail.toLowerCase());
    if (lookupErr) throw lookupErr;
    if (targetUsers && targetUsers.length > 0) {
      const { error: delErr } = await supabaseAdmin.from('platform_admins').delete().in('user_id', targetUsers.map((u) => u.id));
      if (delErr) throw delErr;
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('admin-sync error', e);
    Sentry.captureException(e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
