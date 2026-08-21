// Verifies a Cloudflare Turnstile response token server-side. This is what
// actually enforces the check — the client-side widget only produces a
// token; trusting the client to have run it would let anyone skip straight
// to POSTing the API route directly, exactly like the anon-INSERT holes
// this project has already closed elsewhere.
export async function verifyTurnstile(token, remoteip) {
  if (!process.env.TURNSTILE_SECRET_KEY || !token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip }),
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}
