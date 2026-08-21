import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SENTRY_DSN (no VITE_ prefix, so Vite would normally never expose it to
// client code) comes from the Sentry x Vercel Marketplace integration —
// injected here at BUILD time, straight from Vercel's build environment
// into the bundle, so nobody ever has to copy/paste the actual secret
// value by hand. A DSN isn't sensitive the way an API key is (it's
// designed to be embedded in public client code), so this is safe.
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN || ''),
  },
});
