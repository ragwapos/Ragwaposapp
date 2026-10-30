// Real URLs for the tabs inside the authenticated dashboard (main tabs, plus
// the sub-tabs inside Reports/Purchases — those two views keep their own
// local sub-tab state, driven by these paths; see ReportsView/
// PurchasesExpensesView and LaundryOpsApp's navigateTab/tabForPath). Two
// lookup directions: pathForTab (tab/subTab -> URL) and tabForPath (URL ->
// tab/subTab) — used both by App.jsx (to resolve an incoming URL to
// 'dashboard' vs 'notFound' before a session is even confirmed) and by
// LaundryOpsApp in ../dashboard/TenantApp.jsx (for its own tab navigation
// once inside the authenticated app) — hence this shared file rather than
// two copies.
// Must stay in sync with KNOWN_PATHS in middleware.js (repo root).
export const DASHBOARD_TAB_PATHS = {
  home: '/home', pos: '/pos', invoices: '/active-invoices',
  delivery_invoices: '/delivery-invoices', customers: '/customers',
  inventory: '/inventory', purchases: '/purchases', promotions: '/promotions',
  reports: '/reports', whatsapp: '/whatsapp', branches: '/branches', settings: '/settings',
};
export const REPORTS_SUBTAB_PATHS = { procurement: '/reports/procurement', expenses: '/reports/expenses', pl: '/reports/profit-loss', vat: '/reports/vat' };
export const PURCHASES_SUBTAB_PATHS = { expenses: '/purchases/expenses' };
export const ALL_DASHBOARD_PATHS = [...Object.values(DASHBOARD_TAB_PATHS), ...Object.values(REPORTS_SUBTAB_PATHS), ...Object.values(PURCHASES_SUBTAB_PATHS)];

export function pathForTab(tab, subTab) {
  if (tab === 'reports' && subTab && REPORTS_SUBTAB_PATHS[subTab]) return REPORTS_SUBTAB_PATHS[subTab];
  if (tab === 'purchases' && subTab && PURCHASES_SUBTAB_PATHS[subTab]) return PURCHASES_SUBTAB_PATHS[subTab];
  return DASHBOARD_TAB_PATHS[tab] || '/home';
}
export function tabForPath(path) {
  // '/' itself is never pushed by navigateTab (home's real URL is /home),
  // but it's always the very first browser-history entry for any session
  // (the page's original load URL) -- so back/forward can land back on it
  // for an authenticated tenant. Treat it as home rather than leaving
  // whatever tab was showing before stuck on screen under a '/' URL.
  if (path === '/') return { tab: 'home', subTab: null };
  const reportsSub = Object.entries(REPORTS_SUBTAB_PATHS).find(([, p]) => p === path);
  if (reportsSub) return { tab: 'reports', subTab: reportsSub[0] };
  const purchasesSub = Object.entries(PURCHASES_SUBTAB_PATHS).find(([, p]) => p === path);
  if (purchasesSub) return { tab: 'purchases', subTab: purchasesSub[0] };
  const main = Object.entries(DASHBOARD_TAB_PATHS).find(([, p]) => p === path);
  if (main) return { tab: main[0], subTab: null };
  return null;
}
