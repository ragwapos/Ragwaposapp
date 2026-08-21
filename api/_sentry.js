import * as Sentry from '@sentry/node';

// SENTRY_DSN is set directly by the Sentry x Vercel Marketplace
// integration (server-side env var, never exposed to the client). If it's
// missing (e.g. integration not yet connected on this deploy), init()
// still runs but Sentry's SDK is a safe no-op without a DSN.
if (!globalThis.__sentryInitialized) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  globalThis.__sentryInitialized = true;
}

export { Sentry };
