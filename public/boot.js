// Runs before the first paint (plain <script> in <head>, added to every HTML
// shell by scripts/build-landing-prerender.mjs) and picks which of the static
// views already in the HTML to show, so the right screen is up before the app
// bundle has downloaded. The rules for [data-boot-view] are in src/index.css.
// A separate file because the site's CSP allows no inline scripts.
//
//   app      a saved sign-in exists: the dashboard skeleton shaped like the
//            page in the URL (data-boot-skel), the dashboard chunk starts
//            downloading now, and the database connection is opened early
//   login    /login: the real login form
//   landing  / and /en: the landing page (also what shows with no JavaScript)
//   blank    every other page: its dark background until React renders it
//
// Only checks that a sign-in key exists; the token itself is never read here.
(function () {
  var root = document.documentElement;
  var path = location.pathname;
  var authKey = null;
  var lastDest = null;
  // Same rule as initialSiteLang() in src/App.jsx.
  var lang = path === '/en' ? 'en' : 'ar';
  try {
    for (var i = 0; i < localStorage.length; i++) {
      if (/^sb-[a-z0-9]+-auth-token$/.test(localStorage.key(i))) authKey = localStorage.key(i);
    }
    if (path !== '/' && path !== '/en' && localStorage.getItem('ragwa_site_lang') === 'en') lang = 'en';
    lastDest = JSON.parse(localStorage.getItem('ragwa_last_dest') || 'null');
  } catch (e) {}

  var mode = authKey ? 'app' : path === '/login' ? 'login' : (path === '/' || path === '/en') ? 'landing' : 'blank';
  root.setAttribute('data-boot', mode);
  root.setAttribute('data-boot-lang', lang);
  if (!authKey) return;

  // Must agree with VARIANT_BY_TAB in src/dashboard/DashboardSkeleton.jsx
  // (the same pages, keyed by tab there). A branch login has no home screen,
  // so its "/" opens the register (same rule as BOOT_SKELETON in src/App.jsx).
  var VARIANT_BY_PATH = {
    '/pos': 'pos', '/active-invoices': 'table', '/delivery-invoices': 'table', '/customers': 'table',
    '/promotions': 'table', '/branches': 'table', '/inventory': 'stats', '/purchases': 'stats',
    '/purchases/expenses': 'stats', '/reports': 'reports', '/whatsapp': 'cards', '/settings': 'settings',
  };
  var skel = VARIANT_BY_PATH[path] || (path.indexOf('/reports/') === 0 ? 'reports' : 'home');
  if (skel === 'home' && lastDest && lastDest.branchId) skel = 'pos';
  root.setAttribute('data-boot-skel', skel);
  // The skeleton has no text; its sidebar side follows the page direction.
  root.dir = lang === 'en' ? 'ltr' : 'rtl';

  // The first database requests otherwise pay for opening the connection
  // (DNS + TLS). The project is the one named in the sign-in key itself.
  var ref = authKey.slice(3, -'-auth-token'.length);
  var pre = document.createElement('link');
  pre.rel = 'preconnect';
  pre.href = 'https://' + ref + '.supabase.co';
  pre.crossOrigin = 'anonymous';
  document.head.appendChild(pre);

  var chunk = document.querySelector('meta[name="ragwa-tenant-chunk"]');
  if (!chunk) return;
  var link = document.createElement('link');
  if (link.relList && link.relList.supports && link.relList.supports('modulepreload')) {
    link.rel = 'modulepreload';
  } else {
    link.rel = 'preload';
    link.as = 'script';
    link.crossOrigin = 'anonymous';
  }
  link.href = chunk.content;
  document.head.appendChild(link);
})();
