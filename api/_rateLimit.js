import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Upstash Redis (Vercel Marketplace integration — provisions
// KV_REST_API_URL/KV_REST_API_TOKEN, not the @upstash/redis default
// UPSTASH_REDIS_REST_* names, so this can't use Redis.fromEnv()).
// Built lazily, not at module load: importing this file must never throw
// just because the env vars happen to be missing (e.g. a fresh preview
// deploy before the integration's connected) — every check function below
// already fails open in that case.
let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

const limiters = new Map();
function getLimiter(max, window) {
  const key = `${max}:${window}`;
  if (!limiters.has(key)) {
    const r = getRedis();
    if (!r) return null;
    limiters.set(key, new Ratelimit({ redis: r, limiter: Ratelimit.slidingWindow(max, window), prefix: 'ragwapos-ratelimit' }));
  }
  return limiters.get(key);
}

// Sends a 429 and returns false if the identifier is over its limit for
// this bucket; otherwise returns true. Fails OPEN (returns true, lets the
// request through) if Redis isn't configured or the check itself errors —
// a rate limiter that's down should never be why a real signup/sale fails,
// it should just stop limiting until Redis is back.
export async function checkRateLimit(res, bucket, identifier, max, window) {
  try {
    const limiter = getLimiter(max, window);
    if (!limiter) return true;
    const { success } = await limiter.limit(`${bucket}:${identifier}`);
    if (!success) {
      res.status(429).json({ success: false, error: 'rate_limited' });
      return false;
    }
    return true;
  } catch (e) {
    console.error('checkRateLimit failed (failing open)', e);
    return true;
  }
}

export function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
