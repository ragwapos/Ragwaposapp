import { createClient } from '@supabase/supabase-js';

// Production defaults; the staging deployment overrides them through VITE_* env vars.
// A malformed override (stray character, wrong host) would make every request fail with
// "Invalid API key", so only well-formed values are used.
const envUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const SUPABASE_URL = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(envUrl) ? envUrl : 'https://qepsmlnozznqfybavyix.supabase.co';
const SUPABASE_ANON_KEY = /^(sb_publishable_|eyJ)[A-Za-z0-9._-]+$/.test(envKey) ? envKey : 'sb_publishable_xhU8bp5pS45Brd5HqDJ9sA_zeMidsGk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const auth = supabase.auth;
export const db = supabase;
export default supabase;

// True when a saved sign-in exists in this browser (presence only; the token
// itself isn't read or validated here). Lets the app show the dashboard
// skeleton straight away for a returning shop instead of a public page.
// The key is the one supabase-js derives from the project URL.
const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
export function hasStoredSession() {
  try { return Boolean(localStorage.getItem(AUTH_STORAGE_KEY)); } catch { return false; }
}
