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

  // Turnstile is the real bot barrier — honeypot/timing above only catch
  // unsophisticated scripts. Same "pretend success" response as the other
  // checks here, so a script that skips straight to POSTing this endpoint
  // (bypassing the widget entirely) can't tell which check it failed.
  if (!(await verifyTurnstile(turnstileToken, clientIp(req)))) {
    return res.status(200).json({ success: true });
  }

  try {
    const { error } = await supabaseAdmin.from('sales_inquiries').insert({
      name: (name || '—').trim().slice(0, 200),
      mobile: (mobile || '—').trim().slice(0, 50),
      email: (email || '—').trim().slice(0, 200),
      type: type || 'شراء نظام',
      message: message.trim().slice(0, 5000),
      date: new Date().toISOString(),
      status: 'new',
      note: '',
    });
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('submit-contact error', e);
    Sentry.captureException(e);
    return res.status(200).json({ success: false, error: 'submit_failed' });
  }
}
