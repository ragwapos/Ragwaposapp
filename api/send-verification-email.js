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

function emailHtml({ shopName, actionLink }) {
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:32px 0;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
      <div style="background:#0f172a; padding:28px; text-align:center;">
        <div style="font-size:22px; font-weight:700; color:#ffffff;">رغوة <span style="color:#5eead4;">Ragwa</span></div>
        <div style="font-size:12px; color:#94a3b8; margin-top:4px;">THE LEADING LAUNDRY ASSISTANT</div>
      </div>
      <div style="padding:32px; text-align:center; direction:rtl;">
        <h1 style="font-size:20px; color:#0f172a; margin:0 0 12px;">أهلًا ${shopName ? `— ${shopName}` : ''} 👋</h1>
        <p style="font-size:14px; color:#475569; line-height:1.7; margin:0 0 24px;">
          شكرًا لتسجيلك في رغوة. اضغط الزر أدناه لتأكيد بريدك الإلكتروني وتفعيل حسابك.
        </p>
        <a href="${actionLink}" style="display:inline-block; background:#0d9488; color:#ffffff; text-decoration:none; font-weight:600; font-size:14px; padding:12px 32px; border-radius:10px;">
          تأكيد البريد الإلكتروني
        </a>
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
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'signup', email, password,
    });
    if (linkErr) throw linkErr;
    const actionLink = linkData?.properties?.action_link;
    if (!actionLink) throw new Error('No action_link returned by Supabase');

    const { error: sendErr } = await resend.emails.send({
      from: 'Ragwa <no-reply@ragwapos.com>',
      to: email,
      subject: 'تأكيد بريدك الإلكتروني — رغوة',
      html: emailHtml({ shopName, actionLink }),
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
