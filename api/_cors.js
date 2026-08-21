const ALLOWED_ORIGINS = new Set([
  'https://www.ragwapos.com',
  'https://ragwapos.com', // apex 308-redirects to www, but still worth allowing directly
]);

// None of these endpoints were ever meant to be callable from any origin
// other than the app itself — with no CORS headers at all (the previous
// state), a browser lets ANY website's JS fetch() them, since the
// same-origin policy is what CORS headers exist to relax, not restrict;
// omitting them entirely is the permissive default, not a safe one.
// Returns true if the request was a handled preflight (caller should
// return immediately without doing any real work).
export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
