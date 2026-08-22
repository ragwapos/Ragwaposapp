import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, clientIp } from './_rateLimit.js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';
import { verifyTurnstile } from './_turnstile.js';

// Server-side only, same pattern as send-verification-email.js. This used
// to be a direct client-side insert (db.from('sales_inquiries').insert()),
// which needed a wide-open anon INSERT policy (with_check: true) — anyone
// with the public anon key could flood the table directly, no rate limit,
// no bot check, completely bypassing this form. Moving it here closes
// that off (see supabase-close-anon-sales-inquiries.sql, which drops that
// policy now that nothing needs it) and adds real abuse protection.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { name, mobile, email, type, message, website, formStartedAt, turnstileToken } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'message is required' });

  // Honeypot: a real visitor never sees or fills this field (hidden via
  // CSS in the actual form) — a bot filling every field blind trips it.
  if (website) return res.status(200).json({ success: true }); // pretend success, don't tip the bot off

  // Minimum-fill-time: a bot that fetches the page and immediately POSTs
  // can't have spent any real time typing a message. 2s is generous for a
  // human, impossible for a script that doesn't bother waiting.
  const elapsed = Date.now() - Number(formStartedAt || 0);
  if (!formStartedAt || elapsed < 2000) return res.status(200).json({ success: true });

  if (!(await checkRateLimit(res, 'submit-contact:ip', clientIp(req), 5, '10 m'))) return;

  // Turnstile is advisory here, NOT a hard gate — unlike signup, a failed
  // Turnstile check on a real visitor (ad-blocker, uBlock/Brave shields,
  // corporate proxy blocking challenges.cloudflare.com, a slow/flaky
  // network) must not silently drop a real inquiry. It first shipped as a
  // hard gate returning the same fake success:true as the honeypot/timing
  // checks above — which is exactly right for an actual bot, but for a
  // legitimate visitor it meant "sent!" on screen while the message never
  // reached the database or the admin at all, with nothing in any log to
  // explain why. Honeypot + timing + the rate limit above already do the
  // real bot-filtering job here (verified live) — this just tags the row
  // for triage instead of throwing the message away.
  const turnstilePassed = await verifyTurnstile(turnstileToken, clientIp(req));

  try {
    const { error } = await supabaseAdmin.from('sales_inquiries').insert({
      name: (name || '—').trim().slice(0, 200),
      mobile: (mobile || '—').trim().slice(0, 50),
      email: (email || '—').trim().slice(0, 200),
      type: type || 'شراء نظام',
      message: message.trim().slice(0, 5000),
      date: new Date().toISOString(),
      status: 'new',
      note: turnstilePassed ? '' : 'turnstile_failed',
    });
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('submit-contact error', e);
    Sentry.captureException(e);
    return res.status(200).json({ success: false, error: 'submit_failed' });
  }
}
