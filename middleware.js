import { next } from '@vercel/functions';

// Same negative-lookahead as the SPA rewrite in vercel.json (api/, assets/,
// anything with a file extension never hits this) so their behavior stays
// completely untouched by this file.
export const config = {
  matcher: ['/((?!api/|assets/|.*\\.\\w+$).*)'],
};

// Must stay in sync with PATH_PAGE_MAP in src/App.jsx. Duplicated here (not
// imported) because this runs in an isolated Edge runtime that can't pull in
// App.jsx (a large JSX file, not a plain ESM module this runtime can load).
const KNOWN_PATHS = new Set(['/', '/en', '/login', '/signup', '/forgot-password', '/terms', '/privacy']);

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  if (KNOWN_PATHS.has(pathname)) return next();

  // Unknown path: serve the same SPA shell the normal rewrite would have,
  // but with a real 404 status instead of 200 -- src/App.jsx's own
  // pageForPath/currentPage logic renders the actual "not found" UI once
  // this loads client-side.
  const shell = await fetch(new URL('/index.html', request.url));
  const html = await shell.text();
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
