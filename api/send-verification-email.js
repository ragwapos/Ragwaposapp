import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

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
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { email, password, shopName } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: 'email and password are required' });

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

    // generateLink is what actually creates the Supabase Auth user (type:
    // 'signup' behaves like signUp() itself) — the caller never calls
    // auth.signUp() separately, so it needs this user object back to know
    // the new uid for its own registration_requests/tenants inserts.
    return res.status(200).json({ success: true, user: linkData.user });
  } catch (e) {
    console.error('send-verification-email error', e);
    return res.status(200).json({ success: false, error: e.message || String(e), code: e.code });
  }
}
