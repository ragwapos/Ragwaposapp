import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from './_supabaseConfig.js';
import { Resend } from 'resend';
import { checkRateLimit, clientIp } from './_rateLimit.js';
import { Sentry } from './_sentry.js';
import { applyCors } from './_cors.js';
import { verifyTurnstile } from './_turnstile.js';

// Password recovery by a typed one-time code (ForgotPasswordPage in App.jsx
// verifies it with auth.verifyOtp({type:'recovery'}) and then sets the new
// password) instead of Supabase's default emailed link. The link signed the
// user straight in and the app's normal routing took them to the dashboard
// before they could set a password; it is also a bare one-time GET that mail
// scanners pre-fetch and burn — the same reason signup uses a code (see
// send-verification-email.js). Server-side only: the service-role and Resend
// keys never reach the browser.
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const EMAIL_TEXT = {
  ar: {
    subject: 'رمز استرجاع كلمة المرور — رغوة', dir: 'rtl', title: 'استرجاع كلمة المرور',
    body: 'ارجع لصفحة استرجاع كلمة المرور وحط الرمز التالي مع كلمة المرور الجديدة.',
    ignore: 'إذا ما طلبت تغيير كلمة المرور، تجاهل هذه الرسالة — كلمة مرورك الحالية ما تغيرت.', codeLabel: 'رمز التحقق',
  },
  en: {
    subject: 'Your password reset code — Ragwa', dir: 'ltr', title: 'Reset your password',
    body: 'Go back to the password reset page and enter the code below with your new password.',
    ignore: "If you didn't ask to reset your password, ignore this email. Your current password hasn't changed.", codeLabel: 'Your code',
  },
};

// Every value interpolated here is fixed text or the numeric code Supabase
// generated, never anything the caller sent.
function emailHtml({ otp, txt }) {
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:32px 0;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
      <div style="background:#0f172a; padding:28px; text-align:center;">
        <div style="font-size:22px; font-weight:700; color:#ffffff;">رغوة <span style="color:#5eead4;">Ragwa</span></div>
        <div style="font-size:12px; color:#94a3b8; margin-top:4px;">THE LEADING LAUNDRY ASSISTANT</div>
      </div>
      <div style="padding:32px; text-align:center; direction:${txt.dir};">
        <h1 style="font-size:20px; color:#0f172a; margin:0 0 12px;">${txt.title} 🔑</h1>
        <p style="font-size:14px; color:#475569; line-height:1.7; margin:0 0 24px;">${txt.body}</p>
        <div style="font-size:13px; color:#64748b; margin:0 0 8px;">${txt.codeLabel}</div>
        <div style="display:inline-block; background:#f1f5f9; color:#0f172a; font-weight:700; font-size:28px; letter-spacing:6px; padding:16px 28px; border-radius:10px;">
          ${otp}
        </div>
        <p style="font-size:12px; color:#94a3b8; margin-top:24px;">${txt.ignore}</p>
      </div>
    </div>
  </div>`;
}

// Branch logins (no real inbox) and reserved/placeholder domains never get mail.
const NO_MAIL_DOMAINS = new Set(['branches.ragwapos.com', 'example.com', 'example.org', 'example.net', 'example.edu', 'test.com', 'localhost']);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { email: emailRaw, lang: langRaw, turnstileToken } = req.body || {};
  const txt = EMAIL_TEXT[langRaw === 'en' ? 'en' : 'ar'];
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ success: false, error: 'invalid_email' });
  }

  // Unauthenticated by design; each real call is a billed Resend send. By IP
  // caps one sender spraying many inboxes, by email caps many IPs flooding one.
  if (!(await checkRateLimit(res, 'send-reset-code:ip', clientIp(req), 5, '10 m'))) return;
  if (!(await checkRateLimit(res, 'send-reset-code:email', email, 3, '1 h'))) return;
  if (!(await verifyTurnstile(turnstileToken, clientIp(req)))) {
    return res.status(400).json({ success: false, error: 'invalid_request' });
  }

  // The response is the same whether or not the email has an account, so this
  // endpoint can't be used to find out who is a customer.
  if (NO_MAIL_DOMAINS.has(email.split('@')[1])) return res.status(200).json({ success: true });

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email });
    // No such user: answer exactly like a real send.
    if (error) {
      if (error.status === 404 || error.code === 'user_not_found') return res.status(200).json({ success: true });
      throw error;
    }
    const otp = data?.properties?.email_otp;
    if (!otp) throw new Error('No email_otp returned by Supabase');

    const { error: sendErr } = await resend.emails.send({
      from: 'Ragwa <no-reply@ragwapos.com>',
      to: email,
      subject: txt.subject,
      text: `${txt.codeLabel}: ${otp}

${txt.ignore}`,
      html: emailHtml({ otp, txt }),
    });
    if (sendErr) throw sendErr;
    return res.status(200).json({ success: true });
  } catch (e) {
    // Never log the code or the address.
    console.error('send-reset-code error', e?.code || e?.name || 'unknown');
    Sentry.captureException(e);
    return res.status(200).json({ success: false, error: 'invalid_request' });
  }
}
