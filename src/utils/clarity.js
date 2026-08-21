import { useEffect } from 'react';

// Microsoft Clarity tracking — scoped to public/marketing pages only
// (landing, login, signup). Never imported by index.html or main.jsx, so
// the tag can only ever load from here, and only while `active` is true.
//
// The project ID never ships as a literal in this file — it comes from
// VITE_CLARITY_PROJECT_ID (see .env.local / Vercel project env vars), so a
// build with that var unset simply never loads Clarity at all.
export function useClarityTracking(active) {
  useEffect(() => {
    if (!active) return;
    const projectId = import.meta.env.VITE_CLARITY_PROJECT_ID;
    if (!projectId) return;

    // Guard on the actual <script> tag, not just `window.clarity` — the
    // snippet below sets that stub synchronously on first run regardless of
    // whether the tag ends up appended once or twice, so checking only the
    // stub can't by itself rule out a duplicate <script src> ever having
    // been inserted (e.g. by a leftover tag from a prior mount this effect
    // doesn't know about). This is the actual condition Clarity's own
    // "CL001: Multiple Clarity tags detected" check cares about.
    if (!window.clarity && !document.querySelector('script[src*="clarity.ms/tag/"]')) {
      (function (c, l, a, r, i) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        const t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
        const y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
      })(window, document, 'clarity', 'script', projectId);
    }
    // Queued the same way as the init call above, so this is safe to fire
    // immediately even before the async tag script has actually loaded.
    window.clarity('start');

    // Leaving a public page (route changed to POS/admin, or unmount): pause
    // recording via Clarity's own stop() rather than ripping the <script>
    // tag out — Clarity has no supported "unload" path, and this is the
    // documented way to guarantee nothing further is captured.
    return () => { if (window.clarity) window.clarity('stop'); };
  }, [active]);
}
