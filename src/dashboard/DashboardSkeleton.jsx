import React from "react";
import { tabForPath } from "../utils/dashboardPaths.js";

// Grey placeholder shapes shown while the dashboard's code or data is still on
// its way, drawn to match the page being opened (register, invoice table,
// WhatsApp cards...) inside the same frame as the real AppShell (TenantApp.jsx),
// so the real page replaces it without anything jumping. No text and no hooks:
// the build also renders every variant to static HTML
// (scripts/build-landing-prerender.mjs) and public/boot.js shows the one for
// the URL before any JavaScript has run, so this must work without
// window/document. Direction comes from <html dir>.

export const SKELETON_VARIANTS = ["home", "pos", "table", "stats", "reports", "cards", "settings"];

// Must agree with VARIANT_BY_PATH in public/boot.js (same pages, by URL there).
const VARIANT_BY_TAB = {
  home: "home", pos: "pos",
  invoices: "table", delivery_invoices: "table", customers: "table", promotions: "table", branches: "table",
  inventory: "stats", purchases: "stats", reports: "reports", whatsapp: "cards", settings: "settings",
};
export function skeletonVariantForTab(tab) {
  return VARIANT_BY_TAB[tab] || "home";
}
export function skeletonVariantForPath(path) {
  const resolved = tabForPath(path);
  return skeletonVariantForTab(resolved ? resolved.tab : "home");
}

const Bar = ({ className }) => <div className={`rounded bg-stone-200 ${className}`} />;
const Box = ({ className = "", children }) => <div className={`rounded-2xl border border-stone-200 bg-white ${className}`}>{children}</div>;

function Title({ subtitle = true }) {
  return (
    <div>
      <Bar className="h-6 w-40" />
      {subtitle && <Bar className="mt-2.5 h-3 w-64" />}
    </div>
  );
}

function StatCards({ count }) {
  return (
    <div className={`mt-6 grid grid-cols-2 gap-4 ${count === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
      {Array.from({ length: count }, (_, i) => (
        <Box key={i} className="p-4">
          <div className="size-8 rounded-lg bg-stone-100" />
          <Bar className="mt-4 h-3 w-20" />
          <Bar className="mt-2.5 h-5 w-16" />
        </Box>
      ))}
    </div>
  );
}

function Rows({ count, cols = 4 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="flex items-center gap-4 border-b border-stone-100 px-4 py-3.5 last:border-b-0">
      <Bar className="h-3 w-16" />
      <Bar className="h-3 flex-1" />
      {cols > 3 && <Bar className="hidden h-3 w-20 sm:block" />}
      <Bar className="h-5 w-14 rounded-full" />
    </div>
  ));
}

function HomeContent() {
  return (
    <>
      <Bar className="h-6 w-28" />
      <StatCards count={4} />
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Box className="lg:col-span-2">
          <div className="flex items-center justify-between px-4 py-4"><Bar className="h-4 w-28" /><Bar className="h-3 w-14" /></div>
          <Rows count={4} cols={3} />
        </Box>
        <Box className="p-4">
          <Bar className="h-4 w-24" />
          <div className="mt-4 h-10 rounded-lg bg-stone-200" />
          <div className="mt-2.5 h-10 rounded-lg border border-stone-200" />
          <div className="mt-2.5 h-10 rounded-lg border border-stone-200" />
        </Box>
      </div>
    </>
  );
}

function PosContent() {
  return (
    <div className="flex flex-col gap-4 lg:h-full lg:flex-row">
      <div className="min-w-0 flex-1">
        <div className="h-10 rounded-xl border border-stone-200 bg-white" />
        <div className="mt-3 flex gap-2"><Bar className="h-8 w-14 rounded-full" /><Bar className="h-8 w-36 rounded-full" /></div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Box key={i} className="overflow-hidden">
              <div className="aspect-[4/3] bg-stone-100" />
              <div className="p-3"><Bar className="h-3.5 w-16" /><Bar className="mt-2 h-3 w-12" /></div>
            </Box>
          ))}
        </div>
      </div>
      <Box className="flex flex-col p-4 lg:w-80">
        <Bar className="h-5 w-20" />
        <Bar className="mt-5 h-3 w-16" />
        <div className="mt-2 h-10 rounded-lg border border-stone-200" />
        <div className="my-6 flex flex-1 items-center justify-center"><div className="size-10 rounded-full bg-stone-100" /></div>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-12 rounded-lg border border-stone-200" />)}
        </div>
        <div className="mt-4 flex justify-between"><Bar className="h-4 w-14" /><Bar className="h-4 w-16" /></div>
        <div className="mt-3 h-11 rounded-lg bg-stone-200" />
      </Box>
    </div>
  );
}

function TableContent() {
  return (
    <>
      <Title />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="h-10 w-full rounded-xl border border-stone-200 bg-white sm:w-72" />
        {["w-14", "w-16", "w-12", "w-12", "w-12"].map((w, i) => <div key={i} className={`h-8 rounded-full bg-stone-200 ${w}`} />)}
      </div>
      <Box className="mt-4">
        <div className="flex gap-4 border-b border-stone-100 px-4 py-3">
          {Array.from({ length: 6 }, (_, i) => <Bar key={i} className="h-3 flex-1" />)}
        </div>
        <Rows count={6} />
      </Box>
    </>
  );
}

function StatsContent() {
  return (
    <>
      <div className="flex items-start justify-between gap-4"><Title /><Bar className="h-10 w-32 rounded-lg" /></div>
      <StatCards count={3} />
      <div className="mt-6 h-10 w-full max-w-md rounded-xl border border-stone-200 bg-white" />
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Box key={i} className="overflow-hidden">
            <div className="h-36 bg-stone-100" />
            <div className="space-y-2.5 p-4"><Bar className="h-3.5 w-20" /><Bar className="h-3 w-28" /><Bar className="h-3 w-14" /></div>
          </Box>
        ))}
      </div>
    </>
  );
}

function ReportsContent() {
  return (
    <>
      <Title />
      <div className="mt-5 flex flex-wrap gap-2">{Array.from({ length: 5 }, (_, i) => <Bar key={i} className="h-8 w-24 rounded-full" />)}</div>
      <StatCards count={4} />
      <Box className="mt-6 p-5"><Bar className="h-4 w-32" /><div className="mt-5 h-56 rounded-xl bg-stone-100" /></Box>
    </>
  );
}

function CardsContent() {
  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3"><Title /><Bar className="h-9 w-48 rounded-full" /></div>
      <div className="mt-5 grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Box key={i} className="rounded-xl">
            <div className="p-5 pb-4">
              <div className="flex items-center justify-between"><div className="flex items-center gap-3"><div className="size-9 rounded-lg bg-stone-100" /><Bar className="h-4 w-24" /></div><Bar className="h-6 w-11 rounded-full" /></div>
              <Bar className="mt-3 h-3 w-full" /><Bar className="mt-2 h-3 w-2/3" />
              <div className="mt-3 h-32 rounded-lg bg-stone-100" />
            </div>
            <div className="border-t border-stone-200"><div className="flex justify-between px-5 py-3.5"><Bar className="h-3 w-24" /><Bar className="h-3 w-4" /></div></div>
            <div className="border-t border-stone-200"><div className="flex justify-between px-5 py-3.5"><Bar className="h-3 w-20" /><Bar className="h-3 w-4" /></div></div>
          </Box>
        ))}
      </div>
    </div>
  );
}

function SettingsContent() {
  return (
    <>
      <Bar className="h-6 w-28" />
      <Box className="mt-6 p-5">
        <Bar className="h-4 w-16" /><Bar className="mt-2 h-3 w-72" />
        <div className="mt-4 grid grid-cols-3 gap-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-12 rounded-xl border border-stone-200" />)}</div>
      </Box>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Box className="space-y-4 p-5">
          <Bar className="h-4 w-28" />
          {Array.from({ length: 4 }, (_, i) => <div key={i}><Bar className="h-3 w-24" /><div className="mt-2 h-10 rounded-lg border border-stone-200" /></div>)}
        </Box>
        <div className="space-y-4">
          {Array.from({ length: 2 }, (_, i) => <Box key={i} className="p-5"><Bar className="h-4 w-48" /><Bar className="mt-2.5 h-3 w-64" /></Box>)}
        </div>
      </div>
    </>
  );
}

const CONTENT = { home: HomeContent, pos: PosContent, table: TableContent, stats: StatsContent, reports: ReportsContent, cards: CardsContent, settings: SettingsContent };

// The content area only: used inside the real shell while a tab's data loads.
export function ContentSkeleton({ variant = "home" }) {
  const Content = CONTENT[variant] || HomeContent;
  return <div className="animate-pulse lg:h-full" aria-hidden="true"><Content /></div>;
}

// The whole screen: sidebar (desktop) or top bar (mobile) plus the content area.
export function DashboardSkeleton({ variant = "home" }) {
  return (
    <div className="flex h-screen w-full bg-stone-100" aria-hidden="true">
      <div className="hidden h-full w-60 shrink-0 flex-col bg-navy-900 lg:flex">
        <div className="flex items-center gap-3 px-5 py-6">
          <div className="h-11 w-11 shrink-0 rounded-xl bg-white/10" />
          <div className="h-5 w-20 rounded bg-white/10" />
        </div>
        <div className="flex-1 space-y-1 px-3">
          {Array.from({ length: 11 }, (_, i) => (
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
          <ContentSkeleton variant={variant} />
        </main>
      </div>
    </div>
  );
}
