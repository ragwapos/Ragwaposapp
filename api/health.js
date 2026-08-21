import { createClient } from '@supabase/supabase-js';

// Plain uptime-check endpoint for an external monitor (UptimeRobot,
// BetterStack, etc.) to poll. Deliberately uses the public anon key, not
// the service role — this only needs to prove the DB is reachable, not
// touch anything privileged. platform_config's SELECT policy is already
// open to anon (see supabase RLS), so this is a trivial, harmless read.
const supabase = createClient(
  'https://qepsmlnozznqfybavyix.supabase.co',
  'sb_publishable_xhU8bp5pS45Brd5HqDJ9sA_zeMidsGk'
);

export default async function handler(req, res) {
  const startedAt = Date.now();
  let dbOk = false;
  try {
    const { error } = await supabase.from('platform_config').select('id').limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  const body = {
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    latencyMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };
  return res.status(dbOk ? 200 : 503).json(body);
}
