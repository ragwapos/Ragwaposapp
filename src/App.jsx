import React, { useState, useRef, useEffect, lazy, Suspense } from "react";
import { Mail } from "lucide-react";
// auth/db here are supabase.auth / the Supabase client (see src/supabase.js).
// Every database call below is a METHOD chain on db — db.from('table').select()
// / .upsert() / .delete() / .channel() — not a standalone function imported
// from a package the way Firebase's collection()/doc()/setDoc() worked.
import { auth, db } from "./supabase";
import { toCamelCase } from "./utils/transforms.js";
import { normalizeSaudiMobile, isValidSaudiMobile } from "./utils/phone.js";
import { useClarityTracking } from "./utils/clarity.js";
import { getTurnstileToken, preloadTurnstile } from "./utils/turnstile.js";
import LandingPage from "./landing/LandingPage.jsx";
import { subscribeToTable, subscribeToRow } from "./utils/dbSubscribe.js";
import { ALL_DASHBOARD_PATHS } from "./utils/dashboardPaths.js";

// The tenant dashboard and admin console are each the vast majority of this
// app's former single-file bundle (POS/invoices/customers/reports/... and
// the whole admin panel, respectively) — neither is needed by a visitor who
// never logs in (landing page, /signup, /terms, /login...). Splitting them
// into their own lazy-loaded chunks keeps those public routes from ever
// downloading dashboard/admin code. See PROJECT_REFERENCE.md.
const loadTenantApp = () => import('./dashboard/TenantApp.jsx');
const LaundryOpsApp = lazy(loadTenantApp);
const AdminDashboard = lazy(() => import('./dashboard/AdminApp.jsx'));
// Minimal, dependency-free fallback shown only for the (usually brief) time
// it takes to fetch the lazy chunk after a successful login — deliberately
// unstyled by Tailwind/Cairo so it renders instantly regardless of what else
// has loaded yet, same spirit as main.jsx's ErrorFallback.
function DashboardLoading() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.2)', borderTopColor: '#17a5a0', animation: 'spin 0.8s linear infinite' }} />
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

/* =========================================================================
   CONSTANTS
   ========================================================================= */
const ADMIN_EMAILS_DEFAULT = ["ragwapos@gmail.com"];

// Supabase Auth error codes → Arabic messages shown in the login/signup forms.
// Unlike Firebase, Supabase never distinguishes "wrong password" from "no such
// account" on sign-in (both come back as invalid_credentials, by design, for
// enumeration protection) — so there is no separate "user not found" case here.
const authErrorMessage = (error) => {
  const code = error && error.code;
  switch (code) {
    // Confirmed live: Supabase's admin.generateLink({type:'signup'}) actually
    // returns code "email_exists" for a duplicate email (verified via a real
    // request against the production API) — "user_already_exists" was never
    // the real value, so this branch was silently dead and every duplicate-
    // signup attempt fell through to the raw English Supabase message below.
    case "email_exists":
    case "user_already_exists": return "هذا البريد مسجل مسبقًا — سجل دخول بدل إنشاء حساب جديد.";
    case "email_address_invalid": return "بريد إلكتروني غير صحيح.";
    case "weak_password": return "كلمة المرور ضعيفة — لازم 6 أحرف على الأقل.";
    case "invalid_credentials": return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit": return "محاولات كثيرة فاشلة — انتظر شوي وحاول مرة ثانية.";
    // Not a Supabase auth code — these are api/send-verification-email.js's
    // own error strings (no `code` field on that response), so `error.message`
    // below would otherwise leak the raw machine string to the user.
    case undefined:
      if (error && error.message === "invalid_email") return "بريد إلكتروني غير صحيح.";
      if (error && error.message === "invalid_request") return "تعذر إتمام الطلب — حاول مرة ثانية.";
      return (error && typeof error.message === "string" && error.message) || "صار خطأ غير متوقع — حاول مرة ثانية.";
    // No matching Supabase auth code — this is most likely an error relayed
    // as-is from /api/send-verification-email (Resend/service-role failures
    // have their own message text, not a Supabase auth code), so show it
    // instead of masking it behind the generic fallback below.
    default: return (error && typeof error.message === "string" && error.message) || "صار خطأ غير متوقع — حاول مرة ثانية.";
  }
};




  function LoginPage(props) {
  const { navigate, showPassword, setShowPassword, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, handleLogin, loginError, loginLoading } = props;
  // Start downloading the dashboard chunk while the owner is still typing, so
  // it's ready the moment sign-in succeeds instead of being fetched after.
  useEffect(() => { loadTenantApp().catch(() => {}); }, []);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="absolute top-6 right-6">
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('landing', '/'); }} className="px-4 py-2 text-gray-300 hover:text-white transition">
          ← العودة
        </a>
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
          <p className="text-gray-400 text-sm">نظام إدارة مغاسل الملابس</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">دخول</h2>
          <p className="text-gray-400 text-center text-sm mb-8">الدخول إلى لوحة التحكم</p>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
            <input type="text" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg pr-4 pl-12 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
              <button onClick={() => setShowPassword(!showPassword)} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-lg">
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="text-left mb-4 -mt-2">
            <a href="/forgot-password" onClick={(e) => { e.preventDefault(); navigate('forgotPassword', '/forgot-password'); }} className="text-cyan-400 hover:text-cyan-300 text-xs">نسيت كلمة المرور؟</a>
          </div>

          {loginError && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{loginError}</div>}

          <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
            {loginLoading ? 'جارٍ الدخول...' : 'دخول'}
          </button>

          <p className="text-center text-gray-400 text-sm">
            ليس لديك حساب؟ <a href="/signup" onClick={(e) => { e.preventDefault(); navigate('signup', '/signup'); }} className="text-cyan-400 hover:text-cyan-300">إنشاء حساب</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// Sends the recovery email (Supabase's own default link-based flow —
// clicking it redirects back here with a session already exchanged, which
// onAuthStateChange picks up as a PASSWORD_RECOVERY event and routes to
// ResetPasswordPage). Self-contained: reads/writes nothing from LaundryPOS's
// own state, just `auth` directly, same as LandingPage/LoginPage.
function ForgotPasswordPage({ navigate }) {
  const goLogin = (e) => { e.preventDefault(); navigate('login', '/login'); };
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm) { setError('حط بريدك الإلكتروني.'); return; }
    setLoading(true); setError('');
    const { error: err } = await auth.resetPasswordForEmail(emailNorm, { redirectTo: window.location.origin });
    if (err) setError(authErrorMessage(err));
    else setSent(true);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
        </div>
        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">استرجاع كلمة المرور</h2>
          {sent ? (
            <>
              <p className="text-gray-400 text-center text-sm mb-8">تم إرسال رابط استرجاع كلمة المرور لبريدك — افتحه من نفس الجهاز اللي بتحط فيه كلمة المرور الجديدة.</p>
              <a href="/login" onClick={goLogin} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-3 rounded-lg transition inline-block text-center">رجوع لتسجيل الدخول</a>
            </>
          ) : (
            <>
              <p className="text-gray-400 text-center text-sm mb-8">حط بريدك الإلكتروني وبنرسل لك رابط لتعيين كلمة مرور جديدة.</p>
              <div className="mb-6">
                <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
                <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
              </div>
              {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
              <button onClick={submit} disabled={loading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
                {loading ? 'جارٍ الإرسال...' : 'إرسال رابط الاسترجاع'}
              </button>
              <p className="text-center text-gray-400 text-sm">
                <a href="/login" onClick={goLogin} className="text-cyan-400 hover:text-cyan-300">رجوع لتسجيل الدخول</a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Shown for any URL not in PATH_PAGE_MAP — middleware.js (repo root) already
// answers these with a real HTTP 404 status; this is what actually renders
// once that shell loads client-side.
function NotFoundPage({ navigate }) {
  const goHome = (e) => { e.preventDefault(); navigate('landing', '/'); };
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <img src="/logo.png" alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h1 className="text-5xl font-bold text-white mb-3">404</h1>
          <p className="text-gray-400 text-sm mb-8">هذي الصفحة غير موجودة — يمكن الرابط قديم أو فيه خطأ إملائي.</p>
          <a href="/" onClick={goHome} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-3 rounded-lg transition inline-block text-center">
            رجوع للصفحة الرئيسية
          </a>
        </div>
      </div>
    </div>
  );
}

// Reached only via the PASSWORD_RECOVERY auth event (see the
// onAuthStateChange listener in LaundryPOS) — a real recovery session
// already exists at this point, so auth.updateUser() is all that's needed.
function ResetPasswordPage({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!password || password.length < 6) { setError('كلمة المرور لازم تكون 6 أحرف على الأقل.'); return; }
    if (password !== confirm) { setError('كلمتا المرور غير متطابقتين.'); return; }
    setLoading(true); setError('');
    const { error: err } = await auth.updateUser({ password });
    if (err) { setError(authErrorMessage(err)); setLoading(false); return; }
    setLoading(false);
    onDone();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
        </div>
        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">تعيين كلمة مرور جديدة</h2>
          <p className="text-gray-400 text-center text-sm mb-8">حط كلمة المرور الجديدة اللي بتستخدمها من الحين.</p>
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور الجديدة</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">تأكيد كلمة المرور</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>
          {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
          <button onClick={submit} disabled={loading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition">
            {loading ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Platform-wide incident/maintenance notice — shown above everything else
// (public pages and the app alike) whenever an admin turns it on. Plain
// dismiss (not tied to platform_config), so it comes back on reload/next
// visit for as long as the admin leaves it active, but doesn't nag someone
// who's already seen it and kept working this session.
function MaintenanceBanner({ active, message }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (active) setDismissed(false); }, [active, message]);
  if (!active || dismissed) return null;
  return (
    <div dir="rtl" className="sticky top-0 z-[100] flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span>⚠️ {message || 'النظام حاليًا بصيانة مجدولة — بعض الميزات قد لا تعمل مؤقتًا.'}</span>
      <button onClick={() => setDismissed(true)} className="shrink-0 text-amber-950/70 hover:text-amber-950">✕</button>
    </div>
  );
}

function EmailVerificationPage({ email, onVerified, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resent, setResent] = useState(false);

  const handleResend = async () => {
    setResendLoading(true); setError(''); setResent(false);
    // Supabase has no "currentUser.sendEmailVerification()" — resending a
    // signup confirmation email is its own top-level call, keyed by email.
    const { error: err } = await auth.resend({ type: 'signup', email });
    if (err) setError(authErrorMessage(err));
    else setResent(true);
    setResendLoading(false);
  };

  // Deliberately a typed one-time code instead of "click the link, then
  // come back and press a button": a plain confirmation link is a bare GET
  // request, and mail providers (Gmail, Outlook, corporate gateways)
  // routinely pre-fetch every link in an incoming email to scan it for
  // malware before the recipient ever opens it — which silently consumes a
  // one-time confirmation link exactly like a real click. The customer then
  // opens the email, clicks it themselves, and hits "invalid/expired link"
  // even though the account was already confirmed by the scanner. A code
  // the user has to actually read and type has no URL for anything to
  // pre-fetch, so only this explicit submit can consume it.
  const handleConfirm = async () => {
    setVerifying(true); setError('');
    const { error: err } = await auth.verifyOtp({ email, token: code.trim(), type: 'signup' });
    if (err) setError(authErrorMessage(err));
    else await onVerified();
    setVerifying(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">تأكيد البريد الإلكتروني</h1>
          <p className="text-gray-400 text-sm">خطوة أخيرة قبل الدخول للوحة التحكم</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-cyan-500/10 flex items-center justify-center shrink-0">
              <Mail className="text-cyan-400" size={20} />
            </div>
            <p className="text-gray-300 text-sm">
              أرسلنا رمز تحقق إلى
              <br />
              <span className="text-cyan-400 font-semibold" dir="ltr">{email}</span>
              <br />
              افتح بريدك، وحط الرمز اللي وصلك بالمربع تحت.
            </p>
          </div>

          <input
            type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
            // Supabase's generateLink() email_otp for the "signup" type is 8
            // digits, not the more common 6 — a 6-char maxLength here would
            // have silently truncated every real code before it ever reached
            // verifyOtp(), making confirmation fail for every real user.
            placeholder="00000000" maxLength={8} dir="ltr"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white text-center text-2xl tracking-[0.35em] placeholder-gray-600 focus:border-cyan-400 outline-none transition mb-4"
          />

          {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
          {resent && <div className="mb-4 rounded-lg bg-green-500/10 border border-green-500/30 px-4 py-2.5 text-sm text-green-400">تم إرسال رمز جديد.</div>}

          <button onClick={handleConfirm} disabled={verifying || !code.trim()} className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-3">
            {verifying ? 'جارٍ التحقق...' : 'تأكيد'}
          </button>
          <button onClick={handleResend} disabled={resendLoading} className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-3">
            {resendLoading ? 'جارٍ الإرسال...' : 'إعادة إرسال الرمز'}
          </button>
          <button onClick={onBack} className="w-full text-gray-400 hover:text-gray-300 text-sm py-2 transition">
            رجوع
          </button>
        </div>
      </div>
    </div>
  );
}

function SignupPage(props) {
  const { navigate, signupShop, setSignupShop, signupEmail, setSignupEmail,
    signupMobile, setSignupMobile, signupAddress, setSignupAddress, signupPassword, setSignupPassword,
    signupAgree, setSignupAgree, handleSignup, signupError, signupLoading, onOpenTerms } = props;
  // Same honeypot + minimum-fill-time anti-bot pattern as the landing
  // page's contact form (see LandingPage) — checked server-side in
  // api/send-verification-email.js.
  const [signupWebsite, setSignupWebsite] = useState('');
  const formStartedAtRef = useRef(Date.now());
  useEffect(() => { preloadTurnstile(); }, []);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="absolute top-6 right-6">
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('landing', '/'); }} className="px-4 py-2 text-gray-300 hover:text-white transition">
          ← العودة
        </a>
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">إنشاء حساب</h1>
          <p className="text-gray-400 text-sm">ابدأ مع رغوة الآن</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">اسم المحل</label>
            <input type="text" value={signupShop} onChange={(e) => setSignupShop(e.target.value)} placeholder="اسم مغسلتك" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">العنوان</label>
            <input type="text" value={signupAddress} onChange={(e) => setSignupAddress(e.target.value)} placeholder="المدينة، الحي" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
            <input type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">رقم الجوال</label>
            <input type="tel" inputMode="numeric" value={signupMobile} onChange={(e) => setSignupMobile(normalizeSaudiMobile(e.target.value))} placeholder="05XXXXXXXX" maxLength={12} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="ltr" />
            <p className="text-gray-500 text-xs mt-1.5">يبدأ تلقائيًا بـ 966 — اكتب رقمك كالمعتاد (05... أو 5...)</p>
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور</label>
            <input type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>

          <div className="flex items-start gap-3 mb-6">
            <input type="checkbox" checked={signupAgree} onChange={(e) => setSignupAgree(e.target.checked)} className="w-4 h-4 rounded accent-cyan-400 mt-1" />
            <label className="text-gray-400 text-sm">
              أوافق على <button type="button" onClick={() => onOpenTerms()} className="text-cyan-400 hover:underline">شروط الخدمة</button>
            </label>
          </div>

          {signupError && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{signupError}</div>}

          <input
            type="text" value={signupWebsite} onChange={(e) => setSignupWebsite(e.target.value)}
            autoComplete="off" tabIndex={-1} aria-hidden="true"
            style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0, opacity: 0 }}
          />
          <button onClick={() => handleSignup({ website: signupWebsite, formStartedAt: formStartedAtRef.current })} disabled={signupLoading || !signupAgree} className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
            {signupLoading ? 'جارٍ الإنشاء...' : 'إنشاء الحساب'}
          </button>

          <p className="text-center text-gray-400 text-sm">
            لديك حساب؟ <a href="/login" onClick={(e) => { e.preventDefault(); navigate('login', '/login'); }} className="text-cyan-400 hover:text-cyan-300">دخول</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// Blocks copy/select on the terms text itself (still fully legible — this
// is friction against casual copy-paste, not an attempt to hide anything;
// trivially bypassed via view-source/print/screenshot, which is fine, this
// isn't meant to be real DRM). Deliberately NOT pairing this with a tiny or
// low-contrast font: a Terms of Service only has legal weight if the user
// could actually read what they agreed to — a court or consumer-protection
// body could treat an intentionally illegible contract as never properly
// disclosed, which undermines the entire point of having one.
function TermsPage({ onBack, scrollTarget }) {
  const blockCopy = (e) => e.preventDefault();
  useEffect(() => {
    if (!scrollTarget) return;
    document.getElementById(scrollTarget)?.scrollIntoView({ block: 'start' });
  }, [scrollTarget]);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-start justify-center p-4 py-10">
      <div className="fixed top-6 right-6 z-10">
        <button onClick={onBack} className="px-4 py-2 rounded-lg bg-slate-900/80 backdrop-blur border border-slate-700 text-gray-300 hover:text-white transition shadow-lg">← العودة</button>
      </div>
      <div className="w-full max-w-3xl mt-16">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">شروط وأحكام استخدام نظام رغوة (Ragwa)</h1>
          <p className="text-gray-400 text-sm">اتفاقية استخدام ملزمة قانونياً</p>
        </div>

        <div
          className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8 text-gray-300 text-base leading-relaxed space-y-6 select-none"
          onCopy={blockCopy} onCut={blockCopy} onContextMenu={blockCopy}
          dir="rtl"
        >
          <section>
            <h2 className="text-xl font-bold text-white mb-2">المقدمة</h2>
            <p>هذه الاتفاقية تحكم استخدامك لمنصة رغوة وخدماتها. بالاشتراك في المنصة أو استخدامك لها، فإنك تقر بأنك قد قرأت واستوعبت جميع الشروط والأحكام الواردة فيها وتوافق على الالتزام بها بشكل كامل. هدفنا هو توفير خدمة موثوقة وشفافة تلبي احتياجاتك.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الأول: التعاريف</h2>
            <p><strong className="text-white">النظام/المنصة:</strong> منصة رغوة الإلكترونية وجميع خدماتها وتطبيقاتها بمختلف صيغها (ويب، تطبيقات محمولة، إلخ).</p>
            <p><strong className="text-white">الشركة:</strong> الجهة المسؤولة عن تطوير وتشغيل النظام وإدارة خدماته بكفاءة واحترافية.</p>
            <p><strong className="text-white">المستخدم/العميل:</strong> أي شخص يقوم بإنشاء حساب واستخدام خدمات النظام.</p>
            <p><strong className="text-white">الخدمة:</strong> جميع الأدوات والميزات والخدمات التي توفرها المنصة للعميل لإدارة عملياته بفعالية.</p>
            <p><strong className="text-white">بيانات المستخدم:</strong> المعلومات التي يدخلها المستخدم في النظام (اسم، رقم، بيانات نشاط، إلخ).</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثاني: قبول الشروط والتزام المستخدم</h2>
            <p>استخدامك للنظام يعني قبولك الكامل لجميع شروط هذه الاتفاقية. إذا كنت لا توافق على أي بند، يجب عليك عدم استخدام المنصة. تحتفظ الشركة بحق تحديث هذه الشروط لتحسين الخدمة، وسيتم إخطارك بالتغييرات المهمة. استمرارك في استخدام المنصة يعني موافقتك على التحديثات.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثالث: استخدام المنصة بشكل مسؤول</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">3.1 الالتزامات القانونية والأخلاقية</h3>
            <p>نطلب منك استخدام المنصة بشكل مسؤول وقانوني وبما يتوافق مع جميع القوانين والأنظمة المعمول بها في المملكة العربية السعودية. نتعاون معك لبناء بيئة آمنة وموثوقة. تتعهد بعدم استخدام المنصة في:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>أي نشاط غير قانوني أو يخالف القوانين المعمول بها</li>
              <li>تمويل الإرهاب أو غسيل الأموال أو الأنشطة الإجرامية</li>
              <li>الاحتيال أو التدليس أو التلاعب أو الخداع</li>
              <li>انتهاك حقوق الآخرين أو الإساءة إليهم</li>
              <li>نشر محتوى يحرض على العنف أو الكراهية</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">3.2 الأمان والحماية</h3>
            <p>نعتمد عليك في حماية حسابك. تتعهد بحماية بيانات اعتمادك (اسم المستخدم وكلمة المرور) والحفاظ على سريتها. أنت الوحيد المسؤول عن جميع الأنشطة التي تتم من خلال حسابك. لا تحاول الوصول بطرق غير مصرح بها إلى النظام أو حسابات المستخدمين الآخرين.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">3.3 المسؤولية عن الانتهاكات</h3>
            <p>في حالة انتهاكك لهذه الشروط، أنت تتحمل المسؤولية الكاملة عن ذلك، وتوافق على تعويض الشركة عن أي خسائر أو أضرار قد تنشأ عن انتهاكك.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الرابع: وصف الخدمة</h2>
            <p>منصة رغوة مصممة بعناية لإدارة عمليات محلات مغاسل الملابس بكفاءة، وتوفر:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>إدارة البيانات والسجلات بسهولة وأمان</li>
              <li>توليد التقارير والإحصائيات الشاملة</li>
              <li>تحليل بيانات الاستخدام لاتخاذ قرارات أفضل</li>
            </ul>
            <p>تقتصر الخدمة على مستخدم واحد لكل حساب لضمان الأمان والسيطرة. تحتفظ الشركة بحقها في تطوير وتحسين وإضافة ميزات جديدة للمنصة في أي وقت لتطورها باستمرار وتلبية احتياجاتك المتغيرة.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الخامس: حالة المنصة وتطورها</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">5.1 مرحلة تطويرية مثيرة</h3>
            <p>منصة رغوة في مرحلة تطوير ديناميكية وحية. نحن نركز على جودة الخدمة والأداء الفعلي قبل التسجيل الرسمي، وهذا يعني:</p>
            <ul className="space-y-1">
              <li>✓ كل تحديث واختبار من أجلك ومن أجل تحسين تجربتك</li>
              <li>✓ استقرار النظام والبيانات الآمنة هي أولويتنا</li>
              <li>✓ نحن نستمع إلى ملاحظاتك وندمجها بسرعة</li>
            </ul>
            <p>المنصة حالياً لم تتلقَّ التسجيل الرسمي من هيئة الزكاة والضريبة والدخل، وهذا طبيعي وشائع في مرحلة التطوير. سيتم الانتقال للتسجيل الرسمي عندما تكون المنصة جاهزة تماماً.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">5.2 فرصة حقيقية للمستخدمين الأوائل</h3>
            <p>كنت من أوائل من يستخدم المنصة، وهذا يعني:</p>
            <ul className="space-y-1">
              <li>✓ الخدمة مجانية تماماً خلال هذه المرحلة</li>
              <li>✓ تأثيرك المباشر على تطوير الميزات القادمة</li>
              <li>✓ دعم شخصي من فريقنا</li>
              <li>✓ تحسين مستمر بناءً على احتياجاتك</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">5.3 التزامنا بالجودة والاستقرار</h3>
            <p>نحن ملتزمون بتقديم خدمة موثوقة وآمنة. يتم توفير الخدمة بأفضل جودة ممكنة مع التزامنا بـ:</p>
            <ul className="space-y-1">
              <li>✓ استقرار النظام والأداء الجيد</li>
              <li>✓ حماية بياناتك بأعلى معايير الأمان</li>
              <li>✓ تحسين مستمر بناءً على ملاحظات المستخدمين</li>
            </ul>
            <p className="italic text-gray-400">ملاحظة مهمة: كما هو الحال مع أي نظام تقني، قد تحدث توقفات غير متوقعة للصيانة أو التحديث (نادرة جداً). سنحاول إخطارك مسبقاً عند الإمكان، لأننا نقدّر وقتك.</p>
          </section>

          <section id="privacy">
            <h2 className="text-xl font-bold text-white mb-2">البند السادس: بيانات المستخدم والخصوصية</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">6.1 جمع البيانات بهدف التحسين</h3>
            <p>نجمع البيانات عن استخدامك للمنصة فقط لـ تحسين الخدمة وجعلها أفضل لك. البيانات التي نجمعها:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>سلوك الاستخدام (الميزات التي تستخدمها أكثر)</li>
              <li>البيانات التقنية (لضمان الأداء الأفضل)</li>
              <li>معلومات الجهاز والمتصفح (للتوافقية)</li>
            </ul>
            <p>كل هذا يساعدنا على:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>فهم احتياجاتك بشكل أفضل</li>
              <li>تحسين السرعة والاستقرار</li>
              <li>إضافة ميزات تناسبك</li>
              <li>منع المشاكل الأمنية</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.2 خوادم آمنة وموثوقة</h3>
            <p>بيانات حسابك تُخزّن على خوادم موجودة في الدمام وقد تكون في مواقع أخرى استراتيجية لضمان أسرع وصول وأعلى أمان. إذا كان لديك مخاوف جدية بخصوص الخوادم، يرجى عدم استخدام المنصة.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.3 نستخدم معلوماتك للتواصل المهم</h3>
            <p>عند تسجيلك أو تواصلك معنا، تسمح لنا بـ:</p>
            <ul className="space-y-1">
              <li>✓ إرسال تحديثات مهمة عن النظام (صيانة، ميزات جديدة)</li>
              <li>✓ الرد على استفساراتك وحل مشاكلك</li>
              <li>✓ مشاركة نصائح وأفضل الممارسات</li>
              <li>✓ إخبارك عن التطويرات الجديدة</li>
            </ul>
            <p>نحترم بريدك ولن نرسل لك رسائل عشوائية.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.4 بيانات آمنة وسرية</h3>
            <p>لن نشارك بيانات حسابك الشخصية مع أحد، إلا في الحالات الضرورية جداً:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>شركاء تقنيين نحتاجهم لتقديم الخدمة</li>
              <li>إذا أجبرتنا القوانين على ذلك</li>
              <li>في حالات شراكة استراتيجية في المستقبل (سنخبرك مسبقاً)</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.5 الإحصائيات المجمعة (بدون اسمك)</h3>
            <p>قد نستخدم إحصائيات عامة من كل المستخدمين (بدون ذكر اسمك) لـ:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>فهم الأنماط الكلية للاستخدام</li>
              <li>تحسين الخدمة العام</li>
              <li>البحث والتطوير</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.6 بيانات آمنة للأبد</h3>
            <p>معلومات حسابك الأساسية (اسمك ورقمك) ستبقى محفوظة آمنة لدينا بشكل دائم. هذا يضمن أمانك ويساعدنا في الاحتفاظ بسجلات موثوقة.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.7 الحماية من البوتات (Cloudflare Turnstile)</h3>
            <p>تستخدم منصة رغوة خدمة Cloudflare Turnstile للتحقق من أن الزوار أشخاص حقيقيون وحماية النظام من محاولات التسجيل الوهمية والاختراق، دون إزعاجك بأي اختبار مرئي في الغالب. باستخدامك للمنصة، فإنك تقر باطلاعك على سياسة خصوصية وشروط استخدام Cloudflare الخاصة بهذه الخدمة.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.8 مراقبة الأخطاء التقنية (Sentry)</h3>
            <p>تستخدم منصة رغوة خدمة Sentry لرصد الأخطاء التقنية غير المتوقعة وتشخيصها بهدف إصلاحها بسرعة والحفاظ على استقرار النظام. قد تصل هذه الخدمة إلى بيانات تقنية محدودة عند حدوث خطأ (مثل نوع الخطأ ومساره داخل الكود)، وليست مخصصة لجمع بيانات شخصية أو تسويقية.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند السابع: التطوير والتحديثات المستمرة</h2>
            <p>هدفنا تحسين المنصة باستمرار. نحتفظ بحقنا في:</p>
            <ul className="space-y-1">
              <li>✓ إضافة ميزات جديدة ومفيدة</li>
              <li>✓ تحسين الواجهة والأداء</li>
              <li>✓ تحديثات أمان ضرورية</li>
              <li>✓ تعديل أو حذف ميزات قديمة لم تعد مفيدة</li>
            </ul>
            <p>التزامنا بالاختبار: قبل أي تحديث رئيسي، نختبره بعناية. هذا يعني أن التحديثات تأتي محسّنة وآمنة. قد تحدث توقفات قصيرة جداً للصيانة (نادراً)، وسنحاول إخبارك بها.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثامن: الخدمة بكل شفافية</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">8.1 ما نقدمه بصراحة</h3>
            <p>نحن صرحاء معك: المنصة في مرحلة تطوير، لذلك:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>نوفرها كما هي الآن (مع التحسينات المستمرة)</li>
              <li>نعمل بجد لضمان الاستقرار والأمان</li>
              <li>لا نستطيع ضمان خلو النظام من أي مشكلة تقنية صغيرة</li>
              <li>قد تحتاج إلى النسخ الاحتياطية للبيانات الحساسة</li>
            </ul>
            <p>هذا طبيعي وشفاف.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">8.2 نحن لا نتحمل مسؤوليات غير معقولة</h3>
            <p>في حالة حدوث مشكلة تقنية:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>مسؤولية الشركة محدودة ومعقولة</li>
              <li>نحن لا نستطيع تعويض خسائر كبيرة جداً (هذا معيار في جميع الخدمات)</li>
              <li>لكننا ملتزمون بإصلاح أي مشكلة بسرعة</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">8.3 أنت مسؤول أيضاً عن أمان حسابك</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>احفظ نسخة احتياطية من البيانات المهمة</li>
              <li>استخدم كلمة مرور قوية</li>
              <li>لا تشارك بيانات حسابك مع أحد</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند التاسع: إذا توقفت عن الخدمة</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">9.1 حقك في الإيقاف وحقنا أيضاً</h3>
            <p>أنت حر في إيقاف استخدام المنصة في أي وقت. نحن أيضاً قد نضطر لإيقاف خدمتك إذا:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>انتهكت شروط الاستخدام</li>
              <li>استخدمت النظام بطرق تضره</li>
              <li>قررنا إيقاف الخدمة (سنحاول إخبارك)</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">9.2 بيانات آمنة حتى بعد الانتهاء</h3>
            <p>عند الإيقاف، قد لا تتمكن من الوصول لحسابك مباشرة. لذلك من الضروري حفظ نسختك الاحتياطية من أي بيانات مهمة قبل الانتهاء.</p>
            <p>احنا نحتفظ بالبيانات بأمان وفقاً للقانون (للسجلات والأرشفة).</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند العاشر: إذا غيّرنا الشروط</h2>
            <p>قد نحتاج لتحديث هذه الشروط لتحسين الخدمة. عندما نفعل:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>سنخبرك بالتغييرات المهمة عبر البريد</li>
              <li>استمرارك في الاستخدام يعني موافقتك</li>
              <li>إذا لم توافق على التغييرات، عليك التوقف عن الاستخدام</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الحادي عشر: القانون والمحاكم</h2>
            <p>هذه الاتفاقية تحكمها قوانين المملكة العربية السعودية. أي نزاع سيُحل من خلال المحاكم السعودية.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثاني عشر: نحن هنا لك</h2>
            <p>للتواصل معنا بسهولة:</p>
            <ul className="space-y-1">
              <li>📧 البريد الإلكتروني: support@ragwapos.com</li>
              <li>💬 من خلال المنصة: قسم "الاتصال بنا"</li>
            </ul>
            <p>نحن نقدّر تعليقاتك وشكاواك - هذا يساعدنا على التحسين!</p>
            <p className="italic text-gray-400">ملاحظة: قد نسجل اتصالاتك لتحسين خدمتنا والتدريب. بك توافقك على هذا.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثالث عشر: معلومات إضافية</h2>
            <ul className="list-disc pr-6 space-y-1">
              <li>إذا وجدنا بند من بنود الشروط غير صحيح، ستبقى البنود الأخرى سارية</li>
              <li>عدم تطبيقنا لبند معين لا يعني تنازلنا عنه</li>
              <li>نحن غير مسؤولين عن روابط خارجية قد توجد في المنصة</li>
            </ul>
          </section>

          <p className="text-center text-white font-semibold pt-4">شكراً لاستخدامك منصة رغوة! 🙏</p>
          <p className="text-center text-gray-500 text-xs">آخر تحديث: 25/08/2026</p>
        </div>
      </div>
    </div>
  );
}

// Public, crawlable paths → internal page state, for the unauthenticated
// marketing/auth flow (admin/pending still have no dedicated URL — they're
// not tenant-facing screens worth a real address).
const PATH_PAGE_MAP = {
  '/': 'landing', '/en': 'landing',
  '/login': 'login', '/signup': 'signup',
  '/forgot-password': 'forgotPassword',
  '/terms': 'terms', '/privacy': 'terms',
};
// pathForTab/tabForPath/DASHBOARD_TAB_PATHS/etc. now live in
// ./utils/dashboardPaths.js (imported above) — LaundryOpsApp in
// ../dashboard/TenantApp.jsx needs the exact same lookup for its own tab
// navigation, so this is a shared module rather than two copies.
// Anything not in PATH_PAGE_MAP/ALL_DASHBOARD_PATHS is a genuinely unknown
// URL — middleware.js (repo root) already answers these with a real HTTP
// 404 status; this just makes sure the client-rendered UI matches that,
// instead of silently showing the landing page for a broken/typo'd link.
const pageForPath = (path) => PATH_PAGE_MAP[path] || (ALL_DASHBOARD_PATHS.includes(path) ? 'dashboard' : 'notFound');
const PAGE_TO_PATH = {
  landing: '/', login: '/login', signup: '/signup', forgotPassword: '/forgot-password',
};

const SITE_ORIGIN = 'https://www.ragwapos.com';
// Per-page <title>/description/canonical/robots, keyed the same way
// PATH_PAGE_MAP resolves a pathname to a page — used to keep the document
// head in sync with whatever `currentPage` is actually showing, since this
// is a pure client-rendered SPA with one static index.html for every route.
// /login and /forgot-password are noindex: real utility pages with no
// unique search intent behind them (nobody searches "ragwa login"), so
// indexing them just dilutes crawl budget / looks like thin content.
function getPageMeta(page, termsScrollTarget, siteLang) {
  if (page === 'landing' && siteLang === 'en') {
    return { title: 'Ragwa | Laundry Shop POS System', description: 'Ragwa keeps your laundry shop organized from intake to delivery. A fast checkout, per-item tracking, e-invoices, and drivers you can always see — all in one cloud system built for Saudi laundry shops.', path: '/en', robots: null };
  }
  if (page === 'terms' && termsScrollTarget === 'privacy') {
    return { title: 'سياسة الخصوصية | رغوة', description: 'كيف تجمع منصة رغوة بيانات المستخدمين وتحميها وتستخدمها.', path: '/privacy', robots: null };
  }
  switch (page) {
    case 'login': return { title: 'تسجيل الدخول | رغوة', description: 'سجّل دخولك إلى لوحة تحكم رغوة لإدارة مغسلتك.', path: '/login', robots: 'noindex,follow' };
    case 'signup': return { title: 'إنشاء حساب | رغوة', description: 'أنشئ حساب رغوة مجاناً وابدأ إدارة مغسلتك اليوم.', path: '/signup', robots: null };
    case 'forgotPassword': return { title: 'استعادة كلمة المرور | رغوة', description: 'استعد كلمة مرور حسابك في رغوة.', path: '/forgot-password', robots: 'noindex,follow' };
    case 'terms': return { title: 'الشروط والأحكام | رغوة', description: 'الشروط والأحكام الخاصة باستخدام منصة رغوة.', path: '/terms', robots: null };
    case 'notFound': return { title: 'الصفحة غير موجودة | رغوة', description: 'الصفحة اللي تدور عليها مو موجودة.', path: window.location.pathname, robots: 'noindex,follow' };
    case 'dashboard': return { title: 'لوحة التحكم | رغوة', description: 'لوحة تحكم رغوة لإدارة المغسلة.', path: window.location.pathname, robots: 'noindex,nofollow' };
    default: return { title: 'رغوة | نظام نقطة بيع لمغاسل الملابس', description: 'رغوة: نظام نقطة بيع لمغاسل الملابس يجمع البيع، تتبع الطلبات، الاشتراكات، والدفع الآجل في مكان واحد. جرّب رغوة مجاناً.', path: '/', robots: null };
  }
}
function setMetaTag(selector, create, attrs) {
  let el = document.head.querySelector(selector);
  if (!el) { el = create(); document.head.appendChild(el); }
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}
function removeMetaTag(selector) {
  document.head.querySelectorAll(selector).forEach((el) => el.remove());
}

const LaundryPOS = () => {
  // Real <a href> anchors point at these paths (crawlable, shareable,
  // right-click-able), so a direct visit or a page refresh has to land on
  // the matching page instead of always resetting to the landing page —
  // checked once at mount via lazy init, and re-derived on browser
  // back/forward via the popstate listener below.
  const [currentPage, setCurrentPage] = useState(() => pageForPath(window.location.pathname));
  // Where to send the user back to from the terms page — it can be reached
  // from more than one place (signup checkbox, landing page footer), and a
  // plain setCurrentPage('signup') on the way back would strand a visitor
  // who opened it from the landing page instead.
  const [termsReferrer, setTermsReferrer] = useState('landing');
  // Optional section id (e.g. "privacy") to scroll TermsPage to on open —
  // lets the footer's "Privacy Policy" link jump straight to the privacy
  // clause instead of duplicating that content on a separate page.
  const [termsScrollTarget, setTermsScrollTarget] = useState(() =>
    window.location.pathname === '/privacy' ? 'privacy' : null
  );
  // Chosen once on the landing page (before any login/signup) and carried
  // through as the dashboard's starting language, so a visitor who picked
  // Arabic there doesn't land on an English dashboard after signing up.
  // '/en' is the only path with real translated content today, so it's the
  // only one that seeds this to 'en'.
  const [siteLang, setSiteLang] = useState(() => (window.location.pathname === '/en' ? 'en' : 'ar'));
  // Central navigation: updates the URL bar (so refresh/share/back-forward
  // all work) and the page state together. Every internal nav control for
  // the five public pages routes through this instead of calling
  // setCurrentPage directly, so the URL never drifts out of sync with what's
  // actually rendered.
  const navigate = (page, path) => {
    window.history.pushState({}, '', path);
    setCurrentPage(page);
    // '/' and '/en' are the two language variants of the landing page —
    // keep siteLang in lockstep with whichever one we just navigated to.
    if (path === '/en') setSiteLang('en');
    else if (path === '/') setSiteLang('ar');
  };
  const openTerms = (scrollTarget) => {
    setTermsReferrer(currentPage);
    setTermsScrollTarget(scrollTarget || null);
    navigate('terms', scrollTarget === 'privacy' ? '/privacy' : '/terms');
  };
  const closeTerms = () => {
    const path = termsReferrer === 'landing' ? (siteLang === 'en' ? '/en' : '/') : (PAGE_TO_PATH[termsReferrer] || '/');
    navigate(termsReferrer, path);
  };
  // Declared here (not further down with the rest of this component's auth
  // state) because the popstate effect right below needs it in its
  // dependency array — a `const` referenced there is in the temporal dead
  // zone until its own declaration line runs, regardless of the effect
  // callback itself only executing later.
  const [tenantId, setTenantId] = useState(null);
  // Browser back/forward doesn't call navigate() (pushState doesn't fire
  // popstate), so it needs its own re-derivation straight from the URL —
  // same source of truth as the initial-mount lazy inits above.
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      const resolvedPage = pageForPath(path);
      // An authenticated tenant navigating back/forward through their own
      // dashboard history stays on 'dashboard' even when the URL also
      // happens to be a public path (e.g. the very first history entry,
      // '/', maps to 'landing') -- same "a resolved session wins"
      // principle onAuthStateChange already applies on initial load.
      // LaundryOpsApp's own popstate listener resolves which tab that
      // means internally. A genuinely unknown URL still shows the real
      // 404 regardless of auth state. Depends on tenantId (not []) so
      // this doesn't close over a stale null from before login resolved.
      setCurrentPage(tenantId && resolvedPage !== 'notFound' ? 'dashboard' : resolvedPage);
      setTermsScrollTarget(path === '/privacy' ? 'privacy' : null);
      if (path === '/en') setSiteLang('en'); else if (path === '/') setSiteLang((l) => (l === 'en' ? 'ar' : l));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [tenantId]);
  // Keeps <title>/description/canonical/robots/hreflang/<html lang> in sync
  // with whatever page is actually showing — there's one static index.html
  // shared by every route, so without this every public URL would report
  // the homepage's metadata regardless of what a crawler or a shared link
  // preview actually rendered.
  useEffect(() => {
    const meta = getPageMeta(currentPage, termsScrollTarget, siteLang);
    const url = `${SITE_ORIGIN}${meta.path}`;
    document.title = meta.title;
    setMetaTag('meta[name="description"]', () => document.createElement('meta'), { name: 'description', content: meta.description });
    setMetaTag('link[rel="canonical"]', () => document.createElement('link'), { rel: 'canonical', href: url });
    setMetaTag('meta[property="og:title"]', () => document.createElement('meta'), { property: 'og:title', content: meta.title });
    setMetaTag('meta[property="og:description"]', () => document.createElement('meta'), { property: 'og:description', content: meta.description });
    setMetaTag('meta[property="og:url"]', () => document.createElement('meta'), { property: 'og:url', content: url });
    if (meta.robots) setMetaTag('meta[name="robots"]', () => document.createElement('meta'), { name: 'robots', content: meta.robots });
    else removeMetaTag('meta[name="robots"]');
    // Only the landing page has two real language variants today.
    if (currentPage === 'landing') {
      setMetaTag('link[hreflang="ar"]', () => document.createElement('link'), { rel: 'alternate', hreflang: 'ar', href: `${SITE_ORIGIN}/` });
      setMetaTag('link[hreflang="en"]', () => document.createElement('link'), { rel: 'alternate', hreflang: 'en', href: `${SITE_ORIGIN}/en` });
      setMetaTag('link[hreflang="x-default"]', () => document.createElement('link'), { rel: 'alternate', hreflang: 'x-default', href: `${SITE_ORIGIN}/` });
      document.documentElement.lang = siteLang;
      document.documentElement.dir = siteLang === 'en' ? 'ltr' : 'rtl';
    } else {
      removeMetaTag('link[hreflang]');
      document.documentElement.lang = 'ar';
      document.documentElement.dir = 'rtl';
    }
  }, [currentPage, termsScrollTarget, siteLang]);
  const [showPassword, setShowPassword] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);

  // Live-synced from platform_config so AdminDashboard's "add admin" /
  // "remove admin" / "toggle auto-approve" controls actually take effect.
  // Falls back to ADMIN_EMAILS_DEFAULT/true until the row loads (or if it's
  // still missing / rejected by RLS pre-bootstrap).
  const [adminEmails, setAdminEmails] = useState(ADMIN_EMAILS_DEFAULT);
  const [autoApprove, setAutoApprove] = useState(true);
  // Platform-wide maintenance banner — set by an admin (AdminDashboard),
  // shown to every visitor on every page (public and inside the app) via
  // MaintenanceBanner below. Live-synced same as the other platform_config
  // fields, so it appears/disappears with no reload needed on either side.
  const [maintenanceActive, setMaintenanceActive] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  useEffect(() => {
    const applyRow = (d) => {
      if (!d) return;
      if (Array.isArray(d.adminEmails) && d.adminEmails.length > 0) setAdminEmails(d.adminEmails);
      if (typeof d.autoApprove === 'boolean') setAutoApprove(d.autoApprove);
      if (typeof d.maintenanceActive === 'boolean') setMaintenanceActive(d.maintenanceActive);
      if (typeof d.maintenanceMessage === 'string') setMaintenanceMessage(d.maintenanceMessage);
    };
    const unsub = subscribeToRow('platform_config', null, null, applyRow);
    return () => unsub();
  }, []);

  const [registrationRequests, setRegistrationRequests] = useState([]);
  const [salesInquiries, setSalesInquiries] = useState([]);
  const [tenants, setTenants] = useState([]);

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [signupShop, setSignupShop] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupMobile, setSignupMobile] = useState('');
  const [signupAddress, setSignupAddress] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupAgree, setSignupAgree] = useState(false);
  const [signupError, setSignupError] = useState('');
  const [signupLoading, setSignupLoading] = useState(false);

  const [showEmailVerification, setShowEmailVerification] = useState(false);
  const [pendingSignup, setPendingSignup] = useState(null); // { email } — holds who we're waiting on verification for

  const [showContact, setShowContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactType, setContactType] = useState('شراء نظام');
  const [contactMessage, setContactMessage] = useState('');
  const [contactSent, setContactSent] = useState(false);

  const isAdminEmail = (email) => adminEmails.includes((email || '').trim().toLowerCase());

  // Ensures platform_config exists and lists this email. RLS only lets this
  // happen either because the row doesn't exist yet (true first-ever
  // bootstrap, seed email only) or because this email is already an admin
  // per the existing row — never for anyone else. Safe to call defensively
  // after any successful admin sign-in, not just on fresh account creation.
  const ensurePlatformConfig = async (emailNorm) => {
    // Not checking `error` here on purpose — a read rejected by RLS during
    // the pre-bootstrap phase should fall through to the bootstrap branch
    // below, exactly like the missing-doc case did with Firestore.
    const { data: row } = await db.from('platform_config').select().eq('id', true).maybeSingle();
    if (row) {
      const current = row.admin_emails || [];
      if (!current.includes(emailNorm)) {
        await db.from('platform_config').update({ admin_emails: [...current, emailNorm] }).eq('id', true)
          .then(({ error }) => { if (error) console.error('platform_config update failed', error); });
      }
    } else {
      await db.from('platform_config').upsert({ id: true, admin_emails: [emailNorm], auto_approve: true })
        .then(({ error }) => { if (error) console.error('platform_config bootstrap failed', error); });
    }
    // platform_admins (what RLS's is_admin() actually checks) is separate
    // from admin_emails above and has zero client-writable RLS policies by
    // design — only api/admin-sync.js (service role) can insert into it.
    // Without this, an admin_emails entry with no matching platform_admins
    // row sees the dashboard fine but every write in it (maintenance
    // toggle, sales-inquiry status, ...) silently fails RLS with no
    // visible error. See api/admin-sync.js for the full explanation.
    const { data: { session } } = await auth.getSession();
    if (session?.access_token) {
      await fetch('/api/admin-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'ensure' }),
      }).catch((e) => console.error('admin-sync ensure failed', e));
    }
  };

  // Admin accounts must already exist in Supabase Auth (created manually by
  // the owner via the Supabase Dashboard → Authentication → Users) before
  // anyone can log in as that email. Deliberately NOT auto-provisioning via
  // auth.signUp() here anymore — the old behavior let whoever typed ANY
  // password for an allow-listed admin email FIRST claim that account
  // permanently, which is an open race for any email added to admin_emails
  // (including the hardcoded default, which ships in client JS). Sign-in
  // only, no bootstrap.
  const adminSignIn = async (emailNorm, password) => {
    const { error: signInErr } = await auth.signInWithPassword({ email: emailNorm, password });
    if (signInErr) throw signInErr;
    // Self-heal: covers the case where the account exists but config/platform
    // was never bootstrapped yet.
    await ensurePlatformConfig(emailNorm).catch(() => {});
  };

  // Figures out where a signed-in user belongs: admin console, straight into
  // their shop dashboard, awaiting-approval, or rejected.
  const resolveDestination = async (user) => {
    if (isAdminEmail(user.email)) {
      // Self-heal here too (not just in adminSignIn): an already-established
      // browser session goes straight through onAuthStateChange on refresh
      // and never calls adminSignIn, so config/platform could otherwise stay
      // missing indefinitely for a session that was live before it existed.
      await ensurePlatformConfig(user.email).catch(() => {});
      return { page: 'admin' };
    }
    if (!user.email_confirmed_at) return { page: 'verify' };
    // maybeSingle() (not single()) — a missing tenant row is the expected,
    // non-error outcome for a user who just signed up and isn't approved yet.
    // Both lookups in parallel — one database round trip instead of two.
    const [{ data: tenantRow }, { data: reqRows }] = await Promise.all([
      db.from('tenants').select().eq('id', user.id).maybeSingle(),
      db.from('registration_requests').select().eq('uid', user.id),
    ]);
    if (tenantRow) return { page: 'dashboard', tenantId: user.id };
    const req = reqRows && reqRows[0] ? toCamelCase(reqRows[0]) : null;
    if (req && req.status === 'rejected') return { page: 'rejected', reason: req.rejectReason };
    return { page: 'pending' };
  };

  // Restores the session on page refresh (Supabase Auth persists it in
  // localStorage) and reacts to sign-in/sign-out from anywhere in the app.
  // Supabase's callback shape is (event, session) — not a plain user object
  // like Firebase's onAuthStateChanged — so the user has to be pulled out of
  // session.user, and it's null (not the user) when signed out.
  useEffect(() => {
    const { data: { subscription } } = auth.onAuthStateChange(async (event, session) => {
      const user = session?.user;
      if (!user) {
        // An anonymous visitor landing directly on a dashboard-only URL
        // (e.g. a bookmarked /reports) has no session to resolve — send
        // them to log in instead of leaving LaundryOpsApp to render with
        // no tenantId. currentPage is already 'dashboard' at this point
        // (see pageForPath), so this is the only place that can catch it.
        if (pageForPath(window.location.pathname) === 'dashboard') navigate('login', '/login');
        setAuthResolved(true);
        return;
      }
      // Fires when the user lands back on the site via a password-recovery
      // link (auth.resetPasswordForEmail) — Supabase already exchanges it
      // for a real session by this point, so intercept BEFORE the normal
      // resolveDestination routing (which would otherwise send them
      // straight to their dashboard/pending screen instead of letting them
      // actually set a new password).
      if (event === 'PASSWORD_RECOVERY') {
        setCurrentPage('resetPassword');
        setAuthResolved(true);
        return;
      }
      // A resolved session always wins over whatever public path the URL
      // bar happens to still show (e.g. /login right after signing in) —
      // clear it so it doesn't sit there stale while the private app
      // renders. Doesn't push a path of its own for dashboard/admin/pending
      // since those aren't given dedicated public URLs.
      if (['/login', '/signup', '/forgot-password'].includes(window.location.pathname)) {
        window.history.pushState({}, '', '/');
      }
      // A genuinely unknown URL should still show the real 404 page, even
      // for an already-authenticated tenant who followed a stale or
      // mistyped link — not silently bounce them into their dashboard,
      // which would make the 404 only ever appear for logged-out visitors.
      if (pageForPath(window.location.pathname) === 'notFound') { setAuthResolved(true); return; }
      try {
        const dest = await resolveDestination(user);
        if (dest.page === 'verify') {
          setPendingSignup({ email: user.email });
          setShowEmailVerification(true);
        } else if (dest.page === 'dashboard') {
          // Clears the verification-waiting screen automatically — needed
          // for the case where THIS listener is what first notices the
          // email got confirmed (e.g. the confirmation link redirected back
          // into this same running tab), so the user isn't stuck looking at
          // "check your email" after the app already knows they're in.
          setShowEmailVerification(false); setPendingSignup(null);
          setTenantId(dest.tenantId);
          setCurrentPage('dashboard');
        } else if (dest.page === 'admin') {
          setShowEmailVerification(false); setPendingSignup(null);
          setCurrentPage('admin');
        } else if (dest.page === 'pending') {
          setShowEmailVerification(false); setPendingSignup(null);
          setCurrentPage((p) => (p === 'landing' || p === 'login' || p === 'signup') ? 'pending' : p);
        }
      } catch (e) {
        console.error('auth state resolve failed', e);
      }
      setAuthResolved(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async () => {
    setLoginError('');
    const emailNorm = loginEmail.trim().toLowerCase();
    if (!emailNorm) { setLoginError('حط البريد الإلكتروني.'); return; }
    setLoginLoading(true);
    try {
      if (isAdminEmail(emailNorm)) {
        await adminSignIn(emailNorm, loginPassword);
        setCurrentPage('admin');
        setLoginLoading(false);
        return;
      }
      const { data, error: signInErr } = await auth.signInWithPassword({ email: emailNorm, password: loginPassword });
      if (signInErr) {
        // Supabase rejects the sign-in itself for an unconfirmed account
        // (error_code "email_not_confirmed") rather than letting it through
        // with a null email_confirmed_at — so a customer who signed up,
        // didn't finish clicking the verification link, and comes back to
        // log in later would otherwise hit a dead-end error and never see
        // the "check your email" screen again. Route them back to it here,
        // same as resolveDestination does for an already-signed-in session.
        if (signInErr.code === 'email_not_confirmed') {
          setPendingSignup({ email: emailNorm });
          setShowEmailVerification(true);
          setLoginLoading(false);
          return;
        }
        throw signInErr;
      }
      const user = data.user;
      const dest = await resolveDestination(user);
      if (dest.page === 'verify') {
        setPendingSignup({ email: user.email });
        setShowEmailVerification(true);
      } else if (dest.page === 'rejected') {
        setLoginError(`تم رفض طلب تسجيلك${dest.reason ? `: ${dest.reason}` : '.'}`);
        await auth.signOut();
      } else if (dest.page === 'pending') {
        setCurrentPage('pending');
      } else {
        setTenantId(dest.tenantId);
        setCurrentPage(dest.page);
      }
    } catch (e) {
      setLoginError(authErrorMessage(e));
    }
    setLoginLoading(false);
  };

  const handleSignup = async ({ website, formStartedAt } = {}) => {
    setSignupError('');
    if (isAdminEmail(signupEmail)) {
      setSignupLoading(true);
      try {
        await adminSignIn(signupEmail.trim().toLowerCase(), signupPassword);
        setCurrentPage('admin');
      } catch (e) {
        setSignupError(authErrorMessage(e));
      }
      setSignupLoading(false);
      return;
    }
    if (!signupAgree) { setSignupError('لازم توافق على شروط الخدمة.'); return; }
    if (!isValidSaudiMobile(signupMobile)) { setSignupError('رقم الجوال غير صحيح.'); return; }
    const emailNorm = signupEmail.trim().toLowerCase();
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) { setSignupError('حط بريد إلكتروني صحيح.'); return; }
    if (!signupPassword) { setSignupError('حط كلمة مرور.'); return; }

    setSignupLoading(true);
    try {
      const shopName = signupShop.trim() || '—';
      const address = signupAddress.trim() || '—';

      // The API route creates the Supabase Auth user itself, via
      // admin.generateLink({type:'signup'}) — that call behaves like
      // auth.signUp() and fails with "user already registered" if the user
      // already exists. So this must be the ONLY place that creates the
      // account; calling auth.signUp() here too (the old code did, before
      // this fetch) silently broke the branded Resend email on every signup.
      //
      // It also now writes the registration_requests/tenants rows itself
      // (service-role client, server-side) instead of this still-anonymous
      // client doing those inserts — the anon-role INSERT policies that
      // used to make that possible had to be wide open (no ownership
      // check at all, since no session exists yet at this point), which
      // meant literally anyone with the public anon key could POST
      // directly to Supabase's REST API and insert arbitrary tenants /
      // registration_requests rows with zero signup, zero verification.
      // See supabase-close-anon-signup-inserts.sql.
      const turnstileToken = await getTurnstileToken();
      const resp = await fetch('/api/send-verification-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailNorm, password: signupPassword, shopName, mobile: signupMobile, address, website, formStartedAt, turnstileToken }),
      });
      const result = await resp.json();
      if (!result.success) throw { message: result.error, code: result.code };

      setPendingSignup({ email: emailNorm });
      setShowEmailVerification(true);
    } catch (e) {
      setSignupError(authErrorMessage(e));
    }
    setSignupLoading(false);
  };

  // Called once the user confirms they clicked the real verification link.
  // Re-resolves their destination from Firestore — works whether they're
  // finishing a fresh signup or just verifying late after a previous visit.
  const completeSignupAfterVerification = async () => {
    const { data } = await auth.getUser(); // no sync auth.currentUser in Supabase
    const user = data.user;
    if (!user) return;
    setShowEmailVerification(false);
    setPendingSignup(null);
    const dest = await resolveDestination(user);
    if (dest.page === 'dashboard') { setTenantId(dest.tenantId); setCurrentPage('dashboard'); }
    else if (dest.page === 'admin') setCurrentPage('admin');
    else setCurrentPage('pending');
  };

  const handleLogout = async () => {
    const { error: err } = await auth.signOut();
    if (err) console.error(err);
    navigate('landing', '/');
    setTenantId(null);
    setLoginEmail(''); setLoginPassword(''); setLoginError('');
  };

  // Admin-only: mirrors the cross-tenant collections live while the admin
  // console is open (Firestore rules only allow reading these to admins).
  // Plain onSnapshot with no server-side orderBy — sorted client-side
  // instead, matching TenantDataManagementView's pattern. This also sidesteps
  // orderBy silently excluding any older/legacy document that happens to be
  // missing the sorted field.
  useEffect(() => {
    if (currentPage !== 'admin') return;
    const byDateDesc = (field) => (a, b) => new Date(b[field] || 0) - new Date(a[field] || 0);
    const unsubReq = subscribeToTable('registration_requests', null, null, setRegistrationRequests, null, (rows) => [...rows].sort(byDateDesc('date')));
    const unsubTen = subscribeToTable('tenants', null, null, setTenants, null, (rows) => [...rows].sort(byDateDesc('approvedDate')));
    const unsubInq = subscribeToTable('sales_inquiries', null, null, setSalesInquiries, null, (rows) => [...rows].sort(byDateDesc('date')));
    return () => { unsubReq(); unsubTen(); unsubInq(); };
  }, [currentPage]);

  // Public contact form on the landing page — no login required. Goes
  // through api/submit-contact now (rate-limited + honeypot + minimum-
  // fill-time checked server-side) instead of inserting into
  // sales_inquiries directly from this still-signed-out client — see
  // supabase-close-anon-sales-inquiries.sql for why that direct-insert
  // path was closed off.
  const submitContact = ({ website, formStartedAt } = {}) => {
    // Field values captured NOW, synchronously — the actual send (including
    // the Turnstile round-trip below) is fire-and-forget, same as before
    // Turnstile existed. Awaiting getTurnstileToken() before showing "sent"
    // used to leave the visitor staring at an unresponsive form for however
    // long the challenge took (a real regression this caused: the
    // confirmation only appeared after the full Turnstile round-trip).
    const payload = {
      name: contactName.trim() || '—', mobile: contactMobile.trim() || '—', email: contactEmail.trim() || '—',
      type: contactType, message: contactMessage.trim(), website, formStartedAt,
    };
    (async () => {
      const turnstileToken = await getTurnstileToken();
      fetch('/api/submit-contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, turnstileToken }),
      }).catch((e) => console.error('submitContact failed', e));
    })();
    setContactSent(true);
    setTimeout(() => {
      setShowContact(false); setContactSent(false);
      setContactName(''); setContactMobile(''); setContactEmail(''); setContactMessage(''); setContactType('شراء نظام');
    }, 1500);
  };

  // Clarity only ever runs on the public marketing/auth pages — never on the
  // POS, reports, customer/supplier data, or the admin console. Anything
  // outside this list (dashboard, admin, pending-approval, email
  // verification) leaves `active` false, which pauses/never loads the tag.
  // Also gated on `authResolved`: `currentPage` defaults to 'landing' before
  // the session-restore check runs, so a returning already-authenticated
  // tenant would otherwise have Clarity start()-ing for the instant before
  // that check redirects them straight to the dashboard.
  const PUBLIC_TRACKED_PAGES = ['landing', 'login', 'signup'];
  useClarityTracking(authResolved && !showEmailVerification && PUBLIC_TRACKED_PAGES.includes(currentPage));

  if (!authResolved) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center">
        <div className="text-gray-400 text-sm">جارٍ التحميل...</div>
      </div>
    );
  }

  return (
    <>
      <MaintenanceBanner active={maintenanceActive} message={maintenanceMessage} />
      {showEmailVerification && pendingSignup ? (
    <EmailVerificationPage
      email={pendingSignup.email}
      onVerified={completeSignupAfterVerification}
      onBack={async () => { const { error: err } = await auth.signOut(); if (err) console.error(err); setShowEmailVerification(false); setPendingSignup(null); }}
    />
  ) : currentPage === 'pending' ? (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-3">طلبك قيد المراجعة</h1>
        <p className="text-gray-400 text-sm mb-6">تم تأكيد بريدك الإلكتروني بنجاح. حسابك الآن بانتظار موافقة الإدارة، بترجع تقدر تدخل بمجرد ما توافق الإدارة.</p>
        <button onClick={handleLogout} className="w-full text-gray-400 hover:text-gray-300 text-sm py-2 transition">رجوع لتسجيل الدخول</button>
      </div>
    </div>
  ) : currentPage === 'landing' ? (
    <LandingPage
      navigate={navigate} showWorkflow={showWorkflow} setShowWorkflow={setShowWorkflow}
      showContact={showContact} setShowContact={setShowContact}
      contactName={contactName} setContactName={setContactName}
      contactMobile={contactMobile} setContactMobile={setContactMobile}
      contactEmail={contactEmail} setContactEmail={setContactEmail}
      contactType={contactType} setContactType={setContactType}
      contactMessage={contactMessage} setContactMessage={setContactMessage}
      contactSent={contactSent} submitContact={submitContact}
      lang={siteLang} onOpenTerms={openTerms}
    />
  ) : currentPage === 'login' ? (
    <LoginPage
      navigate={navigate} showPassword={showPassword} setShowPassword={setShowPassword}
      loginEmail={loginEmail} setLoginEmail={setLoginEmail}
      loginPassword={loginPassword} setLoginPassword={setLoginPassword}
      handleLogin={handleLogin} loginError={loginError} loginLoading={loginLoading}
    />
  ) : currentPage === 'forgotPassword' ? (
    <ForgotPasswordPage navigate={navigate} />
  ) : currentPage === 'resetPassword' ? (
    <ResetPasswordPage onDone={async () => { await auth.signOut(); setCurrentPage('login'); }} />
  ) : currentPage === 'terms' ? (
    <TermsPage onBack={closeTerms} scrollTarget={termsScrollTarget} />
  ) : currentPage === 'signup' ? (
    <SignupPage
      navigate={navigate} signupShop={signupShop} setSignupShop={setSignupShop}
      signupEmail={signupEmail} setSignupEmail={setSignupEmail}
      signupMobile={signupMobile} setSignupMobile={setSignupMobile}
      signupAddress={signupAddress} setSignupAddress={setSignupAddress}
      signupPassword={signupPassword} setSignupPassword={setSignupPassword}
      signupAgree={signupAgree} setSignupAgree={setSignupAgree}
      handleSignup={handleSignup} signupError={signupError} signupLoading={signupLoading}
      onOpenTerms={openTerms}
    />
  ) : currentPage === 'notFound' ? (
    <NotFoundPage navigate={navigate} />
  ) : currentPage === 'admin' ? (
    <Suspense fallback={<DashboardLoading />}>
      <AdminDashboard
        registrationRequests={registrationRequests}
        salesInquiries={salesInquiries}
        tenants={tenants}
        adminEmails={adminEmails}
        autoApprove={autoApprove}
        maintenanceActive={maintenanceActive}
        maintenanceMessage={maintenanceMessage}
        onLogout={handleLogout}
      />
    </Suspense>
  ) : (
    <Suspense fallback={<DashboardLoading />}>
      <LaundryOpsApp tenantId={tenantId} onLogout={handleLogout} initialLang={siteLang} />
    </Suspense>
  )}
    </>
  );
};

export default LaundryPOS;
