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
    integrations: [Sentry.replayIntegration()],
  });
}

function ErrorFallback() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', fontFamily: 'system-ui, sans-serif', padding: '24px', textAlign: 'center' }}>
      <p style={{ fontSize: '16px', color: '#333' }}>حدث خطأ غير متوقع. الرجاء إعادة تحميل الصفحة.</p>
      <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', borderRadius: '8px', border: 'none', background: '#17a5a0', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
        إعادة التحميل
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
