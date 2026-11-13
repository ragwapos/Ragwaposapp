import React, { useEffect } from "react";
import { AUTH_TEXT } from "./authText.js";

// Its own file (not in App.jsx) so the build can also render it to static HTML:
// scripts/build-landing-prerender.mjs puts that markup in dist/app.html, and the
// form is on screen as soon as the HTML + CSS arrive instead of after the JS
// bundle. Anything running at render time here must work without window/document.
// focusField ('email' | 'password') restores the caret when the visitor was
// already typing in the static form before React took over.
export default function LoginPage(props) {
  const { navigate, showPassword, setShowPassword, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, handleLogin, loginError, loginLoading, lang,
    preloadDashboard, focusField } = props;
  const T = AUTH_TEXT[lang];
  const home = lang === 'en' ? '/en' : '/';
  // Start downloading the dashboard chunk while the owner is still typing, so
  // it's ready the moment sign-in succeeds instead of being fetched after.
  useEffect(() => { preloadDashboard(); }, []);
  return (
    <div dir={T.dir} className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="absolute top-6 end-6">
        <a href={home} onClick={(e) => { e.preventDefault(); navigate('landing', home); }} className="px-4 py-2 text-gray-300 hover:text-white transition">
          {T.back}
        </a>
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">{T.brand}</h1>
          <p className="text-gray-400 text-sm">{T.tagline}</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">{T.loginTitle}</h2>
          <p className="text-gray-400 text-center text-sm mb-8">{T.loginSubtitle}</p>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">{T.email}</label>
            <input type="text" name="email" autoFocus={focusField === 'email'} value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="ltr" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">{T.password}</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} name="password" autoFocus={focusField === 'password'} value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg ps-4 pe-12 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
              <button onClick={() => setShowPassword(!showPassword)} className="absolute end-4 top-1/2 -translate-y-1/2 text-gray-500 text-lg">
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="text-end mb-4 -mt-2">
            <a href="/forgot-password" onClick={(e) => { e.preventDefault(); navigate('forgotPassword', '/forgot-password'); }} className="text-cyan-400 hover:text-cyan-300 text-xs">{T.forgot}</a>
          </div>

          {loginError && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{loginError}</div>}

          <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
            {loginLoading ? T.loggingIn : T.loginBtn}
          </button>

          <p className="text-center text-gray-400 text-sm">
            {T.noAccount} <a href="/signup" onClick={(e) => { e.preventDefault(); navigate('signup', '/signup'); }} className="text-cyan-400 hover:text-cyan-300">{T.createAccount}</a>
          </p>
        </div>
      </div>
    </div>
  );
}
