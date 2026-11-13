// Runs before the first paint (plain <script> in <head>, added to every HTML
// shell by scripts/build-landing-prerender.mjs) and picks which of the static
// views already in the HTML to show, so the right screen is up before the app
// bundle has downloaded. The rules for [data-boot-view] are in src/index.css.
// A separate file because the site's CSP allows no inline scripts.
//
//   app      a saved sign-in exists: dashboard skeleton, and the dashboard
//            chunk starts downloading now, alongside the app bundle
//   login    /login: the real login form
//   landing  / and /en: the landing page (also what shows with no JavaScript)
//   blank    every other page: its dark background until React renders it
//
// Only checks that a sign-in key exists; the token itself is never read here.
(function () {
  var root = document.documentElement;
  var path = location.pathname;
  var signedIn = false;
  // Same rule as initialSiteLang() in src/App.jsx.
  var lang = path === '/en' ? 'en' : 'ar';
  try {
    for (var i = 0; i < localStorage.length; i++) {
      if (/^sb-[a-z0-9]+-auth-token$/.test(localStorage.key(i))) signedIn = true;
    }
    if (path !== '/' && path !== '/en' && localStorage.getItem('ragwa_site_lang') === 'en') lang = 'en';
  } catch (e) {}

  var mode = signedIn ? 'app' : path === '/login' ? 'login' : (path === '/' || path === '/en') ? 'landing' : 'blank';
  root.setAttribute('data-boot', mode);
  root.setAttribute('data-boot-lang', lang);
  if (!signedIn) return;

  // The skeleton has no text; its sidebar side follows the page direction.
  root.dir = lang === 'en' ? 'ltr' : 'rtl';
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
