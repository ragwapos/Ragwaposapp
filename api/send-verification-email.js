import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { checkRateLimit, clientIp } from './_rateLimit.js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';

// Server-side only — SUPABASE_SERVICE_ROLE_KEY and RESEND_API_KEY must be
// set as private Vercel env vars (NOT prefixed with VITE_, or they'd get
// bundled into the public client JS). This function is the only place in
// the project allowed to hold either of them.
const supabaseAdmin = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

// A clickable "confirm" link is a single-use GET request — Gmail/Outlook/
// corporate mail gateways routinely pre-fetch every link in an incoming
// email to scan it for malware before the recipient ever opens the message,
// which silently consumes a one-time confirmation link exactly like a real
// click would. The customer then opens the email, clicks it themselves, and
// hits "invalid/expired link" even though their account was already
// confirmed by the scanner — this was the actual "verification doesn't
// work" symptom. A displayed one-time code that the user types into the app
// (verified via auth.verifyOtp() on an explicit button press) has no URL
// for anything to pre-fetch, so only a real user action can consume it.
// shopName comes straight from the public signup form (this endpoint needs
// no auth — anyone can call it) and gets interpolated into an HTML email
// body, not React JSX, so it gets none of JSX's automatic escaping. Without
// this, a shop name like `<img src=x onerror=...>` would inject live HTML
// into a real branded email sent from no-reply@ragwapos.com.
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emailHtml({ shopName, otp }) {
  const safeShopName = escHtml(shopName);
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:32px 0;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
      <div style="background:#0f172a; padding:28px; text-align:center;">
        <div style="font-size:22px; font-weight:700; color:#ffffff;">رغوة <span style="color:#5eead4;">Ragwa</span></div>
        <div style="font-size:12px; color:#94a3b8; margin-top:4px;">THE LEADING LAUNDRY ASSISTANT</div>
      </div>
      <div style="padding:32px; text-align:center; direction:rtl;">
        <h1 style="font-size:20px; color:#0f172a; margin:0 0 12px;">أهلًا ${safeShopName ? `— ${safeShopName}` : ''} 👋</h1>
        <p style="font-size:14px; color:#475569; line-height:1.7; margin:0 0 24px;">
          شكرًا لتسجيلك في رغوة. ارجع لصفحة التسجيل وحط رمز التحقق التالي لتفعيل حسابك.
        </p>
        <div style="display:inline-block; background:#f1f5f9; color:#0f172a; font-weight:700; font-size:28px; letter-spacing:6px; padding:16px 28px; border-radius:10px;">
          ${otp}
        </div>
        <p style="font-size:12px; color:#94a3b8; margin-top:24px;">
          إذا لم تطلب هذا الحساب، تجاهل هذه الرسالة.
        </p>
      </div>
    </div>
  </div>`;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { email, password, shopName, mobile, address, website, formStartedAt } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: 'email and password are required' });

  // Honeypot + minimum-fill-time — same anti-bot pattern as submit-contact.js.
  // Real Supabase Auth writes/Resend sends are too costly to skip these two
  // free, pre-rate-limit checks. A tripped check still returns a generic
  // 400 (not `success:true` like the contact form) — a genuine signup
  // attempt needs to actually know something went wrong and retry, unlike
  // an anonymous inquiry a bot has no reason to resubmit either way.
  if (website) return res.status(400).json({ success: false, error: 'invalid_request' });
  if (!formStartedAt || Date.now() - Number(formStartedAt) < 2000) {
    return res.status(400).json({ success: false, error: 'invalid_request' });
  }

  // Unauthenticated by design (this is what creates the account) — the two
  // buckets below cap both "one attacker, many target emails" (by IP) and
  // "one target email, many IPs" (by email itself), so neither alone is a
  // bypass. Each real call here does a real Supabase Auth write and a real
  // billed Resend send, so this also caps the Financial-DoS exposure.
  if (!(await checkRateLimit(res, 'send-verification-email:ip', clientIp(req), 8, '10 m'))) return;
  if (!(await checkRateLimit(res, 'send-verification-email:email', email.toLowerCase(), 3, '1 h'))) return;

  try {
    // generateLink is still what creates the Supabase Auth user (type:
    // 'signup' behaves like signUp() itself) — it just also happens to hand
    // back a plain one-time OTP code (properties.email_otp) alongside the
    // action_link, which is all this needs now that the email shows a code
    // instead of a clickable link.
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'signup', email, password,
    });
    if (linkErr) throw linkErr;
    const otp = linkData?.properties?.email_otp;
    if (!otp) throw new Error('No email_otp returned by Supabase');

    const { error: sendErr } = await resend.emails.send({
      from: 'Ragwa <no-reply@ragwapos.com>',
      to: email,
      subject: 'تأكيد بريدك الإلكتروني — رغوة',
      html: emailHtml({ shopName, otp }),
    });
    if (sendErr) throw sendErr;

    // registration_requests/tenants used to be inserted by the still-
    // anonymous client right after this call returned — that required an
    // anon-role INSERT policy on both tables with no ownership check at
    // all (no session exists yet client-side at that point), which meant
    // anyone with the public anon key could insert arbitrary rows into
    // either table directly, no signup required. Doing both inserts here
    // instead, with the service-role client, closes that off entirely —
    // see supabase-close-anon-signup-inserts.sql, which drops those two
    // policies now that nothing needs them.
    const uid = linkData.user.id;
    const { data: cfgRow, error: cfgErr } = await supabaseAdmin.from('platform_config').select('auto_approve').eq('id', true).maybeSingle();
    if (cfgErr) throw cfgErr;
    const approved = cfgRow?.auto_approve ?? true;

    const { error: reqErr } = await supabaseAdmin.from('registration_requests').insert({
      uid, shop_name: shopName || '—', mobile: mobile || '—', email, address: address || '—',
      date: new Date().toISOString(), status: approved ? 'approved' : 'pending', reject_reason: '',
    });
    if (reqErr) throw reqErr;

    if (approved) {
      const { error: tenantErr } = await supabaseAdmin.from('tenants').insert({
        id: uid, shop_name: shopName || '—', mobile: mobile || '—', email, address: address || '—',
        approved_date: new Date().toISOString(),
      });
      if (tenantErr) throw tenantErr;
    }

    return res.status(200).json({ success: true, user: linkData.user });
  } catch (e) {
    console.error('send-verification-email error', e);
    Sentry.captureException(e);
    return res.status(200).json({ success: false, error: e.message || String(e), code: e.code });
  }
}
