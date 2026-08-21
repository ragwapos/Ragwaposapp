// Cloudflare Turnstile (invisible mode) — loaded lazily so public pages that
// never show a protected form (most of the SPA) never pay for the script.
// The widget is rendered fresh into a throwaway off-screen container right
// before each submit and torn down immediately after, rather than kept
// mounted, since a token is single-use and expires after a few minutes —
// keeping one around invites stale-token failures for slow fillers.
let scriptPromise = null;

function loadTurnstileScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) { resolve(window.turnstile); return; }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error('turnstile_script_failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Resolves with a Turnstile response token, or null if the widget fails to
// load/execute (network blocked, ad-blocker, etc). Callers should treat a
// null token as "let the server's other checks decide" rather than hard-
// blocking the user, since Turnstile itself is a defense-in-depth layer on
// top of the existing honeypot/timing/rate-limit checks, not the only one.
export async function getTurnstileToken() {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (!siteKey) return null;
  try {
    const turnstile = await loadTurnstileScript();
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;';
    document.body.appendChild(container);
    return await new Promise((resolve) => {
      let widgetId;
      const cleanup = () => {
        try { if (widgetId != null) turnstile.remove(widgetId); } catch { /* already gone */ }
        container.remove();
      };
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token) => { cleanup(); resolve(token); },
        'error-callback': () => { cleanup(); resolve(null); },
        'timeout-callback': () => { cleanup(); resolve(null); },
      });
    });
  } catch {
    return null;
  }
}
