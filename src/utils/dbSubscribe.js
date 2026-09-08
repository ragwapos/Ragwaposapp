import { db } from '../supabase';
import { toCamelCase } from './transforms.js';

/* =========================================================================
   SUPABASE DATA-LAYER HELPERS
   Firestore's onSnapshot(query, cb) hands you the WHOLE current result set
   on every change. Supabase Realtime (v2) only hands you individual INSERT/
   UPDATE/DELETE row events — so getting the same "always-in-sync local
   array/object" behavior means: load the initial rows once, then apply each
   realtime event as a diff. One shared pair of helpers instead of
   duplicating this pattern at every one of the ~15 call sites that used to
   call onSnapshot. Both return a plain unsubscribe function, so every call
   site keeps the exact same `const unsub = ...(); return () => unsub();`
   shape the Firestore version used.

   Extracted from App.jsx (was module-scope there) so the root/public bundle,
   the tenant dashboard bundle, and the admin dashboard bundle — each lazy-
   loaded separately — can share this real logic without duplicating it three
   times. See PROJECT_REFERENCE.md for the bundle-splitting rationale.
   ========================================================================= */
// List-style — for a table where many rows share one tenant/filter value
// (products, invoices, customers, etc). Optional `transform` post-processes
// the array (e.g. client-side sort) before every setState call, both on the
// initial load and on every realtime diff — needed since a couple of call
// sites keep their local state pre-sorted rather than sorting at render time.
export function subscribeToTable(table, filterColumn, filterValue, setState, orderColumn, transform) {
  let cancelled = false;
  const apply = transform || ((arr) => arr);

  let initial = db.from(table).select("*");
  if (filterColumn) initial = initial.eq(filterColumn, filterValue);
  if (orderColumn) initial = initial.order(orderColumn);
  initial.then(({ data, error }) => {
    if (cancelled) return;
    if (error) { console.error(`${table} initial load failed`, error); return; }
    const fetched = (data || []).map(toCamelCase);
    // Merge rather than replace: this fetch was issued at mount time, so if
    // an optimistic add already landed in state before this slower request
    // resolved, blindly overwriting with the (now-stale) fetched snapshot
    // would wipe that row back out. Anything in `prev` not present in the
    // fetched set is assumed to be one of those not-yet-reflected rows.
    setState((prev) => {
      const fetchedIds = new Set(fetched.map((r) => r.id));
      const optimisticOnly = prev.filter((r) => !fetchedIds.has(r.id));
      return apply([...fetched, ...optimisticOnly]);
    });
  });

  const channel = db
    .channel(`${table}-${filterColumn || "all"}-${filterValue || "all"}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table, filter: filterColumn ? `${filterColumn}=eq.${filterValue}` : undefined },
      (payload) => {
        setState((prev) => {
          if (payload.eventType === "INSERT") {
            const n = toCamelCase(payload.new);
            // Dedupe against an optimistic update already applied locally
            // (add*/updateIn/removeFrom below update state immediately,
            // ahead of this realtime echo) so the row doesn't end up twice.
            if (prev.some((row) => row.id === n.id)) return apply(prev.map((row) => (row.id === n.id ? n : row)));
            return apply([...prev, n]);
          }
          if (payload.eventType === "UPDATE") { const n = toCamelCase(payload.new); return apply(prev.map((row) => (row.id === n.id ? n : row))); }
          if (payload.eventType === "DELETE") return apply(prev.filter((row) => row.id !== payload.old.id));
          return prev;
        });
      }
    )
    .subscribe();

  return () => { cancelled = true; db.removeChannel(channel); };
}

// Single-row-style — for tables where a given filter matches at most one row
// (tenant_settings for one tenant, platform_config's single row).
export function subscribeToRow(table, filterColumn, filterValue, setState) {
  let cancelled = false;

  let initial = db.from(table).select("*");
  if (filterColumn) initial = initial.eq(filterColumn, filterValue);
  initial.maybeSingle().then(({ data, error }) => {
    if (cancelled) return;
    if (error) { console.error(`${table} initial load failed`, error); return; }
    setState(data ? toCamelCase(data) : null);
  });

  const channel = db
    .channel(`${table}-row-${filterColumn || "all"}-${filterValue || "all"}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table, filter: filterColumn ? `${filterColumn}=eq.${filterValue}` : undefined },
      (payload) => { setState(payload.eventType === "DELETE" ? null : toCamelCase(payload.new)); }
    )
    .subscribe();

  return () => { cancelled = true; db.removeChannel(channel); };
}
