import React from "react";

// Grey placeholder shapes shown while the dashboard's code or data is still on
// its way, in the same frame as the real AppShell (TenantApp.jsx) so nothing
// jumps when the real content replaces it. No text and no hooks: the build also
// renders DashboardSkeleton to static HTML (scripts/build-landing-prerender.mjs)
// for a returning shop to see before any JavaScript has run, so it must work
// without window/document. Direction comes from <html dir>.

// The content area only: used inside the real shell while a tab's data loads.
export function ContentSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="h-7 w-44 rounded-lg bg-stone-200" />
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="h-3 w-16 rounded bg-stone-200" />
            <div className="mt-4 h-6 w-24 rounded bg-stone-200" />
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-stone-100 py-3.5 last:border-b-0">
            <div className="h-9 w-9 shrink-0 rounded-lg bg-stone-200" />
            <div className="h-3 flex-1 rounded bg-stone-200" />
            <div className="hidden h-3 w-24 rounded bg-stone-200 sm:block" />
            <div className="h-3 w-14 rounded bg-stone-200" />
          </div>
        ))}
      </div>
    </div>
  );
}

// The whole screen: sidebar (desktop) or top bar (mobile) plus the content area.
export function DashboardSkeleton() {
  return (
    <div className="flex h-screen w-full bg-stone-100" aria-hidden="true">
      <div className="hidden h-full w-60 shrink-0 flex-col bg-navy-900 lg:flex">
        <div className="flex items-center gap-3 px-5 py-6">
          <div className="h-11 w-11 shrink-0 rounded-xl bg-white/10" />
          <div className="h-5 w-20 rounded bg-white/10" />
        </div>
        <div className="flex-1 space-y-1 px-3">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <div className="size-[18px] shrink-0 rounded bg-white/10" />
              <div className="h-3 w-28 rounded bg-white/10" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-3 lg:hidden">
          <div className="size-5 rounded bg-stone-200" />
          <div className="h-4 w-16 rounded bg-stone-200" />
        </div>
        <main className="flex-1 overflow-hidden p-6">
          <ContentSkeleton />
        </main>
      </div>
    </div>
  );
}
