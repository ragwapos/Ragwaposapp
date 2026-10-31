import { createClient } from '@supabase/supabase-js';

// Production defaults; the staging deployment overrides them through VITE_* env vars.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://qepsmlnozznqfybavyix.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_xhU8bp5pS45Brd5HqDJ9sA_zeMidsGk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const auth = supabase.auth;
export const db = supabase;
export default supabase;
