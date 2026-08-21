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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LaundryPOS />
  </React.StrictMode>
);
