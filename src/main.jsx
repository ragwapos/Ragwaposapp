import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import LaundryPOS from './App.jsx';
import './index.css';

// VITE_SENTRY_DSN is injected at build time from the server-side SENTRY_DSN
// (see vite.config.js) — empty on any deploy that hasn't got the Sentry
// integration connected yet, in which case init() below is a safe no-op.
const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    // Session Replay only on error, not every session — keeps the free
    // plan's 50-replay quota for when it actually matters.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
  // Replay is about a third of the entry bundle and only matters once an
  // error happens, so it loads in its own chunk after the first paint instead
  // of delaying it. Error reporting itself is live from init() above.
  const loadReplay = () => import('./utils/sentryReplay.js')
    .then((m) => Sentry.addIntegration(m.replayIntegration()))
    .catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(loadReplay, { timeout: 5000 });
  else setTimeout(loadReplay, 2000);
}

// Can't rely on any app state here (the app itself just crashed), so it reads
// the language the page was last showing, or the visitor's landing-page choice.
const ERROR_TEXT = {
  ar: { dir: 'rtl', msg: 'حدث خطأ غير متوقع. الرجاء إعادة تحميل الصفحة.', reload: 'إعادة التحميل' },
  en: { dir: 'ltr', msg: 'Something went wrong. Please reload the page.', reload: 'Reload' },
};
function errorLang() {
  if (document.documentElement.lang === 'en') return 'en';
  try { return localStorage.getItem('ragwa_site_lang') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; }
}

function ErrorFallback() {
  const txt = ERROR_TEXT[errorLang()];
  return (
    <div dir={txt.dir} style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', fontFamily: 'system-ui, sans-serif', padding: '24px', textAlign: 'center' }}>
      <p style={{ fontSize: '16px', color: '#333' }}>{txt.msg}</p>
      <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: '#17a5a0', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
        {txt.reload}
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <LaundryPOS />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
