// Which Supabase project the API talks to. Production uses the defaults; the
// staging deployment overrides them with its own project through the Vercel
// Preview environment variables (SUPABASE_URL / SUPABASE_ANON_KEY).
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qepsmlnozznqfybavyix.supabase.co';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_xhU8bp5pS45Brd5HqDJ9sA_zeMidsGk';
