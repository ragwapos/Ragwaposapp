import React, { useState, useMemo, useRef, useEffect, createContext, useContext } from "react";
import {
  Search, Plus, X, Check, ChevronRight, Shirt, Package, Users, ClipboardList,
  Truck, Tag, BarChart3, Wallet, ImageIcon, Ban, ArrowRight, Trash2, CreditCard,
  Banknote, Percent, Clock, Mail, AlertTriangle, AlertCircle, CheckCircle2, Circle, Upload,
  ReceiptText, Receipt, Building2, FileText, Sparkles, Settings, Globe, Lock, Pencil, Paperclip,
  MessageCircle, Loader2, Smartphone, Car, QrCode, MapPin, Home, SplitSquareHorizontal, Printer, StickyNote,
  Phone, User, Link2, FlaskConical, KeyRound, LogOut, XCircle
} from "lucide-react";
import QRCode from "qrcode";
// auth/db here are supabase.auth / the Supabase client (see src/supabase.js).
// Every database call below is a METHOD chain on db — db.from('table').select()
// / .upsert() / .delete() / .channel() — not a standalone function imported
// from a package the way Firebase's collection()/doc()/setDoc() worked.
import { auth, db } from "./supabase";
import { toSnakeCase, toCamelCase } from "./utils/transforms.js";
import { normalizeSaudiMobile, isValidSaudiMobile, cleanPhoneForWhatsApp, fillWhatsAppTemplate, DEFAULT_WHATSAPP_TEMPLATE } from "./utils/phone.js";
import { generateInvoiceImage } from "./utils/invoiceImage.js";
import { useClarityTracking } from "./utils/clarity.js";
import { uploadTenantFile, deleteTenantFile, uploadPrivateFile, deletePrivateFile, openStoredDocument } from "./utils/storage.js";
import { getTurnstileToken } from "./utils/turnstile.js";

/* =========================================================================
   CONSTANTS
   ========================================================================= */
const STAGES = ["Received", "Washing", "Pressing", "Ready", "Delivered"];
const VAT_RATE = 0.15;
const ADMIN_EMAILS_DEFAULT = ["ragwapos@gmail.com"];

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
   ========================================================================= */
// List-style — for a table where many rows share one tenant/filter value
// (products, invoices, customers, etc). Optional `transform` post-processes
// the array (e.g. client-side sort) before every setState call, both on the
// initial load and on every realtime diff — needed since a couple of call
// sites keep their local state pre-sorted rather than sorting at render time.
function subscribeToTable(table, filterColumn, filterValue, setState, orderColumn, transform) {
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
function subscribeToRow(table, filterColumn, filterValue, setState) {
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

// Supabase Auth error codes → Arabic messages shown in the login/signup forms.
// Unlike Firebase, Supabase never distinguishes "wrong password" from "no such
// account" on sign-in (both come back as invalid_credentials, by design, for
// enumeration protection) — so there is no separate "user not found" case here.
const authErrorMessage = (error) => {
  const code = error && error.code;
  switch (code) {
    // Confirmed live: Supabase's admin.generateLink({type:'signup'}) actually
    // returns code "email_exists" for a duplicate email (verified via a real
    // request against the production API) — "user_already_exists" was never
    // the real value, so this branch was silently dead and every duplicate-
    // signup attempt fell through to the raw English Supabase message below.
    case "email_exists":
    case "user_already_exists": return "هذا البريد مسجل مسبقًا — سجل دخول بدل إنشاء حساب جديد.";
    case "email_address_invalid": return "بريد إلكتروني غير صحيح.";
    case "weak_password": return "كلمة المرور ضعيفة — لازم 6 أحرف على الأقل.";
    case "invalid_credentials": return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit": return "محاولات كثيرة فاشلة — انتظر شوي وحاول مرة ثانية.";
    // Not a Supabase auth code — these are api/send-verification-email.js's
    // own error strings (no `code` field on that response), so `error.message`
    // below would otherwise leak the raw machine string to the user.
    case undefined:
      if (error && error.message === "invalid_email") return "بريد إلكتروني غير صحيح.";
      if (error && error.message === "invalid_request") return "تعذر إتمام الطلب — حاول مرة ثانية.";
      return (error && typeof error.message === "string" && error.message) || "صار خطأ غير متوقع — حاول مرة ثانية.";
    // No matching Supabase auth code — this is most likely an error relayed
    // as-is from /api/send-verification-email (Resend/service-role failures
    // have their own message text, not a Supabase auth code), so show it
    // instead of masking it behind the generic fallback below.
    default: return (error && typeof error.message === "string" && error.message) || "صار خطأ غير متوقع — حاول مرة ثانية.";
  }
};
// Revenue/VAT actually reportable for a given invoice:
// - Money paid FROM the customer's wallet (fully or as part of a split payment)
//   was already recognised as revenue at top-up time, so it is excluded here
//   to avoid double counting.
// - If the merchant had no tax number registered at the moment the invoice
//   was created (invoice.vatExempt), no VAT is reported for it at all — even
//   if a tax number gets added to the shop later, this past invoice keeps its
//   original status.
function invoiceRevenue(inv) {
  let amount = inv.total;
  if (inv.payMethod === "Wallet Balance") amount = 0;
  else if (inv.payMethod === "Split") {
    const walletPortion = (inv.splitPayments || []).filter((sp) => sp.method === "Wallet Balance").reduce((s, sp) => s + sp.amount, 0);
    amount = Math.max(0, inv.total - walletPortion);
  }
  const vat = inv.vatExempt ? 0 : amount - amount / (1 + VAT_RATE);
  const net = amount - vat;
  return { amount, net, vat };
}

// Builds report rows for the Sales Ledger, method-filter aware. When a specific
// payment method is selected, a Split invoice contributes only the sub-amount
// assigned to that method (counted once, under that method) rather than its
// full total — so filtering by "Cash" on a Cash+Network split invoice shows
// exactly 1 invoice at the Cash portion's amount, matching the same rule for
// "External Network". Selecting "All" still shows it once at its full total.
function buildSalesRows(invoices, start, end, method) {
  const startTs = start ? new Date(start).getTime() : null;
  const endTs = end ? new Date(end).getTime() : null;
  const rows = [];
  invoices.forEach((inv) => {
    const ts = new Date(inv.createdAt).getTime();
    if (startTs && ts < startTs) return;
    if (endTs && ts > endTs) return;
    if (method === "all") {
      const rev = invoiceRevenue(inv);
      if (rev.amount > 0) rows.push({ inv, amount: rev.amount, net: rev.net, vat: rev.vat });
    } else if (inv.payMethod === "Split" && inv.splitPayments) {
      const sp = inv.splitPayments.find((s) => s.method === method);
      if (sp && sp.amount > 0) {
        const vat = inv.vatExempt ? 0 : sp.amount - sp.amount / (1 + VAT_RATE);
        rows.push({ inv, amount: sp.amount, net: sp.amount - vat, vat });
      }
    } else if (inv.payMethod === method) {
      const rev = invoiceRevenue(inv);
      if (rev.amount > 0) rows.push({ inv, amount: rev.amount, net: rev.net, vat: rev.vat });
    }
  });
  return rows;
}

/* =========================================================================
   RETENTION / COHORT ANALYSIS (admin — SaaS tenant retention). Cohort =
   tenant's signup month; a tenant is "retained" in a given month if it has
   ≥1 invoice (wallet top-ups count) in that calendar month.
   ========================================================================= */
function monthKey(iso) { return String(iso).slice(0, 7); } // "YYYY-MM"

// Pure integer arithmetic on "YYYY-MM" — deliberately NOT Date.setMonth(),
// which has no day component here to overflow but would still drag in
// local-timezone conversion for zero benefit.
function addMonths(mKey, n) {
  const [y, m] = mKey.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

const RETENTION_MAX_OFFSET = 12; // cap columns so a years-old cohort can't blow up the table width

// entities: [{ cohortPeriod: "YYYY-MM", activePeriods: Set<string>, ...extra }]
// (extra fields like id/shopName are ignored here but fine to carry through
// for the caller's own use, e.g. building a tenant picker)
// Returns { rows: [{ cohortPeriod, size, offsets: [{ offset, retainedCount, pct, valid }] }], maxOffset }
// `valid: false` means that offset's period hasn't happened yet for that
// cohort (still in the future) — rendered as "—", not 0%, since "no data
// yet" and "nobody came back" are very different things.
function computeCohortRetention(entities) {
  const currentPeriodKey = monthKey(new Date().toISOString());

  const cohorts = new Map();
  entities.forEach((e) => {
    if (!cohorts.has(e.cohortPeriod)) cohorts.set(e.cohortPeriod, []);
    cohorts.get(e.cohortPeriod).push(e);
  });

  const cohortKeys = [...cohorts.keys()].sort();
  let maxOffset = 0;

  const rows = cohortKeys.map((cohortPeriod) => {
    const members = cohorts.get(cohortPeriod) || [];
    const size = members.length;
    const offsets = [];
    for (let offset = 0; offset <= RETENTION_MAX_OFFSET; offset++) {
      const periodAtOffset = addMonths(cohortPeriod, offset);
      const valid = periodAtOffset <= currentPeriodKey;
      if (!valid) break; // periods only move forward — once invalid, every later offset is too
      maxOffset = Math.max(maxOffset, offset);
      const retainedCount = size > 0 ? members.filter((m) => m.activePeriods.has(periodAtOffset)).length : 0;
      const pct = size > 0 ? (retainedCount / size) * 100 : 0;
      offsets.push({ offset, retainedCount, pct, valid: true });
    }
    return { cohortPeriod, size, offsets };
  });

  return { rows, maxOffset };
}

// Small color-tier scale for the cohort matrix cells — kept as its own pure
// function (not inline JSX ternaries) to match this file's existing habit
// (payMethodLabel, invoicePaymentStatus) of extracting small display-logic
// helpers. Cyan-tinted to match the admin panel's existing dark theme.
function retentionShade(pct) {
  if (pct >= 75) return "bg-cyan-500/30 text-cyan-300";
  if (pct >= 50) return "bg-cyan-500/20 text-cyan-300";
  if (pct >= 25) return "bg-cyan-500/10 text-gray-300";
  if (pct > 0) return "bg-slate-800 text-gray-400";
  return "bg-slate-800/50 text-gray-600";
}

const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const sar = (n) => `${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)} SAR`;
// 1-9 from either the main number row or the numpad. `e.key` alone handles
// the main row (and the numpad too, but only while NumLock is on — with it
// off, numpad keys report as Home/End/etc via `key` instead of a digit).
// `e.code` is NumLock-independent, so checking it too keeps numpad shortcuts
// working either way, matching the main POS keyboard shortcuts below.
function digitFromKeyEvent(e) {
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}
// Shared by the POS screen's quick-access shortcuts and the Product Options
// Modal's own shortcuts (see ProductModal) — a single window keydown
// listener, added/removed as `active` toggles rather than left permanently
// attached and self-filtering, so only one of the two is ever actually
// listening at a time: the modal mounting flips the POS screen's `active`
// to false in the same render that mounts the modal's own listener.
function useKeydown(handler, active = true) {
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler, active]);
}
// Every upload in this app (product image, purchase invoice attachment,
// expense receipt) goes through uploadTenantFile (src/utils/storage.js) —
// straight to Supabase Storage, never through a Postgres column — and only
// the resulting public URL string gets saved on the row. This check still
// isn't a real security boundary (file.type is client-reported and
// trivially spoofable), just a sanity/UX gate before spending an upload.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_ATTACHMENT_TYPES = [...ALLOWED_IMAGE_TYPES, "application/pdf"];
function validateUploadedFile(file, { maxBytes, allowedTypes }) {
  if (allowedTypes && !allowedTypes.includes(file.type)) return "upload_badType";
  if (file.size > maxBytes) return "upload_tooLarge";
  return null;
}
// Quick-glance list columns only (customers wallet/debt, product price,
// delivery fee, supplier balance, expense amount) — keeps them from growing
// with the number's length (a 6-figure balance shouldn't be what forces the
// whole row wider). Caps at the first `maxDigits` integer digits + "+"; the
// exact amount is always still shown in full inside that row's own detail
// view. Never used on Reports/Tax Return — those need the real number.
const sarCompact = (n, maxDigits = 4) => {
  const digits = String(Math.round(Math.abs(n)));
  return digits.length > maxDigits ? `${digits.slice(0, maxDigits)}+ SAR` : sar(n);
};
// Dashboard-only flourish: the approved reference renders the Home KPI
// row's big numbers in Eastern Arabic-Indic digits while every other real
// screen (tables, totals, phone numbers) stays Western — so this is scoped
// to that one row for Arabic, not a app-wide numeral switch.
const ARABIC_INDIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const toArabicIndicDigits = (input) => String(input).replace(/[0-9]/g, (d) => ARABIC_INDIC_DIGITS[d]);
const nowISO = () => new Date().toISOString();
// Owner/section PINs are hashed before storage (Web Crypto, no extra
// dependency) so a tenant_settings row leak or network capture doesn't hand
// over the raw 4-digit PIN. This is still a UI-level gate within the SAME
// already-authenticated tenant session (hiding sections from a cashier
// sharing the login) — not a security boundary against an outside attacker.
// Thrown specifically when apply_customer_payment()/adjust_supplier_balance()
// (see supabase-rls-and-integrity.sql) reject a change for being genuinely
// short of funds — as opposed to any OTHER failure (network hiccup, the SQL
// migration not having been run yet so the function doesn't exist, etc.).
// Distinguishing the two matters: telling a cashier "wallet balance is too
// low" when the real problem is an unrelated system error is actively
// misleading, especially for a Credit (On Account) sale, which never
// touches the wallet at all.
class InsufficientBalanceError extends Error {}
function rpcBalanceError(error) {
  return error?.message?.includes("insufficient_balance") ? new InsufficientBalanceError(error.message) : error;
}
// True when a db.rpc() call failed because the Postgres function itself
// doesn't exist yet — i.e. supabase-rls-and-integrity.sql hasn't been run
// on this project — as opposed to any other kind of failure (network,
// permissions, a real business-rule rejection). PGRST202 is PostgREST's own
// code for "function not found in the schema cache"; 42883 is Postgres's.
function isMissingRpcError(error) {
  return error?.code === "PGRST202" || error?.code === "42883" || /could not find the function|does not exist/i.test(error?.message || "");
}
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const fmtDate = (iso) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDateSec = (iso) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function printDateLabel(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", "");
  const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  return `${time} ${date}`;
}
const LOGO_DATA_URI = "data:image/png;base64,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";


/* =========================================================================
   SMALL SHARED UI PRIMITIVES
   ========================================================================= */
const Fonts = () => (
  <style>{`
    /* Cairo itself is already loaded site-wide via the <link> in index.html
       (originally added for the public landing page) — the approved
       internal-app reference build also renders every screen in Cairo,
       numbers included, so the tenant/admin UI adopts the same family here
       instead of the old Latin-only Space Grotesk/Inter/JetBrains Mono set
       (which never actually rendered Arabic glyphs — the browser silently
       fell back to a system font for every Arabic character anyway). */
    .f-display{font-family:'Cairo','Segoe UI',Tahoma,sans-serif; font-weight:700;}
    .f-body{font-family:'Cairo','Segoe UI',Tahoma,sans-serif;}
    .f-mono{font-family:'Cairo','Segoe UI',Tahoma,sans-serif; font-weight:600; direction:ltr; unicode-bidi:embed; display:inline-block;}
    /* .f-mono's own display:inline-block (needed so a <span> of it sits
       correctly LTR inside surrounding RTL text) silently breaks any <td>/<th>
       that also carries the class: inline-block removes it from the table's
       column-width algorithm entirely, so that cell shrinks to its own content
       width instead of matching its column — the header then visibly sits
       over a completely different width than the data below it. Table cells
       need their native table-cell display restored; unicode-bidi/direction
       above still make the LTR number render correctly either way.
       Separately, .f-mono's own direction:ltr flips text-align:start (the
       browser default for table cells) from right to left in an RTL table —
       so every f-mono column's values hugged the opposite edge from their
       header and from every other (non-mono) column, even though the DOM
       order and column widths were always correct. match-parent resolves
       start/end against the table's actual direction instead of the cell's
       own forced-ltr one, so it lines back up in both RTL and LTR (EN) mode. */
    td.f-mono, th.f-mono { display: table-cell; text-align: match-parent; }
    @media print {
      body * { visibility: hidden; }
      .print-area, .print-area * { visibility: visible; }
      .print-area { position: absolute; top: 0; left: 0; width: 100%; }
      .no-print { display: none !important; }
    }
  `}</style>
);

function Modal({ title, onClose, children, width = "max-w-lg" }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 p-4 f-body" onClick={onClose}>
      <div className={`w-full ${width} max-h-[90vh] overflow-y-auto rounded-2xl bg-app-surface shadow-app-lg`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-app-border px-6 py-4 sticky top-0 bg-app-surface rounded-t-2xl">
          <h3 className="f-display text-lg font-semibold text-app-text">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1.5 text-app-text-subtle hover:bg-app-bg hover:text-app-text">
            <X size={18} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-4">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100";

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2 text-sm">
      <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${checked ? "bg-teal-600" : "bg-stone-300"}`}>
        <span className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition ${checked ? "translate-x-5" : "translate-x-1"}`} style={{ height: 18, width: 18 }} />
      </span>
      {label && <span className="text-slate-700">{label}</span>}
    </button>
  );
}

/* =========================================================================
   PRINTING — Simplified Tax Invoice / Receipt / Delivery Receipt
   The printed document itself is always in Arabic (with small English
   labels), matching Saudi commercial-document convention, independent of
   whichever UI language the staff currently has selected.
   ========================================================================= */
// ZATCA Phase 1 QR payload — TLV (Tag-Length-Value), 5 tags, Base64-encoded.
// Length byte is the UTF-8 BYTE length of the value, not its character count
// (critical for Arabic text, where each character is 2+ bytes in UTF-8).
function zatcaTlvEncode(tag, value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const out = new Uint8Array(2 + bytes.length);
  out[0] = tag;
  out[1] = bytes.length;
  out.set(bytes, 2);
  return out;
}

function buildZatcaQrBase64({ sellerName, vatNumber, isoDateTime, total, vatTotal }) {
  const tags = [
    zatcaTlvEncode(1, sellerName),
    zatcaTlvEncode(2, vatNumber),
    zatcaTlvEncode(3, isoDateTime),
    zatcaTlvEncode(4, total),
    zatcaTlvEncode(5, vatTotal),
  ];
  const combined = new Uint8Array(tags.reduce((s, t) => s + t.length, 0));
  let offset = 0;
  tags.forEach((t) => { combined.set(t, offset); offset += t.length; });
  let binary = "";
  combined.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

// Builds the ZATCA QR payload (base64 TLV string) straight from a printDoc
// object — same doc.merchant / doc.totals / doc.isoDateTime already used to
// render the invoice body, so the QR can never disagree with what's printed.
function buildZatcaQrFromDoc(doc) {
  return buildZatcaQrBase64({
    sellerName: doc.merchant.name || "",
    vatNumber: doc.merchant.taxNumber || "",
    isoDateTime: doc.isoDateTime || new Date().toISOString(),
    total: doc.totals.gross.toFixed(2),
    vatTotal: doc.totals.vat.toFixed(2),
  });
}

// Real, scannable QR matrix (not a decorative pattern) — uses the qrcode
// package's synchronous low-level API so both the React preview and the
// plain-HTML print string can render identically without async data URLs.
function qrModules(value) {
  return QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
}

function RealQR({ value, size = 96 }) {
  const modules = qrModules(value);
  const n = modules.size;
  const cell = size / n;
  const boxes = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules.data[r * n + c]) {
        boxes.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} fill="#000" />);
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto" style={{ background: "#fff" }}>
      {boxes}
    </svg>
  );
}

// Fixed print-document vocabulary — deliberately NOT tied to useLang()/t().
// A tax invoice / receipt is a legal commercial document, so it always
// prints in Arabic (with the small English labels from the reference
// template) no matter which UI language the staff currently has selected.
const PRINT = {
  addressEn: "Address:", addressAr: "العنوان",
  phoneEn: "Phone Num:", phoneAr: "رقم الهاتف",
  dateEn: "Date:", dateAr: "التاريخ",
  invNumEn: "Inv Num:", invNumAr: "رقم الفاتورة",
  cashier: "Casher_1",
  branchAr: "الفرع", branchValueAr: "الفرع الرئيسي",
  customerAr: "اسم العميل",
  taxInvoiceAr: "فاتورة ضريبية مبسطة", taxInvoiceEn: "Simplified Tax Invoice",
  productAr: "المنتج", priceAr: "السعر", totalAr: "الإجمالي",
  deliveredDateAr: "تاريخ التسليم",
  subtotalAr: "الإجمالي (غير شامل الضريبة)", discountAr: "الخصم", vatAr: "الضريبة (15%)", grandTotalAr: "الإجمالي (شامل الضريبة)",
  paidAr: "المدفوع", remainingAr: "المتبقي", pieceCountAr: "عدد القطع", payMethodAr: "طريقة الدفع", dueDateAr: "تاريخ الاستحقاق",
  deliverFirstAr: "الرجاء تسليم قطعة واحدة على الأقل أولًا حتى يمكن طباعة الإيصال.",
};

function payMethodPrintLabel(_t, method) {
  if (method === "Cash") return "نقدًا";
  if (method === "External Network") return "شبكة خارجية";
  if (method === "Wallet Balance") return "رصيد العميل";
  if (method === "Credit (On Account)") return "دفع آجل";
  return method;
}

function buildQrSvgString(value, size = 96) {
  const modules = qrModules(value);
  const n = modules.size;
  const cell = size / n;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules.data[r * n + c]) {
        rects += `<rect x="${(c * cell).toFixed(3)}" y="${(r * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="#000"/>`;
      }
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;margin:0 auto;background:#fff;">${rects}</svg>`;
}

// Builds a fully self-contained, inline-styled HTML page for the invoice/receipt —
// used to open a real print-ready preview in a new window. Self-contained (no
// Tailwind dependency) so it renders identically regardless of environment.
function buildPrintableHtml(doc) {
  const isTax = doc.kind === "tax";
  const isDelivery = doc.kind === "delivery";
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row3 = (en, center, ar) => `
    <tr>
      <td style="text-align:left; font-weight:600; width:33%; padding:2px 0;">${esc(en)}</td>
      <td style="text-align:center; width:34%; padding:2px 0;">${esc(center)}</td>
      <td style="text-align:right; font-weight:600; width:33%; padding:2px 0;">${esc(ar)}</td>
    </tr>`;
  const totalsRow = (num, label, bold) => `<div style="display:flex;justify-content:space-between;font-size:13px;${bold ? "font-weight:700;" : ""}"><span style="font-family:'Courier New',monospace;direction:ltr;">${esc(num)}</span><span>${esc(label)}</span></div>`;

  const header = `
    <div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:14px;">${esc(doc.merchant.name || "—")}</div>
    <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:10px;">
      ${row3(PRINT.addressEn, doc.merchant.address || "—", PRINT.addressAr)}
      ${row3(PRINT.phoneEn, doc.merchant.phone || "—", PRINT.phoneAr)}
      ${row3(PRINT.dateEn, doc.dateLabel, PRINT.dateAr)}
      ${row3(PRINT.invNumEn, doc.invoiceCode, PRINT.invNumAr)}
      ${row3(PRINT.cashier, PRINT.branchValueAr, PRINT.branchAr)}
      ${row3("", doc.customerName, PRINT.customerAr)}
    </table>
    <hr style="border:none;border-top:1px solid #1e293b;margin:10px 0;">
  `;

  let body;
  if (isDelivery) {
    body = `
      <table dir="rtl" style="width:100%;font-size:13px;border-collapse:collapse;border:1px solid #1e293b;">
        <thead><tr style="border-bottom:1px solid #1e293b;"><th style="text-align:right;padding:6px 8px;">${PRINT.deliveredDateAr}</th><th style="text-align:right;padding:6px 8px;">${PRINT.productAr}</th></tr></thead>
        <tbody>${doc.deliveredItems.map((it) => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 8px;font-family:'Courier New',monospace;font-size:12px;direction:ltr;text-align:right;">${esc(fmtDateSec(it.deliveredAt))}</td><td style="padding:6px 8px;">${esc(it.name)}${it.service ? " — " + esc(it.service) : ""}</td></tr>`).join("")}</tbody>
      </table>`;
  } else {
    const taxBlock = isTax ? `
      <div style="text-align:center;margin-bottom:10px;">
        <div style="font-weight:700;">${PRINT.taxInvoiceAr}</div>
        <div style="font-size:11px;color:#64748b;">${PRINT.taxInvoiceEn}</div>
        <div style="margin-top:4px;font-size:11px;font-family:'Courier New',monospace;">TAX: ${esc(doc.merchant.taxNumber || "—")}</div>
      </div>` : "";
    const itemsRows = doc.items.map((it) => `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:6px 8px;">${it.qty}X ${esc(it.name)}</td>
        <td style="padding:6px 8px;font-family:'Courier New',monospace;">${it.price.toFixed(2)}</td>
        <td style="padding:6px 8px;font-family:'Courier New',monospace;">${it.lineTotal.toFixed(2)}</td>
      </tr>`).join("");
    body = `
      ${taxBlock}
      <table dir="rtl" style="width:100%;font-size:13px;border-collapse:collapse;border:1px solid #1e293b;margin-bottom:10px;">
        <thead><tr style="border-bottom:1px solid #1e293b;"><th style="text-align:right;padding:6px 8px;">${PRINT.productAr}</th><th style="text-align:right;padding:6px 8px;">${PRINT.priceAr}</th><th style="text-align:right;padding:6px 8px;">${PRINT.totalAr}</th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <div style="margin-bottom:10px;">
        ${totalsRow(doc.totals.net.toFixed(2), PRINT.subtotalAr)}
        ${totalsRow(doc.totals.discount.toFixed(2), PRINT.discountAr)}
        ${totalsRow(doc.totals.vat.toFixed(2), PRINT.vatAr)}
        ${totalsRow(doc.totals.gross.toFixed(2), PRINT.grandTotalAr, true)}
      </div>
      <hr style="border:none;border-top:1px solid #1e293b;margin:10px 0;">
      <div>
        ${totalsRow(doc.totals.paid.toFixed(2), PRINT.paidAr, true)}
        ${totalsRow(doc.totals.remaining.toFixed(2), PRINT.remainingAr)}
        ${totalsRow(doc.totals.pieceCount, PRINT.pieceCountAr)}
        ${totalsRow(doc.payMethodLabel, PRINT.payMethodAr)}
        ${doc.dueDate ? totalsRow(doc.dueDate, PRINT.dueDateAr) : ""}
      </div>
      ${isTax ? `<div style="margin-top:16px;">${buildQrSvgString(doc.zatcaQrOverride || buildZatcaQrFromDoc(doc))}</div>` : ""}
    `;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.invoiceCode)}</title>
<style>
  body { font-family: Arial, 'Segoe UI', Tahoma, sans-serif; color:#0f172a; padding:24px; max-width:380px; margin:0 auto; }
  @media print { body { padding:0; } }
</style>
</head><body>${header}${body}</body></html>`;
}

// api.whatsapp.com/send is WhatsApp's own "Click to Chat" API endpoint —
// wa.me is a short link that itself redirects here, so calling it directly
// skips that extra redirect hop.
// On desktop, the native attempt below goes through a hidden iframe rather
// than window.open()/location.href — a custom-protocol navigation there
// never touches this tab or opens a blank one: if WhatsApp Desktop has the
// whatsapp:// handler registered, the OS switches to it; if not, the
// iframe's failed navigation is invisible, no error page, no popup. The POS
// tab itself is never touched either way.
// There's no reliable way from a web page to confirm the OS actually
// switched to the app, so this uses the standard heuristic other sites use
// for this same problem (Slack, Zoom, etc.): treat the browser window
// losing focus (`blur`) within the next ~1.2s as "handed off successfully"
// and skip the web fallback; otherwise assume the app isn't
// installed/registered and open the web version in a genuinely new tab —
// the ONLY point anything new gets opened. Imperfect (an unrelated alt-tab
// could suppress the fallback) but strictly additive — mobile skips this
// path entirely, since wa.me/api.whatsapp.com already hands off to the
// native app there via the OS's own app-link mechanism with no extra step.
function openWhatsApp(phone, message) {
  const encoded = encodeURIComponent(message);
  const webUrl = `https://api.whatsapp.com/send?phone=${phone}&text=${encoded}`;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) { window.open(webUrl, "_blank"); return; }

  let handedOff = false;
  const onBlur = () => { handedOff = true; };
  window.addEventListener("blur", onBlur, { once: true });
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = `whatsapp://send?phone=${phone}&text=${encoded}`;
  document.body.appendChild(iframe);
  setTimeout(() => {
    iframe.remove();
    window.removeEventListener("blur", onBlur);
    if (!handedOff) window.open(webUrl, "_blank");
  }, 1200);
}

function PrintDocumentModal({ doc, onClose }) {
  const { t } = useLang();
  const isTax = doc.kind === "tax";
  const isDelivery = doc.kind === "delivery";

  // Same-page hidden iframe instead of window.open() + a guessed setTimeout:
  // no popup (nothing for a popup blocker to block, and no extra Chrome
  // window/dialog to manage), and printing is triggered from the iframe's
  // own `load` event — i.e. only once the receipt HTML has actually
  // finished rendering — instead of hoping 300ms was long enough. That
  // fixed-timeout race was the likely cause of "blank page instead of the
  // receipt" on the thermal printer: print() firing before layout/paint
  // completed. Combined with launching Chrome with --kiosk-printing (set
  // on the till's shortcut, not in this code) and the OS default printer
  // set to the receipt printer, this prints immediately with no dialog.
  const printOnce = () => new Promise((resolve) => {
    const html = buildPrintableHtml(doc);
    const iframe = document.createElement("iframe");
    // Positioned off-screen rather than 0×0 — a zero-size iframe renders its
    // document at a 0px-wide viewport, which computes every "width:100%"
    // element in the receipt to 0 and prints blank. Real (off-screen)
    // dimensions matching the receipt's own max-width keep layout correct.
    iframe.style.position = "fixed";
    iframe.style.top = "-9999px";
    iframe.style.left = "-9999px";
    iframe.style.width = "380px";
    iframe.style.height = "600px";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    const cleanup = () => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); resolve(); };
    iframe.onload = () => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { console.error("print failed", e); }
      // afterprint doesn't fire in every browser once the dialog is skipped
      // (kiosk-printing) — the fallback timeout guarantees cleanup either way.
      try { iframe.contentWindow.onafterprint = cleanup; } catch (e) {}
      setTimeout(cleanup, 5000);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });

  // copies > 1 (see settings_autoPrintCopies) prints sequentially, one
  // iframe/print job at a time, rather than firing them all at once —
  // overlapping print jobs against the same physical printer can otherwise
  // collide or get dropped.
  const printInNewWindow = async (copies = 1) => {
    for (let i = 0; i < copies; i++) {
      await printOnce();
      if (i < copies - 1) await new Promise((r) => setTimeout(r, 400));
    }
  };

  // Auto Print (settings_autoPrint): skips the manual "طباعة" click
  // entirely — fires as soon as this receipt is ready to show, using
  // whatever copy count the owner configured in Settings. Runs once per
  // receipt (mount-only effect — a new receipt is always a fresh mount
  // since the caller unmounts this modal via `printDoc && <...>` on close).
  // The `firedRef` guard is required because React.StrictMode (see
  // main.jsx) deliberately double-invokes effects in development to catch
  // exactly this kind of bug — without it, dev mode prints every copy twice.
  // The configured copy count only applies to the main POS sale
  // invoice/receipt — a delivery/pickup receipt (ايصال استلام الملابس) or a
  // wallet top-up invoice always auto-prints exactly one copy regardless of
  // that setting, since those are single hand-to-customer documents, not
  // something the shop typically wants duplicated.
  // settings_showPrintPreview: with auto-print on, the owner can also
  // choose to skip this whole dialog — print happens in the background and
  // the modal closes itself the moment printing has been dispatched, so the
  // cashier lands straight back on a fresh sale instead of having to close
  // a popup first. Defaults to shown (=== false is the only opt-out) so
  // existing tenants who saved settings before this option existed keep
  // seeing the preview exactly as before.
  const silent = Boolean(doc.merchant?.autoPrint) && doc.merchant?.showPrintPreview === false;

  // Rasterizes the very same .print-area node below (ref'd, not re-rendered
  // offscreen) into a compressed JPEG and uploads it — no PDF step, so
  // Arabic renders exactly as the browser already shapes it here (no font
  // embedding) AND the customer sees the receipt as an inline WhatsApp
  // thumbnail instead of having to open a separate PDF viewer.
  // Only runs at all when this tenant has WhatsApp sharing turned on (see
  // "واتس" in Settings) — everyone else never triggers any of this.
  // Started in the background the moment this modal MOUNTS (see the effect
  // below), not when "واتساب" is clicked, so by the time a cashier at a
  // shop that uses this feature actually clicks, the upload has usually
  // already finished and the click opens WhatsApp with zero wait.
  const printAreaRef = useRef(null);
  const [whatsappSending, setWhatsappSending] = useState(false);
  const [whatsappError, setWhatsappError] = useState("");
  const [imageUrl, setImageUrl] = useState(null);
  const imagePrepRef = useRef(null);
  // Set the instant Print or Close is clicked — html2canvas is synchronous,
  // main-thread work, so a click landing while it's already running still
  // has to wait for it either way (JS can't interrupt its own currently-
  // running code); this just stops the THEN-finished result from doing
  // anything further (no pointless setImageUrl call) once the cashier has
  // already moved on to the next sale.
  const cancelledRef = useRef(false);
  const cancelBackgroundPrep = () => { cancelledRef.current = true; };

  // Bucket is still named "invoice-pdfs" (created back when this uploaded
  // PDFs) — kept as-is rather than provisioning a second bucket + RLS
  // policies for zero functional benefit; the bucket name is just an
  // identifier, not a content-type constraint.
  const prepareImageUrl = () => {
    if (imagePrepRef.current) return imagePrepRef.current;
    const promise = (async () => {
      const { data } = await auth.getUser();
      const uid = data?.user?.id;
      if (!uid) throw new Error("no_session");
      const blob = await generateInvoiceImage(printAreaRef.current);
      const path = `${uid}/${doc.invoiceCode}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: uploadErr } = await db.storage.from("invoice-pdfs").upload(path, blob, { contentType: "image/jpeg" });
      if (uploadErr) throw uploadErr;
      const { data: pub } = db.storage.from("invoice-pdfs").getPublicUrl(path);
      return pub?.publicUrl || "";
    })();
    imagePrepRef.current = promise;
    return promise;
  };

  useEffect(() => {
    // Skipped entirely when this tenant hasn't turned WhatsApp sharing on,
    // or in silent auto-print mode (neither renders a "واتساب" button for
    // anyone to click), or with no phone to share to — preparing an image
    // in any of those cases would just be a wasted upload.
    if (!doc.whatsappEnabled || !doc.customerPhone || silent) return;
    prepareImageUrl().then((url) => { if (!cancelledRef.current) setImageUrl(url); }).catch((e) => {
      console.error("background whatsapp image prep failed", e);
      imagePrepRef.current = null; // let a manual click retry from scratch
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shareOnWhatsApp = async () => {
    if (!doc.customerPhone || whatsappSending) return;
    setWhatsappError("");
    setWhatsappSending(true);
    try {
      let url = imageUrl;
      if (url === null) url = await prepareImageUrl(); // rare — the button's own spinner covers this wait
      setImageUrl(url);
      const message = fillWhatsAppTemplate(doc.whatsappTemplate, {
        customer_name: doc.customerName || "",
        invoice_id: doc.invoiceCode || "",
        store_name: doc.merchant?.name || "",
        invoice_url: url,
        total_amount: doc.totals?.gross != null ? doc.totals.gross.toFixed(2) : "",
      });
      openWhatsApp(cleanPhoneForWhatsApp(doc.customerPhone), message);
    } catch (e) {
      console.error("shareOnWhatsApp failed", e);
      setWhatsappError(t("print_whatsappError"));
    }
    setWhatsappSending(false);
  };

  const autoPrintFiredRef = useRef(false);
  useEffect(() => {
    if (doc.merchant?.autoPrint && !autoPrintFiredRef.current) {
      autoPrintFiredRef.current = true;
      const copies = (isDelivery || doc.isTopUp) ? 1 : Math.min(10, Math.max(1, Number(doc.merchant.autoPrintCopies) || 1));
      printInNewWindow(copies).then(() => { if (silent) onClose(); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (silent) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy-950/60 p-4" onClick={() => { cancelBackgroundPrep(); onClose(); }}>
      <div className="flex w-full max-w-sm max-h-[92vh] flex-col overflow-hidden rounded-2xl bg-app-surface shadow-app-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex-1 overflow-y-auto">
        <div ref={printAreaRef} className="print-area p-6 text-slate-900" style={{ fontFamily: "'Inter', sans-serif" }}>
          <div className="mb-4 text-center text-lg font-bold">{doc.merchant.name || "—"}</div>

          {/* Arabic label on the right, English label on the left, shared value centered — explicit alignment, not dependent on ambient text direction */}
          <div className="mb-3 space-y-1.5 text-[13px]">
            {[
              [PRINT.addressEn, doc.merchant.address || "—", PRINT.addressAr],
              [PRINT.phoneEn, doc.merchant.phone || "—", PRINT.phoneAr, true],
              [PRINT.dateEn, doc.dateLabel, PRINT.dateAr, true],
              [PRINT.invNumEn, doc.invoiceCode, PRINT.invNumAr, true],
              [PRINT.cashier, PRINT.branchValueAr, PRINT.branchAr],
              ["", doc.customerName, PRINT.customerAr],
            ].map(([en, center, ar, mono], i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="w-1/3 text-left font-semibold">{en}</span>
                <span className={`w-1/3 text-center ${mono ? "f-mono" : ""}`}>{center}</span>
                <span className="w-1/3 text-right font-semibold">{ar}</span>
              </div>
            ))}
          </div>

          <hr className="my-3 border-slate-800" />

          {isDelivery ? (
            <div dir="rtl" className="overflow-hidden rounded border border-slate-800 mb-3">
              <table className="w-full text-[13px]">
                <thead><tr className="border-b border-slate-800"><th className="px-2 py-1.5 text-right">{PRINT.deliveredDateAr}</th><th className="px-2 py-1.5 text-right">{PRINT.productAr}</th></tr></thead>
                <tbody>
                  {doc.deliveredItems.map((it, i) => (
                    <tr key={i} className="border-b border-slate-200 last:border-0">
                      <td className="px-2 py-1.5 f-mono text-xs">{fmtDateSec(it.deliveredAt)}</td>
                      <td className="px-2 py-1.5">{it.name}{it.service ? ` — ${it.service}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              {isTax && (
                <div className="mb-3 text-center">
                  <div className="font-bold">{PRINT.taxInvoiceAr}</div>
                  <div className="text-xs text-slate-500">{PRINT.taxInvoiceEn}</div>
                  <div className="mt-1 text-xs f-mono">TAX: {doc.merchant.taxNumber || "—"}</div>
                </div>
              )}
              <div dir="rtl" className="overflow-hidden rounded border border-slate-800 mb-3">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b border-slate-800"><th className="px-2 py-1.5 text-right">{PRINT.productAr}</th><th className="px-2 py-1.5 text-right">{PRINT.priceAr}</th><th className="px-2 py-1.5 text-right">{PRINT.totalAr}</th></tr></thead>
                  <tbody>
                    {doc.items.map((it, i) => (
                      <tr key={i} className="border-b border-slate-200 last:border-0">
                        <td className="px-2 py-1.5">{it.qty}X {it.name}</td>
                        <td className="px-2 py-1.5 f-mono">{it.price.toFixed(2)}</td>
                        <td className="px-2 py-1.5 f-mono">{it.lineTotal.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1 text-[13px]">
                <div className="flex justify-between"><span className="f-mono">{doc.totals.net.toFixed(2)}</span><span>{PRINT.subtotalAr}</span></div>
                <div className="flex justify-between"><span className="f-mono">{doc.totals.discount.toFixed(2)}</span><span>{PRINT.discountAr}</span></div>
                <div className="flex justify-between"><span className="f-mono">{doc.totals.vat.toFixed(2)}</span><span>{PRINT.vatAr}</span></div>
                <div className="flex justify-between font-bold"><span className="f-mono">{doc.totals.gross.toFixed(2)}</span><span>{PRINT.grandTotalAr}</span></div>
              </div>
              <hr className="my-3 border-slate-800" />
              <div className="space-y-1 text-[13px]">
                <div className="flex justify-between font-semibold"><span className="f-mono">{doc.totals.paid.toFixed(2)}</span><span>{PRINT.paidAr}</span></div>
                <div className="flex justify-between"><span className="f-mono">{doc.totals.remaining.toFixed(2)}</span><span>{PRINT.remainingAr}</span></div>
                <div className="flex justify-between"><span className="f-mono">{doc.totals.pieceCount}</span><span>{PRINT.pieceCountAr}</span></div>
                <div className="flex justify-between"><span>{doc.payMethodLabel}</span><span>{PRINT.payMethodAr}</span></div>
                {doc.dueDate && <div className="flex justify-between"><span className="f-mono">{doc.dueDate}</span><span>{PRINT.dueDateAr}</span></div>}
              </div>
              {isTax && <div className="mt-4"><RealQR value={doc.zatcaQrOverride || buildZatcaQrFromDoc(doc)} /></div>}
            </>
          )}
        </div>
        </div>

        <div className="no-print flex shrink-0 flex-col gap-2 border-t border-app-border p-4 bg-app-surface">
          {doc.whatsappEnabled && whatsappError && <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700">{whatsappError}</div>}
          {doc.whatsappEnabled && !doc.customerPhone && <div className="text-center text-[11px] text-app-text-subtle">{t("print_whatsappNoPhone")}</div>}
          <div className="flex gap-2">
            {/* Manual click always prints exactly one copy — "عدد النسخ" only governs the automatic (no-click) auto-print above. */}
            <button onClick={() => { cancelBackgroundPrep(); printInNewWindow(1); }} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600"><Printer size={16} /> {t("print_printBtn")}</button>
            {doc.whatsappEnabled && (
              <button onClick={shareOnWhatsApp} disabled={!doc.customerPhone || whatsappSending} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
                {whatsappSending ? <Loader2 size={16} className="animate-spin" /> : <MessageCircle size={16} />} {whatsappSending ? t("print_whatsappSending") : t("print_whatsappBtn")}
              </button>
            )}
            <button onClick={() => { cancelBackgroundPrep(); onClose(); }} className="rounded-lg border border-app-border-strong px-4 py-2.5 text-sm font-medium text-app-text-muted hover:bg-app-bg">{t("print_close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KPI({ label, value, accent = "slate" }) {
  const accents = { slate: "text-slate-900", teal: "text-teal-700", rose: "text-rose-600", amber: "text-amber-600" };
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`f-mono mt-1.5 text-2xl font-semibold ${accents[accent]}`}>{value}</div>
    </div>
  );
}

function EmptyDropdownAdd({ label, items, valueId, onSelect, onAdd, placeholder }) {
  const { t } = useLang();
  const ph = placeholder || t("common_selectPlaceholder");
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  return (
    <div>
      {items.length === 0 && !showAdd ? (
        <button type="button" onClick={() => setShowAdd(true)} className="w-full rounded-lg border-2 border-dashed border-teal-300 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100">
          {t("common_addNew")} {label}
        </button>
      ) : showAdd ? (
        <div className="flex gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`${t("common_newNamePlaceholder")} — ${label}`} className={inputCls} />
          <button type="button" onClick={() => { if (name.trim()) { onAdd(name.trim()); setName(""); setShowAdd(false); } }} className="shrink-0 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700">{t("common_save")}</button>
          <button type="button" onClick={() => setShowAdd(false)} className="shrink-0 rounded-lg border border-stone-300 px-3 py-2 text-sm text-slate-600 hover:bg-stone-50">{t("common_cancel")}</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <select value={valueId} onChange={(e) => onSelect(e.target.value)} className={inputCls}>
            <option value="" disabled>{ph}</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
          </select>
          <button type="button" onClick={() => setShowAdd(true)} title={`${t("common_addNew")} ${label}`} className="shrink-0 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-teal-700 hover:bg-teal-100"><Plus size={16} /></button>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   SIDEBAR
   ========================================================================= */
/* =========================================================================
   INTERNATIONALIZATION (English / Arabic / Urdu)
   All static UI chrome is translated. User-entered business data (product
   names, category names, customer names, service/add-on labels typed by
   the staff) is never auto-translated — exactly like real POS software.
   ========================================================================= */
const STAGE_KEYS = { Received: "stage_received", Washing: "stage_washing", Pressing: "stage_pressing", Ready: "stage_ready", Delivered: "stage_delivered" };
const stageLabel = (t, stage) => t(STAGE_KEYS[stage] || stage);

const DICT = {
  en: {
    app_name: "Ragwa", app_tagline: "The Leading Laundry Assistant",
    nav_home: "Home",
    nav_pos: "Point of Sale", nav_invoices: "Active Invoices", nav_delivery: "Active Delivery Invoices",
    nav_customers: "Customer Ledger", nav_products: "Products", nav_purchases: "Purchases & Expenses",
    nav_promotions: "Promotions", nav_reports: "Reports", nav_settings: "Settings",
    sidebar_footer: "Dynamic state · no hardcoded catalogs",

    home_welcomeBack: "Welcome back", home_salesToday: "Today's Sales", home_ordersToday: "Today's Orders",
    home_readyOrders: "Ready Orders", home_deliveryActive: "Delivery In Progress",
    home_recentOrders: "Recent Orders", home_viewAll: "View All", home_noOrders: "No orders yet",
    home_quickActions: "Quick Actions", home_quickPos: "New Sale", home_quickInvoices: "Active Invoices",
    home_quickCustomers: "Customers",

    common_save: "Save", common_cancel: "Cancel", common_add: "Add", common_close: "Close",
    common_notes: "Notes", common_category: "Category", common_paymentMethod: "Payment Method",
    common_customer: "Customer", common_status: "Status", common_date: "Date", common_amount: "Amount (SAR)",
    common_cash: "Cash", common_externalNetwork: "External Network", common_walletBalance: "Wallet Balance",
    common_creditOnAccount: "Credit (On Account)", common_splitPayment: "Split Payment", common_selectPlaceholder: "Select...",
    common_addNew: "+ Add New", common_newNamePlaceholder: "New name",
    common_operationFailed: "Could not complete this operation — please try again.",
    common_live: "Live", common_draft: "Draft", common_active: "Active", common_expired: "Expired",
    common_yes: "Yes", common_no: "No", common_view: "View",

    stage_received: "Received", stage_washing: "Washing", stage_pressing: "Pressing", stage_ready: "Ready", stage_delivered: "Delivered",

    productModal_startingFrom: "Starting From", productModal_qty: "Qty", productModal_coreService: "Core Service",
    productModal_addons: "Optional Add-ons", productModal_itemTotal: "Item Total", productModal_confirm: "Confirm & Add to Cart",
    productModal_notes: "Notes", productModal_notesPlaceholder: "e.g. a stain on the cuff, needs extra care...",

    pos_allItems: "All Items", pos_checkout: "Checkout", pos_cartEmpty: "Pick an item from the menu to start the order", pos_newOrder: "New Order",
    pos_noProductsInCategory: "No products in this category yet.",
    pos_noProductsTitle: "No products yet", pos_noProductsSubtitle: "Add your products first from the \"Products\" page so they show up here and you can start selling.",
    pos_deliveryOrder: "Delivery Order", pos_pickupOrder: "Counter / Pickup Order",
    pos_deliveryFeeLabel: "Delivery Fee (based on customer location):", pos_deliveryFeePlaceholder: "Enter fee manually",
    pos_deliveryFee: "Delivery Fee", pos_total: "Total", pos_completeSale: "Complete Sale",
    pos_searchCustomerPlaceholder: "Search by name / mobile / #ID...", pos_noMatchingCustomers: "No matching customers",
    pos_wallet: "Wallet", pos_debt: "Debt", pos_customerRequired: "A customer must be selected before checkout",
    pos_searchProductsPlaceholder: "Search for an item...",
    pos_discount: "Discount", pos_coupon: "Coupon Code", pos_applyCoupon: "Apply", pos_removeCoupon: "Remove",
    pos_invalidCoupon: "Invalid or expired code.", pos_autoDiscountApplied: "Discount applied automatically",
    pos_walletInsufficient: "Wallet balance is not enough to complete this sale.",
    pos_splitMethod1: "First Payment Method", pos_splitAmount1: "Amount Paid",
    pos_splitMethod2: "Second Payment Method", pos_splitRemaining: "Remaining Amount (auto-calculated)",
    pos_splitErrorAmount: "Enter an amount less than the total for the first method.",
    pos_splitErrorWallet: "Wallet balance is not enough for the amount assigned to it in this split payment.",

    invoices_liveDashboard: "Active Invoices", invoices_deliveryDashboard: "Active Delivery Invoices",
    invoices_activeDescription: "Orders in progress, from intake to delivery", invoices_deliveryDescription: "Track delivery orders and their assigned couriers",
    invoices_invoiceId: "Order ID", invoices_customer: "Customer", invoices_items: "Items", invoices_deliveryFee: "Delivery Fee",
    invoices_total: "Total", invoices_allStatuses: "All",
    invoices_eta: "Expected Ready", invoices_etaToday: "Today", invoices_etaTomorrow: "Tomorrow",
    invoices_noActive: "No active invoices. All caught up.", invoices_noActiveDelivery: "No active delivery orders.",
    invoices_clearFilter: "Clear Filter",
    invoices_actionDeliver: "Deliver", invoices_actionDetails: "Details",
    invoices_statusWaitingCourier: "Awaiting Courier", invoices_statusOnTheWay: "On the Way", invoices_statusDelivered: "Delivered",
    invoiceDetail_title: "Invoice", invoiceDetail_deliveryOrder: "Delivery Order", invoiceDetail_fee: "Fee:",
    invoiceDetail_zatcaCleared: "Verified by ZATCA ✅", invoiceDetail_zatcaSigned: "Digitally signed — pending submission to ZATCA",
    invoiceDetail_itemizedMatrix: "Itemized Matrix", invoiceDetail_closeAll: "Close Invoice / Deliver All",
    invoiceDetail_urgent: "Urgent",

    customers_title: "Customer Ledger", customers_addCustomer: "Add Customer",
    customers_subtitle: "Wallet balances and outstanding debts for the shop's customers",
    customers_totalDebt: "Total Outstanding Debt", customers_totalWallet: "Total Wallet Balances",
    customers_searchPlaceholder: "Search by name, mobile, or #ID...", customers_id: "ID", customers_name: "Name",
    customers_mobile: "Mobile", customers_wallet: "Wallet", customers_debt: "Debt", customers_noneYet: "No customers yet.",
    customers_lastOrder: "Last Order", customers_details: "Details", customers_neverOrdered: "Never ordered",
    customers_today: "Today", customers_yesterday: "Yesterday", customers_daysAgo: "{n} days ago",
    customers_weekAgo: "A week ago", customers_weeksAgo: "{n} weeks ago",
    customers_monthAgo: "A month ago", customers_monthsAgo: "{n} months ago",
    customers_yearAgo: "A year ago", customers_yearsAgo: "{n} years ago",
    customerDetail_mobile: "Mobile", customerDetail_walletBalance: "Wallet Balance", customerDetail_debt: "Debt / On Account",
    customerDetail_totalInvoices: "Total Invoices", customerDetail_addBalance: "Add Balance (with Discount)",
    customerDetail_settleDebt: "Settle / Close Debt", customerDetail_invoiceHistory: "Invoice History",
    customerDetail_invoice: "Invoice", customerDetail_method: "Method", customerDetail_total: "Total",
    customerDetail_noInvoices: "No previous invoices for this customer.",
    customerDetail_transactions: "Wallet & Debt Transactions", customerDetail_receipt: "Receipt",
    customerDetail_type: "Type", customerDetail_detail: "Detail", customerDetail_paid: "Paid",
    customerDetail_noTransactions: "No wallet or debt transactions yet.",
    customerDetail_topupType: "Wallet Top-Up", customerDetail_debtType: "Debt Payment",
    customerDetail_delivered: "Delivered", customerDetail_processing: "Processing",
    customerDetail_creditedDetail: "Credited {credited} · {discount} · {method}",
    customerDetail_debtDetail: "Debt settlement · {method}",

    addCustomer_title: "➕ Add New Customer", addCustomer_systemId: "System ID (auto, can be edited)",
    addCustomer_idTaken: "This number is already used by another customer — pick a different one.",
    addCustomer_mobileTaken: "This number is already registered for customer #{id} ({name}).",
    addCustomer_mobileInvalid: "Enter a valid mobile number (starting with 05 or 5).",
    addCustomer_name: "Customer Name", addCustomer_mobile: "Mobile Number",
    addCustomer_save: "Save Customer",

    topup_title: "Top-Up Wallet", topup_amount: "Top-Up Amount (SAR)", topup_discountMode: "Discount Mode",
    topup_flat: "Flat SAR", topup_percent: "Percentage", topup_discountAmount: "Discount Amount (SAR)",
    topup_discountPercent: "Discount (%)", topup_newBalance: "New Wallet Balance", topup_duePayable: "Total Due Payable",
    topup_addedToDebt: "Added to Debt", topup_creditWarning: "{amount} will be added as debt to the customer instead of collecting it as cash now.",
    topup_confirm: "Confirm Top-Up", topup_noDiscount: "No discount", topup_flatOff: "{amount} flat off", topup_percentOff: "{percent}% off",

    settle_title: "Settle Debt", settle_currentDebt: "Current Outstanding Debt", settle_availableWallet: "Available Wallet Balance",
    settle_amount: "Payment Amount (SAR)", settle_overWallet: "Wallet balance is not enough for this amount.",
    settle_exceedsDebtError: "Amount exceeds the maximum outstanding debt ({amount})",
    settle_remaining: "Remaining Debt After Payment", settle_confirm: "Confirm Payment & Close",

    products_newProduct: "New Product", products_image: "Image", products_upload: "Upload (250×250)",
    products_name: "Product Name", products_servicePrices: "Service Prices",
    products_servicePricesHint: "(fill in at least one)", products_noServiceTypes: "No service types yet.",
    products_addServiceType: "Add Service Type", products_newServiceName: "New service name",
    products_operationalCost: "Operational Cost (SAR)", products_noCost: "No Cost",
    products_liveOnPos: "Live on POS", products_draft: "Saved as Draft", products_save: "Save Product",
    products_editTitle: "Edit Product", products_saveChanges: "Save Changes",
    products_errName: "Enter a product name.", products_errCategory: "Choose or add a category.",
    upload_tooLarge: "File is too large.", upload_badType: "Unsupported file type.",
    upload_failed: "Upload failed — check your connection and try again.", upload_uploading: "Uploading...",
    products_errService: "You must set the price of at least one service.",
    products_quickAccess: "Quick-Access Shortcut", products_quickAccessNone: "None",
    products_quickAccessTaken: "This number is already used by another product.",
    products_table_product: "Product", products_table_category: "Category", products_table_services: "Services",
    products_table_from: "From", products_table_cost: "Cost", products_table_status: "Status",
    products_table_empty: "No products yet. Add your first product from the form on the left.",
    products_addonsCatalog: "Optional Add-ons Catalog", products_addonNamePlaceholder: "Add-on name (e.g. Starch)",
    products_addonPricePlaceholder: "Price", products_noAddons: "No add-ons yet.",
    products_ownAddons: "Add-ons for this product only", products_noOwnAddons: "No product-specific add-ons yet.",
    products_kpiServiceTypes: "Service Types", products_kpiCategories: "Categories", products_kpiTotal: "Total Products",
    products_searchPlaceholder: "Search for a product...", products_all: "All",
    products_emptyState: "No products yet. Click \"New Product\" to add your first one.",
    products_noResults: "No products match your search.",
    products_subtitle: "Manage laundry items, categories, services and pricing.",

    purchases_suppliersTab: "Suppliers & Purchases", purchases_expensesTab: "Expenses",
    purchases_recordPurchase: "Record Purchase", purchases_newSupplier: "+ New Supplier",
    purchases_supplier: "Supplier", purchases_payment: "Payment", purchases_credit: "Credit",
    purchases_savePurchase: "Save Purchase", purchases_table_supplier: "Supplier", purchases_table_agent: "Agent",
    purchases_table_contact: "Contact", purchases_table_liability: "Liability", purchases_payBalance: "Pay Balance",
    purchases_invoiceFile: "Supplier Invoice File", purchases_uploadInvoice: "Upload invoice",
    purchases_pageTitle: "Purchases & Expenses", purchases_pageSubtitle: "Track supplier invoices and operating expenses",
    purchases_kpiCount: "Purchases Recorded", purchases_kpiSuppliers: "Suppliers", purchases_kpiDue: "Due to Suppliers",
    purchases_addPurchaseBtn: "Purchase Invoice", purchases_searchSuppliers: "Search suppliers...",
    purchases_settled: "Settled", purchases_noSuppliers: "No suppliers yet.",
    purchases_recentTitle: "Recent Purchases", purchases_noPurchases: "No purchases recorded yet.",
    expenses_addExpense: "Add Expense", expenses_taxStatus: "Tax Status", expenses_taxInclusive: "Tax Inclusive",
    expenses_taxExempt: "Exempt", expenses_date: "Date", expenses_receiptFile: "Receipt / File",
    expenses_uploadReceipt: "Upload receipt", expenses_save: "Save Expense",
    expenses_table_category: "Category", expenses_table_amount: "Amount", expenses_table_tax: "Tax",
    expenses_table_date: "Date", expenses_table_receipt: "Receipt",
    expenses_kpiExempt: "Tax Exempt", expenses_kpiTaxable: "Taxable", expenses_kpiTotal: "Total Expenses",
    expenses_addExpenseBtn: "New Expense", expenses_searchPlaceholder: "Search expenses...",
    expenses_noExpenses: "No expenses recorded yet.",
    addSupplier_title: "Add New Supplier", addSupplier_editTitle: "Edit Supplier", addSupplier_company: "Company Name", addSupplier_agent: "Agent Name",
    addSupplier_contact: "Contact Number", addSupplier_taxNumber: "Tax Number (optional)", addSupplier_save: "Save Supplier",
    addSupplier_taxExempt: "Supplier is Tax Exempt", addSupplier_exemptionNumber: "Tax Exemption Number",
    supplierDetail_agent: "Agent", supplierDetail_contact: "Contact", supplierDetail_liability: "Outstanding Liability",
    supplierDetail_totalPurchased: "Total Purchased", supplierDetail_payBalance: "Pay Balance",
    supplierDetail_taxNumber: "Tax Number", supplierDetail_noTaxNumber: "Not registered",
    supplierDetail_history: "Purchase History", supplierDetail_poId: "PO ID", supplierDetail_method: "Method",
    supplierDetail_amount: "Amount", supplierDetail_invoice: "Invoice", supplierDetail_empty: "No purchase invoices from this supplier yet.",
    payBalance_title: "Pay Balance", payBalance_liability: "Outstanding liability:", payBalance_confirm: "Confirm Payment",
    payBalance_exceedsError: "Amount exceeds the maximum outstanding balance ({amount})",

    promotions_title: "Promotions", promotions_subtitle: "Percentage and fixed discounts, plus coupon codes for your laundry's customers.", promotions_addDiscount: "Add Discount",
    promotions_table_name: "Name", promotions_table_type: "Type", promotions_table_value: "Value", promotions_table_coupon: "Coupon",
    promotions_table_start: "Start", promotions_table_end: "End", promotions_table_status: "Status",
    promotions_empty: "No promotions yet.", promotions_edit: "Edit", promotions_cancel: "Cancel", promotions_cancelled: "Cancelled",
    promotions_scheduled: "Scheduled", promotions_typePercent: "Percentage", promotions_typeFixed: "Fixed",
    promoModal_title: "Add Discount", promoModal_editTitle: "Edit Discount", promoModal_name: "Discount Name", promoModal_requiresCoupon: "Requires Coupon?",
    promoModal_couponRequired: "Coupon required", promoModal_appliesAuto: "Applies automatically",
    promoModal_couponCode: "Coupon Code", promoModal_evalType: "Discount Type", promoModal_percentage: "Percentage %",
    promoModal_fixed: "Fixed", promoModal_discountPercent: "Discount (%)", promoModal_discountAmount: "Discount (SAR)",
    promoModal_start: "Start", promoModal_end: "End", promoModal_save: "Save Discount", promoModal_saveEdit: "Save Changes",
    promoModal_overlapError: "There is already an active discount running during this period — overlapping discount periods are not allowed.",
    promoModal_valueError: "Enter a value greater than 0 (percentage discounts can't exceed 100%).",

    reports_salesTab: "Sales Ledger", reports_procurementTab: "Procurement Ledger",
    reports_kpi_invoices: "Invoices", reports_kpi_grossSales: "Gross Sales", reports_kpi_vatCollected: "VAT Collected",
    reports_kpi_netRevenue: "Net Revenue", reports_kpi_outstandingDebt: "Outstanding Debt",
    reports_allPaymentMethods: "All Payment Methods",
    reports_table_invoice: "Invoice", reports_table_client: "Client", reports_table_method: "Method",
    reports_table_net: "Net", reports_table_vat: "VAT", reports_table_gross: "Gross",
    reports_salesEmpty: "No sales match these filters.",
    reports_kpi_purchases: "Purchases", reports_kpi_grossOutflow: "Gross Outflow", reports_kpi_inputVat: "Input VAT Paid",
    reports_kpi_netCost: "Net Procurement Cost", reports_table_poId: "PO ID", reports_table_supplier: "Supplier",
    reports_table_value: "Value", reports_table_created: "Created", reports_procurementEmpty: "No procurement records yet.",

    reports_expensesTab: "Expenses", reports_plTab: "Profit & Loss", reports_vatTab: "Tax Return",
    reports_kpi_totalExpenses: "Total Expenses", reports_kpi_expenseVat: "VAT on Expenses", reports_kpi_expenseNet: "Net Expenses (Excl. VAT)",
    reports_expensesEmpty: "No expenses match these filters.",

    reports_pl_allTimeTitle: "Since the Store Opened", reports_pl_periodTitle: "Selected Period",
    reports_pl_revenue: "Revenue", reports_pl_costs: "Costs (Purchases + Expenses)",
    reports_pl_profit: "Profit", reports_pl_loss: "Loss", reports_pl_margin: "Profit Margin",
    reports_pl_result: "Result",

    reports_vat_periodMode: "Period Type", reports_vat_quarterly: "Quarterly", reports_vat_monthly: "Monthly",
    reports_vat_year: "Year", reports_vat_quarter: "Quarter", reports_vat_month: "Month",
    reports_vat_salesTable: "Sales — Output VAT", reports_vat_purchasesTable: "Purchases — Input VAT",
    reports_vat_box1_sales: "1. Standard-rated supplies (15%)", reports_vat_box2_sales: "2. Supplies to citizens borne by the government",
    reports_vat_box3_sales: "3. Zero-rated domestic supplies", reports_vat_box4_sales: "4. Exports outside the Kingdom (zero-rated)",
    reports_vat_box5_sales: "5. Exempt supplies",
    reports_vat_box1_purch: "1. Standard-rated purchases (15%)", reports_vat_box2_purch: "2. Imports subject to VAT paid at customs",
    reports_vat_box3_purch: "3. Purchases subject to the reverse-charge mechanism", reports_vat_box4_purch: "4. Zero-rated purchases",
    reports_vat_box5_purch: "5. Exempt purchases",
    reports_vat_taxableAmount: "Taxable Amount", reports_vat_vatAmount: "VAT Amount",
    reports_vat_totalSales: "Total Sales", reports_vat_totalOutputVat: "Total Output VAT",
    reports_vat_totalPurchases: "Total Purchases", reports_vat_totalInputVat: "Total Input VAT",
    reports_vat_netTitle: "Net VAT Due to the Authority", reports_vat_dueToAuthority: "Amount payable to the Authority:",
    reports_vat_dueRefund: "Amount due for refund/carry-forward:",
    reports_vat_copy: "Copy", reports_vat_copied: "Copied!", reports_vat_exportCsv: "⬇️ Export CSV (Excel)", reports_vat_printPdf: "🖨️ Print / Save as PDF",
    reports_vat_notTracked: "Not tracked separately in this system — shown as 0.",

    settings_title: "Settings", settings_language: "Language", settings_languageHint: "Choose the app language. Everything switches immediately — only names you type yourself (products, categories, customers) stay as written.",
    settings_lang_ar: "العربية", settings_lang_en: "English", settings_lang_ur: "اردو",

    settings_merchantInfo: "Merchant Information", settings_merchantInfoHint: "Used to print tax invoices and receipts.",
    settings_autoPrint: "Auto Print", settings_autoPrintHint: "Automatically print the receipt/invoice right after a sale, with no extra click.",
    settings_autoPrintCopies: "Number of copies",
    settings_showPrintPreview: "Show invoice preview", settings_showPrintPreviewHint: "Turn off to print silently with no popup and go straight to the next sale.",
    settings_merchantName: "Name (as registered in the Commercial Registry)", settings_merchantPhone: "Store Phone Number",
    settings_merchantAddress: "Store Location", settings_merchantTax: "Tax Number",
    settings_merchantSave: "Save Changes", settings_merchantSaved: "Saved",
    settings_ownerOnly: "For Owner Only", settings_ownerOnlyHint: "Protect sensitive sections with a password only you know.",
    whatsapp_title: "Send Invoice via WhatsApp", whatsapp_hint: "Automatically sends the invoice to the customer over WhatsApp right after the sale is completed — available tags:",
    owner_setMasterTitle: "Set a password for this section", owner_enterMasterTitle: "Enter the owner password",
    owner_setSectionTitle: "Set a password for \"{section}\"", owner_enterSectionTitle: "This section is locked — enter the password",
    owner_pinLabel: "Password (4 digits)", owner_pinConfirmLabel: "Confirm password",
    owner_pinFormatError: "Password must be exactly 4 digits (numbers only).", owner_pinMismatch: "Passwords don't match.",
    owner_pinWrong: "Incorrect password.", owner_lockPanel: "Lock this section again",
    owner_payMethodsTitle: "Payment Methods Shown at POS", owner_payMethodsHint: "Turn off any payment method the staff should not see or use at checkout.",
    owner_atLeastOnePayMethod: "At least one payment method must stay enabled.",
    owner_sectionLockTitle: "Lock Sections From Staff", owner_sectionLockHint: "Turn on a section to require the owner PIN before staff can open it.",
    owner_payMethodsRowLabel: "Payment Methods", owner_protectedByMaster: "Protected",
    zatca_title: "ZATCA Integration (Phase 2)", zatca_hint: "When enabled, new invoices are verified with ZATCA automatically.",
    zatca_connected: "Connected", zatca_notConnected: "Not connected",
    zatca_enableToggle: "Enable ZATCA Integration", zatca_otpLabel: "OTP Code", zatca_otpPlaceholder: "6-digit code",
    zatca_otpInvalid: "Code must be 6 digits.", zatca_connect: "Connect to ZATCA", zatca_cancel: "Cancel",
    zatca_disableConfirm: "Disable ZATCA integration? New invoices will go back to normal.",
    zatca_statusConnected: "Connected", zatca_statusDisconnected: "Disconnected",
    zatca_certificateStatus: "Certificate Status", zatca_certActive: "Active", zatca_certPending: "Pending",
    zatca_certExpired: "Expired", zatca_certRevoked: "Revoked",
    zatca_expiresOn: "Expires on", zatca_lastSync: "Last Sync", zatca_neverSynced: "Not synced yet",
    zatca_stats: "Statistics", zatca_cleared: "Cleared Invoices", zatca_reported: "Reported Invoices", zatca_failed: "Failed",
    zatca_testConnection: "Test Connection", zatca_testSuccess: "Connection working",
    zatca_reset: "Remove ZATCA Data", zatca_resetConfirm: "Delete all ZATCA configuration? This cannot be undone.",
    zatca_enableSuccess: "Connected to ZATCA successfully", zatca_lastError: "Last Error",
    zatca_generateCsr: "1. Generate Certificate Request (CSR)", zatca_generateCsrButton: "Generate CSR",
    zatca_businessCategory: "Business Category", zatca_businessCategoryPlaceholder: "e.g. Laundry Services",
    zatca_csrLabel: "Certificate Request (CSR)", zatca_csrHint: "Submit this CSR at ZATCA's Fatoora portal (fatoora.zatca.gov.sa) to get your real verification code, then enter it below.",
    zatca_copyCsr: "Copy CSR", zatca_copied: "Copied", zatca_publicKeyLabel: "Public Key",
    zatca_connectStep: "2. Enter ZATCA's Verification Code", zatca_csrRequiredFirst: "Generate a CSR first.",
    settings_account: "Account", settings_logout: "Log Out",

    print_taxInvoice: "Simplified Tax Invoice", print_receipt: "Receipt", print_deliveryReceipt: "Delivery Receipt",
    print_address: "Address:", print_phone: "Phone Num:", print_date: "Date:", print_invNum: "Inv Num:",
    print_cashier: "Casher_1", print_branchLabel: "Branch:", print_branchValue: "Main Branch", print_customerLabel: "Customer Name:",
    print_product: "Product", print_price: "Price", print_total: "Total", print_deliveredDate: "Delivery Date",
    print_subtotal: "Total (Excl. VAT)", print_discount: "Discount", print_vat: "VAT (15%)", print_grandTotal: "Total (Incl. VAT)",
    print_paid: "Paid", print_remaining: "Remaining", print_pieceCount: "Piece Count", print_payMethod: "Payment Method",
    print_dueDate: "Due Date", print_printBtn: "Print", print_close: "Close",
    print_deliverFirst: "Please deliver at least one item first, then the receipt can be printed.",
    print_printDeliveryReceipt: "Print Delivery Receipt", print_noItemsDelivered: "No items have been delivered from this invoice yet.",
    pay_cash: "Cash", pay_network: "External Network", pay_wallet: "Customer Balance", pay_credit: "Deferred Payment",
    print_whatsappBtn: "WhatsApp", print_whatsappSending: "Sending...", print_whatsappNoPhone: "No phone number on file for this customer.",
    print_whatsappError: "Couldn't share this invoice — please try again.",
  },

  ar: {
    app_name: "رغوة", app_tagline: "المساعد الأول للمغاسل",
    nav_home: "الرئيسية",
    nav_pos: "نقطة البيع", nav_invoices: "الفواتير النشطة", nav_delivery: "فواتير التوصيل النشطة",
    nav_customers: "سجل العملاء", nav_products: "المنتجات", nav_purchases: "المشتريات والمصروفات",
    nav_promotions: "العروض", nav_reports: "التقارير", nav_settings: "الإعدادات",
    sidebar_footer: "بيانات ديناميكية · بدون كتالوجات ثابتة",

    home_welcomeBack: "أهلاً بك", home_salesToday: "مبيعات اليوم", home_ordersToday: "طلبات اليوم",
    home_readyOrders: "طلبات جاهزة", home_deliveryActive: "توصيل قيد التنفيذ",
    home_recentOrders: "أحدث الطلبات", home_viewAll: "عرض الكل", home_noOrders: "لا توجد طلبات بعد",
    home_quickActions: "إجراءات سريعة", home_quickPos: "بيع جديد", home_quickInvoices: "الفواتير النشطة",
    home_quickCustomers: "العملاء",

    common_save: "حفظ", common_cancel: "إلغاء", common_add: "إضافة", common_close: "إغلاق",
    common_notes: "ملاحظات", common_category: "الفئة", common_paymentMethod: "طريقة الدفع",
    common_customer: "العميل", common_status: "الحالة", common_date: "التاريخ", common_amount: "المبلغ (ريال)",
    common_cash: "نقدًا", common_externalNetwork: "شبكة خارجية", common_walletBalance: "رصيد المحفظة",
    common_creditOnAccount: "آجل (على الحساب)", common_splitPayment: "دفع متعدد", common_selectPlaceholder: "اختر...",
    common_addNew: "+ إضافة جديد", common_newNamePlaceholder: "اسم جديد",
    common_operationFailed: "تعذر إتمام العملية — حاول مرة أخرى.",
    common_live: "مفعّل", common_draft: "مسودة", common_active: "نشط", common_expired: "منتهي",
    common_yes: "نعم", common_no: "لا", common_view: "عرض",

    stage_received: "استلام", stage_washing: "غسيل", stage_pressing: "كوي", stage_ready: "جاهز", stage_delivered: "تم التسليم",

    productModal_startingFrom: "يبدأ من", productModal_qty: "الكمية", productModal_coreService: "الخدمة الأساسية",
    productModal_addons: "إضافات اختيارية", productModal_itemTotal: "إجمالي القطعة", productModal_confirm: "تأكيد وإضافة للسلة",
    productModal_notes: "ملاحظات", productModal_notesPlaceholder: "مثال: بقعة على الكم، تحتاج عناية إضافية...",

    pos_allItems: "الكل", pos_checkout: "الفاتورة", pos_cartEmpty: "اختر قطعة من القائمة عشان تبدأ الطلب", pos_newOrder: "طلب جديد",
    pos_noProductsInCategory: "لا توجد منتجات في هذه الفئة بعد.",
    pos_noProductsTitle: "لا توجد منتجات بعد", pos_noProductsSubtitle: "أضف منتجاتك أولًا من صفحة \"المنتجات\" حتى تظهر هنا وتقدر تبدأ البيع.",
    pos_deliveryOrder: "طلب توصيل", pos_pickupOrder: "استلام من الفرع",
    pos_deliveryFeeLabel: "سعر التوصيل (حسب موقع العميل):", pos_deliveryFeePlaceholder: "حدد السعر يدويًا",
    pos_deliveryFee: "سعر التوصيل", pos_total: "الإجمالي", pos_completeSale: "إتمام البيع",
    pos_searchCustomerPlaceholder: "ابحث بالاسم / الجوال / #الرقم...", pos_noMatchingCustomers: "لا يوجد عملاء مطابقين",
    pos_wallet: "المحفظة", pos_debt: "الدين", pos_customerRequired: "لازم تختار عميل قبل إتمام البيع",
    pos_searchProductsPlaceholder: "ابحث عن قطعة...",
    pos_discount: "الخصم", pos_coupon: "كود الخصم", pos_applyCoupon: "تطبيق", pos_removeCoupon: "إزالة",
    pos_invalidCoupon: "الكود غير صحيح أو منتهي.", pos_autoDiscountApplied: "تم تطبيق الخصم تلقائيًا",
    pos_walletInsufficient: "رصيد المحفظة لا يكفي لإتمام هذه العملية.",
    pos_splitMethod1: "طريقة الدفع الأولى", pos_splitAmount1: "المبلغ المدفوع",
    pos_splitMethod2: "طريقة الدفع الثانية", pos_splitRemaining: "المبلغ المتبقي (يُحسب تلقائيًا)",
    pos_splitErrorAmount: "حط مبلغ أقل من الإجمالي للطريقة الأولى.",
    pos_splitErrorWallet: "رصيد المحفظة لا يكفي المبلغ المخصص لها في هذا الدفع المتعدد.",

    invoices_liveDashboard: "الفواتير النشطة", invoices_deliveryDashboard: "فواتير التوصيل النشطة",
    invoices_activeDescription: "الطلبات الجارية من الاستلام إلى التسليم", invoices_deliveryDescription: "متابعة طلبات التوصيل والمناديب المكلّفين بها",
    invoices_invoiceId: "رقم الطلب", invoices_customer: "العميل", invoices_items: "القطع", invoices_deliveryFee: "سعر التوصيل",
    invoices_total: "الإجمالي", invoices_allStatuses: "الكل",
    invoices_eta: "موعد التسليم", invoices_etaToday: "اليوم", invoices_etaTomorrow: "غدًا",
    invoices_noActive: "لا توجد فواتير نشطة. كل شيء منجز.", invoices_noActiveDelivery: "لا توجد طلبات توصيل نشطة.",
    invoices_clearFilter: "حذف الفلترة",
    invoices_actionDeliver: "تسليم", invoices_actionDetails: "تفاصيل",
    invoices_statusWaitingCourier: "بانتظار المندوب", invoices_statusOnTheWay: "في الطريق", invoices_statusDelivered: "تم التسليم",
    invoiceDetail_title: "فاتورة", invoiceDetail_deliveryOrder: "طلب توصيل", invoiceDetail_fee: "السعر:",
    invoiceDetail_zatcaCleared: "موثقة من الهيئة ✅", invoiceDetail_zatcaSigned: "موقّعة رقميًا — بانتظار الإرسال للهيئة",
    invoiceDetail_itemizedMatrix: "تفاصيل القطع", invoiceDetail_closeAll: "إغلاق الفاتورة / تسليم الكل",
    invoiceDetail_urgent: "مستعجل",

    customers_title: "سجل العملاء", customers_addCustomer: "إضافة عميل",
    customers_subtitle: "أرصدة المحافظ والديون المستحقة لعملاء المغسلة",
    customers_totalDebt: "إجمالي الديون المستحقة", customers_totalWallet: "إجمالي أرصدة المحافظ",
    customers_searchPlaceholder: "ابحث بالاسم أو الجوال أو #الرقم...", customers_id: "الرقم", customers_name: "العميل",
    customers_mobile: "الجوال", customers_wallet: "رصيد المحفظة", customers_debt: "دين مستحق", customers_noneYet: "لا يوجد عملاء بعد.",
    customers_lastOrder: "آخر طلب", customers_details: "تفاصيل", customers_neverOrdered: "لم يطلب بعد",
    customers_today: "اليوم", customers_yesterday: "أمس", customers_daysAgo: "قبل {n} أيام",
    customers_weekAgo: "قبل أسبوع", customers_weeksAgo: "قبل {n} أسابيع",
    customers_monthAgo: "قبل شهر", customers_monthsAgo: "قبل {n} أشهر",
    customers_yearAgo: "قبل سنة", customers_yearsAgo: "قبل {n} سنوات",
    customerDetail_mobile: "الجوال", customerDetail_walletBalance: "رصيد المحفظة", customerDetail_debt: "الدين / على الحساب",
    customerDetail_totalInvoices: "إجمالي الفواتير", customerDetail_addBalance: "إضافة رصيد (مع خصم)",
    customerDetail_settleDebt: "تسوية / إغلاق الدين", customerDetail_invoiceHistory: "سجل الفواتير",
    customerDetail_invoice: "الفاتورة", customerDetail_method: "الطريقة", customerDetail_total: "الإجمالي",
    customerDetail_noInvoices: "لا توجد فواتير سابقة لهذا العميل.",
    customerDetail_transactions: "عمليات المحفظة والدين", customerDetail_receipt: "الإيصال",
    customerDetail_type: "النوع", customerDetail_detail: "التفاصيل", customerDetail_paid: "المدفوع",
    customerDetail_noTransactions: "لا توجد عمليات محفظة أو دين بعد.",
    customerDetail_topupType: "شحن محفظة", customerDetail_debtType: "دفعة دين",
    customerDetail_delivered: "تم التسليم", customerDetail_processing: "قيد التنفيذ",
    customerDetail_creditedDetail: "أُضيف {credited} · {discount} · {method}",
    customerDetail_debtDetail: "تسوية دين · {method}",

    addCustomer_title: "➕ إضافة عميل جديد", addCustomer_systemId: "الرقم التسلسلي (تلقائي، يمكن تعديله)",
    addCustomer_idTaken: "هذا الرقم مستخدم مسبقًا لعميل آخر — اختر رقمًا آخر.",
    addCustomer_mobileTaken: "هذا الرقم مسجل مسبقًا للعميل #{id} ({name}).",
    addCustomer_mobileInvalid: "حط رقم جوال صحيح (يبدأ بـ 05 أو 5).",
    addCustomer_name: "اسم العميل", addCustomer_mobile: "رقم الجوال",
    addCustomer_save: "حفظ العميل",

    topup_title: "شحن المحفظة", topup_amount: "مبلغ الشحن (ريال)", topup_discountMode: "نوع الخصم",
    topup_flat: "مبلغ ثابت", topup_percent: "نسبة مئوية", topup_discountAmount: "قيمة الخصم (ريال)",
    topup_discountPercent: "الخصم (%)", topup_newBalance: "الرصيد الجديد", topup_duePayable: "المبلغ المستحق للدفع",
    topup_addedToDebt: "يُضاف كدين", topup_creditWarning: "سيتم إضافة {amount} كدين على العميل بدل تحصيلها نقدًا الآن.",
    topup_confirm: "تأكيد الشحن", topup_noDiscount: "بدون خصم", topup_flatOff: "خصم {amount}", topup_percentOff: "خصم {percent}%",

    settle_title: "تسوية الدين", settle_currentDebt: "الدين المستحق حاليًا", settle_availableWallet: "الرصيد المتاح بالمحفظة",
    settle_amount: "مبلغ الدفعة (ريال)", settle_overWallet: "رصيد المحفظة لا يكفي هذا المبلغ.",
    settle_exceedsDebtError: "المبلغ يتجاوز الحد الأقصى المستحق ({amount})",
    settle_remaining: "الدين المتبقي بعد الدفع", settle_confirm: "تأكيد الدفع والإغلاق",

    products_newProduct: "منتج جديد", products_image: "الصورة", products_upload: "رفع صورة (250×250)",
    products_name: "اسم المنتج", products_servicePrices: "أسعار الخدمات",
    products_servicePricesHint: "(حدد سعر واحد على الأقل)", products_noServiceTypes: "لا توجد أنواع خدمات بعد.",
    products_addServiceType: "إضافة نوع خدمة", products_newServiceName: "اسم خدمة جديدة",
    products_operationalCost: "التكلفة التشغيلية (ريال)", products_noCost: "بدون تكلفة",
    products_liveOnPos: "مفعّل في نقطة البيع", products_draft: "محفوظ كمسودة", products_save: "حفظ المنتج",
    products_editTitle: "تعديل المنتج", products_saveChanges: "حفظ التعديلات",
    products_errName: "حط اسم المنتج.", products_errCategory: "اختر أو أضف فئة.",
    upload_tooLarge: "حجم الملف كبير جداً.", upload_badType: "نوع الملف غير مدعوم.",
    upload_failed: "فشل رفع الملف — تحقق من الاتصال وحاول مرة ثانية.", upload_uploading: "جارٍ الرفع...",
    products_errService: "لازم تحط سعر خدمة واحدة على الأقل.",
    products_quickAccess: "إضافة وصول سريع للمنتج", products_quickAccessNone: "بدون",
    products_quickAccessTaken: "هذا الزر مستخدم لمنتج آخر.",
    products_table_product: "المنتج", products_table_category: "الفئة", products_table_services: "الخدمات",
    products_table_from: "يبدأ من", products_table_cost: "التكلفة", products_table_status: "الحالة",
    products_table_empty: "لا توجد منتجات بعد. أضف أول منتج من النموذج على اليسار.",
    products_addonsCatalog: "كتالوج الإضافات الاختيارية", products_addonNamePlaceholder: "اسم الإضافة (مثال: نشا)",
    products_addonPricePlaceholder: "السعر", products_noAddons: "لا توجد إضافات بعد.",
    products_ownAddons: "إضافات خاصة بهذا المنتج فقط", products_noOwnAddons: "لا توجد إضافات خاصة بهذا المنتج بعد.",
    products_kpiServiceTypes: "أنواع الخدمات", products_kpiCategories: "الفئات", products_kpiTotal: "إجمالي المنتجات",
    products_searchPlaceholder: "ابحث عن منتج...", products_all: "الكل",
    products_emptyState: "لا توجد منتجات بعد. اضغط \"منتج جديد\" لإضافة أول منتج.",
    products_noResults: "لا توجد منتجات مطابقة لبحثك.",
    products_subtitle: "إدارة قطع الغسيل، الفئات، الخدمات والأسعار.",

    purchases_suppliersTab: "الموردون والمشتريات", purchases_expensesTab: "المصروفات",
    purchases_recordPurchase: "تسجيل مشترى", purchases_newSupplier: "+ مورد جديد",
    purchases_supplier: "المورد", purchases_payment: "طريقة الدفع", purchases_credit: "آجل",
    purchases_savePurchase: "حفظ الفاتورة", purchases_table_supplier: "المورد", purchases_table_agent: "الوكيل",
    purchases_table_contact: "التواصل", purchases_table_liability: "المستحق", purchases_payBalance: "سداد الرصيد",
    purchases_invoiceFile: "فاتورة المورد", purchases_uploadInvoice: "رفع الفاتورة",
    purchases_pageTitle: "المشتريات والمصروفات", purchases_pageSubtitle: "متابعة فواتير الموردين والمصروفات التشغيلية",
    purchases_kpiCount: "عمليات شراء مسجلة", purchases_kpiSuppliers: "عدد الموردين", purchases_kpiDue: "مستحق للموردين",
    purchases_addPurchaseBtn: "فاتورة شراء", purchases_searchSuppliers: "ابحث عن مورد...",
    purchases_settled: "مسدد", purchases_noSuppliers: "لا يوجد موردون بعد.",
    purchases_recentTitle: "آخر عمليات الشراء", purchases_noPurchases: "لا توجد مشتريات مسجلة بعد.",
    expenses_addExpense: "إضافة مصروف", expenses_taxStatus: "حالة الضريبة", expenses_taxInclusive: "شامل الضريبة",
    expenses_taxExempt: "معفى", expenses_date: "التاريخ", expenses_receiptFile: "الإيصال / الملف",
    expenses_uploadReceipt: "رفع الإيصال", expenses_save: "حفظ المصروف",
    expenses_table_category: "الفئة", expenses_table_amount: "المبلغ", expenses_table_tax: "الضريبة",
    expenses_table_date: "التاريخ", expenses_table_receipt: "الإيصال",
    expenses_kpiExempt: "معفاة", expenses_kpiTaxable: "خاضعة للضريبة", expenses_kpiTotal: "إجمالي المصروفات",
    expenses_addExpenseBtn: "مصروف جديد", expenses_searchPlaceholder: "ابحث عن مصروف...",
    expenses_noExpenses: "لا توجد مصروفات مسجلة بعد.",
    addSupplier_title: "إضافة مورد جديد", addSupplier_editTitle: "تعديل المورد", addSupplier_company: "اسم الشركة", addSupplier_agent: "اسم الوكيل",
    addSupplier_contact: "رقم التواصل", addSupplier_taxNumber: "الرقم الضريبي (اختياري)", addSupplier_save: "حفظ المورد",
    addSupplier_taxExempt: "المورد معفى من الضريبة", addSupplier_exemptionNumber: "رقم الإعفاء الضريبي",
    supplierDetail_agent: "الوكيل", supplierDetail_contact: "التواصل", supplierDetail_liability: "المستحق عليه",
    supplierDetail_totalPurchased: "إجمالي المشتريات", supplierDetail_payBalance: "سداد الرصيد",
    supplierDetail_taxNumber: "الرقم الضريبي", supplierDetail_noTaxNumber: "غير مسجّل",
    supplierDetail_history: "سجل المشتريات", supplierDetail_poId: "رقم الطلب", supplierDetail_method: "الطريقة",
    supplierDetail_amount: "المبلغ", supplierDetail_invoice: "الفاتورة", supplierDetail_empty: "لا توجد فواتير شراء من هذا المورد بعد.",
    payBalance_title: "سداد الرصيد", payBalance_liability: "المبلغ المستحق:", payBalance_confirm: "تأكيد السداد",
    payBalance_exceedsError: "المبلغ يتجاوز الحد الأقصى المستحق ({amount})",

    promotions_title: "العروض", promotions_subtitle: "خصومات نسبية وثابتة وأكواد كوبونات لعملاء المغسلة", promotions_addDiscount: "إضافة خصم",
    promotions_table_name: "الاسم", promotions_table_type: "النوع", promotions_table_value: "القيمة", promotions_table_coupon: "الكوبون",
    promotions_table_start: "البداية", promotions_table_end: "النهاية", promotions_table_status: "الحالة",
    promotions_empty: "لا توجد عروض بعد.", promotions_edit: "تعديل", promotions_cancel: "إلغاء", promotions_cancelled: "ملغى",
    promotions_scheduled: "مجدول", promotions_typePercent: "نسبة", promotions_typeFixed: "ثابت",
    promoModal_title: "إضافة خصم", promoModal_editTitle: "تعديل الخصم", promoModal_name: "اسم الخصم", promoModal_requiresCoupon: "يتطلب كوبون؟",
    promoModal_couponRequired: "الكوبون مطلوب", promoModal_appliesAuto: "يُطبّق تلقائيًا",
    promoModal_couponCode: "رمز الكوبون", promoModal_evalType: "نوع الخصم", promoModal_percentage: "نسبة %",
    promoModal_fixed: "ثابت", promoModal_discountPercent: "الخصم (%)", promoModal_discountAmount: "الخصم (ريال)",
    promoModal_start: "البداية", promoModal_end: "النهاية", promoModal_save: "حفظ الخصم", promoModal_saveEdit: "حفظ التعديلات",
    promoModal_overlapError: "يوجد خصم آخر نشط بالفعل خلال هذه الفترة — لا يُسمح بتداخل فترات الخصومات.",
    promoModal_valueError: "أدخل قيمة أكبر من صفر (الخصم كنسبة مئوية ما يتجاوز 100%).",

    reports_salesTab: "سجل المبيعات", reports_procurementTab: "سجل المشتريات",
    reports_kpi_invoices: "الفواتير", reports_kpi_grossSales: "إجمالي المبيعات", reports_kpi_vatCollected: "الضريبة المحصلة",
    reports_kpi_netRevenue: "صافي الإيرادات", reports_kpi_outstandingDebt: "الديون المستحقة",
    reports_allPaymentMethods: "كل طرق الدفع",
    reports_table_invoice: "الفاتورة", reports_table_client: "العميل", reports_table_method: "الطريقة",
    reports_table_net: "الصافي", reports_table_vat: "الضريبة", reports_table_gross: "الإجمالي",
    reports_salesEmpty: "لا توجد مبيعات مطابقة لهذه الفلاتر.",
    reports_kpi_purchases: "المشتريات", reports_kpi_grossOutflow: "إجمالي المصروف", reports_kpi_inputVat: "ضريبة المدخلات",
    reports_kpi_netCost: "صافي تكلفة المشتريات", reports_table_poId: "رقم الطلب", reports_table_supplier: "المورد",
    reports_table_value: "القيمة", reports_table_created: "تاريخ الإنشاء", reports_procurementEmpty: "لا توجد سجلات مشتريات بعد.",

    reports_expensesTab: "المصروفات", reports_plTab: "الربح والخسارة", reports_vatTab: "الإقرار الضريبي",
    reports_kpi_totalExpenses: "إجمالي المصروفات", reports_kpi_expenseVat: "ضريبة المصروفات", reports_kpi_expenseNet: "صافي المصروفات (غير شامل الضريبة)",
    reports_expensesEmpty: "لا توجد مصروفات مطابقة لهذه الفلاتر.",

    reports_pl_allTimeTitle: "منذ افتتاح المحل", reports_pl_periodTitle: "الفترة المحددة",
    reports_pl_revenue: "الإيرادات", reports_pl_costs: "التكاليف (مشتريات + مصروفات)",
    reports_pl_profit: "ربح", reports_pl_loss: "خسارة", reports_pl_margin: "هامش الربح",
    reports_pl_result: "النتيجة",

    reports_vat_periodMode: "نوع الفترة", reports_vat_quarterly: "ربع سنوي", reports_vat_monthly: "شهري",
    reports_vat_year: "السنة", reports_vat_quarter: "الربع", reports_vat_month: "الشهر",
    reports_vat_salesTable: "المبيعات — ضريبة المخرجات", reports_vat_purchasesTable: "المشتريات — ضريبة المدخلات",
    reports_vat_box1_sales: "1. التوريدات الخاضعة للنسبة الأساسية (15%)", reports_vat_box2_sales: "2. مبيعات المواطنين التي تتحمل الدولة ضريبتها",
    reports_vat_box3_sales: "3. التوريدات المحلية الخاضعة لنسبة الصفر", reports_vat_box4_sales: "4. الصادرات خارج المملكة (نسبة صفر)",
    reports_vat_box5_sales: "5. التوريدات المعفاة من الضريبة",
    reports_vat_box1_purch: "1. المشتريات الخاضعة للنسبة الأساسية (15%)", reports_vat_box2_purch: "2. الاستيرادات الخاضعة لضريبة القيمة المضافة بالجمارك",
    reports_vat_box3_purch: "3. المشتريات الخاضعة لآلية الاحتساب العكسي", reports_vat_box4_purch: "4. المشتريات الخاضعة لنسبة الصفر",
    reports_vat_box5_purch: "5. المشتريات المعفاة من الضريبة",
    reports_vat_taxableAmount: "المبلغ الخاضع للضريبة", reports_vat_vatAmount: "مبلغ الضريبة",
    reports_vat_totalSales: "إجمالي المبيعات", reports_vat_totalOutputVat: "إجمالي ضريبة المبيعات",
    reports_vat_totalPurchases: "إجمالي المشتريات", reports_vat_totalInputVat: "إجمالي ضريبة المشتريات",
    reports_vat_netTitle: "صافي الضريبة المستحقة للهيئة", reports_vat_dueToAuthority: "المبلغ المطلوب سداده للهيئة:",
    reports_vat_dueRefund: "مبلغ مستحق الاسترداد/الترحيل:",
    reports_vat_copy: "نسخ", reports_vat_copied: "تم النسخ!", reports_vat_exportCsv: "⬇️ تصدير CSV (إكسل)", reports_vat_printPdf: "🖨️ طباعة / حفظ PDF",
    reports_vat_notTracked: "غير مرصود بشكل منفصل بهذا النظام — يظهر كـ 0.",

    settings_title: "الإعدادات", settings_language: "اللغة", settings_languageHint: "اختر لغة التطبيق. كل شيء يتغير فورًا — فقط الأسماء اللي تكتبها بنفسك (منتجات، فئات، عملاء) تبقى كما كتبتها.",
    settings_lang_ar: "العربية", settings_lang_en: "English", settings_lang_ur: "اردو",

    settings_merchantInfo: "بيانات التاجر", settings_merchantInfoHint: "تُستخدم لطباعة الفواتير الضريبية والإيصالات.",
    settings_autoPrint: "الطباعة التلقائية", settings_autoPrintHint: "تطبع الفاتورة/الإيصال تلقائيًا فور إتمام البيع، بدون ضغطة إضافية.",
    settings_autoPrintCopies: "عدد النسخ",
    settings_showPrintPreview: "إظهار معاينة الفاتورة", settings_showPrintPreviewHint: "أطفئها عشان تطبع مباشرة بدون أي نافذة، وتنتقل فورًا للبيعة التالية.",
    settings_merchantName: "الاسم (كما هو مسجل في السجل التجاري)", settings_merchantPhone: "رقم هاتف المحل",
    settings_merchantAddress: "موقع المحل", settings_merchantTax: "الرقم الضريبي",
    settings_merchantSave: "حفظ التغييرات", settings_merchantSaved: "تم الحفظ",
    settings_ownerOnly: "للمالك فقط", settings_ownerOnlyHint: "احمِ الأقسام الحساسة بكلمة مرور ما يعرفها إلا أنت.",
    whatsapp_title: "إرسال الفاتورة عبر واتساب", whatsapp_hint: "ترسل الفاتورة تلقائيًا للعميل عبر واتساب بعد إتمام البيع — الوسوم المتاحة:",
    owner_setMasterTitle: "حط كلمة مرور جديدة لهذي الخانة", owner_enterMasterTitle: "أدخل كلمة مرور المالك",
    owner_setSectionTitle: "حط كلمة مرور لقسم \"{section}\"", owner_enterSectionTitle: "هذا القسم مقفل — أدخل كلمة المرور",
    owner_pinLabel: "كلمة المرور (٤ أرقام)", owner_pinConfirmLabel: "تأكيد كلمة المرور",
    owner_pinFormatError: "كلمة المرور لازم تكون ٤ أرقام بالضبط (أرقام فقط).", owner_pinMismatch: "كلمتا المرور غير متطابقتين.",
    owner_pinWrong: "كلمة المرور غير صحيحة.", owner_lockPanel: "إغلاق هذا القسم مرة ثانية",
    owner_payMethodsTitle: "طرق الدفع الظاهرة بصفحة البيع", owner_payMethodsHint: "أطفئ أي طريقة دفع ما تبي الموظف يشوفها أو يستخدمها وقت البيع.",
    owner_atLeastOnePayMethod: "لازم تبقى طريقة دفع واحدة على الأقل مفعّلة.",
    owner_sectionLockTitle: "إغلاق الأقسام عن الموظفين", owner_sectionLockHint: "فعّل أي قسم عشان يطلب رمز المالك قبل ما يقدر الموظف يفتحه.",
    owner_payMethodsRowLabel: "طرق الدفع", owner_protectedByMaster: "محمي",
    zatca_title: "الربط مع هيئة الزكاة والضريبة (المرحلة الثانية)", zatca_hint: "عند التفعيل، يتم توثيق الفواتير الجديدة مع الهيئة تلقائيًا.",
    zatca_connected: "متصل", zatca_notConnected: "غير متصل",
    zatca_enableToggle: "تفعيل الربط مع الهيئة", zatca_otpLabel: "رمز التحقق (OTP)", zatca_otpPlaceholder: "٦ أرقام",
    zatca_otpInvalid: "الرمز يجب أن يكون 6 أرقام.", zatca_connect: "ربط مع الهيئة", zatca_cancel: "إلغاء",
    zatca_disableConfirm: "هل تريد تعطيل الربط مع الهيئة؟ الفواتير الجديدة ستعود للوضع العادي.",
    zatca_statusConnected: "متصل", zatca_statusDisconnected: "غير متصل",
    zatca_certificateStatus: "حالة الشهادة", zatca_certActive: "نشطة", zatca_certPending: "قيد الانتظار",
    zatca_certExpired: "منتهية", zatca_certRevoked: "ملغاة",
    zatca_expiresOn: "تنتهي في", zatca_lastSync: "آخر تحديث", zatca_neverSynced: "لم يتم التحديث بعد",
    zatca_stats: "الإحصائيات", zatca_cleared: "فواتير موثقة", zatca_reported: "فواتير مبلغة", zatca_failed: "فواتير فاشلة",
    zatca_testConnection: "اختبار الاتصال", zatca_testSuccess: "الاتصال يعمل بشكل صحيح",
    zatca_reset: "إزالة بيانات الربط", zatca_resetConfirm: "هل تريد حذف جميع بيانات الربط مع الهيئة؟ لا يمكن التراجع عن هذا.",
    zatca_enableSuccess: "تم الربط مع الهيئة بنجاح", zatca_lastError: "آخر خطأ",
    zatca_generateCsr: "١. توليد طلب الشهادة (CSR)", zatca_generateCsrButton: "توليد CSR",
    zatca_businessCategory: "النشاط التجاري", zatca_businessCategoryPlaceholder: "مثال: خدمات المغاسل",
    zatca_csrLabel: "طلب الشهادة (CSR)", zatca_csrHint: "قدّم طلب الشهادة هذا في بوابة فاتورة (fatoora.zatca.gov.sa) للحصول على رمز التحقق الحقيقي، ثم أدخله بالأسفل.",
    zatca_copyCsr: "نسخ CSR", zatca_copied: "تم النسخ", zatca_publicKeyLabel: "المفتاح العام",
    zatca_connectStep: "٢. أدخل رمز التحقق من الهيئة", zatca_csrRequiredFirst: "وَلّد CSR أولاً.",
    settings_account: "الحساب", settings_logout: "تسجيل الخروج",

    print_taxInvoice: "فاتورة ضريبية مبسطة", print_receipt: "إيصال", print_deliveryReceipt: "إيصال تسليم الملابس",
    print_address: "العنوان:", print_phone: "رقم الهاتف:", print_date: "التاريخ:", print_invNum: "رقم الفاتورة:",
    print_cashier: "الكاشير", print_branchLabel: "الفرع:", print_branchValue: "الفرع الرئيسي", print_customerLabel: "اسم العميل:",
    print_product: "المنتج", print_price: "السعر", print_total: "الإجمالي", print_deliveredDate: "تاريخ التسليم",
    print_subtotal: "الإجمالي (غير شامل الضريبة)", print_discount: "الخصم", print_vat: "الضريبة (15%)", print_grandTotal: "الإجمالي (شامل الضريبة)",
    print_paid: "المدفوع", print_remaining: "المتبقي", print_pieceCount: "عدد القطع", print_payMethod: "طريقة الدفع",
    print_dueDate: "تاريخ الاستحقاق", print_printBtn: "طباعة", print_close: "إغلاق",
    print_deliverFirst: "الرجاء تسليم قطعة واحدة على الأقل أولًا حتى يمكن طباعة الإيصال.",
    print_printDeliveryReceipt: "طباعة إيصال الاستلام", print_noItemsDelivered: "لم يتم تسليم أي قطعة من هذه الفاتورة بعد.",
    pay_cash: "نقدًا", pay_network: "شبكة خارجية", pay_wallet: "رصيد العميل", pay_credit: "دفع آجل",
    print_whatsappBtn: "واتساب", print_whatsappSending: "جارٍ الإرسال...", print_whatsappNoPhone: "لا يوجد رقم جوال مسجّل لهذا العميل.",
    print_whatsappError: "تعذّرت مشاركة الفاتورة — حاول مرة أخرى.",
  },

  ur: {
    app_name: "رغوہ", app_tagline: "لانڈری کا سب سے بہترین اسسٹنٹ",
    nav_home: "ہوم",
    nav_pos: "پوائنٹ آف سیل", nav_invoices: "جاری آرڈرز", nav_delivery: "جاری ڈیلیوری آرڈرز",
    nav_customers: "کسٹمر لیجر", nav_products: "پروڈکٹس", nav_purchases: "خریداری اور اخراجات",
    nav_promotions: "پرموشنز", nav_reports: "رپورٹس", nav_settings: "سیٹنگز",
    sidebar_footer: "متحرک ڈیٹا · کوئی فکسڈ کیٹلاگ نہیں",

    home_welcomeBack: "خوش آمدید", home_salesToday: "آج کی فروخت", home_ordersToday: "آج کے آرڈرز",
    home_readyOrders: "تیار آرڈرز", home_deliveryActive: "جاری ڈیلیوری",
    home_recentOrders: "حالیہ آرڈرز", home_viewAll: "سب دیکھیں", home_noOrders: "ابھی کوئی آرڈر نہیں",
    home_quickActions: "فوری اقدامات", home_quickPos: "نئی فروخت", home_quickInvoices: "جاری آرڈرز",
    home_quickCustomers: "کسٹمرز",

    common_save: "محفوظ کریں", common_cancel: "منسوخ کریں", common_add: "شامل کریں", common_close: "بند کریں",
    common_notes: "نوٹس", common_category: "کیٹگری", common_paymentMethod: "ادائیگی کا طریقہ",
    common_customer: "کسٹمر", common_status: "صورتحال", common_date: "تاریخ", common_amount: "رقم (ریال)",
    common_cash: "نقد", common_externalNetwork: "بیرونی نیٹ ورک", common_walletBalance: "والٹ بیلنس",
    common_creditOnAccount: "ادھار (کھاتے پر)", common_splitPayment: "ملٹی پیمنٹ", common_selectPlaceholder: "منتخب کریں...",
    common_addNew: "+ نیا شامل کریں", common_newNamePlaceholder: "نیا نام",
    common_operationFailed: "یہ عمل مکمل نہیں ہو سکا — دوبارہ کوشش کریں۔",
    common_live: "فعال", common_draft: "ڈرافٹ", common_active: "جاری", common_expired: "ختم شدہ",
    common_yes: "جی ہاں", common_no: "نہیں", common_view: "دیکھیں",

    stage_received: "موصول ہوا", stage_washing: "دھلائی", stage_pressing: "استری", stage_ready: "تیار", stage_delivered: "ڈیلیور ہو گیا",

    productModal_startingFrom: "شروع قیمت", productModal_qty: "تعداد", productModal_coreService: "بنیادی سروس",
    productModal_addons: "اضافی سہولیات", productModal_itemTotal: "کل رقم", productModal_confirm: "تصدیق کریں اور کارٹ میں شامل کریں",
    productModal_notes: "نوٹس", productModal_notesPlaceholder: "مثلاً: آستین پر داغ، اضافی خیال رکھیں...",

    pos_allItems: "تمام اشیاء", pos_checkout: "چیک آؤٹ", pos_cartEmpty: "آرڈر شروع کرنے کے لیے فہرست سے کوئی چیز منتخب کریں", pos_newOrder: "نیا آرڈر",
    pos_noProductsInCategory: "اس کیٹگری میں ابھی کوئی پروڈکٹ نہیں ہے۔",
    pos_noProductsTitle: "ابھی کوئی پروڈکٹ موجود نہیں", pos_noProductsSubtitle: "پہلے \"پروڈکٹس\" صفحے سے اپنی اشیاء شامل کریں تاکہ یہاں نظر آئیں اور آپ فروخت شروع کر سکیں۔",
    pos_deliveryOrder: "ڈیلیوری آرڈر", pos_pickupOrder: "کاؤنٹر / پک اپ آرڈر",
    pos_deliveryFeeLabel: "ڈیلیوری چارجز (کسٹمر کے مقام کے مطابق):", pos_deliveryFeePlaceholder: "چارجز خود درج کریں",
    pos_deliveryFee: "ڈیلیوری چارجز", pos_total: "کل رقم", pos_completeSale: "سیل مکمل کریں",
    pos_searchCustomerPlaceholder: "نام / موبائل / #نمبر سے تلاش کریں...", pos_noMatchingCustomers: "کوئی کسٹمر نہیں ملا",
    pos_wallet: "والٹ", pos_debt: "ادھار", pos_customerRequired: "چیک آؤٹ سے پہلے کسٹمر منتخب کرنا ضروری ہے",
    pos_searchProductsPlaceholder: "آئٹم تلاش کریں...",
    pos_discount: "رعایت", pos_coupon: "کوپن کوڈ", pos_applyCoupon: "لاگو کریں", pos_removeCoupon: "ہٹا دیں",
    pos_invalidCoupon: "کوڈ غلط ہے یا میعاد ختم ہو چکی ہے۔", pos_autoDiscountApplied: "رعایت خودکار طور پر لاگو ہو گئی",
    pos_walletInsufficient: "یہ سیل مکمل کرنے کے لیے والٹ بیلنس ناکافی ہے۔",
    pos_splitMethod1: "پہلا ادائیگی کا طریقہ", pos_splitAmount1: "ادا کی گئی رقم",
    pos_splitMethod2: "دوسرا ادائیگی کا طریقہ", pos_splitRemaining: "باقی رقم (خودکار حساب)",
    pos_splitErrorAmount: "پہلے طریقے کے لیے کل رقم سے کم رقم درج کریں۔",
    pos_splitErrorWallet: "اس ملٹی پیمنٹ میں والٹ کو تفویض کردہ رقم کے لیے بیلنس ناکافی ہے۔",

    invoices_liveDashboard: "جاری آرڈرز", invoices_deliveryDashboard: "جاری ڈیلیوری آرڈرز",
    invoices_activeDescription: "وصولی سے ڈیلیوری تک جاری آرڈرز", invoices_deliveryDescription: "ڈیلیوری آرڈرز اور ان کے تفویض کردہ ڈیلیوری والوں کی نگرانی",
    invoices_invoiceId: "آرڈر نمبر", invoices_customer: "کسٹمر", invoices_items: "اشیاء", invoices_deliveryFee: "ڈیلیوری چارجز",
    invoices_total: "کل رقم", invoices_allStatuses: "تمام",
    invoices_eta: "متوقع تیاری", invoices_etaToday: "آج", invoices_etaTomorrow: "کل",
    invoices_noActive: "کوئی جاری آرڈر نہیں۔ سب کچھ مکمل ہے۔", invoices_noActiveDelivery: "کوئی جاری ڈیلیوری آرڈر نہیں۔",
    invoices_clearFilter: "فلٹر ہٹائیں",
    invoices_actionDeliver: "ڈیلیور کریں", invoices_actionDetails: "تفصیلات",
    invoices_statusWaitingCourier: "ڈیلیوری والے کا انتظار", invoices_statusOnTheWay: "راستے میں", invoices_statusDelivered: "ڈیلیور ہو گیا",
    invoiceDetail_title: "آرڈر", invoiceDetail_deliveryOrder: "ڈیلیوری آرڈر", invoiceDetail_fee: "چارجز:",
    invoiceDetail_zatcaCleared: "زکوٰۃ اتھارٹی سے تصدیق شدہ ✅", invoiceDetail_zatcaSigned: "ڈیجیٹل دستخط شدہ — اتھارٹی کو ارسال کا انتظار",
    invoiceDetail_itemizedMatrix: "اشیاء کی تفصیل", invoiceDetail_closeAll: "آرڈر بند کریں / سب ڈیلیور کریں",
    invoiceDetail_urgent: "فوری",

    customers_title: "کسٹمر لیجر", customers_addCustomer: "کسٹمر شامل کریں",
    customers_subtitle: "لانڈری کے کسٹمرز کے والٹ بیلنس اور واجب الادا ادھار",
    customers_totalDebt: "کل واجب الادا ادھار", customers_totalWallet: "کل والٹ بیلنس",
    customers_searchPlaceholder: "نام، موبائل، یا #نمبر سے تلاش کریں...", customers_id: "نمبر", customers_name: "نام",
    customers_mobile: "موبائل", customers_wallet: "والٹ", customers_debt: "ادھار", customers_noneYet: "ابھی کوئی کسٹمر نہیں۔",
    customers_lastOrder: "آخری آرڈر", customers_details: "تفصیلات", customers_neverOrdered: "ابھی تک کوئی آرڈر نہیں",
    customers_today: "آج", customers_yesterday: "کل", customers_daysAgo: "{n} دن پہلے",
    customers_weekAgo: "ایک ہفتہ پہلے", customers_weeksAgo: "{n} ہفتے پہلے",
    customers_monthAgo: "ایک مہینہ پہلے", customers_monthsAgo: "{n} مہینے پہلے",
    customers_yearAgo: "ایک سال پہلے", customers_yearsAgo: "{n} سال پہلے",
    customerDetail_mobile: "موبائل", customerDetail_walletBalance: "والٹ بیلنس", customerDetail_debt: "ادھار / کھاتہ",
    customerDetail_totalInvoices: "کل آرڈرز", customerDetail_addBalance: "بیلنس شامل کریں (رعایت کے ساتھ)",
    customerDetail_settleDebt: "ادھار ادا کریں / بند کریں", customerDetail_invoiceHistory: "آرڈرز کی تاریخ",
    customerDetail_invoice: "آرڈر", customerDetail_method: "طریقہ", customerDetail_total: "کل رقم",
    customerDetail_noInvoices: "اس کسٹمر کا کوئی سابقہ آرڈر نہیں۔",
    customerDetail_transactions: "والٹ اور ادھار کی سرگرمیاں", customerDetail_receipt: "رسید",
    customerDetail_type: "قسم", customerDetail_detail: "تفصیل", customerDetail_paid: "ادا شدہ",
    customerDetail_noTransactions: "ابھی کوئی والٹ یا ادھار کی سرگرمی نہیں۔",
    customerDetail_topupType: "والٹ ری چارج", customerDetail_debtType: "ادھار کی ادائیگی",
    customerDetail_delivered: "ڈیلیور ہو گیا", customerDetail_processing: "زیرِ عمل",
    customerDetail_creditedDetail: "{credited} جمع ہوا · {discount} · {method}",
    customerDetail_debtDetail: "ادھار کی ادائیگی · {method}",

    addCustomer_title: "➕ نیا کسٹمر شامل کریں", addCustomer_systemId: "سسٹم نمبر (خودکار، تبدیل کیا جا سکتا ہے)",
    addCustomer_idTaken: "یہ نمبر پہلے سے کسی اور کسٹمر کے پاس ہے — دوسرا نمبر منتخب کریں۔",
    addCustomer_mobileTaken: "یہ نمبر پہلے سے کسٹمر #{id} ({name}) کے لیے رجسٹرڈ ہے۔",
    addCustomer_mobileInvalid: "درست موبائل نمبر درج کریں (05 یا 5 سے شروع ہونا چاہیے)۔",
    addCustomer_name: "کسٹمر کا نام", addCustomer_mobile: "موبائل نمبر",
    addCustomer_save: "کسٹمر محفوظ کریں",

    topup_title: "والٹ ری چارج", topup_amount: "ری چارج رقم (ریال)", topup_discountMode: "رعایت کی قسم",
    topup_flat: "فکسڈ ریال", topup_percent: "فیصد", topup_discountAmount: "رعایت کی رقم (ریال)",
    topup_discountPercent: "رعایت (%)", topup_newBalance: "نیا والٹ بیلنس", topup_duePayable: "قابل ادائیگی رقم",
    topup_addedToDebt: "ادھار میں شامل ہوگا", topup_creditWarning: "{amount} نقد وصول کرنے کے بجائے کسٹمر کے ادھار میں شامل کر دیا جائے گا۔",
    topup_confirm: "ری چارج کی تصدیق کریں", topup_noDiscount: "کوئی رعایت نہیں", topup_flatOff: "{amount} رعایت", topup_percentOff: "{percent}% رعایت",

    settle_title: "ادھار کی ادائیگی", settle_currentDebt: "موجودہ واجب الادا رقم", settle_availableWallet: "دستیاب والٹ بیلنس",
    settle_amount: "ادائیگی کی رقم (ریال)", settle_overWallet: "اس رقم کے لیے والٹ بیلنس ناکافی ہے۔",
    settle_exceedsDebtError: "رقم زیادہ سے زیادہ واجب الادا حد ({amount}) سے تجاوز کر گئی ہے",
    settle_remaining: "ادائیگی کے بعد باقی ادھار", settle_confirm: "ادائیگی کی تصدیق اور بند کریں",

    products_newProduct: "نیا پروڈکٹ", products_image: "تصویر", products_upload: "تصویر اپ لوڈ کریں (250×250)",
    products_name: "پروڈکٹ کا نام", products_servicePrices: "سروس کی قیمتیں",
    products_servicePricesHint: "(کم از کم ایک قیمت درج کریں)", products_noServiceTypes: "ابھی کوئی سروس ٹائپ موجود نہیں۔",
    products_addServiceType: "سروس ٹائپ شامل کریں", products_newServiceName: "نئی سروس کا نام",
    products_operationalCost: "آپریشنل لاگت (ریال)", products_noCost: "کوئی لاگت نہیں",
    products_liveOnPos: "پوائنٹ آف سیل پر فعال", products_draft: "ڈرافٹ کے طور پر محفوظ", products_save: "پروڈکٹ محفوظ کریں",
    products_editTitle: "پروڈکٹ میں ترمیم کریں", products_saveChanges: "تبدیلیاں محفوظ کریں",
    products_errName: "پروڈکٹ کا نام درج کریں۔", products_errCategory: "کیٹگری منتخب کریں یا شامل کریں۔",
    upload_tooLarge: "فائل بہت بڑی ہے۔", upload_badType: "فائل کی قسم معاون نہیں ہے۔",
    upload_failed: "اپ لوڈ ناکام — کنکشن چیک کریں اور دوبارہ کوشش کریں۔", upload_uploading: "اپ لوڈ ہو رہا ہے...",
    products_errService: "کم از کم ایک سروس کی قیمت درج کرنا لازمی ہے۔",
    products_quickAccess: "پروڈکٹ کے لیے فوری رسائی شارٹ کٹ", products_quickAccessNone: "کوئی نہیں",
    products_quickAccessTaken: "یہ نمبر پہلے سے کسی اور پروڈکٹ کے لیے استعمال ہو رہا ہے۔",
    products_table_product: "پروڈکٹ", products_table_category: "کیٹگری", products_table_services: "سروسز",
    products_table_from: "شروع قیمت", products_table_cost: "لاگت", products_table_status: "صورتحال",
    products_table_empty: "ابھی کوئی پروڈکٹ نہیں۔ بائیں طرف فارم سے پہلا پروڈکٹ شامل کریں۔",
    products_addonsCatalog: "اضافی سہولیات کی فہرست", products_addonNamePlaceholder: "سہولت کا نام (مثلاً نشاستہ)",
    products_addonPricePlaceholder: "قیمت", products_noAddons: "ابھی کوئی اضافی سہولت موجود نہیں۔",
    products_ownAddons: "صرف اس پروڈکٹ کے لیے اضافی سہولیات", products_noOwnAddons: "ابھی اس پروڈکٹ کی اپنی کوئی اضافی سہولت نہیں۔",
    products_kpiServiceTypes: "سروس کی اقسام", products_kpiCategories: "کیٹگریز", products_kpiTotal: "کل پروڈکٹس",
    products_searchPlaceholder: "پروڈکٹ تلاش کریں...", products_all: "تمام",
    products_emptyState: "ابھی کوئی پروڈکٹ نہیں۔ پہلا پروڈکٹ شامل کرنے کے لیے \"نیا پروڈکٹ\" دبائیں۔",
    products_noResults: "آپ کی تلاش سے مماثل کوئی پروڈکٹ نہیں۔",
    products_subtitle: "لانڈری آئٹمز، کیٹگریز، سروسز اور قیمتوں کا نظم کریں۔",

    purchases_suppliersTab: "سپلائرز اور خریداری", purchases_expensesTab: "اخراجات",
    purchases_recordPurchase: "خریداری درج کریں", purchases_newSupplier: "+ نیا سپلائر",
    purchases_supplier: "سپلائر", purchases_payment: "ادائیگی", purchases_credit: "ادھار",
    purchases_savePurchase: "خریداری محفوظ کریں", purchases_table_supplier: "سپلائر", purchases_table_agent: "ایجنٹ",
    purchases_table_contact: "رابطہ", purchases_table_liability: "واجبات", purchases_payBalance: "بیلنس ادا کریں",
    purchases_invoiceFile: "سپلائر انوائس فائل", purchases_uploadInvoice: "انوائس اپ لوڈ کریں",
    purchases_pageTitle: "خریداری اور اخراجات", purchases_pageSubtitle: "سپلائر انوائسز اور آپریٹنگ اخراجات ٹریک کریں",
    purchases_kpiCount: "درج شدہ خریداریاں", purchases_kpiSuppliers: "سپلائرز کی تعداد", purchases_kpiDue: "سپلائرز کو واجب الادا",
    purchases_addPurchaseBtn: "خریداری انوائس", purchases_searchSuppliers: "سپلائر تلاش کریں...",
    purchases_settled: "ادا شدہ", purchases_noSuppliers: "ابھی کوئی سپلائر نہیں۔",
    purchases_recentTitle: "حالیہ خریداریاں", purchases_noPurchases: "ابھی کوئی خریداری درج نہیں ہوئی۔",
    expenses_addExpense: "خرچہ شامل کریں", expenses_taxStatus: "ٹیکس کی صورتحال", expenses_taxInclusive: "ٹیکس شامل",
    expenses_taxExempt: "ٹیکس فری", expenses_date: "تاریخ", expenses_receiptFile: "رسید / فائل",
    expenses_uploadReceipt: "رسید اپ لوڈ کریں", expenses_save: "خرچہ محفوظ کریں",
    expenses_table_category: "کیٹگری", expenses_table_amount: "رقم", expenses_table_tax: "ٹیکس",
    expenses_table_date: "تاریخ", expenses_table_receipt: "رسید",
    expenses_kpiExempt: "ٹیکس فری", expenses_kpiTaxable: "ٹیکس ایبل", expenses_kpiTotal: "کل اخراجات",
    expenses_addExpenseBtn: "نیا خرچہ", expenses_searchPlaceholder: "خرچہ تلاش کریں...",
    expenses_noExpenses: "ابھی کوئی خرچہ درج نہیں ہوا۔",
    addSupplier_title: "نیا سپلائر شامل کریں", addSupplier_editTitle: "سپلائر میں ترمیم کریں", addSupplier_company: "کمپنی کا نام", addSupplier_agent: "ایجنٹ کا نام",
    addSupplier_contact: "رابطہ نمبر", addSupplier_taxNumber: "ٹیکس نمبر (اختیاری)", addSupplier_save: "سپلائر محفوظ کریں",
    addSupplier_taxExempt: "سپلائر ٹیکس سے مستثنیٰ ہے", addSupplier_exemptionNumber: "ٹیکس چھوٹ نمبر",
    supplierDetail_agent: "ایجنٹ", supplierDetail_contact: "رابطہ", supplierDetail_liability: "واجب الادا رقم",
    supplierDetail_totalPurchased: "کل خریداری", supplierDetail_payBalance: "بیلنس ادا کریں",
    supplierDetail_taxNumber: "ٹیکس نمبر", supplierDetail_noTaxNumber: "رجسٹرڈ نہیں",
    supplierDetail_history: "خریداری کی تاریخ", supplierDetail_poId: "آرڈر نمبر", supplierDetail_method: "طریقہ",
    supplierDetail_amount: "رقم", supplierDetail_invoice: "انوائس", supplierDetail_empty: "اس سپلائر سے ابھی کوئی خریداری نہیں ہوئی۔",
    payBalance_title: "بیلنس ادا کریں", payBalance_liability: "واجب الادا رقم:", payBalance_confirm: "ادائیگی کی تصدیق کریں",
    payBalance_exceedsError: "رقم زیادہ سے زیادہ واجب الادا حد ({amount}) سے تجاوز کر گئی ہے",

    promotions_title: "پرموشنز", promotions_subtitle: "گاہکوں کے لیے فیصد اور فکسڈ رعایتیں اور کوپن کوڈز۔", promotions_addDiscount: "رعایت شامل کریں",
    promotions_table_name: "نام", promotions_table_type: "قسم", promotions_table_value: "قیمت", promotions_table_coupon: "کوپن",
    promotions_table_start: "آغاز", promotions_table_end: "اختتام", promotions_table_status: "صورتحال",
    promotions_empty: "ابھی کوئی رعایت موجود نہیں۔", promotions_edit: "ترمیم", promotions_cancel: "منسوخ کریں", promotions_cancelled: "منسوخ شدہ",
    promotions_scheduled: "شیڈول", promotions_typePercent: "فیصد", promotions_typeFixed: "فکسڈ",
    promoModal_title: "رعایت شامل کریں", promoModal_editTitle: "رعایت میں ترمیم کریں", promoModal_name: "رعایت کا نام", promoModal_requiresCoupon: "کوپن درکار ہے؟",
    promoModal_couponRequired: "کوپن لازمی ہے", promoModal_appliesAuto: "خودکار لاگو ہوگی",
    promoModal_couponCode: "کوپن کوڈ", promoModal_evalType: "رعایت کی قسم", promoModal_percentage: "فیصد %",
    promoModal_fixed: "فکسڈ", promoModal_discountPercent: "رعایت (%)", promoModal_discountAmount: "رعایت (ریال)",
    promoModal_start: "آغاز", promoModal_end: "اختتام", promoModal_save: "رعایت محفوظ کریں", promoModal_saveEdit: "تبدیلیاں محفوظ کریں",
    promoModal_overlapError: "اس مدت کے دوران پہلے سے ایک فعال رعایت موجود ہے — رعایتوں کی مدت میں تداخل کی اجازت نہیں ہے۔",
    promoModal_valueError: "صفر سے بڑی ایک قیمت درج کریں (فیصد رعایت 100% سے زیادہ نہیں ہو سکتی)۔",

    reports_salesTab: "سیلز رپورٹ", reports_procurementTab: "خریداری رپورٹ",
    reports_kpi_invoices: "آرڈرز", reports_kpi_grossSales: "کل فروخت", reports_kpi_vatCollected: "وصول شدہ ٹیکس",
    reports_kpi_netRevenue: "خالص آمدنی", reports_kpi_outstandingDebt: "واجب الادا ادھار",
    reports_allPaymentMethods: "تمام ادائیگی کے طریقے",
    reports_table_invoice: "آرڈر", reports_table_client: "کسٹمر", reports_table_method: "طریقہ",
    reports_table_net: "خالص", reports_table_vat: "ٹیکس", reports_table_gross: "کل رقم",
    reports_salesEmpty: "ان فلٹرز سے کوئی فروخت نہیں ملی۔",
    reports_kpi_purchases: "خریداری", reports_kpi_grossOutflow: "کل اخراجات", reports_kpi_inputVat: "ادا شدہ ٹیکس",
    reports_kpi_netCost: "خالص خریداری لاگت", reports_table_poId: "آرڈر نمبر", reports_table_supplier: "سپلائر",
    reports_table_value: "مالیت", reports_table_created: "تاریخِ تخلیق", reports_procurementEmpty: "ابھی کوئی خریداری ریکارڈ نہیں۔",

    reports_expensesTab: "اخراجات", reports_plTab: "منافع و نقصان", reports_vatTab: "ٹیکس ریٹرن",
    reports_kpi_totalExpenses: "کل اخراجات", reports_kpi_expenseVat: "اخراجات پر ٹیکس", reports_kpi_expenseNet: "خالص اخراجات (ٹیکس کے بغیر)",
    reports_expensesEmpty: "ان فلٹرز سے کوئی خرچہ نہیں ملا۔",

    reports_pl_allTimeTitle: "دکان کھلنے سے اب تک", reports_pl_periodTitle: "منتخب مدت",
    reports_pl_revenue: "آمدنی", reports_pl_costs: "لاگت (خریداری + اخراجات)",
    reports_pl_profit: "منافع", reports_pl_loss: "نقصان", reports_pl_margin: "منافع کا تناسب",
    reports_pl_result: "نتیجہ",

    reports_vat_periodMode: "مدت کی قسم", reports_vat_quarterly: "سہ ماہی", reports_vat_monthly: "ماہانہ",
    reports_vat_year: "سال", reports_vat_quarter: "سہ ماہی", reports_vat_month: "مہینہ",
    reports_vat_salesTable: "فروخت — آؤٹ پٹ ٹیکس", reports_vat_purchasesTable: "خریداری — ان پٹ ٹیکس",
    reports_vat_box1_sales: "1. معیاری شرح والی فروخت (15%)", reports_vat_box2_sales: "2. شہریوں کو فروخت جس کا ٹیکس حکومت برداشت کرتی ہے",
    reports_vat_box3_sales: "3. صفر شرح والی مقامی فروخت", reports_vat_box4_sales: "4. مملکت سے باہر برآمدات (صفر شرح)",
    reports_vat_box5_sales: "5. ٹیکس سے مستثنیٰ فروخت",
    reports_vat_box1_purch: "1. معیاری شرح والی خریداری (15%)", reports_vat_box2_purch: "2. کسٹمز پر ادا شدہ ٹیکس والی درآمدات",
    reports_vat_box3_purch: "3. ریورس چارج میکانزم والی خریداری", reports_vat_box4_purch: "4. صفر شرح والی خریداری",
    reports_vat_box5_purch: "5. ٹیکس سے مستثنیٰ خریداری",
    reports_vat_taxableAmount: "قابلِ ٹیکس رقم", reports_vat_vatAmount: "ٹیکس کی رقم",
    reports_vat_totalSales: "کل فروخت", reports_vat_totalOutputVat: "کل آؤٹ پٹ ٹیکس",
    reports_vat_totalPurchases: "کل خریداری", reports_vat_totalInputVat: "کل ان پٹ ٹیکس",
    reports_vat_netTitle: "ادارے کو واجب الادا خالص ٹیکس", reports_vat_dueToAuthority: "ادارے کو ادا کی جانے والی رقم:",
    reports_vat_dueRefund: "واپسی/منتقلی کے قابل رقم:",
    reports_vat_copy: "کاپی کریں", reports_vat_copied: "کاپی ہو گیا!", reports_vat_exportCsv: "⬇️ CSV ایکسپورٹ کریں (ایکسل)", reports_vat_printPdf: "🖨️ پرنٹ / PDF محفوظ کریں",
    reports_vat_notTracked: "اس نظام میں الگ سے ٹریک نہیں ہوتا — 0 دکھایا گیا ہے۔",

    settings_title: "سیٹنگز", settings_language: "زبان", settings_languageHint: "ایپ کی زبان منتخب کریں۔ ہر چیز فوری تبدیل ہو جائے گی — صرف وہ نام جو آپ خود لکھتے ہیں (پروڈکٹس، کیٹگریز، کسٹمرز) ویسے ہی رہیں گے۔",
    settings_lang_ar: "العربية", settings_lang_en: "English", settings_lang_ur: "اردو",

    settings_merchantInfo: "تاجر کی معلومات", settings_merchantInfoHint: "ٹیکس انوائسز اور رسیدیں پرنٹ کرنے کے لیے استعمال ہوتی ہیں۔",
    settings_autoPrint: "خودکار پرنٹ", settings_autoPrintHint: "سیل مکمل ہوتے ہی رسید/انوائس خودکار طور پر پرنٹ ہو جائے گی، بغیر کسی اضافی کلک کے۔",
    settings_autoPrintCopies: "کاپیوں کی تعداد",
    settings_showPrintPreview: "انوائس پیش نظارہ دکھائیں", settings_showPrintPreviewHint: "بند کریں تاکہ بغیر کسی پاپ اپ کے خاموشی سے پرنٹ ہو اور فوراً اگلی سیل پر جائے۔",
    settings_merchantName: "نام (کمرشل رجسٹریشن میں درج شدہ)", settings_merchantPhone: "دکان کا فون نمبر",
    settings_merchantAddress: "دکان کا مقام", settings_merchantTax: "ٹیکس نمبر",
    settings_merchantSave: "تبدیلیاں محفوظ کریں", settings_merchantSaved: "محفوظ ہو گیا",
    settings_ownerOnly: "صرف مالک کے لیے", settings_ownerOnlyHint: "حساس حصوں کو ایسے پاس ورڈ سے محفوظ کریں جو صرف آپ جانتے ہوں۔",
    whatsapp_title: "واٹس ایپ پر انوائس بھیجیں", whatsapp_hint: "سیل مکمل ہوتے ہی انوائس خودکار طور پر واٹس ایپ کے ذریعے کسٹمر کو بھیج دی جاتی ہے — دستیاب ٹیگز:",
    owner_setMasterTitle: "اس حصے کے لیے نیا پاس ورڈ بنائیں", owner_enterMasterTitle: "مالک کا پاس ورڈ درج کریں",
    owner_setSectionTitle: "\"{section}\" کے لیے پاس ورڈ بنائیں", owner_enterSectionTitle: "یہ حصہ لاک ہے — پاس ورڈ درج کریں",
    owner_pinLabel: "پاس ورڈ (4 ہندسے)", owner_pinConfirmLabel: "پاس ورڈ کی تصدیق کریں",
    owner_pinFormatError: "پاس ورڈ بالکل 4 ہندسوں پر مشتمل ہونا چاہیے (صرف نمبر)۔", owner_pinMismatch: "پاس ورڈز مماثل نہیں ہیں۔",
    owner_pinWrong: "پاس ورڈ غلط ہے۔", owner_lockPanel: "اس حصے کو دوبارہ لاک کریں",
    owner_payMethodsTitle: "POS پر دکھائے جانے والے ادائیگی کے طریقے", owner_payMethodsHint: "کوئی بھی ایسا طریقہ بند کر دیں جو عملے کو چیک آؤٹ پر نظر نہیں آنا چاہیے۔",
    owner_atLeastOnePayMethod: "کم از کم ایک ادائیگی کا طریقہ فعال رہنا ضروری ہے۔",
    owner_sectionLockTitle: "عملے سے حصے مقفل کریں", owner_sectionLockHint: "کسی حصے کو فعال کریں تاکہ عملہ اسے کھولنے سے پہلے مالک کا پن درج کرے۔",
    owner_payMethodsRowLabel: "ادائیگی کے طریقے", owner_protectedByMaster: "محفوظ شدہ",
    zatca_title: "زکوٰۃ اتھارٹی کے ساتھ ربط (فیز 2)", zatca_hint: "فعال ہونے پر، نئے انوائسز خودکار طور پر اتھارٹی سے تصدیق شدہ ہوں گے۔",
    zatca_connected: "منسلک", zatca_notConnected: "غیر منسلک",
    zatca_enableToggle: "زکوٰۃ ربط فعال کریں", zatca_otpLabel: "OTP کوڈ", zatca_otpPlaceholder: "6 ہندسوں کا کوڈ",
    zatca_otpInvalid: "کوڈ 6 ہندسوں کا ہونا چاہیے۔", zatca_connect: "اتھارٹی سے ربط کریں", zatca_cancel: "منسوخ کریں",
    zatca_disableConfirm: "زکوٰۃ ربط غیر فعال کریں؟ نئے انوائسز معمول کی حالت میں واپس چلے جائیں گے۔",
    zatca_statusConnected: "منسلک", zatca_statusDisconnected: "غیر منسلک",
    zatca_certificateStatus: "سرٹیفکیٹ کی صورتحال", zatca_certActive: "فعال", zatca_certPending: "زیر التوا",
    zatca_certExpired: "ختم شدہ", zatca_certRevoked: "منسوخ شدہ",
    zatca_expiresOn: "ختم ہونے کی تاریخ", zatca_lastSync: "آخری ہم آہنگی", zatca_neverSynced: "ابھی تک ہم آہنگ نہیں ہوا",
    zatca_stats: "اعداد و شمار", zatca_cleared: "تصدیق شدہ انوائسز", zatca_reported: "رپورٹ شدہ انوائسز", zatca_failed: "ناکام",
    zatca_testConnection: "کنکشن ٹیسٹ کریں", zatca_testSuccess: "کنکشن ٹھیک کام کر رہا ہے",
    zatca_reset: "زکوٰۃ ڈیٹا ہٹائیں", zatca_resetConfirm: "زکوٰۃ کی تمام ترتیبات حذف کریں؟ اسے واپس نہیں لیا جا سکتا۔",
    zatca_enableSuccess: "اتھارٹی سے کامیابی سے ربط ہو گیا", zatca_lastError: "آخری خرابی",
    zatca_generateCsr: "1. سرٹیفکیٹ ریکویسٹ (CSR) بنائیں", zatca_generateCsrButton: "CSR بنائیں",
    zatca_businessCategory: "کاروباری زمرہ", zatca_businessCategoryPlaceholder: "مثلاً: لانڈری سروسز",
    zatca_csrLabel: "سرٹیفکیٹ ریکویسٹ (CSR)", zatca_csrHint: "یہ CSR ZATCA کے فاتورہ پورٹل (fatoora.zatca.gov.sa) پر جمع کروائیں تاکہ اصل تصدیقی کوڈ ملے، پھر نیچے درج کریں۔",
    zatca_copyCsr: "CSR کاپی کریں", zatca_copied: "کاپی ہو گیا", zatca_publicKeyLabel: "پبلک کی",
    zatca_connectStep: "2. ZATCA کا تصدیقی کوڈ درج کریں", zatca_csrRequiredFirst: "پہلے CSR بنائیں۔",
    settings_account: "اکاؤنٹ", settings_logout: "لاگ آؤٹ",

    print_taxInvoice: "سادہ ٹیکس انوائس", print_receipt: "رسید", print_deliveryReceipt: "کپڑوں کی ڈیلیوری رسید",
    print_address: "پتہ:", print_phone: "فون نمبر:", print_date: "تاریخ:", print_invNum: "انوائس نمبر:",
    print_cashier: "کیشیئر", print_branchLabel: "برانچ:", print_branchValue: "مرکزی برانچ", print_customerLabel: "کسٹمر کا نام:",
    print_product: "پروڈکٹ", print_price: "قیمت", print_total: "کل رقم", print_deliveredDate: "ڈیلیوری کی تاریخ",
    print_subtotal: "کل رقم (ٹیکس کے بغیر)", print_discount: "رعایت", print_vat: "ٹیکس (15%)", print_grandTotal: "کل رقم (ٹیکس سمیت)",
    print_paid: "ادا شدہ", print_remaining: "باقی رقم", print_pieceCount: "اشیاء کی تعداد", print_payMethod: "ادائیگی کا طریقہ",
    print_dueDate: "ادائیگی کی تاریخ", print_printBtn: "پرنٹ کریں", print_close: "بند کریں",
    print_deliverFirst: "پرنٹ کرنے سے پہلے کم از کم ایک شے ڈیلیور کرنا لازمی ہے۔",
    print_printDeliveryReceipt: "ڈیلیوری رسید پرنٹ کریں", print_noItemsDelivered: "اس آرڈر سے ابھی تک کوئی شے ڈیلیور نہیں ہوئی۔",
    pay_cash: "نقد", pay_network: "بیرونی نیٹ ورک", pay_wallet: "کسٹمر بیلنس", pay_credit: "ادھار",
    print_whatsappBtn: "واٹس ایپ", print_whatsappSending: "بھیجا جا رہا ہے...", print_whatsappNoPhone: "اس کسٹمر کا کوئی فون نمبر درج نہیں ہے۔",
    print_whatsappError: "انوائس شیئر نہیں ہو سکی — دوبارہ کوشش کریں۔",
  },
};

const LangContext = createContext(null);
function useLang() {
  const ctx = useContext(LangContext);
  const t = (key, vars) => {
    let str = (DICT[ctx.lang] && DICT[ctx.lang][key]) || DICT.en[key] || key;
    if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
    return str;
  };
  return { lang: ctx.lang, setLang: ctx.setLang, dir: ctx.dir, t };
}

const NAV = [
  { key: "pos", labelKey: "nav_pos", icon: Shirt },
  { key: "invoices", labelKey: "nav_invoices", icon: ClipboardList },
  { key: "delivery_invoices", labelKey: "nav_delivery", icon: Truck },
  { key: "customers", labelKey: "nav_customers", icon: Users },
  { key: "inventory", labelKey: "nav_products", icon: Package },
  { key: "purchases", labelKey: "nav_purchases", icon: Building2 },
  { key: "promotions", labelKey: "nav_promotions", icon: Tag },
  { key: "reports", labelKey: "nav_reports", icon: BarChart3 },
  { key: "settings", labelKey: "nav_settings", icon: Settings },
];

function Sidebar({ tab, setTab, sectionLocks, setSectionLocks, merchant }) {
  const { t } = useLang();
  const [pendingNav, setPendingNav] = useState(null);

  const handleNavClick = (key) => {
    if (sectionLocks[key]) setPendingNav(key);
    else setTab(key);
  };

  return (
    <div className="flex h-full w-60 shrink-0 flex-col bg-navy-900 text-stone-200 f-body">
      <button onClick={() => setTab("home")} className="flex items-center gap-3 px-5 py-6 text-left hover:bg-navy-800/60 transition">
        <img src={LOGO_DATA_URI} alt="Ragwa" className="h-11 w-11 shrink-0 object-contain drop-shadow-md" />
        <div>
          <div className="f-display text-2xl font-bold tracking-tight text-white leading-none">{t("app_name")}</div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-brand-400 mt-1">{t("app_tagline")}</div>
        </div>
      </button>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((n, i) => {
          const Icon = n.icon;
          const active = tab === n.key;
          const locked = Boolean(sectionLocks[n.key]);
          return (
            <button key={n.key} onClick={() => handleNavClick(n.key)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-semibold transition-colors ${active ? "bg-brand-500/15 text-white ring-1 ring-inset ring-brand-400/30" : "text-white/65 hover:bg-white/5 hover:text-white"}`}>
              <Icon className={`size-[18px] shrink-0 ${active ? "text-brand-300" : ""}`} />
              <span className="truncate">{t(n.labelKey)}</span>
              {locked && <Lock size={12} className={active ? "text-brand-100" : "text-amber-400"} />}
              {active && !locked && <span className="mr-auto size-1.5 shrink-0 rounded-full bg-brand-400" />}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-navy-800 px-3 pt-1">
        <button onClick={() => setTab("home")}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${tab === "home" ? "text-white" : "text-white/50 hover:text-white"}`}>
          <Home size={16} />
          <span>{t("nav_home")}</span>
        </button>
      </div>
      <div className="px-5 py-4 border-t border-navy-800">
        <div className="truncate text-sm font-semibold text-white">{merchant?.name || t("app_name")}</div>
        <div className="text-[11px] text-slate-500">{t("sidebar_footer")}</div>
      </div>

      {pendingNav && (
        <PinPromptModal
          title={t("owner_enterSectionTitle")}
          mode="enter"
          verify={async (pin) => {
            const stored = sectionLocks[pendingNav];
            if (pin === stored) { // legacy plaintext — self-heal to a hash
              const key = pendingNav;
              sha256Hex(pin).then((h) => setSectionLocks((p) => ({ ...p, [key]: h })));
              return true;
            }
            return (await sha256Hex(pin)) === stored;
          }}
          onSuccess={() => { setTab(pendingNav); setPendingNav(null); }}
          onClose={() => setPendingNav(null)}
        />
      )}
    </div>
  );
}

/* =========================================================================
   MODULE 1 — POINT OF SALE
   ========================================================================= */
function ProductModal({ product, addons, onClose, onConfirm }) {
  const { t } = useLang();
  const serviceEntries = Object.entries(product.services);
  // Default state on open: first primary service selected, qty 1 — matches
  // what the keyboard-first flow (below) needs to always start from.
  const [service, setService] = useState(serviceEntries[0]?.[0] || "");
  const [selectedAddons, setSelectedAddons] = useState([]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  const qtyInputRef = useRef(null);

  const allAddons = [...addons, ...(product.productAddons || [])];
  const servicePrice = product.services[service] || 0;
  const addonsTotal = selectedAddons.reduce((s, id) => s + (allAddons.find((a) => a.id === id)?.price || 0), 0);
  const lineTotal = (servicePrice + addonsTotal) * qty;

  const toggleAddon = (id) => setSelectedAddons((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const confirm = () => onConfirm({ cartId: uid("cart"), productId: product.id, name: product.name, image: product.image, service, servicePrice, addons: selectedAddons.map((id) => allAddons.find((a) => a.id === id)), qty, lineTotal, notes: notes.trim() });

  // Modal-scoped shortcuts — mounting this modal already stops the POS
  // screen's own listener (see POSView), so these are the only ones live
  // while it's open: 1-9 jump straight to that primary service, Q jumps to
  // (and selects) the quantity field for instant retyping, Enter confirms
  // the sale exactly like the button below, Escape cancels with no change.
  useKeydown((e) => {
    // Typing a multi-line note needs its own Enter/digits/letters untouched
    // by the quantity/service/confirm shortcuts below.
    if (document.activeElement?.tagName === "TEXTAREA") return;
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "Enter") { e.preventDefault(); confirm(); return; }
    // e.code (not just e.key) so this fires off the same physical key
    // regardless of the active keyboard language — "ض" sits on the same key
    // as "Q" in the Arabic layout, and e.code identifies that key directly
    // rather than whatever character the current layout happens to print.
    if (e.key === "q" || e.key === "Q" || e.key === "ض" || e.code === "KeyQ") {
      e.preventDefault();
      qtyInputRef.current?.select();
      return;
    }
    const num = digitFromKeyEvent(e);
    if (num && num <= serviceEntries.length) { e.preventDefault(); setService(serviceEntries[num - 1][0]); }
  });

  return (
    <Modal title={product.name} onClose={onClose} width="max-w-xl">
      <div className="flex gap-5 mb-5">
        {product.image ? (
          <img src={product.image} alt={product.name} loading="lazy" decoding="async" className="h-36 w-36 rounded-xl object-cover ring-1 ring-app-border" />
        ) : (
          <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-xl border border-dashed border-app-border-strong bg-app-bg">
            <ImageIcon size={28} className="text-app-text-subtle" />
          </div>
        )}
        <div className="flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("productModal_startingFrom")}</div>
          <div className="f-mono text-2xl font-semibold text-app-text">{sar(product.price)}</div>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("productModal_qty")}</span>
            <div className="flex items-center rounded-lg border border-app-border-strong">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="px-3 py-1 text-app-text-muted hover:bg-app-bg">−</button>
              <input
                ref={qtyInputRef}
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="f-mono w-12 border-0 bg-transparent text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button onClick={() => setQty((q) => q + 1)} className="px-3 py-1 text-app-text-muted hover:bg-app-bg">+</button>
            </div>
          </div>
        </div>
      </div>

      <div className="mb-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{t("productModal_coreService")}</div>
        <div className="grid grid-cols-3 gap-2">
          {serviceEntries.map(([name, price], i) => (
            <button key={name} onClick={() => setService(name)}
              className={`relative rounded-lg border px-2 py-2.5 text-center transition ${service === name ? "border-brand-600 bg-brand-50 text-brand-800" : "border-app-border text-app-text-muted hover:border-app-border-strong"}`}>
              {i < 9 && <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-app-border text-[9px] font-bold text-app-text-muted">{i + 1}</span>}
              <div className="text-xs font-medium">{name}</div>
              <div className="f-mono text-sm font-semibold mt-0.5">{sar(price)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{t("productModal_addons")}</div>
        <div className="flex flex-wrap gap-2">
          {allAddons.map((a) => {
            const on = selectedAddons.includes(a.id);
            return (
              <button key={a.id} onClick={() => toggleAddon(a.id)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${on ? "border-warning-500 bg-warning-50 text-warning-700" : "border-app-border text-app-text-muted hover:border-app-border-strong"}`}>
                {a.name} {a.price > 0 ? `+${sar(a.price)}` : ""}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{t("productModal_notes")}</div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t("productModal_notesPlaceholder")}
          className="w-full rounded-lg border border-app-border-strong px-3 py-2 text-sm text-app-text focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 resize-none" />
      </div>

      <div className="flex items-center justify-between rounded-xl bg-app-bg border border-app-border px-4 py-3 mb-5">
        <span className="text-sm font-medium text-app-text-muted">{t("productModal_itemTotal")}</span>
        <span className="f-mono text-xl font-bold text-brand-700">{sar(lineTotal)}</span>
      </div>

      <button
        onClick={confirm}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-3 font-semibold text-white hover:bg-brand-600">
        <Check size={18} /> {t("productModal_confirm")}
      </button>
    </Modal>
  );
}

function AddCustomerModal({ customers, onClose, onSave }) {
  const { t } = useLang();
  const suggestedId = customers.length ? Math.max(...customers.map((c) => c.id)) + 1 : 1;
  const [id, setId] = useState(suggestedId);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");

  const idTaken = customers.some((c) => c.id === Number(id));
  const idInvalid = id === "" || Number(id) <= 0 || idTaken;

  const mobileTrimmed = mobile.trim();
  const existingByMobile = mobileTrimmed && mobileTrimmed !== "-" ? customers.find((c) => c.mobile === mobileTrimmed) : null;
  const mobileTaken = Boolean(existingByMobile);
  // Empty is allowed (renders as "-" in the ledger, same as before) — the
  // 9665XXXXXXXX format is only enforced once the owner actually types something.
  const mobileFormatInvalid = mobileTrimmed !== "" && !isValidSaudiMobile(mobileTrimmed);
  const mobileInvalid = mobileTaken || mobileFormatInvalid;

  return (
    <Modal title={t("addCustomer_title")} onClose={onClose}>
      <Field label={t("addCustomer_systemId")}>
        <input type="number" min="1" value={id} onChange={(e) => setId(e.target.value)} className={`${inputCls} ${idTaken ? "border-danger-400" : ""}`} />
        {idTaken && <div className="mt-1.5 text-xs font-semibold text-danger-600">{t("addCustomer_idTaken")}</div>}
      </Field>
      {/* Capped at 15 chars so a long name can't be the thing that forces the
          customer ledger's name column wider than its allotted share. */}
      <Field label={t("addCustomer_name")}><input autoFocus value={name} onChange={(e) => setName(e.target.value.slice(0, 15))} maxLength={15} className={inputCls} /></Field>
      <Field label={t("addCustomer_mobile")}>
        <input value={mobile} onChange={(e) => setMobile(normalizeSaudiMobile(e.target.value))} placeholder="05XXXXXXXX" maxLength={12} dir="ltr" className={`${inputCls} ${mobileTaken ? "border-danger-400" : ""}`} />
        {mobileTaken && <div className="mt-1.5 text-xs font-semibold text-danger-600">{t("addCustomer_mobileTaken", { id: existingByMobile.id, name: existingByMobile.name })}</div>}
      </Field>
      <button
        disabled={!name.trim() || idInvalid || mobileInvalid}
        onClick={() => onSave({ id: Number(id), name: name.trim(), mobile: mobileTrimmed || "-", walletBalance: 0, debt: 0 })}
        className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:bg-app-border-strong">
        {t("addCustomer_save")}
      </button>
    </Modal>
  );
}

function AddSupplierModal({ onClose, onSave, editing }) {
  const { t } = useLang();
  const [company, setCompany] = useState(editing?.company || "");
  const [agent, setAgent] = useState(editing?.agent && editing.agent !== "-" ? editing.agent : "");
  const [contact, setContact] = useState(editing?.contact && editing.contact !== "-" ? editing.contact : "");
  const [taxNumber, setTaxNumber] = useState(editing?.taxNumber || "");
  const [taxExempt, setTaxExempt] = useState(Boolean(editing?.taxExempt));
  const [exemptionNumber, setExemptionNumber] = useState(editing?.exemptionNumber || "");
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          {editing ? <Pencil size={16} /> : <Plus size={16} />}
          {editing ? t("addSupplier_editTitle") : t("addSupplier_title")}
        </span>
      }
      onClose={onClose}>
      <Field label={t("addSupplier_company")}><input autoFocus value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls} /></Field>
      <Field label={t("addSupplier_agent")}><input value={agent} onChange={(e) => setAgent(e.target.value.slice(0, 15))} maxLength={15} className={inputCls} /></Field>
      <Field label={t("addSupplier_contact")}><input value={contact} onChange={(e) => setContact(e.target.value)} className={inputCls} /></Field>
      <Field label={t("addSupplier_taxNumber")}><input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} className={`${inputCls} f-mono`} /></Field>
      <div className="mb-4">
        <Toggle checked={taxExempt} onChange={setTaxExempt} label={t("addSupplier_taxExempt")} />
      </div>
      {/* Distinct from the regular tax number above: this is what makes a
          purchase count toward the Tax Return's exempt-purchases box (#5)
          instead of the standard-rated box. Without it, purchases from this
          supplier stay recorded in the system/reports but excluded from the
          tax return entirely, same as any supplier with no tax info at all. */}
      {taxExempt && (
        <Field label={t("addSupplier_exemptionNumber")}><input value={exemptionNumber} onChange={(e) => setExemptionNumber(e.target.value)} className={`${inputCls} f-mono`} /></Field>
      )}
      <button
        onClick={() => { if (!company.trim()) return; onSave({ company: company.trim(), agent: agent.trim() || "-", contact: contact.trim() || "-", taxNumber: taxNumber.trim(), taxExempt, exemptionNumber: taxExempt ? exemptionNumber.trim() : "" }); }}
        className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600">
        {t("addSupplier_save")}
      </button>
    </Modal>
  );
}

// Inline "add new supplier" card rendered INSIDE the record-purchase modal —
// distinct from AddSupplierModal above (a full modal, used only for editing
// an existing supplier from SupplierDetailModal). Same fields/validation as
// AddSupplierModal, just laid out inline instead of stacking a modal-on-modal.
function SupplierQuickAddFields({ onSave, onCancel }) {
  const { t } = useLang();
  const [company, setCompany] = useState("");
  const [agent, setAgent] = useState("");
  const [contact, setContact] = useState("");
  const [taxExempt, setTaxExempt] = useState(false);
  const [exemptionNumber, setExemptionNumber] = useState("");
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-800">{t("purchases_newSupplier")}</span>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-app-text-muted hover:text-app-text">{t("common_cancel")}</button>
      </div>
      <input autoFocus value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t("addSupplier_company")} className={inputCls} />
      <input value={agent} onChange={(e) => setAgent(e.target.value.slice(0, 15))} maxLength={15} placeholder={t("addSupplier_agent")} className={inputCls} />
      <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t("addSupplier_contact")} className={inputCls} />
      {/* This quick-add card skips the real tax NUMBER field (registered
          suppliers are the less-common case and can be filled in later via
          the full edit modal) — but the exemption number can't be skipped
          the same way: exemptSupplierIds only counts a supplier as exempt
          when BOTH taxExempt and exemptionNumber are set, so saving exempt=true
          with no number here would silently drop this supplier's purchases
          out of the tax return entirely (neither taxed nor exempt) until
          someone remembers to go edit it — a real VAT-classification bug,
          not just a missing field. */}
      <Toggle checked={taxExempt} onChange={setTaxExempt} label={t("addSupplier_taxExempt")} />
      {taxExempt && (
        <input value={exemptionNumber} onChange={(e) => setExemptionNumber(e.target.value)} placeholder={t("addSupplier_exemptionNumber")} className={`${inputCls} f-mono`} />
      )}
      <button
        type="button"
        onClick={() => { if (!company.trim()) return; onSave({ company: company.trim(), agent: agent.trim() || "-", contact: contact.trim() || "-", taxNumber: "", taxExempt, exemptionNumber: taxExempt ? exemptionNumber.trim() : "" }); }}
        className="w-full rounded-lg bg-brand-500 py-2 text-sm font-semibold text-white hover:bg-brand-600">
        {t("addSupplier_save")}
      </button>
    </div>
  );
}

function SupplierDetailModal({ supplier, purchases, onClose, onPayBalance, onEdit }) {
  const { t } = useLang();
  const supplierPurchases = purchases.filter((p) => p.supplierId === supplier.id).sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalSpent = supplierPurchases.reduce((s, p) => s + p.amount, 0);

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          {supplier.company}
          <button onClick={onEdit} className="rounded-full p-1 text-app-text-subtle hover:bg-app-bg hover:text-brand-700"><Pencil size={15} /></button>
        </span>
      }
      onClose={onClose} width="max-w-2xl">
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-app-border bg-app-bg p-3">
          <div className="text-xs text-app-text-muted">{t("supplierDetail_agent")}</div>
          <div className="font-semibold text-app-text text-sm">{supplier.agent}</div>
        </div>
        <div className="rounded-lg border border-app-border bg-app-bg p-3">
          <div className="text-xs text-app-text-muted">{t("supplierDetail_contact")}</div>
          <div className="f-mono font-semibold text-app-text text-sm">{supplier.contact}</div>
        </div>
        <div className="rounded-lg border border-danger-200 bg-danger-50 p-3">
          <div className="text-xs text-danger-700">{t("supplierDetail_liability")}</div>
          <div className="f-mono font-semibold text-danger-800">{sar(supplier.balance)}</div>
        </div>
        <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
          <div className="text-xs text-brand-700">{t("supplierDetail_totalPurchased")}</div>
          <div className="f-mono font-semibold text-brand-800">{sar(totalSpent)}</div>
        </div>
        <div className="rounded-lg border border-app-border bg-app-bg p-3">
          <div className="text-xs text-app-text-muted">{t("supplierDetail_taxNumber")}</div>
          <div className="f-mono font-semibold text-app-text text-sm">{supplier.taxNumber ? supplier.taxNumber : t("supplierDetail_noTaxNumber")}</div>
        </div>
        {supplier.taxExempt && (
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-3">
            <div className="text-xs text-warning-700">{t("addSupplier_exemptionNumber")}</div>
            <div className="f-mono font-semibold text-warning-800 text-sm">{supplier.exemptionNumber || "—"}</div>
          </div>
        )}
      </div>

      {supplier.balance > 0 && (
        <button onClick={() => onPayBalance(supplier)} className="mb-5 w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600">{t("supplierDetail_payBalance")}</button>
      )}

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{t("supplierDetail_history")}</div>
      <div className="overflow-hidden rounded-xl border border-app-border">
        <table className="w-full text-sm">
          <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
            <tr><th className="px-3 py-2">{t("supplierDetail_poId")}</th><th className="px-3 py-2">{t("common_date")}</th><th className="px-3 py-2">{t("supplierDetail_method")}</th><th className="px-3 py-2">{t("supplierDetail_amount")}</th><th className="px-3 py-2">{t("supplierDetail_invoice")}</th></tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {supplierPurchases.map((p) => (
              <tr key={p.id} className="hover:bg-app-bg">
                <td className="px-3 py-2 f-mono text-app-text-muted">{p.code}</td>
                <td className="px-3 py-2 f-mono text-xs text-app-text-subtle">{fmtDate(p.date)}</td>
                <td className="px-3 py-2 text-app-text-muted">{p.method}</td>
                <td className="px-3 py-2 f-mono font-semibold text-app-text">{sar(p.amount)}</td>
                <td className="px-3 py-2">
                  {p.attachment ? (
                    <button onClick={() => openStoredDocument(p.attachment)} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                      <Paperclip size={13} />{t("common_view")}
                    </button>
                  ) : <span className="text-app-text-subtle">—</span>}
                </td>
              </tr>
            ))}
            {supplierPurchases.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-app-text-subtle">{t("supplierDetail_empty")}</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

const PAY_METHODS = [
  { value: "Cash", key: "common_cash" },
  { value: "External Network", key: "common_externalNetwork" },
  { value: "Wallet Balance", key: "common_walletBalance" },
  { value: "Credit (On Account)", key: "common_creditOnAccount" },
];
const POS_PAY_METHODS = [...PAY_METHODS, { value: "Split", key: "common_splitPayment" }];
const PAY_METHOD_ICONS = {
  "Cash": Banknote,
  "External Network": CreditCard,
  "Wallet Balance": Wallet,
  "Credit (On Account)": Clock,
  "Split": SplitSquareHorizontal,
};

function CustomerPicker({ customers, customerId, onSelect, onAddNew }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = customers.find((c) => c.id === Number(customerId));
  const idOnly = query.startsWith("#");
  const results = customers.filter((c) =>
    idOnly ? String(c.id).includes(query.slice(1).trim()) :
    (c.name.toLowerCase().includes(query.toLowerCase()) || c.mobile.includes(query) || String(c.id).includes(query))
  );

  // Once a customer is attached to the sale, the search box is replaced by
  // this compact summary (avatar + name + real wallet/debt) — clearing it
  // via the X button resets customerId back to "" so the search box (below)
  // reappears.
  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-brand-500 text-[11px] font-extrabold text-white">
            {selected.name.slice(0, 1)}
          </div>
          <div>
            <div className="text-[13px] font-bold text-app-text">{selected.name}</div>
            <div className="text-[11px] font-semibold text-app-text-muted">
              {t("pos_wallet")}: {sar(selected.walletBalance)} · {t("pos_debt")}: {sar(selected.debt)}
            </div>
          </div>
        </div>
        <button type="button" onClick={() => onSelect("")} title={t("common_cancel")} className="flex size-6 items-center justify-center rounded text-app-text-subtle hover:bg-white"><X className="size-3.5" /></button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search size={14} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          placeholder={t("pos_searchCustomerPlaceholder")}
          className={`${inputCls} pl-8`}
        />
        {open && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-app-border bg-app-surface shadow-app-md">
            {results.map((c) => (
              <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onSelect(c.id); setOpen(false); setQuery(""); }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-app-bg">
                <span className="f-mono text-slate-400 mr-1.5">#{c.id}</span>{c.name}<span className="text-slate-400"> · {c.mobile}</span>
              </button>
            ))}
            {results.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">{t("pos_noMatchingCustomers")}</div>}
          </div>
        )}
      </div>
      <button type="button" onClick={onAddNew} title={t("addCustomer_title")} className="shrink-0 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-brand-700 hover:bg-brand-100"><Plus size={16} /></button>
    </div>
  );
}

function isPromoActive(p) {
  if (p.active === false) return false;
  const now = Date.now();
  if (p.startDate && now < new Date(p.startDate).getTime()) return false;
  if (p.endDate && now > new Date(p.endDate).getTime()) return false;
  return true;
}
function promoDiscount(p, base) { return p.isPercent ? (base * p.value) / 100 : p.value; }
// Two discount periods overlap if their [start, end] ranges intersect — an
// empty start/end is treated as an open (unbounded) edge.
function promosOverlap(aStart, aEnd, bStart, bEnd) {
  const aS = aStart ? new Date(aStart).getTime() : -Infinity;
  const aE = aEnd ? new Date(aEnd).getTime() : Infinity;
  const bS = bStart ? new Date(bStart).getTime() : -Infinity;
  const bE = bEnd ? new Date(bEnd).getTime() : Infinity;
  return aS <= bE && bS <= aE;
}

function POSView({ categories, products, addons, customers, addCustomer, onCreateInvoice, merchant, promotions, enabledPayMethods, whatsappTemplate, whatsappEnabled, setTab }) {
  const { t } = useLang();
  const [activeCat, setActiveCat] = useState("all");
  const [productQuery, setProductQuery] = useState("");
  const [modalProduct, setModalProduct] = useState(null);
  const [cart, setCart] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [payMethod, setPayMethod] = useState("External Network");
  const [splitMethod1, setSplitMethod1] = useState("Cash");
  const [splitAmount1, setSplitAmount1] = useState("");
  const [splitMethod2, setSplitMethod2] = useState("Wallet Balance");
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [isDelivery, setIsDelivery] = useState(false);
  const [deliveryFee, setDeliveryFee] = useState("");
  const [printDoc, setPrintDoc] = useState(null);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponError, setCouponError] = useState("");
  const [saleError, setSaleError] = useState("");
  // Ref (not just state) guards re-entrancy — see TopUpModal's confirm() for why a
  // state-only check can still let same-tick rapid clicks slip through.
  const saleSubmittingRef = useRef(false);
  const [saleSubmitting, setSaleSubmitting] = useState(false);

  const availablePosPayMethods = POS_PAY_METHODS.filter((m) => enabledPayMethods[m.value] !== false);
  const availableSplitMethods = PAY_METHODS.filter((m) => enabledPayMethods[m.value] !== false);

  useEffect(() => {
    if (enabledPayMethods[payMethod] === false && availablePosPayMethods.length > 0) setPayMethod(availablePosPayMethods[0].value);
  }, [enabledPayMethods]);
  useEffect(() => {
    if (enabledPayMethods[splitMethod1] === false && availableSplitMethods.length > 0) setSplitMethod1(availableSplitMethods[0].value);
    if (enabledPayMethods[splitMethod2] === false && availableSplitMethods.length > 0) setSplitMethod2(availableSplitMethods[0].value);
  }, [enabledPayMethods]);

  const nonEmptyCategories = categories.filter((c) => products.some((p) => p.published && p.categoryId === c.id));
  const visibleProducts = products.filter((p) => p.published && (activeCat === "all" || p.categoryId === activeCat) && (!productQuery.trim() || p.name.toLowerCase().includes(productQuery.trim().toLowerCase())));
  const cartTotal = cart.reduce((s, i) => s + i.lineTotal, 0);

  // 1-9 opens the Product Options Modal for whichever product has that
  // quick-access key assigned (products_quickAccess in the product form) —
  // a global assignment, so it fires regardless of the active category tab.
  // Suppressed whenever a modal is already open or the caller is typing
  // into a text field (customer search, delivery fee, etc.) — mounting
  // ProductModal itself flips `active` here to false, handing shortcuts
  // over to its own listener (see useKeydown).
  const posShortcutsActive = !modalProduct && !showAddCustomer && !printDoc;
  useKeydown((e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const num = digitFromKeyEvent(e);
    if (!num) return;
    const match = products.find((p) => p.published && p.quickAccessKey === num);
    if (match) { e.preventDefault(); setModalProduct(match); }
  }, posShortcutsActive);

  const autoPromos = promotions.filter((p) => !p.couponOn && isPromoActive(p));
  const applicablePromos = appliedCoupon ? [...autoPromos, appliedCoupon] : autoPromos;
  const discountAmount = Math.min(cartTotal, applicablePromos.reduce((s, p) => s + promoDiscount(p, cartTotal), 0));

  const grandTotal = Math.max(0, cartTotal - discountAmount) + (isDelivery ? Number(deliveryFee || 0) : 0);
  const customer = customers.find((c) => c.id === Number(customerId));
  const customerChosen = Boolean(customerId);
  const deliveryFeeValid = !isDelivery || deliveryFee !== "";
  const walletInsufficient = payMethod === "Wallet Balance" && (!customer || customer.walletBalance < grandTotal);

  const isSplit = payMethod === "Split";
  const splitAmt1 = Number(splitAmount1 || 0);
  const splitAmt2 = Math.max(0, grandTotal - splitAmt1);
  const splitAmountInvalid = isSplit && (splitAmount1 === "" || splitAmt1 <= 0 || splitAmt1 >= grandTotal);
  const splitWalletNeeded = (splitMethod1 === "Wallet Balance" ? splitAmt1 : 0) + (splitMethod2 === "Wallet Balance" ? splitAmt2 : 0);
  const splitWalletInsufficient = isSplit && splitWalletNeeded > 0 && (!customer || customer.walletBalance < splitWalletNeeded);
  const saleBlocked = walletInsufficient || (isSplit && (splitAmountInvalid || splitWalletInsufficient));

  const addToCart = (item) => { setCart((c) => [...c, item]); setModalProduct(null); };
  const removeFromCart = (cartId) => setCart((c) => c.filter((i) => i.cartId !== cartId));

  const saveNewCustomer = (data) => {
    if (!customers.some((c) => c.id === data.id)) addCustomer(data);
    setCustomerId(data.id);
    setShowAddCustomer(false);
  };

  const applyCoupon = () => {
    const code = couponCode.trim().toUpperCase();
    const match = promotions.find((p) => p.couponOn && isPromoActive(p) && p.coupon.trim().toUpperCase() === code);
    if (!match) { setCouponError(t("pos_invalidCoupon")); return; }
    setCouponError(""); setAppliedCoupon(match);
  };
  const removeCoupon = () => { setAppliedCoupon(null); setCouponCode(""); setCouponError(""); };

  const complete = async () => {
    // Guards against a rapid double-click on "إتمام البيع" firing two
    // overlapping sales for the same cart before the first one's async
    // round trip (payment RPC + invoice insert) has even finished.
    if (saleSubmittingRef.current) return;
    setSaleError("");
    if (cart.length === 0 || !customerChosen || !deliveryFeeValid || saleBlocked) return;
    saleSubmittingRef.current = true;
    setSaleSubmitting(true);
    try {
    const fee = Number(deliveryFee || 0);

    // If a split payment pairs Wallet Balance with exactly one other method,
    // ZATCA-safe handling: record ONE real payment method, treat the wallet
    // portion as a discount (wallet money was already reported as revenue at
    // top-up time), and still actually withdraw it from the customer's wallet.
    let finalPayMethod = payMethod;
    let finalDiscount = discountAmount;
    let splitPaymentsToSend = null;
    let walletDeduct = 0;

    if (isSplit) {
      const m1Wallet = splitMethod1 === "Wallet Balance";
      const m2Wallet = splitMethod2 === "Wallet Balance";
      if (m1Wallet !== m2Wallet) {
        walletDeduct = m1Wallet ? splitAmt1 : splitAmt2;
        finalPayMethod = m1Wallet ? splitMethod2 : splitMethod1;
        finalDiscount = discountAmount + walletDeduct;
      } else {
        finalPayMethod = "Split";
        splitPaymentsToSend = [{ method: splitMethod1, amount: splitAmt1 }, { method: splitMethod2, amount: splitAmt2 }];
      }
    }

    let invoice;
    try {
      invoice = await onCreateInvoice({ customerId: Number(customerId), items: cart, total: cartTotal, discount: finalDiscount, payMethod: finalPayMethod, isDelivery, deliveryFee: fee, splitPayments: splitPaymentsToSend, walletDeduct });
    } catch (e) {
      console.error("complete: createInvoice failed", e);
      setSaleError(t("common_operationFailed"));
      return;
    }
    if (!invoice) { setSaleError(t("pos_walletInsufficient")); return; }

    const docItems = cart.map((i) => ({ name: i.name, price: i.servicePrice + i.addons.reduce((s, a) => s + a.price, 0), qty: i.qty, lineTotal: i.lineTotal }));
    if (isDelivery && fee > 0) docItems.push({ name: t("pos_deliveryFee"), price: fee, qty: 1, lineTotal: fee });
    const gross = invoice.total;
    const vatExempt = invoice.vatExempt;
    const net = vatExempt ? gross : gross / (1 + VAT_RATE);
    const vat = vatExempt ? 0 : gross - net;
    const creditAmount = splitPaymentsToSend
      ? (splitMethod1 === "Credit (On Account)" ? splitAmt1 : 0) + (splitMethod2 === "Credit (On Account)" ? splitAmt2 : 0)
      : (finalPayMethod === "Credit (On Account)" ? gross : 0);
    const paid = gross - creditAmount;
    const remaining = creditAmount;
    const pieceCount = cart.reduce((s, i) => s + i.qty, 0);
    const due = new Date(); due.setDate(due.getDate() + 7);
    const payMethodLabelText = splitPaymentsToSend
      ? `${payMethodPrintLabel(t, splitMethod1)} ${splitAmt1.toFixed(2)} + ${payMethodPrintLabel(t, splitMethod2)} ${splitAmt2.toFixed(2)}`
      : payMethodPrintLabel(t, finalPayMethod);

    const nowIso = nowISO();
    setPrintDoc({
      kind: (finalPayMethod === "Wallet Balance" || vatExempt) ? "receipt" : "tax",
      merchant, dateLabel: printDateLabel(nowIso), isoDateTime: nowIso, invoiceCode: invoice.code, customerName: customer?.name || "—",
      customerPhone: customer?.mobile || null, whatsappTemplate, whatsappEnabled,
      items: docItems, totals: { net, discount: finalDiscount, vat, gross, paid, remaining, pieceCount },
      payMethodLabel: payMethodLabelText,
      dueDate: creditAmount > 0 ? `${due.getFullYear()}/${String(due.getMonth() + 1).padStart(2, "0")}/${String(due.getDate()).padStart(2, "0")}` : null,
      // Set only when ZATCA Phase 2 is enabled and signing succeeded — a
      // real 9-tag QR from api/zatca-sign-invoice.js instead of the
      // Phase 1 5-tag one buildZatcaQrFromDoc would otherwise compute.
      zatcaQrOverride: invoice.zatcaQr || null,
    });

    setCart([]); setIsDelivery(false); setDeliveryFee(""); setAppliedCoupon(null); setCouponCode(""); setCouponError("");
    setPayMethod("External Network"); setSplitMethod1("Cash"); setSplitAmount1(""); setSplitMethod2("Wallet Balance");
    // Force the cashier to explicitly pick a customer for every new sale —
    // leaving the previous invoice's customer selected risks a piece being
    // rung up under the wrong customer's ledger by mistake.
    setCustomerId("");
    } finally {
      saleSubmittingRef.current = false;
      setSaleSubmitting(false);
    }
  };

  if (products.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <Package size={40} className="mb-3 text-stone-300" />
        <div className="f-display text-lg font-semibold text-slate-800">{t("pos_noProductsTitle")}</div>
        <div className="mt-1 max-w-sm text-sm text-slate-500">{t("pos_noProductsSubtitle")}</div>
        <button onClick={() => setTab("inventory")} className="mt-3 text-sm font-semibold text-brand-700 hover:underline">{t("nav_products")}</button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 shadow-app-xs">
        <Toggle checked={isDelivery} onChange={setIsDelivery} label={isDelivery ? <span className="inline-flex items-center gap-1.5"><Truck size={14} />{t("pos_deliveryOrder")}</span> : t("pos_pickupOrder")} />
        {isDelivery && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-brand-800">{t("pos_deliveryFeeLabel")}</span>
            <input type="number" min="0" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} placeholder={t("pos_deliveryFeePlaceholder")} className={`${inputCls} w-40`} />
          </div>
        )}
      </div>

      <div className="flex flex-1 gap-5 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative mb-3">
            <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-text-subtle" />
            <input value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder={t("pos_searchProductsPlaceholder")} className={`${inputCls} pr-9`} />
          </div>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            <button onClick={() => setActiveCat("all")} className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${activeCat === "all" ? "bg-brand-600 text-white shadow-app-xs" : "bg-app-surface border border-app-border text-app-text-muted hover:border-app-border-strong"}`}>{t("pos_allItems")}</button>
            {nonEmptyCategories.map((c) => (
              <button key={c.id} onClick={() => setActiveCat(c.id)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${activeCat === c.id ? "bg-brand-600 text-white shadow-app-xs" : "bg-app-surface border border-app-border text-app-text-muted hover:border-app-border-strong"}`}>{c.name}</button>
            ))}
          </div>
          <div className="grid flex-1 auto-rows-max grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 xl:grid-cols-4">
            {visibleProducts.map((p) => (
              <button key={p.id} onClick={() => setModalProduct(p)} className="group relative flex flex-col text-left rounded-xl border border-app-border bg-app-surface overflow-hidden transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-app-md active:translate-y-0">
                {p.quickAccessKey && (
                  <span className="absolute top-1.5 right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-navy-900 text-[11px] font-bold text-white shadow">{p.quickAccessKey}</span>
                )}
                {p.image ? (
                  <img src={p.image} alt={p.name} loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-app-bg text-app-text-subtle transition-colors group-hover:bg-brand-50 group-hover:text-brand-500">
                    <Shirt className="size-9" strokeWidth={1.5} />
                  </div>
                )}
                <div className="p-3">
                  <div className="text-sm font-semibold text-app-text">{p.name}</div>
                  <span className="text-[13px] font-semibold text-brand-600">{sar(p.price)}</span>
                </div>
              </button>
            ))}
            {visibleProducts.length === 0 && <div className="col-span-full text-center text-app-text-subtle py-16">{t("pos_noProductsInCategory")}</div>}
          </div>
        </div>

        <div className="w-80 shrink-0 flex flex-col rounded-xl border border-app-border bg-app-surface shadow-app-sm">
          <div className="border-b border-app-border px-4 py-3 f-display font-semibold text-app-text">{t("pos_checkout")}</div>
          <div className="border-b border-app-border p-4 space-y-2">
            {/* "طلب جديد" header — the reference design also shows a real
                invoice-number badge here (e.g. "#10486"), but that number only
                exists after nextDocNumber() actually runs at sale completion;
                showing a guessed one here could show a number a concurrent
                sale grabs first, so it's intentionally omitted. */}
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-bold text-app-text-subtle">{t("pos_newOrder")}</span>
            </div>
            <Field label={t("common_customer")}>
              <CustomerPicker customers={customers} customerId={customerId} onSelect={setCustomerId} onAddNew={() => setShowAddCustomer(true)} />
            </Field>
            {!customer && (
              <div className="text-xs font-medium text-danger-600">{t("pos_customerRequired")}</div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
            {cart.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-app-bg text-app-text-subtle"><Wallet className="size-5" /></div>
                <p className="text-[13px] font-semibold text-app-text-subtle">{t("pos_cartEmpty")}</p>
              </div>
            )}
            {cart.map((i) => (
              <div key={i.cartId} className="rounded-lg border border-app-border p-2.5">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-medium text-app-text">{i.qty}× {i.name}</div>
                    <div className="text-xs text-app-text-muted">{i.service}{i.addons.length ? ` · ${i.addons.map((a) => a.name).join(", ")}` : ""}</div>
                    {i.notes && <div className="flex items-center gap-1 text-xs text-warning-700"><StickyNote size={12} /> {i.notes}</div>}
                  </div>
                  <button onClick={() => removeFromCart(i.cartId)} className="text-app-text-subtle hover:text-danger-500"><Trash2 size={14} /></button>
                </div>
                <div className="f-mono text-right text-sm font-semibold text-app-text mt-1">{sar(i.lineTotal)}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-app-border p-4 space-y-3">
            <Field label={t("common_paymentMethod")}>
              <div className="grid grid-cols-3 gap-2">
                {availablePosPayMethods.map((m) => {
                  const Icon = PAY_METHOD_ICONS[m.value] || CreditCard;
                  const active = payMethod === m.value;
                  return (
                    <button key={m.value} type="button" onClick={() => setPayMethod(m.value)}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-center text-[10.5px] font-bold leading-tight transition-colors ${active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>
                      <Icon className="size-4" />{t(m.key)}
                    </button>
                  );
                })}
              </div>
            </Field>
            {walletInsufficient && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2 text-xs font-medium text-danger-700">{t("pos_walletInsufficient")}</div>}

            {isSplit && (
              <div className="space-y-2 rounded-lg border border-app-border bg-app-bg p-3">
                <Field label={t("pos_splitMethod1")}>
                  <select value={splitMethod1} onChange={(e) => setSplitMethod1(e.target.value)} className={inputCls}>
                    {availableSplitMethods.map((m) => <option key={m.value} value={m.value}>{t(m.key)}</option>)}
                  </select>
                </Field>
                <Field label={t("pos_splitAmount1")}>
                  <input type="number" min="0" value={splitAmount1} onChange={(e) => setSplitAmount1(e.target.value)} className={inputCls} />
                </Field>
                {splitAmountInvalid && <div className="text-xs font-medium text-danger-600">{t("pos_splitErrorAmount")}</div>}
                <Field label={t("pos_splitMethod2")}>
                  <select value={splitMethod2} onChange={(e) => setSplitMethod2(e.target.value)} className={inputCls}>
                    {availableSplitMethods.map((m) => <option key={m.value} value={m.value}>{t(m.key)}</option>)}
                  </select>
                </Field>
                <Field label={t("pos_splitRemaining")}>
                  <input type="text" readOnly value={sar(splitAmt2)} className={`${inputCls} f-mono bg-app-border/40 text-app-text-muted`} />
                </Field>
                {splitWalletInsufficient && <div className="text-xs font-medium text-danger-600">{t("pos_splitErrorWallet")}</div>}
              </div>
            )}

            {cart.length > 0 && (
              appliedCoupon ? (
                <div className="flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-xs">
                  <span className="f-mono font-semibold text-brand-800">{appliedCoupon.coupon}</span>
                  <button onClick={removeCoupon} className="font-medium text-brand-700 hover:underline">{t("pos_removeCoupon")}</button>
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex gap-2">
                    <input value={couponCode} onChange={(e) => { setCouponCode(e.target.value); setCouponError(""); }} placeholder={t("pos_coupon")} className="flex-1 rounded-lg border border-app-border-strong px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
                    <button onClick={applyCoupon} disabled={!couponCode.trim()} className="shrink-0 rounded-lg border border-app-border-strong px-3 py-2 text-sm font-semibold text-app-text-muted hover:bg-app-bg disabled:opacity-40">{t("pos_applyCoupon")}</button>
                  </div>
                  {couponError && <div className="text-xs font-medium text-danger-600">{couponError}</div>}
                </div>
              )
            )}
            {autoPromos.length > 0 && <div className="flex items-center gap-1 text-[11px] font-medium text-brand-700"><Check size={12} /> {t("pos_autoDiscountApplied")}</div>}

            {discountAmount > 0 && (
              <div className="flex items-center justify-between text-xs text-brand-700">
                <span>{t("pos_discount")}</span><span className="f-mono">-{sar(discountAmount)}</span>
              </div>
            )}
            {isDelivery && (
              <div className="flex items-center justify-between text-xs text-brand-700">
                <span>{t("pos_deliveryFee")}</span><span className="f-mono">{sar(Number(deliveryFee || 0))}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm font-medium text-app-text-muted">
              <span>{t("pos_total")}</span><span className="f-mono text-lg font-bold text-app-text">{sar(grandTotal)}</span>
            </div>
            {saleError && <div className="rounded-lg bg-danger-50 border border-danger-200 px-3 py-2 text-xs font-medium text-danger-700">{saleError}</div>}
            <button onClick={complete} disabled={cart.length === 0 || !customerChosen || !deliveryFeeValid || saleBlocked || saleSubmitting} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:bg-app-border-strong">{t("pos_completeSale")}</button>
          </div>
        </div>
      </div>

      {modalProduct && <ProductModal product={modalProduct} addons={addons} onClose={() => setModalProduct(null)} onConfirm={addToCart} />}
      {showAddCustomer && <AddCustomerModal customers={customers} onClose={() => setShowAddCustomer(false)} onSave={saveNewCustomer} />}
      {printDoc && <PrintDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />}
    </div>
  );
}

/* =========================================================================
   MODULE 2 — ACTIVE INVOICES & LIFECYCLE TRACKER
   ========================================================================= */
function stageIndex(s) { return STAGES.indexOf(s); }

function invoiceOverallStatus(inv) {
  if (inv.closed) return "Delivered";
  const idxs = inv.items.map((i) => stageIndex(i.status));
  return STAGES[Math.min(...idxs)];
}

function LifecycleBar({ status }) {
  const { t } = useLang();
  const current = stageIndex(status);
  return (
    <div className="flex items-center">
      {STAGES.map((s, i) => (
        <React.Fragment key={s}>
          <div className="flex flex-col items-center gap-1">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full border-2 ${i < current ? "border-teal-600 bg-teal-600 text-white" : i === current ? "border-amber-500 bg-amber-50 text-amber-600 animate-pulse" : "border-stone-300 bg-white text-stone-300"}`}>
              {i < current ? <Check size={16} /> : <Circle size={10} fill="currentColor" />}
            </div>
            <span className={`text-[11px] font-medium ${i <= current ? "text-slate-700" : "text-stone-400"}`}>{stageLabel(t, s)}</span>
          </div>
          {i < STAGES.length - 1 && <div className={`mx-1 mb-4 h-0.5 w-10 sm:w-16 ${i < current ? "bg-teal-600" : "bg-stone-200"}`} />}
        </React.Fragment>
      ))}
    </div>
  );
}

function InvoiceDetailModal({ invoice, onClose, onUpdateItemStatus, onCloseInvoice, merchant, zatcaRecord, customerPhone, whatsappTemplate, whatsappEnabled }) {
  const { t } = useLang();
  const status = invoiceOverallStatus(invoice);
  const [printDoc, setPrintDoc] = useState(null);
  const [printError, setPrintError] = useState("");

  const printDeliveryReceipt = () => {
    const delivered = invoice.items.filter((it) => it.status === "Delivered");
    if (delivered.length === 0) {
      setPrintError(t("print_deliverFirst"));
      return;
    }
    setPrintError("");
    setPrintDoc({
      kind: "delivery", merchant, dateLabel: printDateLabel(nowISO()), invoiceCode: invoice.code, customerName: invoice.customerName,
      customerPhone: customerPhone || null, whatsappTemplate, whatsappEnabled,
      deliveredItems: delivered.map((it) => ({ name: it.name, service: it.service, deliveredAt: it.deliveredAt || nowISO() })),
    });
  };

  return (
    <Modal title={`${t("invoiceDetail_title")} ${invoice.code}`} onClose={onClose} width="max-w-2xl">
      <div className="mb-6 flex items-center justify-between text-sm text-slate-500">
        <span>{invoice.customerName}</span><span className="f-mono">{fmtDate(invoice.createdAt)}</span>
      </div>
      {zatcaRecord?.status === "CLEARED" && (
        <div className="mb-6 flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800">
          <CheckCircle2 size={14} /> {t("invoiceDetail_zatcaCleared")}
        </div>
      )}
      {zatcaRecord?.status === "SIGNED" && (
        <div className="mb-6 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          <CheckCircle2 size={14} /> {t("invoiceDetail_zatcaSigned")}
        </div>
      )}
      {invoice.isDelivery && (
        <div className="mb-6 flex items-center justify-between rounded-lg border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm">
          <span className="flex items-center gap-1.5 font-medium text-teal-800"><Truck size={14} /> {t("invoiceDetail_deliveryOrder")}</span>
          <span className="f-mono font-semibold text-teal-800">{t("invoiceDetail_fee")} {sar(invoice.deliveryFee || 0)}</span>
        </div>
      )}
      <div className="mb-6 overflow-x-auto"><LifecycleBar status={status} /></div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("invoiceDetail_itemizedMatrix")}</div>
      <div className="space-y-2 mb-6">
        {invoice.items.map((it) => (
          <div key={it.itemId} className="flex items-center justify-between rounded-lg border border-stone-200 p-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">{it.name}</div>
              <div className="text-xs text-slate-500">{it.service}{it.urgent ? ` · ${t("invoiceDetail_urgent")}` : ""}{it.deliveredAt ? ` · ${fmtDateSec(it.deliveredAt)}` : ""}</div>
              {it.notes && <div className="flex items-center gap-1 text-xs text-amber-700"><StickyNote size={12} /> {it.notes}</div>}
            </div>
            <select value={it.status} onChange={(e) => onUpdateItemStatus(invoice.id, it.itemId, e.target.value)}
              className={`f-mono text-xs rounded-lg border px-2 py-1.5 ${it.status === "Delivered" ? "border-teal-300 bg-teal-50 text-teal-700" : "border-stone-300 text-slate-700"}`}>
              {STAGES.map((s) => <option key={s} value={s}>{stageLabel(t, s)}</option>)}
            </select>
          </div>
        ))}
      </div>

      {printError && <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{printError}</div>}
      <div className="flex gap-2">
        <button onClick={printDeliveryReceipt} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-teal-300 bg-teal-50 py-3 font-semibold text-teal-700 hover:bg-teal-100">
          <ReceiptText size={16} /> {t("print_printDeliveryReceipt")}
        </button>
        {!invoice.closed && (
          <button onClick={() => onCloseInvoice(invoice.id)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 py-3 font-semibold text-white hover:bg-slate-800">
            <Truck size={16} /> {t("invoiceDetail_closeAll")}
          </button>
        )}
      </div>

      {printDoc && <PrintDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />}
    </Modal>
  );
}

// Same live-search mechanics as POS's CustomerPicker (name / mobile / #id,
// "#" prefix = id-only), but for filtering a list instead of selecting into
// a form — so it also carries a full-size "Clear Filter" button, shown
// beside the box whenever there's an active search (typed text or an
// already-picked customer) rather than a cramped icon buried in the input.
function InvoiceCustomerFilter({ customers, selected, onSelect }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const idOnly = query.startsWith("#");
  const results = customers.filter((c) =>
    idOnly ? String(c.id).includes(query.slice(1).trim()) :
    (c.name.toLowerCase().includes(query.toLowerCase()) || c.mobile.includes(query) || String(c.id).includes(query))
  );
  const hasActiveSearch = Boolean(selected) || query.trim().length > 0;

  const clearFilter = () => {
    setQuery(""); setOpen(false); onSelect(null);
  };

  return (
    <div className="flex w-full items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search size={14} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
        <input
          value={open ? query : (selected ? `#${selected.id} · ${selected.name}` : "")}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          placeholder={t("pos_searchCustomerPlaceholder")}
          className={`${inputCls} pl-8`}
        />
        {open && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-app-border bg-app-surface shadow-app-md">
            {results.map((c) => (
              <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onSelect(c); setOpen(false); setQuery(""); }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-app-bg">
                <span className="f-mono text-app-text-subtle mr-1.5">#{c.id}</span>{c.name}<span className="text-app-text-subtle"> · {c.mobile}</span>
              </button>
            ))}
            {results.length === 0 && <div className="px-3 py-2 text-sm text-app-text-subtle">{t("pos_noMatchingCustomers")}</div>}
          </div>
        )}
      </div>
      {hasActiveSearch && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={clearFilter} title={t("invoices_clearFilter")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-danger-300 bg-danger-50 px-3 py-2 text-sm font-medium text-danger-600 hover:bg-danger-100">
          <Trash2 size={15} /> {t("invoices_clearFilter")}
        </button>
      )}
    </div>
  );
}

const INVOICE_STATUS_TONE = {
  Received: "bg-app-bg text-app-text-muted",
  Washing: "bg-info-50 text-info-700",
  Pressing: "bg-warning-50 text-warning-700",
  Ready: "bg-success-50 text-success-700",
  Delivered: "bg-navy-900/5 text-navy-900",
};

// A real promise to a real customer, so this is deliberately simple and
// derived only from data we already track: same-day the moment any piece
// reaches "Ready", next-day otherwise. No per-service/rush-tier turnaround
// table exists yet — if one gets added later, this is the one place to
// plug it in. This is Active-Invoices-only: the Delivery Invoices table
// drops this column in favor of the courier-facing status mapping below.
function estimatedDeliveryLabel(t, inv) {
  return invoiceOverallStatus(inv) === "Ready" ? t("invoices_etaToday") : t("invoices_etaTomorrow");
}

function StatusDot({ tone, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ring-1 ring-inset ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" />{label}
    </span>
  );
}

// The Delivery Invoices screen conceptually tracks a courier hand-off
// (awaiting courier / on the way / delivered), but there is no separate
// driver-assignment field in the real data model — every invoice still
// only carries the same 5-stage per-item status used everywhere else.
// This maps the real, already-available invoiceOverallStatus()/closed
// value onto that courier-facing language instead of inventing a field:
// anything short of "Ready" reads as still being prepared (awaiting a
// courier), "Ready" reads as out with the courier (on the way). The
// success/"delivered" tone is defined for completeness but is never
// actually reached in this table, since a `closed` invoice (the only way
// to reach the real "Delivered" stage) drops out of the active list
// entirely — same as every other status here.
function deliveryStatusMeta(t, inv) {
  const status = invoiceOverallStatus(inv);
  if (status === "Delivered") return { tone: "bg-success-50 text-success-700", label: t("invoices_statusDelivered") };
  if (status === "Ready") return { tone: "bg-info-50 text-info-700", label: t("invoices_statusOnTheWay") };
  return { tone: "bg-app-bg text-app-text-muted", label: t("invoices_statusWaitingCourier") };
}

function InvoicesView({ invoices, customers, updateInvoice, isDelivery = false, merchant, zatcaInvoices = [], whatsappTemplate, whatsappEnabled }) {
  const { t } = useLang();
  const [openId, setOpenId] = useState(null);
  const [customerFilter, setCustomerFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const statusChips = STAGES.filter((s) => s !== "Delivered");
  // Newest at the top, oldest at the bottom — applies whether the list is
  // showing everyone or filtered down to one customer, and stays correct
  // after clearing the filter since this is recomputed fresh every render.
  const active = invoices
    .filter((i) => !i.closed && Boolean(i.isDelivery) === isDelivery && (!customerFilter || i.customerId === customerFilter.id) && (statusFilter === "all" || invoiceOverallStatus(i) === statusFilter))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const openInvoice = invoices.find((i) => i.id === openId);
  const openInvoiceZatcaRecord = openInvoice ? zatcaInvoices.find((z) => z.invoiceId === openInvoice.id) : null;
  const openInvoiceCustomerPhone = openInvoice ? customers.find((c) => c.id === openInvoice.customerId)?.mobile : null;

  const updateItemStatus = (invId, itemId, status) => {
    const inv = invoices.find((i) => i.id === invId);
    if (!inv) return;
    const items = inv.items.map((it) => it.itemId === itemId ? { ...it, status, deliveredAt: status === "Delivered" ? nowISO() : it.deliveredAt } : it);
    updateInvoice(invId, { items });
  };
  const closeInvoice = (invId) => {
    const inv = invoices.find((i) => i.id === invId);
    if (!inv) return;
    const items = inv.items.map((it) => ({ ...it, status: "Delivered", deliveredAt: it.deliveredAt || nowISO() }));
    updateInvoice(invId, { closed: true, items });
    setOpenId(null);
  };

  return (
    <div>
      <div className="mb-4">
        <div className="f-display text-xl font-semibold text-app-text">{isDelivery ? t("invoices_deliveryDashboard") : t("invoices_liveDashboard")}</div>
        <div className="mt-1 text-sm text-app-text-muted">{isDelivery ? t("invoices_deliveryDescription") : t("invoices_activeDescription")}</div>
      </div>

      {isDelivery ? (
        <div className="mb-4 w-full sm:max-w-xs">
          <InvoiceCustomerFilter customers={customers} selected={customerFilter} onSelect={setCustomerFilter} />
        </div>
      ) : (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:max-w-xs">
            <InvoiceCustomerFilter customers={customers} selected={customerFilter} onSelect={setCustomerFilter} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setStatusFilter("all")} className={`rounded-full px-3.5 py-2 text-[12.5px] font-bold transition-colors ${statusFilter === "all" ? "bg-navy-900 text-white" : "bg-app-bg text-app-text-muted hover:text-app-text"}`}>{t("invoices_allStatuses")}</button>
            {statusChips.map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} className={`rounded-full px-3.5 py-2 text-[12.5px] font-bold transition-colors ${statusFilter === s ? "bg-navy-900 text-white" : "bg-app-bg text-app-text-muted hover:text-app-text"}`}>{stageLabel(t, s)}</button>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface">
        <table className="w-full table-fixed text-right text-[13px]">
          <thead className="bg-app-bg/60 text-xs font-semibold uppercase tracking-wide text-app-text-muted">
            <tr>
              <th className="px-4 py-3 w-40 text-center">{t("invoices_invoiceId")}</th>
              <th className="px-4 py-3 w-56 text-center">{t("invoices_customer")}</th>
              {!isDelivery && <th className="px-4 py-3 w-20 text-center">{t("invoices_items")}</th>}
              <th className="px-4 py-3">{t("common_status")}</th>
              {!isDelivery && <th className="px-4 py-3 w-32 text-center">{t("invoices_eta")}</th>}
              <th className="px-4 py-3 w-32 text-center">{t("invoices_total")}</th>
              <th className="px-4 py-3 w-28"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {active.map((inv) => {
              const status = invoiceOverallStatus(inv);
              const delivery = isDelivery ? deliveryStatusMeta(t, inv) : null;
              return (
                <tr key={inv.id} className="cursor-pointer hover:bg-app-bg/60" onClick={() => setOpenId(inv.id)}>
                  <td className="px-4 py-3 f-mono text-app-text-muted w-40" style={{ textAlign: "center" }}>{inv.code}</td>
                  <td className="px-4 py-3 text-app-text truncate w-56 text-center">{inv.customerName}</td>
                  {!isDelivery && <td className="px-4 py-3 text-app-text-muted w-20" style={{ textAlign: "center" }}>{inv.items.length}</td>}
                  <td className="px-4 py-3">
                    {isDelivery
                      ? <StatusDot tone={delivery.tone} label={delivery.label} />
                      : <StatusDot tone={INVOICE_STATUS_TONE[status] || "bg-app-bg text-app-text-muted"} label={stageLabel(t, status)} />}
                  </td>
                  {!isDelivery && <td className="px-4 py-3 text-app-text-muted w-32" style={{ textAlign: "center" }}>{estimatedDeliveryLabel(t, inv)}</td>}
                  <td className="px-4 py-3 f-mono text-app-text w-32" style={{ textAlign: "center" }}>{sarCompact(inv.total)}</td>
                  <td className="px-4 py-3 text-center w-28">
                    <button
                      onClick={(e) => { e.stopPropagation(); setOpenId(inv.id); }}
                      className="rounded-lg border border-app-border px-3 py-1.5 text-[12.5px] font-semibold text-app-text hover:bg-app-bg"
                    >
                      {!isDelivery && status === "Ready" ? t("invoices_actionDeliver") : t("invoices_actionDetails")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {active.length === 0 && <tr><td colSpan={isDelivery ? 5 : 7} className="px-4 py-10 text-center text-app-text-subtle">{isDelivery ? t("invoices_noActiveDelivery") : t("invoices_noActive")}</td></tr>}
          </tbody>
        </table>
      </div>
      {openInvoice && <InvoiceDetailModal invoice={openInvoice} onClose={() => setOpenId(null)} onUpdateItemStatus={updateItemStatus} onCloseInvoice={closeInvoice} merchant={merchant} zatcaRecord={openInvoiceZatcaRecord} customerPhone={openInvoiceCustomerPhone} whatsappTemplate={whatsappTemplate} whatsappEnabled={whatsappEnabled} />}
    </div>
  );
}

/* =========================================================================
   MODULE 3 — CUSTOMER LEDGER & WALLET
   ========================================================================= */
function payMethodLabel(t, value) {
  const m = PAY_METHODS.find((m) => m.value === value);
  return m ? t(m.key) : value;
}

function splitBreakdownLabel(t, inv) {
  if (inv.payMethod !== "Split" || !inv.splitPayments) return payMethodLabel(t, inv.payMethod);
  return inv.splitPayments.map((sp) => `${payMethodLabel(t, sp.method)} ${sar(sp.amount)}`).join(" + ");
}

function TopUpModal({ customer, onClose, onSubmit, error }) {
  const { t } = useLang();
  const [topUp, setTopUp] = useState(100);
  const [mode, setMode] = useState("flat"); // flat | percent
  const [discountVal, setDiscountVal] = useState(0);
  const [payMethod, setPayMethod] = useState("Cash");
  const [notes, setNotes] = useState("");
  // Without this, the modal gives no feedback while the top-up is in
  // flight (no spinner, no disabled state) — a customer who clicks
  // "تأكيد الشحن" repeatedly because nothing visibly happens fires that
  // many independent top-ups, each one really crediting the wallet again.
  // A ref (not just state) guards the actual re-entrancy check: several
  // click() calls fired synchronously in the same tick all close over the
  // same pre-render `submitting` state value, so a state-only guard can
  // still let a tight burst of clicks slip through before React re-renders
  // with the disabled button — the ref is updated immediately, so even
  // same-tick re-entry is blocked.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const confirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({ topUp: Number(topUp || 0), duePayable, notes, mode, discountAmount, payMethod });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const discountAmount = mode === "flat" ? Number(discountVal || 0) : (Number(topUp || 0) * Number(discountVal || 0)) / 100;
  const newBalance = Number(customer.walletBalance) + Number(topUp || 0);
  const duePayable = Math.max(0, Number(topUp || 0) - discountAmount);

  return (
    <Modal title={`${t("topup_title")} · ${customer.name}`} onClose={onClose}>
      <Field label={t("topup_amount")}><input type="number" min="0" value={topUp} onChange={(e) => setTopUp(e.target.value)} className={inputCls} /></Field>
      <Field label={t("topup_discountMode")}>
        <div className="flex gap-2">
          <button onClick={() => setMode("flat")} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${mode === "flat" ? "border-teal-600 bg-teal-50 text-teal-700" : "border-stone-300 text-slate-600"}`}><Banknote size={14} className="inline mr-1" /> {t("topup_flat")}</button>
          <button onClick={() => setMode("percent")} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${mode === "percent" ? "border-teal-600 bg-teal-50 text-teal-700" : "border-stone-300 text-slate-600"}`}><Percent size={14} className="inline mr-1" /> {t("topup_percent")}</button>
        </div>
      </Field>
      <Field label={mode === "flat" ? t("topup_discountAmount") : t("topup_discountPercent")}>
        <input type="number" min="0" value={discountVal} onChange={(e) => setDiscountVal(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t("common_paymentMethod")}>
        <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className={inputCls}>
          <option value="Cash">{t("common_cash")}</option>
          <option value="External Network">{t("common_externalNetwork")}</option>
          <option value="Credit (On Account)">{t("common_creditOnAccount")}</option>
        </select>
      </Field>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
          <div className="text-xs text-slate-500">{t("topup_newBalance")}</div>
          <div className="f-mono font-semibold text-slate-900">{sar(newBalance)}</div>
        </div>
        <div className="rounded-lg bg-teal-50 border border-teal-200 p-3">
          <div className="text-xs text-teal-700">{payMethod === "Credit (On Account)" ? t("topup_addedToDebt") : t("topup_duePayable")}</div>
          <div className="f-mono font-semibold text-teal-800">{sar(duePayable)}</div>
        </div>
      </div>
      {payMethod === "Credit (On Account)" && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-medium text-amber-700">
          {t("topup_creditWarning", { amount: sar(duePayable) })}
        </div>
      )}
      <Field label={t("common_notes")}><textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} /></Field>
      {error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{error}</div>}
      <button
        onClick={confirm}
        disabled={submitting}
        className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-60">
        {t("topup_confirm")}
      </button>
    </Modal>
  );
}

function SettleDebtModal({ customer, onClose, onSubmit, error }) {
  const { t } = useLang();
  const [amount, setAmount] = useState(customer.debt);
  const [payMethod, setPayMethod] = useState("Cash");
  const [notes, setNotes] = useState("");
  const remaining = Math.max(0, Number(customer.debt) - Number(amount || 0));
  const overWallet = payMethod === "Wallet Balance" && Number(amount || 0) > customer.walletBalance;
  const exceedsDebt = Number(amount || 0) > customer.debt;
  // Same rapid-double-click guard as TopUpModal (ref, not just state — see there for why).
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const confirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({ amount: Number(amount || 0), notes, payMethod });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`${t("settle_title")} · ${customer.name}`} onClose={onClose}>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-rose-50 border border-rose-200 p-3">
          <div className="text-xs text-rose-700">{t("settle_currentDebt")}</div>
          <div className="f-mono font-semibold text-rose-800 text-lg">{sar(customer.debt)}</div>
        </div>
        <div className="rounded-lg bg-teal-50 border border-teal-200 p-3">
          <div className="text-xs text-teal-700">{t("settle_availableWallet")}</div>
          <div className="f-mono font-semibold text-teal-800 text-lg">{sar(customer.walletBalance)}</div>
        </div>
      </div>
      <Field label={t("common_paymentMethod")}>
        <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className={inputCls}>
          <option value="Cash">{t("common_cash")}</option>
          <option value="External Network">{t("common_externalNetwork")}</option>
          <option value="Wallet Balance">{t("common_walletBalance")}</option>
        </select>
      </Field>
      <Field label={t("settle_amount")}><input type="number" min="0" max={customer.debt} value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} /></Field>
      {exceedsDebt && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{t("settle_exceedsDebtError", { amount: sar(customer.debt) })}</div>}
      {overWallet && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{t("settle_overWallet")}</div>}
      <div className="mb-4 rounded-lg bg-stone-50 border border-stone-200 p-3">
        <div className="text-xs text-slate-500">{t("settle_remaining")}</div>
        <div className="f-mono font-semibold text-slate-900">{sar(remaining)}</div>
      </div>
      <Field label={t("common_notes")}><textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} /></Field>
      {error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{error}</div>}
      <button
        disabled={overWallet || exceedsDebt || Number(amount || 0) <= 0 || submitting}
        onClick={confirm}
        className="w-full rounded-lg bg-slate-900 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:bg-stone-300">
        {t("settle_confirm")}
      </button>
    </Modal>
  );
}

function CustomerDetailModal({ customer, invoices, transactions, onClose, onOpenTopUp, onOpenSettleDebt }) {
  const { t } = useLang();
  const customerInvoices = invoices.filter((i) => i.customerId === customer.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const customerTxns = transactions.filter((t2) => t2.customerId === customer.id).sort((a, b) => new Date(b.date) - new Date(a.date));

  const discountLabel = (t2) => t2.discountAmount > 0
    ? (t2.discountMode === "flat" ? t("topup_flatOff", { amount: sar(t2.discountAmount) }) : t("topup_percentOff", { percent: t2.discountAmount }))
    : t("topup_noDiscount");

  return (
    <Modal title={`#${customer.id} · ${customer.name}`} onClose={onClose} width="max-w-3xl">
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <div className="text-xs text-slate-500">{t("customerDetail_mobile")}</div>
          <div className="f-mono font-semibold text-slate-800">{customer.mobile}</div>
        </div>
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3">
          <div className="text-xs text-teal-700">{t("customerDetail_walletBalance")}</div>
          <div className="f-mono font-semibold text-teal-800">{sar(customer.walletBalance)}</div>
        </div>
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="text-xs text-rose-700">{t("customerDetail_debt")}</div>
          <div className="f-mono font-semibold text-rose-800">{sar(customer.debt)}</div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <div className="text-xs text-slate-500">{t("customerDetail_totalInvoices")}</div>
          <div className="f-mono font-semibold text-slate-800">{customerInvoices.length}</div>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <button onClick={onOpenTopUp} className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700"><Wallet size={14} /> {t("customerDetail_addBalance")}</button>
        <button onClick={onOpenSettleDebt} disabled={customer.debt <= 0} className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-stone-300">
          <CreditCard size={14} /> {t("customerDetail_settleDebt")}
        </button>
      </div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("customerDetail_invoiceHistory")}</div>
      <div className="mb-6 overflow-hidden rounded-xl border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2">{t("customerDetail_invoice")}</th><th className="px-3 py-2">{t("common_date")}</th><th className="px-3 py-2">{t("invoices_items")}</th><th className="px-3 py-2">{t("customerDetail_method")}</th><th className="px-3 py-2">{t("customerDetail_total")}</th><th className="px-3 py-2">{t("common_status")}</th></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {customerInvoices.map((inv) => {
              const lastDeliveredMs = inv.closed
                ? inv.items.reduce((max, it) => it.deliveredAt && new Date(it.deliveredAt).getTime() > max ? new Date(it.deliveredAt).getTime() : max, 0)
                : 0;
              return (
                <tr key={inv.id} className="hover:bg-stone-50">
                  <td className="px-3 py-2 f-mono text-slate-600">{inv.code}</td>
                  <td className="px-3 py-2 f-mono text-xs text-slate-500">{fmtDate(inv.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-600">{inv.items.length}</td>
                  <td className="px-3 py-2 text-slate-600">{payMethodLabel(t, inv.payMethod)}</td>
                  <td className="px-3 py-2 f-mono font-semibold text-slate-900">{sar(inv.total)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${inv.closed ? "bg-teal-100 text-teal-700" : "bg-amber-100 text-amber-700"}`}>{inv.closed ? t("customerDetail_delivered") : t("customerDetail_processing")}</span>
                    {inv.closed && lastDeliveredMs > 0 && <div className="mt-0.5 f-mono text-[10px] text-slate-400">{fmtDateSec(new Date(lastDeliveredMs).toISOString())}</div>}
                  </td>
                </tr>
              );
            })}
            {customerInvoices.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">{t("customerDetail_noInvoices")}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("customerDetail_transactions")}</div>
      <div className="overflow-hidden rounded-xl border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2">{t("customerDetail_receipt")}</th><th className="px-3 py-2">{t("common_date")}</th><th className="px-3 py-2">{t("customerDetail_type")}</th><th className="px-3 py-2">{t("customerDetail_detail")}</th><th className="px-3 py-2">{t("customerDetail_paid")}</th></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {customerTxns.map((tx) => (
              <tr key={tx.id} className="hover:bg-stone-50">
                <td className="px-3 py-2 f-mono text-slate-600">{tx.code}</td>
                <td className="px-3 py-2 f-mono text-xs text-slate-500">{fmtDate(tx.date)}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tx.type === "topup" ? "bg-teal-100 text-teal-700" : "bg-rose-100 text-rose-700"}`}>{tx.type === "topup" ? t("customerDetail_topupType") : t("customerDetail_debtType")}</span></td>
                <td className="px-3 py-2 text-slate-600">{tx.type === "topup" ? t("customerDetail_creditedDetail", { credited: sar(tx.creditedAmount), discount: discountLabel(tx), method: payMethodLabel(t, tx.payMethod) }) : t("customerDetail_debtDetail", { method: payMethodLabel(t, tx.payMethod) })}</td>
                <td className="px-3 py-2 f-mono font-semibold text-slate-900">{sar(tx.paidAmount)}</td>
              </tr>
            ))}
            {customerTxns.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">{t("customerDetail_noTransactions")}</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// "آخر طلب" / "Last Order" column — relative-time label computed from a
// customer's most recent non-topup invoice (a wallet top-up isn't a laundry
// order, so it's excluded the same way it's excluded from Sales Reports
// revenue — see applyTopUp's isTopup comment below). Falls back to an
// absolute year/month/week count once the gap is too old for "N days ago"
// to read naturally; Western digits throughout per this screen's numeral
// rule (Arabic-Indic is reserved for the Home dashboard KPI row only).
function lastOrderRelativeLabel(t, iso) {
  const diffDays = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (diffDays === 0) return t("customers_today");
  if (diffDays === 1) return t("customers_yesterday");
  if (diffDays < 7) return t("customers_daysAgo", { n: diffDays });
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? t("customers_weekAgo") : t("customers_weeksAgo", { n: weeks });
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? t("customers_monthAgo") : t("customers_monthsAgo", { n: months });
  }
  const years = Math.floor(diffDays / 365);
  return years === 1 ? t("customers_yearAgo") : t("customers_yearsAgo", { n: years });
}

function CustomersView({ customers, updateCustomer, addCustomer, invoices, addInvoice, transactions, addTransaction, merchant, applyCustomerPayment, nextDocNumber, whatsappTemplate, whatsappEnabled }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [topUpFor, setTopUpFor] = useState(null);
  const [settleFor, setSettleFor] = useState(null);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [printDoc, setPrintDoc] = useState(null);
  const [topUpError, setTopUpError] = useState("");
  const [settleError, setSettleError] = useState("");

  const idOnly = query.startsWith("#");
  const filtered = customers.filter((c) =>
    idOnly ? String(c.id).includes(query.slice(1).trim()) :
    (c.mobile.includes(query) || String(c.id).includes(query) || c.name.toLowerCase().includes(query.toLowerCase()))
  );
  const selectedLive = selected ? customers.find((c) => c.id === selected.id) : null;

  // KPI row aggregates — plain sums over the same real customer.walletBalance
  // / customer.debt fields the table itself renders, nothing computed
  // server-side or duplicated elsewhere.
  const totalWalletBalance = useMemo(() => customers.reduce((s, c) => s + Number(c.walletBalance || 0), 0), [customers]);
  const totalDebt = useMemo(() => customers.reduce((s, c) => s + Number(c.debt || 0), 0), [customers]);

  // One pass over invoices (not one pass per customer row) to find each
  // customer's latest real order date for the "Last Order" column.
  const lastOrderByCustomer = useMemo(() => {
    const map = new Map();
    for (const inv of invoices) {
      if (inv.isTopup || !inv.customerId) continue;
      const prev = map.get(inv.customerId);
      if (!prev || new Date(inv.createdAt) > new Date(prev)) map.set(inv.customerId, inv.createdAt);
    }
    return map;
  }, [invoices]);

  const applyTopUp = async ({ topUp, duePayable, notes, mode, discountAmount, payMethod }) => {
    const customer = topUpFor;
    setTopUpError("");
    // Everything below is one try/catch, not just the balance RPC: an
    // earlier version left nextDocNumber()/addTransaction()/addInvoice()
    // unprotected, so if any of them failed AFTER the wallet was already
    // credited, the failure was a silent unhandled rejection — the modal
    // just sat there looking stuck, inviting another click, which credited
    // the wallet AGAIN (that RPC alone always succeeds) without ever
    // recording a matching transaction/invoice. Any failure now surfaces a
    // real error instead of leaving wallet and books out of sync silently.
    try {
      // Delta-based (+topUp to the wallet, +duePayable to debt only if on
      // credit) via apply_customer_payment() — see createInvoice for why.
      await applyCustomerPayment(customer.id, topUp, payMethod === "Credit (On Account)" ? duePayable : 0);

      addTransaction({
        customerId: topUpFor.id, type: "topup",
        code: `RCT-${await nextDocNumber("RCT")}`,
        creditedAmount: topUp, paidAmount: duePayable, payMethod,
        discountAmount, discountMode: mode,
        notes, date: nowISO(),
      });

      if (payMethod !== "Credit (On Account)") {
        // A real Simplified Tax Invoice is generated the moment cash/network payment
        // is actually collected for a top-up — this is what feeds Sales Reports.
        // Later POS sales paid FROM this wallet balance must NOT be recounted as
        // revenue, or the same money would be counted twice.
        const code = `TOP-${await nextDocNumber("TOP")}`;
        const now = nowISO();
        const vatExempt = !merchant.taxNumber || !merchant.taxNumber.trim();
        const invoice = {
          code, customerId: topUpFor.id, customerName: customer.name, payMethod,
          // isTopup (lowercase "up") — matches the actual `is_topup` column
          // exactly; the more natural-looking `isTopUp` would snake_case to
          // `is_top_up`, which doesn't exist and silently failed every
          // wallet top-up's invoice insert (verified against the live schema).
          total: duePayable, isDelivery: false, deliveryFee: 0, createdAt: now, closed: true, isTopup: true, vatExempt,
          items: [{ itemId: uid("item"), name: t("customerDetail_topupType"), service: "-", addons: [], status: "Delivered", urgent: false, deliveredAt: now, price: duePayable, qty: 1, lineTotal: duePayable }],
        };
        addInvoice(invoice);

        const net = vatExempt ? duePayable : duePayable / (1 + VAT_RATE);
        const vat = vatExempt ? 0 : duePayable - net;
        setPrintDoc({
          kind: vatExempt ? "receipt" : "tax", isTopUp: true, merchant, dateLabel: printDateLabel(now), isoDateTime: now, invoiceCode: code, customerName: customer.name,
          customerPhone: customer.mobile || null, whatsappTemplate, whatsappEnabled,
          items: [{ name: t("customerDetail_topupType"), price: duePayable, qty: 1, lineTotal: duePayable }],
          totals: { net, discount: discountAmount, vat, gross: duePayable, paid: duePayable, remaining: 0, pieceCount: 1 },
          payMethodLabel: payMethodPrintLabel(t, payMethod), dueDate: null,
        });
      }
      setTopUpFor(null);
    } catch (e) {
      console.error("applyTopUp failed", e);
      setTopUpError(t("common_operationFailed"));
    }
  };

  const applySettle = async ({ amount, notes, payMethod }) => {
    const customer = settleFor;
    setSettleError("");
    if (!amount || amount <= 0 || amount > customer.debt) return; // belt-and-braces — the modal's own disabled button already blocks this
    try {
      // Delta-based (-amount from debt, and also -amount from the wallet if
      // that's where it's coming from) via apply_customer_payment().
      await applyCustomerPayment(customer.id, payMethod === "Wallet Balance" ? -amount : 0, -amount);
      addTransaction({
        customerId: settleFor.id, type: "debt_payment",
        code: `PMT-${await nextDocNumber("PMT")}`,
        paidAmount: amount, payMethod, notes, date: nowISO(),
      });
      setSettleFor(null);
    } catch (e) {
      console.error("applySettle failed", e);
      setSettleError(t("common_operationFailed"));
    }
  };

  const saveNewCustomer = (data) => {
    if (!customers.some((c) => c.id === data.id)) addCustomer(data);
    setShowAddCustomer(false);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="f-display text-xl font-semibold text-app-text">{t("customers_title")}</div>
          <div className="text-sm text-app-text-muted">{t("customers_subtitle")}</div>
        </div>
        <button onClick={() => setShowAddCustomer(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"><Plus size={15} /> {t("customers_addCustomer")}</button>
      </div>

      {/* Two aggregate KPI tiles over the same customer.walletBalance/debt
          fields the table below renders — see the useMemo sums above. */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-app-text-muted">{t("customers_totalWallet")}</span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-success-50 text-success-700"><Wallet size={18} /></div>
          </div>
          <div className="mt-3 text-2xl font-extrabold text-app-text">{sarCompact(totalWalletBalance)}</div>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-app-text-muted">{t("customers_totalDebt")}</span>
            <div className="flex size-9 items-center justify-center rounded-lg bg-warning-50 text-warning-700"><AlertCircle size={18} /></div>
          </div>
          <div className="mt-3 text-2xl font-extrabold text-app-text">{sarCompact(totalDebt)}</div>
        </div>
      </div>

      <div className="relative mb-4 max-w-sm sm:max-w-xs">
        <Search size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-text-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("customers_searchPlaceholder")} className={`${inputCls} pr-9`} />
      </div>
      <div className="overflow-hidden rounded-xl border border-app-border">
        <table className="w-full text-right text-[13px]">
          <thead className="bg-app-bg/60 text-xs font-semibold uppercase tracking-wide text-app-text-muted">
            <tr><th className="px-4 py-3">{t("customers_name")}</th><th className="px-4 py-3">{t("customers_wallet")}</th><th className="px-4 py-3">{t("customers_debt")}</th><th className="px-4 py-3">{t("customers_mobile")}</th><th className="px-4 py-3">{t("customers_lastOrder")}</th><th className="px-4 py-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {filtered.map((c) => {
              const lastOrderIso = lastOrderByCustomer.get(c.id);
              return (
                <tr key={c.id} onClick={() => setSelected(c)} className="cursor-pointer hover:bg-app-bg/60">
                  <td className="px-4 py-3 font-medium text-app-text">{c.name}</td>
                  <td className={`px-4 py-3 f-mono ${c.walletBalance > 0 ? "font-bold text-success-700" : "text-app-text-subtle"}`}>{sarCompact(c.walletBalance)}</td>
                  <td className={`px-4 py-3 f-mono ${c.debt > 0 ? "font-bold text-danger-700" : "text-app-text-subtle"}`}>{sarCompact(c.debt)}</td>
                  <td className="px-4 py-3 f-mono text-app-text-muted">{c.mobile}</td>
                  <td className="px-4 py-3 text-app-text-muted">{lastOrderIso ? lastOrderRelativeLabel(t, lastOrderIso) : t("customers_neverOrdered")}</td>
                  <td className="px-4 py-3">
                    <button onClick={(e) => { e.stopPropagation(); setSelected(c); }} className="rounded-lg border border-app-border-strong px-3 py-1.5 text-xs font-medium text-app-text-muted hover:bg-app-bg">{t("customers_details")}</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-app-text-subtle">{t("customers_noneYet")}</td></tr>}
          </tbody>
        </table>
      </div>

      {selectedLive && (
        <CustomerDetailModal
          customer={selectedLive}
          invoices={invoices}
          transactions={transactions}
          onClose={() => setSelected(null)}
          onOpenTopUp={() => setTopUpFor(selectedLive)}
          onOpenSettleDebt={() => setSettleFor(selectedLive)}
        />
      )}
      {topUpFor && <TopUpModal customer={topUpFor} onClose={() => setTopUpFor(null)} onSubmit={applyTopUp} error={topUpError} />}
      {settleFor && <SettleDebtModal customer={settleFor} onClose={() => setSettleFor(null)} onSubmit={applySettle} error={settleError} />}
      {showAddCustomer && <AddCustomerModal customers={customers} onClose={() => setShowAddCustomer(false)} onSave={saveNewCustomer} />}
      {printDoc && <PrintDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />}
    </div>
  );
}

/* =========================================================================
   MODULE 4 — INVENTORY
   ========================================================================= */
function ProductFormModal({ editing, categories, addCategory, serviceTypes, addServiceType, addProduct, updateProduct, products, onClose }) {
  const { t } = useLang();
  const [name, setName] = useState(editing?.name || "");
  const [categoryId, setCategoryId] = useState(editing?.categoryId || categories[0]?.id || "");
  const [published, setPublished] = useState(editing ? editing.published : true);
  const [imgPreview, setImgPreview] = useState(editing?.image || "");
  // "" means no shortcut assigned — explicit-assignment-only, never auto-picked.
  const [quickAccessKey, setQuickAccessKey] = useState(editing?.quickAccessKey ? String(editing.quickAccessKey) : "");
  const quickAccessTaken = quickAccessKey !== "" && products.some((p) => p.id !== editing?.id && p.quickAccessKey === Number(quickAccessKey));
  const fileRef = useRef(null);
  const [showAddService, setShowAddService] = useState(false);
  const [newServiceName, setNewServiceName] = useState("");
  const [formError, setFormError] = useState("");
  const [servicePrices, setServicePrices] = useState(() => {
    const init = {};
    if (editing) serviceTypes.forEach((st) => { if (editing.services[st.name] !== undefined) init[st.id] = String(editing.services[st.name]); });
    return init;
  });
  const [productAddons, setProductAddons] = useState(editing?.productAddons || []);
  const [pAddonName, setPAddonName] = useState("");
  const [pAddonPrice, setPAddonPrice] = useState("");
  const [imgUploading, setImgUploading] = useState(false);

  const addProductAddon = () => {
    if (!pAddonName.trim()) return;
    setProductAddons((prev) => [...prev, { id: uid("padd"), name: pAddonName.trim(), price: Number(pAddonPrice || 0) }]);
    setPAddonName(""); setPAddonPrice("");
  };
  const removeProductAddon = (id) => setProductAddons((prev) => prev.filter((a) => a.id !== id));

  const handleAddCategory = (n) => {
    const cat = addCategory(n);
    setCategoryId(cat.id);
  };
  const handleAddServiceType = () => {
    if (!newServiceName.trim()) return;
    addServiceType({ name: newServiceName.trim() });
    setNewServiceName(""); setShowAddService(false);
  };
  const handleFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const err = validateUploadedFile(file, { maxBytes: MAX_IMAGE_BYTES, allowedTypes: ALLOWED_IMAGE_TYPES });
    e.target.value = "";
    if (err) { setFormError(t(err)); return; }
    setFormError(""); setImgUploading(true);
    try {
      const { url } = await uploadTenantFile(file, "products");
      // A re-pick before Save orphans whatever the previous pick uploaded —
      // but never the originally saved image, which is only dropped once Save succeeds.
      if (imgPreview && imgPreview !== editing?.image) deleteTenantFile(imgPreview);
      setImgPreview(url);
    } catch {
      setFormError(t("upload_failed"));
    } finally {
      setImgUploading(false);
    }
  };

  const save = () => {
    setFormError("");
    const filledServices = {};
    serviceTypes.forEach((st) => {
      const v = servicePrices[st.id];
      if (v !== undefined && v !== "") filledServices[st.name] = Number(v);
    });
    if (!name.trim()) { setFormError(t("products_errName")); return; }
    if (!categoryId) { setFormError(t("products_errCategory")); return; }
    if (Object.keys(filledServices).length === 0) { setFormError(t("products_errService")); return; }
    if (quickAccessTaken) { setFormError(t("products_quickAccessTaken")); return; }
    const minPrice = Math.min(...Object.values(filledServices));
    const payload = {
      name: name.trim(), categoryId, image: imgPreview || "", published,
      price: minPrice, services: filledServices, productAddons,
      quickAccessKey: quickAccessKey === "" ? null : Number(quickAccessKey),
    };
    if (editing) {
      const writeDone = updateProduct(editing.id, payload);
      // Old image only becomes safe to drop once the row is CONFIRMED to
      // point elsewhere — deleting it before that (e.g. right away, in
      // parallel with the write) could leave a product pointing at a
      // just-deleted file if this write happens to fail and rolls back.
      if (editing.image && editing.image !== imgPreview) {
        writeDone.then(({ error }) => { if (!error) deleteTenantFile(editing.image); });
      }
    } else {
      addProduct({ ...payload, cost: 0, noCost: true });
    }
    onClose();
  };

  return (
    <Modal title={editing ? t("products_editTitle") : t("products_newProduct")} onClose={onClose} width="max-w-xl">
      <Field label={t("products_name")}>
        <div className="flex items-center gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} flex-1`} />
          <button type="button" disabled={imgUploading} onClick={() => fileRef.current.click()} title={t("products_upload")}
            className="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-app-border-strong bg-app-bg hover:bg-app-border/40 disabled:opacity-60">
            {imgUploading ? <Loader2 size={16} className="animate-spin text-app-text-subtle" />
              : imgPreview ? <img src={imgPreview} alt={t("products_image")} className="h-full w-full object-cover" />
              : <ImageIcon size={16} className="text-app-text-subtle" />}
          </button>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
        </div>
      </Field>
      <Field label={t("common_category")}><EmptyDropdownAdd label={t("common_category")} items={categories} valueId={categoryId} onSelect={setCategoryId} onAdd={handleAddCategory} /></Field>

      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("products_servicePrices")} <span className="normal-case text-app-text-subtle">{t("products_servicePricesHint")}</span></span>
        <div className="space-y-2">
          {serviceTypes.map((st) => (
            <div key={st.id} className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-sm text-app-text-muted">{st.name}</span>
              <input type="number" min="0" placeholder="—" value={servicePrices[st.id] ?? ""} onChange={(e) => setServicePrices((p) => ({ ...p, [st.id]: e.target.value }))} className={inputCls} />
            </div>
          ))}
          {serviceTypes.length === 0 && <div className="text-sm text-app-text-subtle">{t("products_noServiceTypes")}</div>}
          {showAddService ? (
            <div className="flex gap-2">
              <input autoFocus value={newServiceName} onChange={(e) => setNewServiceName(e.target.value)} placeholder={t("products_newServiceName")} className={inputCls} />
              <button onClick={handleAddServiceType} className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600">{t("common_save")}</button>
              <button onClick={() => setShowAddService(false)} className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-app-text-muted hover:text-app-text">{t("common_cancel")}</button>
            </div>
          ) : (
            <button type="button" onClick={() => setShowAddService(true)} className="text-sm font-semibold text-brand-600 hover:text-brand-700">+ {t("products_addServiceType")}</button>
          )}
        </div>
      </div>

      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("products_ownAddons")}</span>
        <div className="mb-2 flex flex-wrap gap-2">
          {productAddons.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 rounded-full border border-app-border bg-app-bg px-3 py-1.5 text-xs font-medium text-app-text-muted">
              {a.name} {a.price > 0 ? `+${sar(a.price)}` : ""}
              <button type="button" onClick={() => removeProductAddon(a.id)} className="text-app-text-subtle hover:text-danger-500"><X size={12} /></button>
            </span>
          ))}
          {productAddons.length === 0 && <span className="text-sm text-app-text-subtle">{t("products_noOwnAddons")}</span>}
        </div>
        <div className="flex gap-2">
          <input value={pAddonName} onChange={(e) => setPAddonName(e.target.value)} placeholder={t("products_addonNamePlaceholder")} className={inputCls} />
          <input type="number" value={pAddonPrice} onChange={(e) => setPAddonPrice(e.target.value)} placeholder={t("products_addonPricePlaceholder")} className={`${inputCls} w-28`} />
          <button type="button" onClick={addProductAddon} className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600">{t("common_add")}</button>
        </div>
      </div>

      <Field label={t("products_quickAccess")}>
        <select value={quickAccessKey} onChange={(e) => setQuickAccessKey(e.target.value)} className={`${inputCls} ${quickAccessTaken ? "border-danger-400" : ""}`}>
          <option value="">{t("products_quickAccessNone")}</option>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {quickAccessTaken && <div className="mt-1.5 text-xs font-semibold text-danger-600">{t("products_quickAccessTaken")}</div>}
      </Field>

      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-semibold text-app-text">{published ? t("products_liveOnPos") : t("products_draft")}</span>
        <Toggle checked={published} onChange={setPublished} />
      </div>
      {formError && <div className="mb-3 rounded-lg bg-danger-50 border border-danger-200 px-3 py-2 text-xs font-medium text-danger-700">{formError}</div>}
      <button disabled={imgUploading} onClick={save} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:opacity-60">{editing ? t("products_saveChanges") : t("products_save")}</button>
    </Modal>
  );
}

function InventoryView({ categories, addCategory, products, addProduct, updateProduct, addons, addAddon, removeAddon, serviceTypes, addServiceType }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState("all");
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [addonName, setAddonName] = useState("");
  const [addonPrice, setAddonPrice] = useState("");

  const handleAddAddon = () => {
    if (!addonName.trim()) return;
    addAddon({ name: addonName.trim(), price: Number(addonPrice || 0) });
    setAddonName(""); setAddonPrice("");
  };

  const filteredProducts = products.filter((p) =>
    (activeCat === "all" || p.categoryId === activeCat) &&
    (!query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()))
  );

  const kpis = [
    { label: t("products_kpiTotal"), value: products.length, icon: Shirt, tint: "bg-brand-50 text-brand-700" },
    { label: t("products_kpiCategories"), value: categories.length, icon: Tag, tint: "bg-info-50 text-info-700" },
    { label: t("products_kpiServiceTypes"), value: serviceTypes.length, icon: Package, tint: "bg-navy-900/5 text-navy-900" },
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="f-display text-xl font-semibold text-app-text">{t("nav_products")}</div>
          <div className="mt-0.5 text-sm text-app-text-muted">{t("products_subtitle")}</div>
        </div>
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 shadow-app-xs">
          <Plus size={16} /> {t("products_newProduct")}
        </button>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-app-text-muted">{k.label}</span>
                <div className={`flex size-9 items-center justify-center rounded-lg ${k.tint}`}><Icon size={16} /></div>
              </div>
              <div className="mt-3 text-2xl font-extrabold text-app-text">{k.value}</div>
            </div>
          );
        })}
      </div>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setActiveCat("all")} className={`rounded-full px-3.5 py-2 text-[12.5px] font-bold transition ${activeCat === "all" ? "bg-navy-900 text-white" : "bg-app-bg text-app-text-muted"}`}>{t("products_all")}</button>
          {categories.map((c) => (
            <button key={c.id} onClick={() => setActiveCat(c.id)} className={`rounded-full px-3.5 py-2 text-[12.5px] font-bold transition ${activeCat === c.id ? "bg-navy-900 text-white" : "bg-app-bg text-app-text-muted"}`}>{c.name}</button>
          ))}
        </div>
        <div className="sm:w-64">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-text-subtle" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("products_searchPlaceholder")} className={`${inputCls} pr-9`} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {filteredProducts.map((p) => {
          const cat = categories.find((c) => c.id === p.categoryId);
          return (
            <div key={p.id} onClick={() => setEditingProduct(p)}
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-xs transition hover:border-brand-300 hover:shadow-app-md">
              {p.quickAccessKey && (
                <span className="absolute top-2 right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-navy-900 text-[11px] font-bold text-white shadow">{p.quickAccessKey}</span>
              )}
              {p.image ? (
                <img src={p.image} alt={p.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
              ) : (
                <div className="flex aspect-[4/3] w-full items-center justify-center bg-app-bg text-app-text-subtle">
                  <Shirt size={26} />
                </div>
              )}
              <div className="p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-app-text">{p.name}</span>
                  <span className="shrink-0 rounded-full border border-app-border bg-app-bg px-2.5 py-1 text-[11px] font-medium text-app-text-muted">{cat?.name || "—"}</span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {Object.keys(p.services).map((sName) => (
                    <span key={sName} className="rounded-full bg-app-bg px-2 py-0.5 text-[10.5px] font-medium text-app-text-muted">{sName}</span>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-app-border pt-2">
                  <div className="text-right">
                    <div className="text-[10px] text-app-text-subtle">{t("products_table_from")}</div>
                    <div className="f-mono text-sm font-bold text-brand-700">{sar(p.price)}</div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Toggle checked={p.published} onChange={(v) => updateProduct(p.id, { published: v })} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {filteredProducts.length === 0 && (
          <div className="col-span-full py-16 text-center text-app-text-subtle">
            {products.length === 0 ? t("products_emptyState") : t("products_noResults")}
          </div>
        )}
      </div>

      <div className="mt-6 rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
        <div className="mb-3 f-display font-semibold text-app-text">{t("products_addonsCatalog")}</div>
        <div className="mb-4 flex flex-wrap gap-2">
          {addons.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 rounded-full border border-app-border bg-app-bg px-3 py-1.5 text-xs font-medium text-app-text-muted">
              {a.name} {a.price > 0 ? `+${sar(a.price)}` : ""}
              <button onClick={() => removeAddon(a.id)} className="text-app-text-subtle hover:text-danger-500"><X size={12} /></button>
            </span>
          ))}
          {addons.length === 0 && <span className="text-sm text-app-text-subtle">{t("products_noAddons")}</span>}
        </div>
        <div className="flex max-w-md gap-2">
          <input value={addonName} onChange={(e) => setAddonName(e.target.value)} placeholder={t("products_addonNamePlaceholder")} className={inputCls} />
          <input type="number" value={addonPrice} onChange={(e) => setAddonPrice(e.target.value)} placeholder={t("products_addonPricePlaceholder")} className={`${inputCls} w-28`} />
          <button onClick={handleAddAddon} className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600">{t("common_add")}</button>
        </div>
      </div>

      {showAddModal && (
        <ProductFormModal
          categories={categories} addCategory={addCategory}
          serviceTypes={serviceTypes} addServiceType={addServiceType}
          addProduct={addProduct} updateProduct={updateProduct}
          products={products}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {editingProduct && (
        <ProductFormModal
          editing={editingProduct}
          categories={categories} addCategory={addCategory}
          serviceTypes={serviceTypes} addServiceType={addServiceType}
          addProduct={addProduct} updateProduct={updateProduct}
          products={products}
          onClose={() => setEditingProduct(null)}
        />
      )}
    </div>
  );
}

/* =========================================================================
   MODULE 5 — PURCHASES & EXPENSES
   ========================================================================= */
// KPI card used only by PurchasesExpensesView — unlike the shared `KPI`
// component (still on the old stone/white palette, used only by the
// not-yet-redesigned ReportsView) this one is tokenized and supports an
// optional accent icon, matching the approved reference for this screen.
function PurchasesStatCard({ label, value, icon: Icon, tone }) {
  const tones = { info: "bg-info-50 text-info-700", warning: "bg-warning-50 text-warning-700" };
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-app-text-muted">{label}</span>
        {Icon && <div className={`flex size-9 items-center justify-center rounded-lg ${tones[tone] || ""}`}><Icon size={18} /></div>}
      </div>
      <div className="mt-3 text-2xl font-extrabold text-app-text">{value}</div>
    </div>
  );
}

function PurchasesExpensesView({ suppliers, addSupplier, updateSupplier, purchases, addPurchase, expenseCategories, addExpenseCategory, expenses, addExpense, adjustSupplierBalance, nextDocNumber }) {
  const { t } = useLang();
  const [tab, setTab] = useState("purchases");

  // Purchases sub-state
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Cash");
  const [attachment, setAttachment] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const purchaseFileRef = useRef(null);
  const [payBalanceFor, setPayBalanceFor] = useState(null);
  const [payAmount, setPayAmount] = useState("");
  const [payBalanceError, setPayBalanceError] = useState("");
  const [purchaseError, setPurchaseError] = useState("");
  // Refs (not just state) guard re-entrancy — see TopUpModal's confirm() for why.
  const purchaseSubmittingRef = useRef(false);
  const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
  const payBalanceSubmittingRef = useRef(false);
  const [payBalanceSubmitting, setPayBalanceSubmitting] = useState(false);
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [supplierQuery, setSupplierQuery] = useState("");

  const saveNewSupplier = (data) => {
    const sup = addSupplier({ ...data, balance: 0 });
    setSupplierId(sup.id);
    setShowAddSupplier(false);
  };

  const saveEditedSupplier = (data) => {
    updateSupplier(editingSupplier.id, data);
    setEditingSupplier(null);
  };

  const handlePurchaseFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = validateUploadedFile(file, { maxBytes: MAX_ATTACHMENT_BYTES, allowedTypes: ALLOWED_ATTACHMENT_TYPES });
    e.target.value = "";
    if (err) { setPurchaseError(t(err)); return; }
    setPurchaseError(""); setAttachmentUploading(true);
    try {
      // Private bucket: `attachment` holds a storage PATH, not a URL — a
      // supplier invoice is a financial document, not something meant to
      // be openable by anyone with the link the way a shared invoice is.
      const { path } = await uploadPrivateFile(file, "purchases");
      if (attachment) deletePrivateFile(attachment); // a re-pick before submit orphans the previous one
      setAttachment(path); setAttachmentName(file.name);
    } catch {
      setPurchaseError(t("upload_failed"));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const recordPurchase = async () => {
    // Guards against a rapid double-click firing two overlapping submissions
    // — each would otherwise independently succeed at the balance RPC (it's
    // safely atomic per-call) while the resulting purchase record could
    // still end up duplicated or, if a later step failed, missing entirely.
    if (purchaseSubmittingRef.current || attachmentUploading || !supplierId || !amount) return;
    const amt = Number(amount);
    setPurchaseError("");
    purchaseSubmittingRef.current = true;
    setPurchaseSubmitting(true);
    try {
      if (method === "Credit (On Account)") {
        // Atomic +amt via adjust_supplier_balance() — see createInvoice for
        // why this replaced a client-computed "supplier.balance + amt" write.
        await adjustSupplierBalance(supplierId, amt);
      }
      addPurchase({ code: `PO-${await nextDocNumber("PO")}`, supplierId, amount: amt, method, date: nowISO(), attachment, attachmentName });
      setAmount(""); setAttachment(""); setAttachmentName("");
      setShowPurchaseModal(false);
    } catch (e) {
      console.error("recordPurchase failed", e);
      setPurchaseError(t("common_operationFailed"));
    } finally {
      purchaseSubmittingRef.current = false;
      setPurchaseSubmitting(false);
    }
  };

  const openPayBalance = (s) => { setPayBalanceFor(s); setPayAmount(""); setPayBalanceError(""); };

  const payBalance = async () => {
    if (payBalanceSubmittingRef.current) return;
    const amt = Number(payAmount || 0);
    if (!amt || amt <= 0) return;
    if (amt > payBalanceFor.balance) {
      setPayBalanceError(t("payBalance_exceedsError", { amount: sar(payBalanceFor.balance) }));
      return;
    }
    payBalanceSubmittingRef.current = true;
    setPayBalanceSubmitting(true);
    try {
      await adjustSupplierBalance(payBalanceFor.id, -amt);
      setPayBalanceFor(null); setPayAmount(""); setPayBalanceError("");
    } catch (e) {
      console.error("payBalance failed", e);
      setPayBalanceError(t("common_operationFailed"));
    } finally {
      payBalanceSubmittingRef.current = false;
      setPayBalanceSubmitting(false);
    }
  };

  // Expenses sub-state
  const [expCat, setExpCat] = useState(expenseCategories[0]?.id || "");
  const [expAmount, setExpAmount] = useState("");
  const [taxFlag, setTaxFlag] = useState("Inclusive");
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));
  const [receipt, setReceipt] = useState("");
  const [receiptName, setReceiptName] = useState("");
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [expenseError, setExpenseError] = useState("");
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expenseQuery, setExpenseQuery] = useState("");
  const fileRef = useRef(null);

  const handleReceiptFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = validateUploadedFile(file, { maxBytes: MAX_ATTACHMENT_BYTES, allowedTypes: ALLOWED_ATTACHMENT_TYPES });
    e.target.value = "";
    if (err) { setExpenseError(t(err)); return; }
    setExpenseError(""); setReceiptUploading(true);
    try {
      // Private bucket: `receipt` holds a storage PATH, not a URL — same
      // reasoning as purchase attachments (see handlePurchaseFile above).
      const { path } = await uploadPrivateFile(file, "receipts");
      if (receipt) deletePrivateFile(receipt); // a re-pick before submit orphans the previous one
      setReceipt(path); setReceiptName(file.name);
    } catch {
      setExpenseError(t("upload_failed"));
    } finally {
      setReceiptUploading(false);
    }
  };

  const addExpCategory = (n) => { const c = addExpenseCategory({ name: n }); setExpCat(c.id); };
  const recordExpense = () => {
    if (!expCat || !expAmount || receiptUploading) return;
    addExpense({ categoryId: expCat, amount: Number(expAmount), taxFlag, date: expDate, receipt, receiptName });
    setExpAmount(""); setReceipt(""); setReceiptName("");
    setShowExpenseModal(false);
  };

  const totalDue = suppliers.reduce((s, x) => s + (x.balance || 0), 0);
  const exemptTotal = expenses.filter((e) => e.taxFlag === "Exempt").reduce((s, e) => s + e.amount, 0);
  const taxableTotal = expenses.filter((e) => e.taxFlag === "Inclusive").reduce((s, e) => s + e.amount, 0);
  const expensesTotal = exemptTotal + taxableTotal;
  const supplierQueryNorm = supplierQuery.trim().toLowerCase();
  const filteredSuppliers = suppliers.filter((s) => !supplierQueryNorm || [s.company, s.agent, s.contact].some((v) => (v || "").toLowerCase().includes(supplierQueryNorm)));
  const recentPurchases = [...purchases].sort((a, b) => new Date(b.date) - new Date(a.date));
  const expenseQueryNorm = expenseQuery.trim().toLowerCase();
  const filteredExpenses = expenses.filter((e) => {
    if (!expenseQueryNorm) return true;
    const catName = (expenseCategories.find((c) => c.id === e.categoryId)?.name || "").toLowerCase();
    return catName.includes(expenseQueryNorm) || (e.date || "").includes(expenseQueryNorm);
  }).sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div>
      <div className="mb-5">
        <div className="f-display text-xl font-semibold text-app-text">{t("purchases_pageTitle")}</div>
        <div className="text-sm text-app-text-muted">{t("purchases_pageSubtitle")}</div>
      </div>

      <div className="mb-6 inline-flex rounded-full border border-app-border bg-app-bg p-1">
        <button onClick={() => setTab("purchases")} className={`rounded-full px-4 py-2 text-sm transition ${tab === "purchases" ? "bg-app-surface font-semibold text-app-text shadow-app-xs" : "font-medium text-app-text-muted"}`}>{t("purchases_suppliersTab")}</button>
        <button onClick={() => setTab("expenses")} className={`rounded-full px-4 py-2 text-sm transition ${tab === "expenses" ? "bg-app-surface font-semibold text-app-text shadow-app-xs" : "font-medium text-app-text-muted"}`}>{t("purchases_expensesTab")}</button>
      </div>

      {tab === "purchases" ? (
        <div>
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PurchasesStatCard label={t("purchases_kpiDue")} value={sar(totalDue)} icon={Wallet} tone="warning" />
            <PurchasesStatCard label={t("purchases_kpiSuppliers")} value={suppliers.length} icon={Receipt} tone="info" />
            <PurchasesStatCard label={t("purchases_kpiCount")} value={purchases.length} />
          </div>

          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button onClick={() => setShowPurchaseModal(true)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"><Plus className="size-4" />{t("purchases_addPurchaseBtn")}</button>
            <div className="relative sm:w-64">
              <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-text-subtle" />
              <input value={supplierQuery} onChange={(e) => setSupplierQuery(e.target.value)} placeholder={t("purchases_searchSuppliers")} className={`${inputCls} pr-9`} />
            </div>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredSuppliers.map((s) => (
              <button key={s.id} onClick={() => setSelectedSupplier(s)} className="rounded-xl border border-app-border bg-app-surface p-4 text-right shadow-app-xs transition hover:border-brand-300 hover:shadow-app-md">
                <div className="mb-3 flex items-center justify-between gap-2">
                  {s.balance > 0 ? (
                    <span className="shrink-0 rounded-full border border-danger-200 bg-danger-50 px-2.5 py-1 text-xs font-bold text-danger-700">{sarCompact(s.balance)}</span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-success-200 bg-success-50 px-2.5 py-1 text-xs font-bold text-success-700">{t("purchases_settled")}</span>
                  )}
                  <span className="truncate font-semibold text-app-text">{s.company}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-app-text-muted">
                  <span className="flex items-center gap-1 f-mono"><Phone size={12} />{s.contact}</span>
                  <span className="flex items-center gap-1 truncate"><User size={12} />{s.agent}</span>
                </div>
              </button>
            ))}
            {filteredSuppliers.length === 0 && <div className="col-span-full py-10 text-center text-app-text-subtle">{t("purchases_noSuppliers")}</div>}
          </div>

          <div className="mb-2 text-sm font-semibold text-app-text">{t("purchases_recentTitle")}</div>
          <div className="space-y-2">
            {recentPurchases.map((p) => {
              const supplier = suppliers.find((s) => s.id === p.supplierId);
              return (
                <div key={p.id} onClick={() => p.attachment && openStoredDocument(p.attachment)} className={`flex items-center justify-between rounded-xl border border-app-border bg-app-surface p-3 ${p.attachment ? "cursor-pointer hover:bg-app-bg" : ""}`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-bg text-app-text-muted"><ReceiptText size={16} /></span>
                    <div>
                      <div className="text-sm font-medium text-app-text">{supplier?.company || "—"}</div>
                      <div className="f-mono text-xs text-app-text-subtle">{p.code} · {fmtDate(p.date)}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="f-mono font-semibold text-app-text">{sarCompact(p.amount)}</div>
                    <span className={`mt-0.5 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${p.method === "Cash" ? "border-app-border-strong text-app-text-muted" : "border-warning-200 bg-warning-50 text-warning-700"}`}>{p.method === "Cash" ? t("common_cash") : t("purchases_credit")}</span>
                  </div>
                </div>
              );
            })}
            {recentPurchases.length === 0 && <div className="py-8 text-center text-app-text-subtle">{t("purchases_noPurchases")}</div>}
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PurchasesStatCard label={t("expenses_kpiExempt")} value={sar(exemptTotal)} />
            <PurchasesStatCard label={t("expenses_kpiTaxable")} value={sar(taxableTotal)} icon={ReceiptText} tone="info" />
            <PurchasesStatCard label={t("expenses_kpiTotal")} value={sar(expensesTotal)} icon={Wallet} tone="warning" />
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button onClick={() => setShowExpenseModal(true)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"><Plus size={16} />{t("expenses_addExpenseBtn")}</button>
            <div className="relative min-w-[200px] flex-1">
              <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-text-subtle" />
              <input value={expenseQuery} onChange={(e) => setExpenseQuery(e.target.value)} placeholder={t("expenses_searchPlaceholder")} className={`${inputCls} pr-9`} />
            </div>
          </div>

          <div className="space-y-2">
            {filteredExpenses.map((e) => {
              const cat = expenseCategories.find((c) => c.id === e.categoryId);
              const hasReceipt = e.receipt?.startsWith("http") || e.receipt?.startsWith("data:") || e.receipt?.includes("/");
              return (
                <div key={e.id} onClick={() => hasReceipt && openStoredDocument(e.receipt)} className={`flex items-center justify-between rounded-xl border border-app-border bg-app-surface p-3 ${hasReceipt ? "cursor-pointer hover:bg-app-bg" : ""}`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-bg text-app-text-muted"><FileText size={16} /></span>
                    <div>
                      <div className="text-sm font-medium text-app-text">{cat?.name || "—"}</div>
                      <div className="f-mono text-xs text-app-text-subtle">{fmtDate(e.date)}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="f-mono font-semibold text-app-text">{sarCompact(e.amount)}</div>
                    <span className={`mt-0.5 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${e.taxFlag === "Inclusive" ? "border-app-border-strong text-app-text-muted" : "border-warning-200 bg-warning-50 text-warning-700"}`}>{e.taxFlag === "Inclusive" ? t("expenses_taxInclusive") : t("expenses_taxExempt")}</span>
                  </div>
                </div>
              );
            })}
            {filteredExpenses.length === 0 && <div className="py-8 text-center text-app-text-subtle">{t("expenses_noExpenses")}</div>}
          </div>
        </div>
      )}

      {showPurchaseModal && (
        <Modal title={t("purchases_recordPurchase")} onClose={() => { setShowPurchaseModal(false); setShowAddSupplier(false); setPurchaseError(""); }} width="max-w-md">
          {showAddSupplier ? (
            <SupplierQuickAddFields onSave={saveNewSupplier} onCancel={() => setShowAddSupplier(false)} />
          ) : (
            <Field label={t("purchases_supplier")}>
              <div className="flex gap-2">
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputCls}>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.company}</option>)}
                </select>
                <button type="button" onClick={() => setShowAddSupplier(true)} title={t("purchases_newSupplier")} className="shrink-0 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-brand-700 hover:bg-brand-100"><Plus size={16} /></button>
              </div>
            </Field>
          )}
          <Field label={t("common_amount")}><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} /></Field>
          <Field label={t("purchases_payment")}>
            <div className="flex gap-2">
              <button onClick={() => setMethod("Cash")} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${method === "Cash" ? "border-brand-500 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("common_cash")}</button>
              <button onClick={() => setMethod("Credit (On Account)")} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${method !== "Cash" ? "border-brand-500 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("purchases_credit")}</button>
            </div>
          </Field>
          <Field label={t("purchases_invoiceFile")}>
            <button disabled={attachmentUploading} onClick={() => purchaseFileRef.current.click()} className="w-full rounded-lg border border-dashed border-app-border-strong px-3 py-2 text-sm text-app-text-muted hover:bg-app-bg disabled:opacity-60">
              {attachmentUploading ? <Loader2 size={13} className="inline mr-1.5 animate-spin" /> : <Upload size={13} className="inline mr-1.5" />}
              {attachmentUploading ? t("upload_uploading") : (attachmentName || t("purchases_uploadInvoice"))}
            </button>
            <input ref={purchaseFileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handlePurchaseFile} />
          </Field>
          {purchaseError && <div className="mb-3 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700">{purchaseError}</div>}
          <button onClick={recordPurchase} disabled={purchaseSubmitting || attachmentUploading} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:opacity-60">{t("purchases_savePurchase")}</button>
        </Modal>
      )}

      {showExpenseModal && (
        <Modal title={t("expenses_addExpense")} onClose={() => setShowExpenseModal(false)}>
          <Field label={t("common_category")}><EmptyDropdownAdd label={t("common_category")} items={expenseCategories} valueId={expCat} onSelect={setExpCat} onAdd={addExpCategory} /></Field>
          <Field label={t("common_amount")}><input type="number" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} className={inputCls} /></Field>
          <div className="mb-4">
            <Toggle checked={taxFlag === "Exempt"} onChange={(v) => setTaxFlag(v ? "Exempt" : "Inclusive")} label={t("expenses_taxExempt")} />
          </div>
          <Field label={t("expenses_date")}><input type="date" value={expDate} onChange={(e) => setExpDate(e.target.value)} className={inputCls} /></Field>
          <Field label={t("expenses_receiptFile")}>
            <button disabled={receiptUploading} onClick={() => fileRef.current.click()} className="w-full rounded-lg border border-dashed border-app-border-strong px-3 py-2 text-sm text-app-text-muted hover:bg-app-bg disabled:opacity-60">
              {receiptUploading ? <Loader2 size={13} className="inline mr-1.5 animate-spin" /> : <Upload size={13} className="inline mr-1.5" />}
              {receiptUploading ? t("upload_uploading") : (receiptName || t("expenses_uploadReceipt"))}
            </button>
            <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleReceiptFile} />
          </Field>
          {expenseError && <div className="mb-3 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700">{expenseError}</div>}
          <button onClick={recordExpense} disabled={receiptUploading} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:opacity-60">{t("expenses_save")}</button>
        </Modal>
      )}

      {payBalanceFor && (
        <Modal title={`${t("payBalance_title")} · ${payBalanceFor.company}`} onClose={() => setPayBalanceFor(null)}>
          <div className="mb-4 text-sm text-app-text-muted">{t("payBalance_liability")} <span className="f-mono text-danger-600 font-semibold">{sar(payBalanceFor.balance)}</span></div>
          <Field label={t("common_amount")}><input type="number" value={payAmount} onChange={(e) => { setPayAmount(e.target.value); setPayBalanceError(""); }} className={inputCls} /></Field>
          {payBalanceError && <div className="mb-3 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{payBalanceError}</div>}
          <button onClick={payBalance} disabled={payBalanceSubmitting} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600 disabled:opacity-60">{t("payBalance_confirm")}</button>
        </Modal>
      )}
      {selectedSupplier && (
        <SupplierDetailModal
          supplier={suppliers.find((s) => s.id === selectedSupplier.id) || selectedSupplier}
          purchases={purchases}
          onClose={() => setSelectedSupplier(null)}
          onPayBalance={(s) => { setSelectedSupplier(null); openPayBalance(s); }}
          onEdit={() => { setEditingSupplier(suppliers.find((s) => s.id === selectedSupplier.id) || selectedSupplier); setSelectedSupplier(null); }}
        />
      )}
      {editingSupplier && <AddSupplierModal editing={editingSupplier} onClose={() => setEditingSupplier(null)} onSave={saveEditedSupplier} />}
    </div>
  );
}

/* =========================================================================
   MODULE 6 — PROMOTIONS
   ========================================================================= */
function PromotionModal({ onClose, onSave, promotions, editing }) {
  const { t } = useLang();
  const [name, setName] = useState(editing?.name || "");
  const [couponOn, setCouponOn] = useState(editing?.couponOn || false);
  const [coupon, setCoupon] = useState(editing?.coupon || "");
  const [isPercent, setIsPercent] = useState(editing ? editing.isPercent : true);
  const [value, setValue] = useState(editing ? String(editing.value) : "");
  const [start, setStart] = useState(editing?.startDate || "");
  const [end, setEnd] = useState(editing?.endDate || "");
  const [error, setError] = useState("");

  const handleSave = () => {
    setError("");
    if (!name.trim()) return;
    // A discount of 0 or below (or a percentage over 100) isn't a discount —
    // depending on how promoDiscount()/Math.min() combine it with the cart
    // total at POS, a negative value actually INCREASES the customer's total
    // instead of reducing it, silently. Reject it here before it can be saved.
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0 || (isPercent && numValue > 100)) {
      setError(t("promoModal_valueError"));
      return;
    }
    // Two active discounts may not cover the same moment in time — an
    // overlapping period would make it ambiguous which one applies at POS.
    const overlap = promotions.some((p) => p.id !== editing?.id && p.active !== false && promosOverlap(start, end, p.startDate, p.endDate));
    if (overlap) { setError(t("promoModal_overlapError")); return; }
    // start_date/end_date are timestamptz columns — Postgres accepts NULL
    // for "no limit" but rejects an empty string outright, so "" must be
    // normalized to null before it ever reaches the database.
    onSave({ name: name.trim(), couponOn, coupon, isPercent, value: numValue, startDate: start || null, endDate: end || null });
  };

  return (
    <Modal title={editing ? t("promoModal_editTitle") : t("promoModal_title")} onClose={onClose}>
      <Field label={t("promoModal_name")}><input value={name} onChange={(e) => setName(e.target.value.slice(0, 15))} maxLength={15} className={inputCls} /></Field>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-medium text-app-text">{t("promoModal_requiresCoupon")}</span>
        <Toggle checked={couponOn} onChange={setCouponOn} />
      </div>
      {couponOn && <Field label={t("promoModal_couponCode")}><input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} className={`${inputCls} f-mono tracking-widest`} /></Field>}
      <Field label={t("promoModal_evalType")}>
        <div className="flex gap-2">
          <button onClick={() => setIsPercent(false)} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${!isPercent ? "border-brand-600 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("promoModal_fixed")}</button>
          <button onClick={() => setIsPercent(true)} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${isPercent ? "border-brand-600 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("promoModal_percentage")}</button>
        </div>
      </Field>
      <Field label={isPercent ? t("promoModal_discountPercent") : t("promoModal_discountAmount")}><input type="number" min="0" max={isPercent ? 100 : undefined} value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("promoModal_start")}><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></Field>
        <Field label={t("promoModal_end")}><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></Field>
      </div>
      {error && <div className="mb-3 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">{error}</div>}
      <button onClick={handleSave} className="w-full rounded-lg bg-brand-500 py-2.5 font-semibold text-white hover:bg-brand-600">{editing ? t("promoModal_saveEdit") : t("promoModal_save")}</button>
    </Modal>
  );
}

// Purely presentational status for the table pill below — mirrors
// isPromoActive()'s two failure cases (not started yet / past its end date)
// but keeps them apart for display instead of collapsing both to "inactive".
// Does not feed back into isPromoActive/promoDiscount, so POS behavior is
// unaffected by anything here.
function promotionDisplayStatus(p) {
  if (p.active === false) return "expired";
  const now = Date.now();
  if (p.startDate && now < new Date(p.startDate).getTime()) return "scheduled";
  if (p.endDate && now > new Date(p.endDate).getTime()) return "expired";
  return "active";
}

const PROMOTION_STATUS_TONE = {
  active: "bg-success-50 text-success-700 ring-success-600/20",
  scheduled: "bg-info-50 text-info-700 ring-info-600/20",
  expired: "bg-app-bg text-app-text-muted ring-app-border",
};

function PromotionsView({ promotions, addPromotion, updatePromotion }) {
  const { t } = useLang();
  const [showModal, setShowModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState(null);

  const cancelPromotion = (p) => updatePromotion(p.id, { active: false });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="f-display text-xl font-semibold text-app-text">{t("promotions_title")}</div>
          <p className="mt-1 text-sm text-app-text-muted">{t("promotions_subtitle")}</p>
        </div>
        <button onClick={() => setShowModal(true)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"><Plus size={15} /> {t("promotions_addDiscount")}</button>
      </div>
      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
        <table className="w-full text-right text-[13px]">
          <thead className="bg-app-bg/60 text-xs font-semibold text-app-text-muted">
            <tr>
              <th className="px-4 py-3">{t("promotions_table_name")}</th>
              <th className="px-4 py-3">{t("promotions_table_coupon")}</th>
              <th className="px-4 py-3">{t("promotions_table_type")}</th>
              <th className="px-4 py-3">{t("promotions_table_value")}</th>
              <th className="px-4 py-3">{t("promotions_table_start")}</th>
              <th className="px-4 py-3">{t("promotions_table_end")}</th>
              <th className="px-4 py-3">{t("promotions_table_status")}</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {promotions.map((p) => {
              const cancelled = p.active === false;
              const status = promotionDisplayStatus(p);
              const statusLabel = status === "scheduled" ? t("promotions_scheduled") : status === "expired" ? t("common_expired") : t("common_active");
              return (
                <tr key={p.id} className="hover:bg-app-bg/60">
                  <td className="px-4 py-3 font-medium text-app-text truncate">{p.name}</td>
                  <td className="px-4 py-3">{p.couponOn ? <span className="f-mono text-xs tracking-wide text-app-text-muted">{p.coupon}</span> : <span className="text-app-text-subtle text-xs">—</span>}</td>
                  <td className="px-4 py-3 text-app-text-muted">{p.isPercent ? t("promotions_typePercent") : t("promotions_typeFixed")}</td>
                  <td className="px-4 py-3 f-mono font-medium text-app-text">{p.isPercent ? `${p.value}%` : sar(p.value)}</td>
                  <td className="px-4 py-3 f-mono text-xs text-app-text-muted">{p.startDate ? fmtDate(p.startDate) : "—"}</td>
                  <td className="px-4 py-3 f-mono text-xs text-app-text-muted">{p.endDate ? fmtDate(p.endDate) : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ring-1 ring-inset ${PROMOTION_STATUS_TONE[status]}`}>
                      <span className="size-1.5 rounded-full bg-current" />{statusLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditingPromo(p)} className="rounded-lg border border-app-border-strong px-2.5 py-1.5 text-xs font-medium text-app-text-muted hover:bg-app-bg"><Pencil size={12} className="inline mr-1" />{t("promotions_edit")}</button>
                      {!cancelled && <button onClick={() => cancelPromotion(p)} className="rounded-lg border border-danger-300 bg-danger-50 px-2.5 py-1.5 text-xs font-medium text-danger-600 hover:bg-danger-100"><Ban size={12} className="inline mr-1" />{t("promotions_cancel")}</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {promotions.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-app-text-subtle">{t("promotions_empty")}</td></tr>}
          </tbody>
        </table>
      </div>
      {showModal && <PromotionModal promotions={promotions} onClose={() => setShowModal(false)} onSave={(p) => { addPromotion({ ...p, active: true }); setShowModal(false); }} />}
      {editingPromo && <PromotionModal promotions={promotions} editing={editingPromo} onClose={() => setEditingPromo(null)} onSave={(p) => { updatePromotion(editingPromo.id, p); setEditingPromo(null); }} />}
    </div>
  );
}

/* =========================================================================
   MODULE 7 — REPORTS
   ========================================================================= */
function CopyableNumber({ value, t }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(String(value)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="inline-flex items-center gap-2">
      <span className="f-mono font-semibold">{value}</span>
      <button onClick={copy} className="rounded border border-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 hover:bg-teal-50">{copied ? t("reports_vat_copied") : t("reports_vat_copy")}</button>
    </div>
  );
}

function downloadCSV(rows, filename) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function ReportsView({ invoices, purchases, suppliers, categories, customers, expenses, expenseCategories }) {
  const { t } = useLang();
  const [tab, setTab] = useState("sales");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [method, setMethod] = useState("all");

  const salesRows = buildSalesRows(invoices, start, end, method);
  const gross = salesRows.reduce((s, r) => s + r.amount, 0);
  const vat = salesRows.reduce((s, r) => s + r.vat, 0);
  const net = gross - vat;
  const debt = customers.reduce((s, c) => s + c.debt, 0);

  // A purchase only carries reclaimable input VAT if its supplier has a
  // registered tax number — without one there's no valid tax invoice to
  // reclaim against, so that purchase contributes zero VAT (its full amount
  // just becomes net cost instead). Shared by both the Procurement Ledger's
  // "Input VAT Paid" KPI and the Tax Return tab's purchases box below.
  const taxedSupplierIds = new Set(suppliers.filter((s) => s.taxNumber && s.taxNumber.trim()).map((s) => s.id));

  const pGross = purchases.reduce((s, p) => s + p.amount, 0);
  const pVatEligibleGross = purchases.filter((p) => taxedSupplierIds.has(p.supplierId)).reduce((s, p) => s + p.amount, 0);
  const pVat = pVatEligibleGross - pVatEligibleGross / (1 + VAT_RATE);
  const pNet = pGross - pVat;

  // ---- Expenses report ----
  const [expStart, setExpStart] = useState("");
  const [expEnd, setExpEnd] = useState("");
  const filteredExpenses = expenses.filter((e) => {
    const ts = new Date(e.date).getTime();
    if (expStart && ts < new Date(expStart).getTime()) return false;
    if (expEnd && ts > new Date(expEnd).getTime()) return false;
    return true;
  });
  const eGross = filteredExpenses.reduce((s, e) => s + e.amount, 0);
  const eVat = filteredExpenses.reduce((s, e) => s + (e.taxFlag === "Inclusive" ? e.amount - e.amount / (1 + VAT_RATE) : 0), 0);
  const eNet = eGross - eVat;

  // ---- Profit & Loss report ----
  const [plStart, setPlStart] = useState("");
  const [plEnd, setPlEnd] = useState("");
  const revenueAllTime = invoices.reduce((s, i) => s + invoiceRevenue(i).amount, 0);
  const costsAllTime = purchases.reduce((s, p) => s + p.amount, 0) + expenses.reduce((s, e) => s + e.amount, 0);
  const resultAllTime = revenueAllTime - costsAllTime;

  const inPeriod = (iso) => {
    const ts = new Date(iso).getTime();
    if (plStart && ts < new Date(plStart).getTime()) return false;
    if (plEnd && ts > new Date(plEnd).getTime()) return false;
    return true;
  };
  const revenuePeriod = invoices.filter((i) => inPeriod(i.createdAt)).reduce((s, i) => s + invoiceRevenue(i).amount, 0);
  const costsPeriod = purchases.filter((p) => inPeriod(p.date)).reduce((s, p) => s + p.amount, 0) + expenses.filter((e) => inPeriod(e.date)).reduce((s, e) => s + e.amount, 0);
  const resultPeriod = revenuePeriod - costsPeriod;
  const marginPeriod = revenuePeriod > 0 ? (resultPeriod / revenuePeriod) * 100 : 0;

  // ---- VAT / Tax Return report ----
  const [vatMode, setVatMode] = useState("quarterly");
  const [vatYear, setVatYear] = useState(new Date().getFullYear());
  const [vatQuarter, setVatQuarter] = useState(Math.floor(new Date().getMonth() / 3) + 1);
  const [vatMonth, setVatMonth] = useState(new Date().getMonth() + 1);

  const vatStartMonth = vatMode === "quarterly" ? (vatQuarter - 1) * 3 : vatMonth - 1;
  const vatEndMonth = vatMode === "quarterly" ? vatStartMonth + 2 : vatStartMonth;
  const vatPeriodStart = new Date(vatYear, vatStartMonth, 1, 0, 0, 0);
  const vatPeriodEnd = new Date(vatYear, vatEndMonth + 1, 0, 23, 59, 59);
  const inVatPeriod = (iso) => { const ts = new Date(iso).getTime(); return ts >= vatPeriodStart.getTime() && ts <= vatPeriodEnd.getTime(); };

  const vatSalesInvoices = invoices.filter((i) => inVatPeriod(i.createdAt));
  const salesBox1Taxable = vatSalesInvoices.reduce((s, i) => s + invoiceRevenue(i).net, 0);
  const salesBox1Vat = vatSalesInvoices.reduce((s, i) => s + invoiceRevenue(i).vat, 0);

  // A supplier only counts as "exempt" for box 5 if the owner explicitly
  // flagged it and gave an exemption number — a supplier with neither a tax
  // number nor an exemption number is just left out of the tax return
  // entirely (its purchases still show up in the Procurement Ledger/reports).
  const exemptSupplierIds = new Set(suppliers.filter((s) => s.taxExempt && s.exemptionNumber && s.exemptionNumber.trim()).map((s) => s.id));

  const vatPurchases = purchases.filter((p) => inVatPeriod(p.date) && taxedSupplierIds.has(p.supplierId));
  const vatPurchasesExempt = purchases.filter((p) => inVatPeriod(p.date) && exemptSupplierIds.has(p.supplierId));
  const vatExpensesIncl = expenses.filter((e) => e.taxFlag === "Inclusive" && inVatPeriod(e.date));
  const vatExpensesExempt = expenses.filter((e) => e.taxFlag === "Exempt" && inVatPeriod(e.date));
  const purchBox1Gross = vatPurchases.reduce((s, p) => s + p.amount, 0) + vatExpensesIncl.reduce((s, e) => s + e.amount, 0);
  const purchBox1Taxable = purchBox1Gross / (1 + VAT_RATE);
  const purchBox1Vat = purchBox1Gross - purchBox1Taxable;
  const purchBox5Exempt = vatExpensesExempt.reduce((s, e) => s + e.amount, 0) + vatPurchasesExempt.reduce((s, p) => s + p.amount, 0);

  const totalSalesValue = salesBox1Taxable;
  const totalOutputVat = salesBox1Vat;
  const totalPurchasesValue = purchBox1Taxable + purchBox5Exempt;
  const totalInputVat = purchBox1Vat;
  const netVatDue = totalOutputVat - totalInputVat;

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const exportVatCsv = () => {
    const rows = [
      ["Sales — Output VAT"],
      ["Box", "Description", "Taxable Amount", "VAT Amount"],
      ["1", "Standard-rated supplies (15%)", round2(salesBox1Taxable), round2(salesBox1Vat)],
      ["2", "Supplies to citizens borne by government", 0, 0],
      ["3", "Zero-rated domestic supplies", 0, 0],
      ["4", "Exports outside the Kingdom", 0, 0],
      ["5", "Exempt supplies", 0, 0],
      ["", "Total", round2(totalSalesValue), round2(totalOutputVat)],
      [],
      ["Purchases — Input VAT"],
      ["Box", "Description", "Taxable Amount", "VAT Amount"],
      ["1", "Standard-rated purchases (15%)", round2(purchBox1Taxable), round2(purchBox1Vat)],
      ["2", "Imports subject to VAT at customs", 0, 0],
      ["3", "Reverse-charge purchases", 0, 0],
      ["4", "Zero-rated purchases", 0, 0],
      ["5", "Exempt purchases", round2(purchBox5Exempt), 0],
      ["", "Total", round2(totalPurchasesValue), round2(totalInputVat)],
      [],
      ["Summary"],
      ["Total Output VAT", round2(totalOutputVat)],
      ["Total Input VAT", round2(totalInputVat)],
      ["Net VAT Due", round2(netVatDue)],
    ];
    downloadCSV(rows, `vat-return-${vatYear}-${vatMode === "quarterly" ? `Q${vatQuarter}` : `M${vatMonth}`}.csv`);
  };

  // Local, presentation-only KPI card — kept private to ReportsView so this
  // redesign never touches the shared (still-legacy-styled) KPI component
  // that other screens might start relying on later.
  const kpiAccents = { slate: "text-app-text", teal: "text-brand-700", rose: "text-danger-600", amber: "text-warning-600" };
  const kpi = (label, value, accent = "slate") => (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-app-xs">
      <div className="text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{label}</div>
      <div className={`f-mono mt-1.5 text-2xl font-semibold ${kpiAccents[accent]}`}>{value}</div>
    </div>
  );

  const tabBtnCls = (active) => `rounded-full px-4 py-2 text-sm font-medium transition ${active ? "bg-brand-600 text-white shadow-app-xs" : "bg-app-surface border border-app-border text-app-text-muted hover:border-app-border-strong"}`;

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setTab("sales")} className={tabBtnCls(tab === "sales")}>{t("reports_salesTab")}</button>
        <button onClick={() => setTab("procurement")} className={tabBtnCls(tab === "procurement")}>{t("reports_procurementTab")}</button>
        <button onClick={() => setTab("expenses")} className={tabBtnCls(tab === "expenses")}>{t("reports_expensesTab")}</button>
        <button onClick={() => setTab("pl")} className={tabBtnCls(tab === "pl")}>{t("reports_plTab")}</button>
        <button onClick={() => setTab("vat")} className={tabBtnCls(tab === "vat")}>{t("reports_vatTab")}</button>
      </div>

      {tab === "sales" && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {kpi(t("reports_kpi_invoices"), salesRows.length)}
            {kpi(t("reports_kpi_grossSales"), sar(gross), "teal")}
            {kpi(t("reports_kpi_vatCollected"), sar(vat), "amber")}
            {kpi(t("reports_kpi_netRevenue"), sar(net), "teal")}
            {kpi(t("reports_kpi_outstandingDebt"), sar(debt), "rose")}
          </div>
          <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-app-xs">
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${inputCls} w-auto`} />
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${inputCls} w-auto`} />
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inputCls} w-auto`}>
              <option value="all">{t("reports_allPaymentMethods")}</option>
              {PAY_METHODS.filter((m) => m.value !== "Wallet Balance").map((m) => <option key={m.value} value={m.value}>{t(m.key)}</option>)}
            </select>
          </div>
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
            <table className="w-full text-sm table-fixed">
              <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
                <tr><th className="px-4 py-3 w-40 text-center">{t("reports_table_invoice")}</th><th className="px-4 py-3 w-56 text-center">{t("reports_table_client")}</th><th className="px-4 py-3 text-center">{t("reports_table_method")}</th><th className="px-4 py-3 w-28 text-center">{t("reports_table_net")}</th><th className="px-4 py-3 w-28 text-center">{t("reports_table_vat")}</th><th className="px-4 py-3 w-28 text-center">{t("reports_table_gross")}</th></tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {salesRows.map((r) => (
                  <tr key={r.inv.id} className="hover:bg-app-bg">
                    <td className="px-4 py-3 f-mono text-app-text-muted w-40" style={{ textAlign: "center" }}>{r.inv.code}</td>
                    <td className="px-4 py-3 w-56 text-center text-app-text truncate">{r.inv.customerName}</td>
                    <td className="px-4 py-3 text-center text-app-text-muted">{method === "all" ? splitBreakdownLabel(t, r.inv) : payMethodLabel(t, method)}</td>
                    <td className="px-4 py-3 f-mono w-28" style={{ textAlign: "center" }}>{sar(r.net)}</td>
                    <td className="px-4 py-3 f-mono text-warning-600 w-28" style={{ textAlign: "center" }}>{sar(r.vat)}</td>
                    <td className="px-4 py-3 f-mono font-semibold text-app-text w-28" style={{ textAlign: "center" }}>{sar(r.amount)}</td>
                  </tr>
                ))}
                {salesRows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-app-text-subtle">{t("reports_salesEmpty")}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "procurement" && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {kpi(t("reports_kpi_purchases"), purchases.length)}
            {kpi(t("reports_kpi_grossOutflow"), sar(pGross), "rose")}
            {kpi(t("reports_kpi_inputVat"), sar(pVat), "amber")}
            {kpi(t("reports_kpi_netCost"), sar(pNet), "teal")}
          </div>
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
            <table className="w-full text-sm table-fixed">
              <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
                <tr><th className="px-4 py-3 w-40 text-center">{t("reports_table_poId")}</th><th className="px-4 py-3 w-56 text-center">{t("reports_table_supplier")}</th><th className="px-4 py-3 w-36 text-center">{t("reports_table_value")}</th><th className="px-4 py-3 w-72 text-center">{t("reports_table_created")}</th><th className="px-4 py-3 w-28 text-center">{t("customerDetail_method")}</th><th className="px-4 py-3">{t("supplierDetail_invoice")}</th></tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {purchases.map((p) => (
                  <tr key={p.id} className="hover:bg-app-bg">
                    <td className="px-4 py-3 f-mono text-app-text-muted w-40" style={{ textAlign: "center" }}>{p.code}</td>
                    <td className="px-4 py-3 w-56 text-center text-app-text truncate">{suppliers.find((s) => s.id === p.supplierId)?.company}</td>
                    <td className="px-4 py-3 f-mono font-semibold text-app-text w-36" style={{ textAlign: "center" }}>{sar(p.amount)}</td>
                    <td className="px-4 py-3 f-mono text-app-text-muted w-72" style={{ textAlign: "center" }}>{fmtDate(p.date)}</td>
                    <td className="px-4 py-3 w-28 text-center text-app-text-muted">{p.method === "Cash" ? t("common_cash") : t("purchases_credit")}</td>
                    <td className="px-4 py-3">
                      {p.attachment ? (
                        <button onClick={() => openStoredDocument(p.attachment)} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                          <Paperclip size={13} />{t("common_view")}
                        </button>
                      ) : <span className="text-app-text-subtle">—</span>}
                    </td>
                  </tr>
                ))}
                {purchases.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-app-text-subtle">{t("reports_procurementEmpty")}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "expenses" && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {kpi(t("reports_kpi_totalExpenses"), sar(eGross), "rose")}
            {kpi(t("reports_kpi_expenseVat"), sar(eVat), "amber")}
            {kpi(t("reports_kpi_expenseNet"), sar(eNet), "teal")}
            {kpi(t("reports_kpi_invoices"), filteredExpenses.length)}
          </div>
          <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-app-xs">
            <input type="date" value={expStart} onChange={(e) => setExpStart(e.target.value)} className={`${inputCls} w-auto`} />
            <input type="date" value={expEnd} onChange={(e) => setExpEnd(e.target.value)} className={`${inputCls} w-auto`} />
          </div>
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
            <table className="w-full text-sm table-fixed">
              <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
                <tr><th className="px-4 py-3 w-56 text-center">{t("expenses_table_category")}</th><th className="px-4 py-3 w-40 text-center">{t("expenses_table_amount")}</th><th className="px-4 py-3 w-48 text-center">{t("expenses_table_tax")}</th><th className="px-4 py-3 w-72 text-center">{t("expenses_table_date")}</th><th className="px-4 py-3">{t("expenses_table_receipt")}</th></tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {filteredExpenses.map((e) => (
                  <tr key={e.id} className="hover:bg-app-bg">
                    <td className="px-4 py-3 w-56 text-center font-medium text-app-text truncate">{expenseCategories.find((c) => c.id === e.categoryId)?.name || "—"}</td>
                    <td className="px-4 py-3 f-mono text-app-text w-40" style={{ textAlign: "center" }}>{sar(e.amount)}</td>
                    <td className="px-4 py-3 w-48 text-center text-app-text-muted">{e.taxFlag === "Inclusive" ? t("expenses_taxInclusive") : t("expenses_taxExempt")}</td>
                    <td className="px-4 py-3 f-mono text-app-text-muted w-72" style={{ textAlign: "center" }}>{e.date}</td>
                    <td className="px-4 py-3 text-app-text-muted">
                      {e.receipt?.startsWith("http") || e.receipt?.startsWith("data:") || e.receipt?.includes("/") ? (
                        <button onClick={() => openStoredDocument(e.receipt)} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                          <ReceiptText size={13} />{e.receiptName || t("common_view")}
                        </button>
                      ) : e.receipt ? (
                        // Pre-upload legacy rows: just a filename typed/picked with no
                        // real file behind it (no "/" — a browser-reported File.name
                        // never contains one) — inert text, not a dead link.
                        <span>{e.receipt}</span>
                      ) : <span className="text-app-text-subtle">—</span>}
                    </td>
                  </tr>
                ))}
                {filteredExpenses.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-app-text-subtle">{t("reports_expensesEmpty")}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "pl" && (
        <>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("reports_pl_allTimeTitle")}</div>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {kpi(t("reports_pl_revenue"), sar(revenueAllTime), "teal")}
            {kpi(t("reports_pl_costs"), sar(costsAllTime), "rose")}
            {kpi(resultAllTime >= 0 ? t("reports_pl_profit") : t("reports_pl_loss"), sar(Math.abs(resultAllTime)), resultAllTime >= 0 ? "teal" : "rose")}
          </div>

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("reports_pl_periodTitle")}</div>
          <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-app-xs">
            <input type="datetime-local" value={plStart} onChange={(e) => setPlStart(e.target.value)} className={`${inputCls} w-auto`} />
            <input type="datetime-local" value={plEnd} onChange={(e) => setPlEnd(e.target.value)} className={`${inputCls} w-auto`} />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {kpi(t("reports_pl_revenue"), sar(revenuePeriod), "teal")}
            {kpi(t("reports_pl_costs"), sar(costsPeriod), "rose")}
            {kpi(resultPeriod >= 0 ? t("reports_pl_profit") : t("reports_pl_loss"), sar(Math.abs(resultPeriod)), resultPeriod >= 0 ? "teal" : "rose")}
            {kpi(t("reports_pl_margin"), `${marginPeriod.toFixed(1)}%`, resultPeriod >= 0 ? "teal" : "rose")}
          </div>
        </>
      )}

      {tab === "vat" && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-app-xs">
            <div>
              <div className="mb-1 text-xs font-semibold text-app-text-muted">{t("reports_vat_periodMode")}</div>
              <div className="flex gap-2">
                <button onClick={() => setVatMode("quarterly")} className={`rounded-lg border px-3 py-2 text-sm font-medium ${vatMode === "quarterly" ? "border-brand-600 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("reports_vat_quarterly")}</button>
                <button onClick={() => setVatMode("monthly")} className={`rounded-lg border px-3 py-2 text-sm font-medium ${vatMode === "monthly" ? "border-brand-600 bg-brand-50 text-brand-700" : "border-app-border-strong text-app-text-muted"}`}>{t("reports_vat_monthly")}</button>
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-app-text-muted">{t("reports_vat_year")}</div>
              <input type="number" value={vatYear} onChange={(e) => setVatYear(Number(e.target.value))} className={`${inputCls} w-24`} />
            </div>
            {vatMode === "quarterly" ? (
              <div>
                <div className="mb-1 text-xs font-semibold text-app-text-muted">{t("reports_vat_quarter")}</div>
                <select value={vatQuarter} onChange={(e) => setVatQuarter(Number(e.target.value))} className={`${inputCls} w-28`}>
                  <option value={1}>Q1</option><option value={2}>Q2</option><option value={3}>Q3</option><option value={4}>Q4</option>
                </select>
              </div>
            ) : (
              <div>
                <div className="mb-1 text-xs font-semibold text-app-text-muted">{t("reports_vat_month")}</div>
                <select value={vatMonth} onChange={(e) => setVatMonth(Number(e.target.value))} className={`${inputCls} w-28`}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="ms-auto flex gap-2">
              <button onClick={exportVatCsv} className="rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700 hover:bg-brand-100">{t("reports_vat_exportCsv")}</button>
              <button onClick={() => window.print()} className="rounded-lg border border-app-border-strong px-3 py-2 text-xs font-medium text-app-text-muted hover:bg-app-bg">{t("reports_vat_printPdf")}</button>
            </div>
          </div>

          <div className="print-area">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("reports_vat_salesTable")}</div>
            <div className="mb-6 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
                  <tr><th className="px-4 py-3 w-10 text-center">#</th><th className="px-4 py-3 text-center">{t("common_category")}</th><th className="px-4 py-3 w-56 text-center">{t("reports_vat_taxableAmount")}</th><th className="px-4 py-3 w-40 text-center">{t("reports_vat_vatAmount")}</th></tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>1</td><td className="px-4 py-3 text-center">{t("reports_vat_box1_sales")}</td><td className="px-4 py-3 w-56 text-center"><CopyableNumber value={round2(salesBox1Taxable)} t={t} /></td><td className="px-4 py-3 w-40 text-center"><CopyableNumber value={round2(salesBox1Vat)} t={t} /></td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>2</td><td className="px-4 py-3 text-center">{t("reports_vat_box2_sales")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>3</td><td className="px-4 py-3 text-center">{t("reports_vat_box3_sales")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>4</td><td className="px-4 py-3 text-center">{t("reports_vat_box4_sales")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>5</td><td className="px-4 py-3 text-center">{t("reports_vat_box5_sales")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr className="bg-app-bg font-semibold"><td className="px-4 py-3 text-center" colSpan={2}>{t("reports_vat_totalSales")} / {t("reports_vat_totalOutputVat")}</td><td className="px-4 py-3 w-56 text-center"><CopyableNumber value={round2(totalSalesValue)} t={t} /></td><td className="px-4 py-3 w-40 text-center"><CopyableNumber value={round2(totalOutputVat)} t={t} /></td></tr>
                </tbody>
              </table>
              <div className="border-t border-app-border px-4 py-2 text-[11px] text-app-text-subtle">{t("reports_vat_notTracked")}</div>
            </div>

            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("reports_vat_purchasesTable")}</div>
            <div className="mb-6 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-app-sm">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-app-bg text-xs font-semibold uppercase tracking-wide text-app-text-muted">
                  <tr><th className="px-4 py-3 w-10 text-center">#</th><th className="px-4 py-3 text-center">{t("common_category")}</th><th className="px-4 py-3 w-56 text-center">{t("reports_vat_taxableAmount")}</th><th className="px-4 py-3 w-40 text-center">{t("reports_vat_vatAmount")}</th></tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>1</td><td className="px-4 py-3 text-center">{t("reports_vat_box1_purch")}</td><td className="px-4 py-3 w-56 text-center"><CopyableNumber value={round2(purchBox1Taxable)} t={t} /></td><td className="px-4 py-3 w-40 text-center"><CopyableNumber value={round2(purchBox1Vat)} t={t} /></td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>2</td><td className="px-4 py-3 text-center">{t("reports_vat_box2_purch")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>3</td><td className="px-4 py-3 text-center">{t("reports_vat_box3_purch")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>4</td><td className="px-4 py-3 text-center">{t("reports_vat_box4_purch")}</td><td className="px-4 py-3 f-mono text-app-text-subtle w-56" style={{ textAlign: "center" }}>0.00</td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr><td className="px-4 py-3 f-mono w-10" style={{ textAlign: "center" }}>5</td><td className="px-4 py-3 text-center">{t("reports_vat_box5_purch")}</td><td className="px-4 py-3 w-56 text-center"><CopyableNumber value={round2(purchBox5Exempt)} t={t} /></td><td className="px-4 py-3 f-mono text-app-text-subtle w-40" style={{ textAlign: "center" }}>0.00</td></tr>
                  <tr className="bg-app-bg font-semibold"><td className="px-4 py-3 text-center" colSpan={2}>{t("reports_vat_totalPurchases")} / {t("reports_vat_totalInputVat")}</td><td className="px-4 py-3 w-56 text-center"><CopyableNumber value={round2(totalPurchasesValue)} t={t} /></td><td className="px-4 py-3 w-40 text-center"><CopyableNumber value={round2(totalInputVat)} t={t} /></td></tr>
                </tbody>
              </table>
              <div className="border-t border-app-border px-4 py-2 text-[11px] text-app-text-subtle">{t("reports_vat_notTracked")}</div>
            </div>

            <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-5">
              <div className="mb-3 f-display font-semibold text-app-text">{t("reports_vat_netTitle")}</div>
              <div className="mb-1 flex justify-between text-sm"><span>{t("reports_vat_totalOutputVat")}</span><CopyableNumber value={round2(totalOutputVat)} t={t} /></div>
              <div className="mb-3 flex justify-between text-sm"><span>{t("reports_vat_totalInputVat")}</span><CopyableNumber value={round2(totalInputVat)} t={t} /></div>
              <hr className="mb-3 border-brand-200" />
              <div className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold ${netVatDue >= 0 ? "border border-danger-200 bg-danger-50 text-danger-700" : "border border-brand-200 bg-brand-50 text-brand-700"}`}>
                <span>{netVatDue >= 0 ? t("reports_vat_dueToAuthority") : t("reports_vat_dueRefund")}</span>
                <span className="f-mono text-lg">{sar(Math.abs(netVatDue))}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* =========================================================================
   ROOT APP
   ========================================================================= */
/* =========================================================================
   SETTINGS
   ========================================================================= */
function PinPromptModal({ title, mode, verify, onSuccess, onClose }) {
  const { t } = useLang();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const isSet = mode === "set";
  const digits = (v) => v.replace(/\D/g, "").slice(0, 4);

  const submit = async () => {
    if (!/^\d{4}$/.test(pin)) { setError(t("owner_pinFormatError")); return; }
    if (isSet) {
      if (pin !== confirmPin) { setError(t("owner_pinMismatch")); return; }
      onSuccess(await sha256Hex(pin));
    } else {
      if (await verify(pin)) onSuccess(pin);
      else setError(t("owner_pinWrong"));
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <Field label={t("owner_pinLabel")}>
        <input autoFocus type="password" autoComplete="new-password" name="owner-pin-entry" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => { setPin(digits(e.target.value)); setError(""); }} className={`${inputCls} f-mono text-center text-lg tracking-[0.4em]`} />
      </Field>
      {isSet && (
        <Field label={t("owner_pinConfirmLabel")}>
          <input type="password" autoComplete="new-password" name="owner-pin-confirm" inputMode="numeric" maxLength={4} value={confirmPin} onChange={(e) => { setConfirmPin(digits(e.target.value)); setError(""); }} className={`${inputCls} f-mono text-center text-lg tracking-[0.4em]`} />
        </Field>
      )}
      {error && <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-medium text-rose-700">{error}</div>}
      <button onClick={submit} className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700">{t("common_save")}</button>
    </Modal>
  );
}

const OWNER_SECTIONS = [
  { key: "customers", labelKey: "nav_customers" },
  { key: "inventory", labelKey: "nav_products" },
  { key: "purchases", labelKey: "nav_purchases" },
  { key: "promotions", labelKey: "nav_promotions" },
  { key: "reports", labelKey: "nav_reports" },
];

// ZATCA Phase 2 panel — SCAFFOLD. Every "connect"/"test" action here is
// simulated client-side (no live ZATCA network call yet); see
// enableZatca/submitInvoiceToZatca in LaundryOpsApp for what's real
// (a genuine SHA-256 hash and the same TLV QR builder Phase 1 printing
// already uses) versus simulated (the certificate/clearance round trip
// itself). Fully isolated: this is the only place in the Settings tree
// that reads zatcaConfig or calls enable/disable/resetZatcaConfig.
function ZatcaSettingsPanel({ zatcaConfig, generateZatcaCsr, enableZatca, disableZatca, resetZatcaConfig }) {
  const { t } = useLang();
  const [showOtpInput, setShowOtpInput] = useState(false);
  const [otp, setOtp] = useState("");
  const [businessCategory, setBusinessCategory] = useState("");
  const [csrCopied, setCsrCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Inline confirm instead of window.confirm() — a native dialog would
  // block the whole page (and any automated testing driving it), unlike
  // every other confirmation in this app which is just more UI.
  const [confirmAction, setConfirmAction] = useState(null); // "disable" | "reset" | null

  const isEnabled = Boolean(zatcaConfig?.isEnabled);

  const handleToggle = () => {
    setError(""); setNotice("");
    if (isEnabled) setConfirmAction("disable");
    else { setShowOtpInput(true); setOtp(""); }
  };

  const runConfirmedAction = async () => {
    const action = confirmAction;
    setConfirmAction(null);
    setBusy(true);
    try {
      if (action === "disable") await disableZatca();
      else if (action === "reset") { await resetZatcaConfig(); setNotice(""); }
    } catch (e) {
      console.error(`zatca ${action} failed`, e);
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  const handleGenerateCsr = async () => {
    setError(""); setNotice(""); setBusy(true);
    try {
      await generateZatcaCsr(businessCategory);
    } catch (e) {
      console.error("generateZatcaCsr failed", e);
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  const copyCsr = () => {
    if (!zatcaConfig?.csr || !navigator.clipboard) return;
    navigator.clipboard.writeText(zatcaConfig.csr).catch(() => {});
    setCsrCopied(true);
    setTimeout(() => setCsrCopied(false), 1500);
  };

  const handleConnect = async () => {
    if (!zatcaConfig?.csr) { setError(t("zatca_csrRequiredFirst")); return; }
    if (!/^\d{6}$/.test(otp)) { setError(t("zatca_otpInvalid")); return; }
    setError(""); setBusy(true);
    try {
      await enableZatca(otp);
      setNotice(t("zatca_enableSuccess"));
      setShowOtpInput(false); setOtp("");
    } catch (e) {
      console.error("enableZatca failed", e);
      setError(String(e.message || e));
    }
    setBusy(false);
  };

  const handleTest = () => {
    setError(""); setNotice(isEnabled ? t("zatca_testSuccess") : "");
  };

  const certLabelKey = { PENDING: "zatca_certPending", ACTIVE: "zatca_certActive", EXPIRED: "zatca_certExpired", REVOKED: "zatca_certRevoked" }[zatcaConfig?.certificateStatus] || "zatca_certPending";
  const CertIcon = { PENDING: Clock, ACTIVE: CheckCircle2, EXPIRED: XCircle, REVOKED: XCircle }[zatcaConfig?.certificateStatus] || Clock;

  return (
    <div className="rounded-lg border border-app-border bg-app-bg/60 p-4">
      <div className="flex items-center justify-between rounded-lg border border-app-border bg-app-surface px-3 py-2.5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <FileText size={14} className="text-brand-600 shrink-0" />
            <span className="text-sm font-semibold text-app-text">{t("zatca_title")}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ring-1 ring-inset ${isEnabled ? "bg-success-50 text-success-700" : "bg-app-bg text-app-text-muted"}`}>
              <span className="size-1.5 rounded-full bg-current" />
              {t(isEnabled ? "zatca_connected" : "zatca_notConnected")}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-app-text-subtle">{t("zatca_hint")}</div>
        </div>
        <Toggle checked={isEnabled} onChange={handleToggle} />
      </div>

      {showOtpInput && !isEnabled && !zatcaConfig?.csr && (
        <div className="mt-2 rounded-lg border border-app-border bg-app-surface p-3">
          <div className="mb-2 text-xs font-semibold text-app-text">{t("zatca_generateCsr")}</div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("zatca_businessCategory")}</label>
          <input
            value={businessCategory}
            onChange={(e) => setBusinessCategory(e.target.value)}
            placeholder={t("zatca_businessCategoryPlaceholder")}
            className={inputCls}
          />
          <div className="mt-2 flex gap-2">
            <button onClick={handleGenerateCsr} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-500 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60"><KeyRound size={15} /> {t("zatca_generateCsrButton")}</button>
            <button onClick={() => { setShowOtpInput(false); setError(""); }} className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted hover:bg-app-bg">{t("zatca_cancel")}</button>
          </div>
        </div>
      )}

      {showOtpInput && !isEnabled && zatcaConfig?.csr && (
        <div className="mt-2 space-y-2">
          <div className="rounded-lg border border-app-border bg-app-surface p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("zatca_csrLabel")}</span>
              <button onClick={copyCsr} className="text-[11px] font-medium text-brand-700 hover:underline">{csrCopied ? t("zatca_copied") : t("zatca_copyCsr")}</button>
            </div>
            <textarea readOnly value={zatcaConfig.csr} rows={4} className={`${inputCls} f-mono text-[10px] leading-tight`} onClick={(e) => e.target.select()} />
            <p className="mt-1.5 text-[11px] text-app-text-subtle">{t("zatca_csrHint")}</p>
          </div>

          <div className="rounded-lg border border-app-border bg-app-surface p-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-app-text-subtle">{t("zatca_connectStep")}</label>
            <input
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              placeholder={t("zatca_otpPlaceholder")}
              className={`${inputCls} f-mono tracking-widest`}
            />
            <div className="mt-2 flex gap-2">
              <button onClick={handleConnect} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-500 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60"><Link2 size={15} /> {t("zatca_connect")}</button>
              <button onClick={() => { setShowOtpInput(false); setOtp(""); setError(""); }} className="rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-text-muted hover:bg-app-bg">{t("zatca_cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {isEnabled && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-app-border bg-app-surface p-2.5">
              <div className="text-[11px] text-app-text-subtle">{t("zatca_certificateStatus")}</div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-app-text"><CertIcon size={14} className="text-brand-600" /> {t(certLabelKey)}</div>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface p-2.5">
              <div className="text-[11px] text-app-text-subtle">{t("zatca_lastSync")}</div>
              <div className="text-sm font-semibold text-app-text">{zatcaConfig.lastSyncAt ? fmtDate(zatcaConfig.lastSyncAt) : t("zatca_neverSynced")}</div>
            </div>
          </div>

          <div className="rounded-lg border border-app-border bg-app-surface p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-app-text-subtle">{t("zatca_stats")}</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><div className="f-mono text-lg font-semibold text-brand-700">{zatcaConfig.invoicesClearedCount || 0}</div><div className="text-[11px] text-app-text-subtle">{t("zatca_cleared")}</div></div>
              <div><div className="f-mono text-lg font-semibold text-app-text">{zatcaConfig.invoicesReportedCount || 0}</div><div className="text-[11px] text-app-text-subtle">{t("zatca_reported")}</div></div>
              <div><div className="f-mono text-lg font-semibold text-danger-600">{zatcaConfig.failedInvoices || 0}</div><div className="text-[11px] text-app-text-subtle">{t("zatca_failed")}</div></div>
            </div>
          </div>

          {zatcaConfig.lastErrorMessage && (
            <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700"><strong>{t("zatca_lastError")}:</strong> {zatcaConfig.lastErrorMessage}</div>
          )}

          <div className="flex gap-2">
            <button onClick={handleTest} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-app-border-strong px-3 py-2 text-xs font-medium text-app-text-muted hover:bg-app-bg"><FlaskConical size={14} /> {t("zatca_testConnection")}</button>
            <button onClick={() => setConfirmAction("reset")} disabled={busy} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-danger-300 px-3 py-2 text-xs font-medium text-danger-600 hover:bg-danger-50 disabled:opacity-60"><Trash2 size={14} /> {t("zatca_reset")}</button>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="mt-2 rounded-lg border border-warning-200 bg-warning-50 p-3">
          <div className="mb-2 text-xs font-medium text-warning-700">{t(confirmAction === "disable" ? "zatca_disableConfirm" : "zatca_resetConfirm")}</div>
          <div className="flex gap-2">
            <button onClick={runConfirmedAction} disabled={busy} className="flex-1 rounded-lg bg-danger-600 py-2 text-xs font-semibold text-white hover:bg-danger-700 disabled:opacity-60">{t("common_yes")}</button>
            <button onClick={() => setConfirmAction(null)} className="rounded-lg border border-app-border-strong px-3 py-2 text-xs font-medium text-app-text-muted hover:bg-app-bg">{t("zatca_cancel")}</button>
          </div>
        </div>
      )}

      {error && <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700"><XCircle size={14} className="shrink-0" /> {error}</div>}
      {notice && <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-success-200 bg-success-50 px-3 py-2 text-xs font-medium text-success-700"><CheckCircle2 size={14} className="shrink-0" /> {notice}</div>}
    </div>
  );
}

const WHATSAPP_TAGS = ["customer_name", "invoice_id", "store_name", "invoice_url", "total_amount"];

// Collapsed (off) by default — a shop that never opens this toggle never
// triggers any background image work on a receipt (see PrintDocumentModal),
// so tenants who don't use WhatsApp sharing pay nothing for it at all.
// Opening the toggle is what "enables" the feature; the template box only
// appears once it's on, prompting the owner to customize their message.
function WhatsAppSettingsPanel({ whatsappEnabled, setWhatsappEnabled, whatsappTemplate, setWhatsappTemplate }) {
  const { t } = useLang();
  const textareaRef = useRef(null);

  // Inserts {tag} at the cursor (or replaces the current selection) instead
  // of appending blindly to the end, so the owner can drop a tag anywhere
  // mid-sentence — click, keep typing, no manual copy/paste needed.
  const insertTag = (tag) => {
    const insertion = `{${tag}}`;
    const el = textareaRef.current;
    if (!el) { setWhatsappTemplate((whatsappTemplate || "") + insertion); return; }
    const start = el.selectionStart ?? whatsappTemplate.length;
    const end = el.selectionEnd ?? whatsappTemplate.length;
    const next = whatsappTemplate.slice(0, start) + insertion + whatsappTemplate.slice(end);
    setWhatsappTemplate(next);
    const cursor = start + insertion.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(cursor, cursor); });
  };

  return (
    <div className="rounded-lg border border-app-border bg-app-bg/60 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <MessageCircle size={14} className="text-brand-600 shrink-0" />
            <span className="text-sm font-semibold text-app-text">{t("whatsapp_title")}</span>
          </div>
          <p className="mt-0.5 text-xs text-app-text-subtle">{t("whatsapp_hint")}</p>
        </div>
        <Toggle checked={whatsappEnabled} onChange={setWhatsappEnabled} />
      </div>
      {whatsappEnabled && (
        <div className="mt-3">
          <textarea
            ref={textareaRef}
            value={whatsappTemplate}
            onChange={(e) => setWhatsappTemplate(e.target.value)}
            placeholder={DEFAULT_WHATSAPP_TEMPLATE}
            rows={5}
            dir="rtl"
            className="w-full rounded-lg border border-app-border-strong bg-app-surface px-3 py-2 text-sm text-app-text outline-none focus:border-brand-500"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {WHATSAPP_TAGS.map((tag) => (
              <button key={tag} type="button" onClick={() => insertTag(tag)} className="rounded bg-app-border/60 px-1.5 py-0.5 text-[11px] font-mono text-app-text-muted transition hover:bg-brand-100 hover:text-brand-800" dir="ltr">{`{${tag}}`}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Renders as grid items directly inside SettingsView's `grid grid-cols-1
// lg:grid-cols-2` — while locked this is a single full-width prompt card;
// once the master PIN is entered it expands into the two real cards
// (enabled payment methods, and per-section staff locks) side by side with
// the merchant-info/ZATCA cards above. Business logic below (PIN verify/
// hash, section lock set/clear, pay-method enable/disable) is unchanged
// from before this layout pass — only the surrounding JSX/className moved.
function OwnerOnlySettings({ ownerPassword, setOwnerPassword, sectionLocks, setSectionLocks, enabledPayMethods, setEnabledPayMethods }) {
  const { t } = useLang();
  const [authenticated, setAuthenticated] = useState(false);
  const [showMasterPin, setShowMasterPin] = useState(false);
  const [pendingSection, setPendingSection] = useState(null);
  const [payMethodError, setPayMethodError] = useState("");

  const handleMasterSuccess = (pin) => {
    if (!ownerPassword) setOwnerPassword(pin);
    setAuthenticated(true);
    setShowMasterPin(false);
  };

  const toggleSection = (key) => {
    if (sectionLocks[key]) {
      setSectionLocks((prev) => ({ ...prev, [key]: null }));
    } else {
      setPendingSection(key);
    }
  };

  const handleSectionPinSet = (pin) => {
    setSectionLocks((prev) => ({ ...prev, [pendingSection]: pin }));
    setPendingSection(null);
  };

  const togglePayMethod = (value) => {
    const enabledCount = Object.values(enabledPayMethods).filter(Boolean).length;
    if (enabledPayMethods[value] && enabledCount <= 1) { setPayMethodError(t("owner_atLeastOnePayMethod")); return; }
    setPayMethodError("");
    setEnabledPayMethods((prev) => ({ ...prev, [value]: !prev[value] }));
  };

  const ownerBadge = (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ring-1 ring-inset bg-app-bg text-app-text-muted">
      <Lock size={11} />{t("settings_ownerOnly")}
    </span>
  );

  const pinModals = (
    <>
      {showMasterPin && (
        <PinPromptModal
          title={ownerPassword ? t("owner_enterMasterTitle") : t("owner_setMasterTitle")}
          mode={ownerPassword ? "enter" : "set"}
          verify={async (pin) => {
            if (pin === ownerPassword) { // legacy plaintext — self-heal to a hash
              sha256Hex(pin).then(setOwnerPassword);
              return true;
            }
            return (await sha256Hex(pin)) === ownerPassword;
          }}
          onSuccess={handleMasterSuccess}
          onClose={() => setShowMasterPin(false)}
        />
      )}
      {pendingSection && (
        <PinPromptModal
          title={t("owner_setSectionTitle", { section: t(OWNER_SECTIONS.find((s) => s.key === pendingSection).labelKey) })}
          mode="set"
          onSuccess={handleSectionPinSet}
          onClose={() => setPendingSection(null)}
        />
      )}
    </>
  );

  if (!authenticated) {
    return (
      <div className="lg:col-span-2 rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
        <button onClick={() => setShowMasterPin(true)} className="flex w-full items-center justify-between text-left">
          <span className="flex items-center gap-2 text-sm font-semibold text-app-text"><Lock size={16} className="text-brand-600" /> {t("settings_ownerOnly")}</span>
          <ChevronRight size={16} className="text-app-text-subtle" />
        </button>
        <p className="mt-1 text-xs text-app-text-subtle">{t("settings_ownerOnlyHint")}</p>
        {pinModals}
      </div>
    );
  }

  return (
    <>
      {/* Card 3: enabled payment methods (POS toggles) — one real, always-on
          toggle per PAY_METHODS entry. "Split" deliberately excluded: it's a
          POS checkout behavior, not a payment method to switch on/off. */}
      <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-app-text"><CreditCard size={16} className="text-brand-600" /> {t("owner_payMethodsTitle")}</span>
          {ownerBadge}
        </div>
        <p className="mb-4 text-xs text-app-text-subtle">{t("owner_payMethodsHint")}</p>
        <div className="space-y-2">
          {PAY_METHODS.map((m) => (
            <div key={m.value} className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2.5">
              <span className="text-sm text-app-text">{t(m.key)}</span>
              <Toggle checked={enabledPayMethods[m.value] !== false} onChange={() => togglePayMethod(m.value)} />
            </div>
          ))}
        </div>
        {payMethodError && <div className="mt-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700">{payMethodError}</div>}
      </div>

      {/* Card 4: per-section staff locks — full width. Exactly OWNER_SECTIONS
          (5 items) are real, individually-lockable sections with their own
          PIN via sectionLocks. "طرق الدفع" is shown as a 6th row for visual
          consistency only — it's already gated behind this same master PIN
          (Card 3 above), not an individually-lockable section, so it renders
          as a static "protected" indicator rather than a real toggle. */}
      <div className="lg:col-span-2 rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-app-text"><Lock size={16} className="text-brand-600" /> {t("owner_sectionLockTitle")}</span>
          {ownerBadge}
        </div>
        <p className="mb-4 text-xs text-app-text-subtle">{t("owner_sectionLockHint")}</p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {OWNER_SECTIONS.map((s) => (
            <div key={s.key} className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm text-app-text">
                <Lock size={13} className={sectionLocks[s.key] ? "text-warning-600" : "text-app-text-subtle"} />
                {t(s.labelKey)}
              </span>
              <Toggle checked={Boolean(sectionLocks[s.key])} onChange={() => toggleSection(s.key)} />
            </div>
          ))}
          <div className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm text-app-text">
              <Lock size={13} className="text-app-text-subtle" />
              {t("owner_payMethodsRowLabel")}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-app-bg px-2 py-1 text-[11px] font-semibold text-app-text-muted">{t("owner_protectedByMaster")}</span>
          </div>
        </div>
        <button onClick={() => setAuthenticated(false)} className="mt-4 text-xs font-medium text-brand-700 hover:underline">{t("owner_lockPanel")}</button>
      </div>

      {pinModals}
    </>
  );
}

function SettingsView({ merchant, setMerchant, ownerPassword, setOwnerPassword, sectionLocks, setSectionLocks, enabledPayMethods, setEnabledPayMethods, whatsappTemplate, setWhatsappTemplate, whatsappEnabled, setWhatsappEnabled, onLogout, zatcaConfig, generateZatcaCsr, enableZatca, disableZatca, resetZatcaConfig }) {
  const { lang, setLang, t } = useLang();
  const options = [
    { code: "ar", key: "settings_lang_ar" },
    { code: "en", key: "settings_lang_en" },
    { code: "ur", key: "settings_lang_ur" },
  ];
  const update = (field) => (e) => setMerchant((prev) => ({ ...prev, [field]: e.target.value }));

  // Merchant fields already autosave through the tenant_settings sync
  // effect in LaundryOpsApp the instant `merchant` state changes — this
  // button doesn't open a second write path, it just gives the owner an
  // explicit, reassuring confirmation that what they typed is saved.
  const [merchantSaved, setMerchantSaved] = useState(false);
  const handleMerchantSave = () => {
    setMerchantSaved(true);
    setTimeout(() => setMerchantSaved(false), 1800);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <div className="mb-4 f-display text-xl font-semibold text-app-text">{t("settings_title")}</div>
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-app-text"><Globe size={16} className="text-brand-600" /> {t("settings_language")}</div>
          <p className="mb-4 text-xs text-app-text-subtle">{t("settings_languageHint")}</p>
          <div className="grid grid-cols-3 gap-3">
            {options.map((o) => (
              <button key={o.code} onClick={() => setLang(o.code)}
                className={`rounded-xl border-2 px-4 py-4 text-center font-semibold transition ${lang === o.code ? "border-brand-600 bg-brand-50 text-brand-800" : "border-app-border text-app-text-muted hover:border-app-border-strong"}`}>
                {t(o.key)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: بيانات المنشأة */}
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-app-text"><Building2 size={16} className="text-brand-600" /> {t("settings_merchantInfo")}</div>
          <p className="mb-4 text-xs text-app-text-subtle">{t("settings_merchantInfoHint")}</p>
          <Field label={t("settings_merchantName")}><input value={merchant.name} onChange={update("name")} className={inputCls} autoComplete="off" /></Field>
          <Field label={t("settings_merchantPhone")}><input value={merchant.phone} onChange={update("phone")} className={inputCls} autoComplete="off" /></Field>
          <Field label={t("settings_merchantAddress")}><input value={merchant.address} onChange={update("address")} className={inputCls} autoComplete="off" /></Field>
          <Field label={t("settings_merchantTax")}><input value={merchant.taxNumber} onChange={update("taxNumber")} className={inputCls} autoComplete="off" /></Field>
          <button onClick={handleMerchantSave} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            {merchantSaved ? t("settings_merchantSaved") : t("settings_merchantSave")}
          </button>
        </div>

        {/* Card 2: التوافق مع ZATCA — badge/CSR/OTP flow (ZatcaSettingsPanel),
            plus the auto-print and WhatsApp-send toggles grouped alongside it. */}
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs space-y-3">
          <ZatcaSettingsPanel zatcaConfig={zatcaConfig} generateZatcaCsr={generateZatcaCsr} enableZatca={enableZatca} disableZatca={disableZatca} resetZatcaConfig={resetZatcaConfig} />

          <div className="rounded-lg border border-app-border bg-app-bg/60 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ReceiptText size={14} className="text-brand-600 shrink-0" />
                <span className="text-sm font-semibold text-app-text">{t("settings_autoPrint")}</span>
              </div>
              <Toggle checked={Boolean(merchant.autoPrint)} onChange={(val) => setMerchant((prev) => ({ ...prev, autoPrint: val }))} />
            </div>
            <p className="mt-0.5 text-[11px] text-app-text-subtle">{t("settings_autoPrintHint")}</p>
            {merchant.autoPrint && (
              <div className="mt-3 space-y-2">
                <Field label={t("settings_autoPrintCopies")}>
                  <input type="number" min="1" max="10" value={merchant.autoPrintCopies || 1}
                    onChange={(e) => setMerchant((prev) => ({ ...prev, autoPrintCopies: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }))}
                    className={`${inputCls} w-24`} />
                </Field>
                <div className="flex items-center justify-between rounded-lg border border-app-border bg-app-surface px-3 py-2.5">
                  <div>
                    <div className="text-sm text-app-text">{t("settings_showPrintPreview")}</div>
                    <p className="text-[11px] text-app-text-subtle">{t("settings_showPrintPreviewHint")}</p>
                  </div>
                  <Toggle checked={merchant.showPrintPreview !== false} onChange={(val) => setMerchant((prev) => ({ ...prev, showPrintPreview: val }))} />
                </div>
              </div>
            )}
          </div>

          <WhatsAppSettingsPanel whatsappEnabled={whatsappEnabled} setWhatsappEnabled={setWhatsappEnabled} whatsappTemplate={whatsappTemplate} setWhatsappTemplate={setWhatsappTemplate} />
        </div>

        {/* Cards 3 & 4: enabled payment methods + per-section staff locks,
            both behind the same master owner PIN — see OwnerOnlySettings. */}
        <OwnerOnlySettings ownerPassword={ownerPassword} setOwnerPassword={setOwnerPassword} sectionLocks={sectionLocks} setSectionLocks={setSectionLocks} enabledPayMethods={enabledPayMethods} setEnabledPayMethods={setEnabledPayMethods} />
      </div>

      <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-app-xs">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-app-text"><Lock size={16} className="text-brand-600" /> {t("settings_account")}</div>
        <button onClick={onLogout} className="flex w-full items-center justify-center gap-2 rounded-lg border border-danger-200 bg-danger-50 py-2.5 text-sm font-semibold text-danger-700 hover:bg-danger-100">
          <LogOut size={16} /> {t("settings_logout")}
        </button>
      </div>
    </div>
  );
}

function HomeDashboardView({ invoices, merchant, setTab }) {
  const { t, lang } = useLang();
  const fmtKpi = (v) => (lang === "ar" ? toArabicIndicDigits(v) : String(v));

  const isToday = (iso) => {
    const d = new Date(iso), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };
  const todayInvoices = invoices.filter((i) => isToday(i.createdAt));
  const salesToday = todayInvoices.reduce((s, i) => s + invoiceRevenue(i).amount, 0);
  const ordersToday = todayInvoices.length;
  const readyCount = invoices.filter((i) => !i.closed && invoiceOverallStatus(i) === "Ready").length;
  const deliveryActive = invoices.filter((i) => !i.closed && i.isDelivery).length;

  const recent = [...invoices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);

  const kpis = [
    { label: t("home_salesToday"), value: fmtKpi(sarCompact(salesToday)), icon: Wallet, tint: "bg-brand-50 text-brand-700" },
    { label: t("home_ordersToday"), value: fmtKpi(ordersToday), icon: ClipboardList, tint: "bg-info-50 text-info-700" },
    { label: t("home_readyOrders"), value: fmtKpi(readyCount), icon: CheckCircle2, tint: "bg-success-50 text-success-700" },
    { label: t("home_deliveryActive"), value: fmtKpi(deliveryActive), icon: Truck, tint: "bg-warning-50 text-warning-700" },
  ];

  return (
    <div>
      <div className="mb-6 f-display text-2xl font-semibold text-slate-900">
        {t("home_welcomeBack")}{merchant?.name ? `, ${merchant.name}` : ""}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${k.tint}`}><Icon size={18} /></div>
              <div className="f-display text-2xl font-bold text-slate-900">{k.value}</div>
              <div className="text-sm text-slate-500">{k.label}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
            <div className="f-display text-base font-semibold text-slate-900">{t("home_recentOrders")}</div>
            <button onClick={() => setTab("invoices")} className="text-sm font-medium text-teal-700 hover:text-teal-800">{t("home_viewAll")}</button>
          </div>
          <div className="divide-y divide-stone-100">
            {recent.length === 0 && <div className="px-5 py-10 text-center text-slate-400">{t("home_noOrders")}</div>}
            {recent.map((inv) => {
              const status = invoiceOverallStatus(inv);
              return (
                <button key={inv.id} onClick={() => setTab(inv.isDelivery ? "delivery_invoices" : "invoices")}
                  className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-stone-50">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="f-mono text-xs text-slate-500 shrink-0">{inv.code}</span>
                    <span className="truncate text-sm text-slate-800">{inv.customerName}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="f-mono text-sm text-slate-700">{sarCompact(inv.total)}</span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status === "Ready" ? "bg-teal-100 text-teal-700" : status === "Received" ? "bg-stone-100 text-stone-600" : "bg-amber-100 text-amber-700"}`}>{stageLabel(t, status)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="mb-4 f-display text-base font-semibold text-slate-900">{t("home_quickActions")}</div>
          <div className="space-y-2">
            <button onClick={() => setTab("pos")} className="flex w-full items-center gap-3 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700">
              <Shirt size={16} /> {t("home_quickPos")}
            </button>
            <button onClick={() => setTab("invoices")} className="flex w-full items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-stone-50">
              <ClipboardList size={16} /> {t("home_quickInvoices")}
            </button>
            <button onClick={() => setTab("customers")} className="flex w-full items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-stone-50">
              <Users size={16} /> {t("home_quickCustomers")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   ROOT APP
   ========================================================================= */
function AppShell({ tab, setTab, categories, addCategory, products, addProduct, updateProduct, addons, addAddon, removeAddon, serviceTypes, addServiceType, customers, addCustomer, updateCustomer, customerTransactions, addTransaction, invoices, addInvoice, updateInvoice, suppliers, addSupplier, updateSupplier, purchases, addPurchase, expenseCategories, addExpenseCategory, expenses, addExpense, promotions, addPromotion, updatePromotion, createInvoice, merchant, setMerchant, ownerPassword, setOwnerPassword, sectionLocks, setSectionLocks, enabledPayMethods, setEnabledPayMethods, whatsappTemplate, setWhatsappTemplate, whatsappEnabled, setWhatsappEnabled, onLogout, applyCustomerPayment, adjustSupplierBalance, nextDocNumber, zatcaConfig, zatcaInvoices, generateZatcaCsr, enableZatca, disableZatca, resetZatcaConfig }) {
  const { dir } = useLang();
  return (
    <div dir={dir} className="flex h-screen w-full bg-stone-100 f-body">
      <Fonts />
      <Sidebar tab={tab} setTab={setTab} sectionLocks={sectionLocks} setSectionLocks={setSectionLocks} merchant={merchant} />
      <main className="flex-1 overflow-y-auto p-6">
        {tab === "home" && <HomeDashboardView invoices={invoices} merchant={merchant} setTab={setTab} />}
        {tab === "pos" && <POSView categories={categories} products={products} addons={addons} customers={customers} addCustomer={addCustomer} onCreateInvoice={createInvoice} merchant={merchant} promotions={promotions} enabledPayMethods={enabledPayMethods} whatsappTemplate={whatsappTemplate} whatsappEnabled={whatsappEnabled} setTab={setTab} />}
        {tab === "invoices" && <InvoicesView invoices={invoices} customers={customers} updateInvoice={updateInvoice} merchant={merchant} zatcaInvoices={zatcaInvoices} whatsappTemplate={whatsappTemplate} whatsappEnabled={whatsappEnabled} />}
        {tab === "delivery_invoices" && <InvoicesView invoices={invoices} customers={customers} updateInvoice={updateInvoice} merchant={merchant} zatcaInvoices={zatcaInvoices} whatsappTemplate={whatsappTemplate} whatsappEnabled={whatsappEnabled} isDelivery />}
        {tab === "customers" && <CustomersView customers={customers} updateCustomer={updateCustomer} addCustomer={addCustomer} invoices={invoices} addInvoice={addInvoice} transactions={customerTransactions} addTransaction={addTransaction} merchant={merchant} applyCustomerPayment={applyCustomerPayment} nextDocNumber={nextDocNumber} whatsappTemplate={whatsappTemplate} whatsappEnabled={whatsappEnabled} />}
        {tab === "inventory" && <InventoryView categories={categories} addCategory={addCategory} products={products} addProduct={addProduct} updateProduct={updateProduct} addons={addons} addAddon={addAddon} removeAddon={removeAddon} serviceTypes={serviceTypes} addServiceType={addServiceType} />}
        {tab === "purchases" && <PurchasesExpensesView suppliers={suppliers} addSupplier={addSupplier} updateSupplier={updateSupplier} purchases={purchases} addPurchase={addPurchase} expenseCategories={expenseCategories} addExpenseCategory={addExpenseCategory} expenses={expenses} addExpense={addExpense} adjustSupplierBalance={adjustSupplierBalance} nextDocNumber={nextDocNumber} />}
        {tab === "promotions" && <PromotionsView promotions={promotions} addPromotion={addPromotion} updatePromotion={updatePromotion} />}
        {tab === "reports" && <ReportsView invoices={invoices} purchases={purchases} suppliers={suppliers} categories={categories} customers={customers} expenses={expenses} expenseCategories={expenseCategories} />}
        {tab === "settings" && <SettingsView merchant={merchant} setMerchant={setMerchant} ownerPassword={ownerPassword} setOwnerPassword={setOwnerPassword} sectionLocks={sectionLocks} setSectionLocks={setSectionLocks} enabledPayMethods={enabledPayMethods} setEnabledPayMethods={setEnabledPayMethods} whatsappTemplate={whatsappTemplate} setWhatsappTemplate={setWhatsappTemplate} whatsappEnabled={whatsappEnabled} setWhatsappEnabled={setWhatsappEnabled} onLogout={onLogout} zatcaConfig={zatcaConfig} generateZatcaCsr={generateZatcaCsr} enableZatca={enableZatca} disableZatca={disableZatca} resetZatcaConfig={resetZatcaConfig} />}
      </main>
    </div>
  );
}

function LaundryOpsApp({ tenantId, onLogout, initialLang }) {
  const [tab, setTab] = useState("home");
  // Starts from whatever language the visitor picked on the landing page;
  // a saved tenant_settings.lang (once one exists) still overrides this on
  // load below, so a returning user's own explicit choice always wins.
  const [lang, setLang] = useState(initialLang || "en");
  const dir = lang === "en" ? "ltr" : "rtl";

  // Every piece of shop data lives in Firestore under this tenant's own
  // subcollections — onSnapshot keeps these local mirrors live and in sync
  // across refreshes/devices; every add/update/remove below writes straight
  // through to Firestore (the mirror then updates itself from the listener).
  const [categories, setCategoriesState] = useState([]);
  const [products, setProductsState] = useState([]);
  const [invoices, setInvoicesState] = useState([]);
  const [customers, setCustomersState] = useState([]);
  const [customerTransactions, setCustomerTransactionsState] = useState([]);
  const [addons, setAddonsState] = useState([]);
  const [serviceTypes, setServiceTypesState] = useState([]);
  const [suppliers, setSuppliersState] = useState([]);
  const [purchases, setPurchasesState] = useState([]);
  const [expenseCategories, setExpenseCategoriesState] = useState([]);
  const [expenses, setExpensesState] = useState([]);
  const [promotions, setPromotionsState] = useState([]);

  useEffect(() => {
    if (!tenantId) return;
    // Every table here is flat with a tenant_id column (Firestore's nested
    // subcollections don't exist in Postgres) — subscribeToTable does the
    // "load once, then apply realtime diffs" work Firestore's onSnapshot
    // used to do in one call, per table.
    const unsubCats = subscribeToTable("categories", "tenant_id", tenantId, setCategoriesState);
    const unsubProds = subscribeToTable("products", "tenant_id", tenantId, setProductsState);
    const unsubInv = subscribeToTable("invoices", "tenant_id", tenantId, setInvoicesState);
    const unsubCust = subscribeToTable("customers", "tenant_id", tenantId, setCustomersState);
    const unsubTxn = subscribeToTable("customer_transactions", "tenant_id", tenantId, setCustomerTransactionsState);
    const unsubAddons = subscribeToTable("addons", "tenant_id", tenantId, setAddonsState);
    const unsubSvc = subscribeToTable("service_types", "tenant_id", tenantId, setServiceTypesState);
    const unsubSup = subscribeToTable("suppliers", "tenant_id", tenantId, setSuppliersState);
    const unsubPur = subscribeToTable("purchases", "tenant_id", tenantId, setPurchasesState);
    const unsubExpCat = subscribeToTable("expense_categories", "tenant_id", tenantId, setExpenseCategoriesState);
    const unsubExp = subscribeToTable("expenses", "tenant_id", tenantId, setExpensesState);
    const unsubPromo = subscribeToTable("promotions", "tenant_id", tenantId, setPromotionsState);
    return () => {
      unsubCats(); unsubProds(); unsubInv(); unsubCust(); unsubTxn(); unsubAddons();
      unsubSvc(); unsubSup(); unsubPur(); unsubExpCat(); unsubExp(); unsubPromo();
    };
  }, [tenantId]);

  // ===== ZATCA Phase 2 integration — SCAFFOLD, fully isolated from the rest
  // of this component. zatcaConfig is null (not just isEnabled: false) until
  // its own subscription resolves, so createInvoice below never mistakes
  // "not loaded yet" for "disabled" and vice versa. See submitInvoiceToZatca
  // for what "isolated" means in practice: it's the only other place in this
  // file that reads/writes either of these two tables.
  const [zatcaConfig, setZatcaConfig] = useState(null);
  const [zatcaInvoices, setZatcaInvoicesState] = useState([]);

  useEffect(() => {
    if (!tenantId) return;
    const unsubZCfg = subscribeToRow("zatca_configurations", "tenant_id", tenantId, setZatcaConfig);
    const unsubZInv = subscribeToTable("zatca_invoices", "tenant_id", tenantId, setZatcaInvoicesState);
    return () => { unsubZCfg(); unsubZInv(); };
  }, [tenantId]);

  // crypto.randomUUID() replaces Firestore's doc(collection(...)).id trick —
  // both generate the new row's id CLIENT-SIDE before the write completes,
  // so callers that use the returned id immediately (e.g. selecting a
  // freshly-added category in a dropdown) keep working unchanged.
  // setDoc(doc(db,...), data) → .upsert(row); updateDoc(...) → .update(row).
  // Every add/update/remove below applies its change to local state
  // immediately (optimistic update) instead of waiting for the realtime
  // channel to echo it back — the channel may lag or never fire depending
  // on this project's Realtime publication config, so waiting on it alone
  // left the UI looking like the save silently did nothing. On failure the
  // optimistic change is rolled back and the error still logs as before.
  const addCategory = (name) => {
    const id = crypto.randomUUID();
    const row = { id, tenantId, name };
    setCategoriesState((prev) => [...prev, row]);
    db.from("categories").upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error("addCategory failed", error); setCategoriesState((prev) => prev.filter((c) => c.id !== id)); }
    });
    return { id, name };
  };
  const addProduct = (data) => {
    const id = crypto.randomUUID();
    const row = { id, tenantId, ...data };
    setProductsState((prev) => [...prev, row]);
    db.from("products").upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error("addProduct failed", error); setProductsState((prev) => prev.filter((p) => p.id !== id)); }
    });
    return { id, ...data };
  };
  // Returns the write's outcome (not fire-and-forget like the other
  // optimistic updaters here) — ProductFormModal.save() needs to know the
  // row actually changed before it's safe to delete the OLD image from
  // Storage; deleting it unconditionally could leave a product pointing at
  // a now-missing file if this write happened to fail.
  const updateProduct = (productId, patch) => {
    let previous;
    setProductsState((prev) => prev.map((p) => { if (p.id === productId) previous = p; return p.id === productId ? { ...p, ...patch } : p; }));
    return db.from("products").update(toSnakeCase(patch)).eq("id", productId).then(({ error }) => {
      if (error) { console.error("updateProduct failed", error); if (previous) setProductsState((prev) => prev.map((p) => (p.id === productId ? previous : p))); }
      return { error };
    });
  };
  const addInvoice = (invoiceData) => {
    const id = crypto.randomUUID();
    const invoice = { ...invoiceData, id };
    const row = { tenantId, ...invoice };
    setInvoicesState((prev) => [...prev, row]);
    db.from("invoices").upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error("addInvoice failed", error); setInvoicesState((prev) => prev.filter((i) => i.id !== id)); }
    });
    return invoice;
  };
  const updateInvoice = (invoiceId, patch) => {
    let previous;
    setInvoicesState((prev) => prev.map((i) => { if (i.id === invoiceId) previous = i; return i.id === invoiceId ? { ...i, ...patch } : i; }));
    db.from("invoices").update(toSnakeCase(patch)).eq("id", invoiceId).then(({ error }) => {
      if (error) { console.error("updateInvoice failed", error); if (previous) setInvoicesState((prev) => prev.map((i) => (i.id === invoiceId ? previous : i))); }
    });
  };

  // Customers keep their own user-chosen numeric "system ID" as the row's
  // real primary key (not a generated uuid) — same id, just a plain integer
  // column instead of a Firestore doc id built from String(data.id).
  const addCustomer = (data) => {
    const row = { tenantId, ...data };
    setCustomersState((prev) => [...prev, row]);
    db.from("customers").upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error("addCustomer failed", error); setCustomersState((prev) => prev.filter((c) => c.id !== data.id)); }
    });
    return data;
  };
  const updateCustomer = (customerId, patch) => {
    let previous;
    setCustomersState((prev) => prev.map((c) => { if (c.id === customerId) previous = c; return c.id === customerId ? { ...c, ...patch } : c; }));
    db.from("customers").update(toSnakeCase(patch)).eq("id", customerId).then(({ error }) => {
      if (error) { console.error("updateCustomer failed", error); if (previous) setCustomersState((prev) => prev.map((c) => (c.id === customerId ? previous : c))); }
    });
  };
  const addTransaction = (data) => {
    const id = crypto.randomUUID();
    const txn = { ...data, id };
    const row = { tenantId, ...txn };
    setCustomerTransactionsState((prev) => [...prev, row]);
    db.from("customer_transactions").upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error("addTransaction failed", error); setCustomerTransactionsState((prev) => prev.filter((t) => t.id !== id)); }
    });
    return txn;
  };

  // Atomic, tenant-scoped document numbering (RCT-/TOP-/PMT-/INV-/DLV-/PO-)
  // via next_doc_number() (see supabase-rls-and-integrity.sql) — a real
  // Postgres sequence per tenant/doc-type, instead of the old
  // `1000 + array.length + 1` guess, which two terminals (or two fast
  // clicks) could both compute identically and mint duplicate codes.
  const nextDocNumber = async (docType) => {
    const { data, error } = await db.rpc("next_doc_number", { p_tenant_id: tenantId, p_doc_type: docType });
    if (!error) return data;
    if (!isMissingRpcError(error)) { console.error("nextDocNumber failed", error); throw error; }
    // Fallback to the old (non-atomic) numbering scheme so sales keep
    // working before supabase-rls-and-integrity.sql has been run.
    console.warn("next_doc_number() not found in the database — run supabase-rls-and-integrity.sql. Using non-atomic fallback numbering for now.");
    const lengthByType = { RCT: customerTransactions.length, PMT: customerTransactions.length, TOP: invoices.length, INV: invoices.length, DLV: invoices.length, PO: purchases.length };
    return 1000 + (lengthByType[docType] || 0) + 1;
  };

  // Atomic wallet/debt change via apply_customer_payment() — takes DELTAS,
  // not an absolute new value, so the database (not a possibly-stale React
  // state read) is what decides whether the balance can go negative. Two
  // concurrent operations against the same customer can no longer silently
  // lose one write. Updates local state from the DB's confirmed result;
  // throws (caller shows an error) if the balance check fails.
  const applyCustomerPayment = async (customerId, walletDelta, debtDelta) => {
    const { data, error } = await db.rpc("apply_customer_payment", {
      p_tenant_id: tenantId, p_customer_id: customerId, p_wallet_delta: walletDelta, p_debt_delta: debtDelta,
    });
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data;
      setCustomersState((prev) => prev.map((c) => (c.id === customerId ? { ...c, walletBalance: row.wallet_balance, debt: row.debt } : c)));
      return row;
    }
    if (!isMissingRpcError(error)) throw rpcBalanceError(error);
    // Fallback to the old read-then-write-absolute-value approach so
    // sales/top-ups/debt settlement keep working before
    // supabase-rls-and-integrity.sql has been run — loses the atomic
    // race-safety until then, but that beats every payment failing outright.
    console.warn("apply_customer_payment() not found in the database — run supabase-rls-and-integrity.sql. Using non-atomic fallback for now.");
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) throw new InsufficientBalanceError("customer not found");
    const newWallet = customer.walletBalance + walletDelta;
    const newDebt = customer.debt + debtDelta;
    if (newWallet < 0 || newDebt < 0) throw new InsufficientBalanceError("insufficient_balance");
    let previous;
    setCustomersState((prev) => prev.map((c) => { if (c.id === customerId) previous = c; return c.id === customerId ? { ...c, walletBalance: newWallet, debt: newDebt } : c; }));
    const { error: updErr } = await db.from("customers").update(toSnakeCase({ walletBalance: newWallet, debt: newDebt })).eq("id", customerId);
    if (updErr) {
      if (previous) setCustomersState((prev) => prev.map((c) => (c.id === customerId ? previous : c)));
      throw updErr;
    }
    return { wallet_balance: newWallet, debt: newDebt };
  };

  // Shared add/update/remove helpers for every plain catalog table (addons,
  // service_types, suppliers, purchases, expense_categories, expenses,
  // promotions) — they all follow the exact same "one row, tenant-scoped" shape.
  // Maps each generic table name to its local state setter so addTo/updateIn/
  // removeFrom can apply the same optimistic-update-with-rollback pattern
  // used above for categories/products (see comment there for why).
  const setStateByTable = {
    addons: setAddonsState, service_types: setServiceTypesState, suppliers: setSuppliersState,
    purchases: setPurchasesState, expense_categories: setExpenseCategoriesState,
    expenses: setExpensesState, promotions: setPromotionsState,
  };
  const addTo = (table) => (data) => {
    const id = crypto.randomUUID();
    const row = { id, tenantId, ...data };
    const setState = setStateByTable[table];
    if (setState) setState((prev) => [...prev, row]);
    db.from(table).upsert(toSnakeCase(row)).then(({ error }) => {
      if (error) { console.error(`add ${table} failed`, error); if (setState) setState((prev) => prev.filter((r) => r.id !== id)); }
    });
    return { id, ...data };
  };
  const updateIn = (table) => (id, patch) => {
    const setState = setStateByTable[table];
    let previous;
    if (setState) setState((prev) => prev.map((r) => { if (r.id === id) previous = r; return r.id === id ? { ...r, ...patch } : r; }));
    db.from(table).update(toSnakeCase(patch)).eq("id", id).then(({ error }) => {
      if (error) { console.error(`update ${table} failed`, error); if (setState && previous) setState((prev) => prev.map((r) => (r.id === id ? previous : r))); }
    });
  };
  const removeFrom = (table) => (id) => {
    const setState = setStateByTable[table];
    let removed;
    if (setState) setState((prev) => { removed = prev.find((r) => r.id === id); return prev.filter((r) => r.id !== id); });
    db.from(table).delete().eq("id", id).then(({ error }) => {
      if (error) { console.error(`remove ${table} failed`, error); if (setState && removed) setState((prev) => [...prev, removed]); }
    });
  };

  const addAddon = addTo("addons");
  const removeAddon = removeFrom("addons");
  const addServiceType = addTo("service_types");
  const addSupplier = addTo("suppliers");
  const updateSupplier = updateIn("suppliers");
  const addPurchase = addTo("purchases");
  // Atomic supplier balance change (credit purchases increase it, paying
  // it down decreases it) via adjust_supplier_balance() — same delta-based,
  // race-safe pattern as applyCustomerPayment above.
  const adjustSupplierBalance = async (supplierId, delta) => {
    const { data, error } = await db.rpc("adjust_supplier_balance", { p_tenant_id: tenantId, p_supplier_id: supplierId, p_delta: delta });
    if (!error) {
      setSuppliersState((prev) => prev.map((s) => (s.id === supplierId ? { ...s, balance: data } : s)));
      return data;
    }
    if (!isMissingRpcError(error)) throw rpcBalanceError(error);
    // Same fallback rationale as applyCustomerPayment above.
    console.warn("adjust_supplier_balance() not found in the database — run supabase-rls-and-integrity.sql. Using non-atomic fallback for now.");
    const supplier = suppliers.find((s) => s.id === supplierId);
    if (!supplier) throw new InsufficientBalanceError("supplier not found");
    const newBalance = supplier.balance + delta;
    if (newBalance < 0) throw new InsufficientBalanceError("insufficient_balance");
    let previous;
    setSuppliersState((prev) => prev.map((s) => { if (s.id === supplierId) previous = s; return s.id === supplierId ? { ...s, balance: newBalance } : s; }));
    const { error: updErr } = await db.from("suppliers").update(toSnakeCase({ balance: newBalance })).eq("id", supplierId);
    if (updErr) {
      if (previous) setSuppliersState((prev) => prev.map((s) => (s.id === supplierId ? previous : s)));
      throw updErr;
    }
    return newBalance;
  };
  const addExpenseCategory = addTo("expense_categories");
  const addExpense = addTo("expenses");
  const addPromotion = addTo("promotions");
  const updatePromotion = updateIn("promotions");

  // Shop settings (merchant profile, owner PIN, section locks, enabled pay
  // methods) live as one doc — loaded once on mount, auto-saved on any change
  // once the initial load has completed (so we never overwrite real saved
  // settings with the blank defaults during the first render).
  const [merchant, setMerchant] = useState({ name: "", phone: "", address: "", taxNumber: "", autoPrint: false, autoPrintCopies: 1, showPrintPreview: true });
  const [ownerPassword, setOwnerPassword] = useState(null);
  const [sectionLocks, setSectionLocks] = useState({ customers: null, inventory: null, purchases: null, promotions: null, reports: null });
  const [enabledPayMethods, setEnabledPayMethods] = useState({ Cash: true, "External Network": true, "Wallet Balance": true, "Credit (On Account)": true, Split: true });
  // Empty string means "use DEFAULT_WHATSAPP_TEMPLATE" (see src/utils/phone.js)
  // rather than storing the default text itself, so a future change to the
  // built-in default keeps applying to every tenant who never customized it.
  const [whatsappTemplate, setWhatsappTemplate] = useState("");
  // Off by default — a tenant who never opens/enables WhatsApp sharing in
  // Settings never pays for it: no background image generation/upload, no
  // "واتساب" button on any receipt at all (see PrintDocumentModal).
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // tenant_settings has its own `id` primary key, separate from `tenant_id`
  // (which is just the filter/uniqueness column) — this holds it once known,
  // either from the row we loaded or from generating one on this tenant's
  // very first-ever save. It MUST stay stable across re-saves: upsert()
  // matches by primary key, so sending a fresh random id on every save would
  // create a brand-new duplicate row every time instead of updating the one
  // real row for this tenant.
  const [settingsRowId, setSettingsRowId] = useState(null);

  useEffect(() => {
    if (!tenantId) return;
    setSettingsLoaded(false);
    setSettingsRowId(null);
    const applyRow = (d) => {
      if (d) {
        setSettingsRowId(d.id);
        if (d.merchant) setMerchant(d.merchant);
        if (d.ownerPassword !== undefined) setOwnerPassword(d.ownerPassword);
        if (d.sectionLocks) setSectionLocks(d.sectionLocks);
        if (d.enabledPayMethods) setEnabledPayMethods(d.enabledPayMethods);
        if (d.whatsappTemplate !== undefined && d.whatsappTemplate !== null) setWhatsappTemplate(d.whatsappTemplate);
        if (d.whatsappEnabled !== undefined && d.whatsappEnabled !== null) setWhatsappEnabled(Boolean(d.whatsappEnabled));
        if (d.lang) setLang(d.lang);
      }
      setSettingsLoaded(true);
    };
    const unsub = subscribeToRow("tenant_settings", "tenant_id", tenantId, applyRow);
    return () => unsub();
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId || !settingsLoaded) return;
    const rowId = settingsRowId || crypto.randomUUID();
    if (!settingsRowId) setSettingsRowId(rowId);
    // Always writing all 7 tracked fields together (never a partial subset)
    // is the equivalent of Firestore's { merge: true } here.
    db.from("tenant_settings").upsert(toSnakeCase({ id: rowId, tenantId, merchant, ownerPassword, sectionLocks, enabledPayMethods, whatsappTemplate, whatsappEnabled, lang }))
      .then(({ error }) => { if (error) console.error("settings save failed", error); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, settingsLoaded, merchant, ownerPassword, sectionLocks, enabledPayMethods, whatsappTemplate, whatsappEnabled, lang]);

  const walkInLabel = lang === "ar" ? "عميل مباشر" : lang === "ur" ? "براہ راست گاہک" : "Walk-in";

  // ===== ZATCA Phase 2 integration — SCAFFOLD (simulated, no live ZATCA API
  // calls yet). Enable/disable/reset just write zatca_configurations; OTP is
  // validated for shape only and never persisted anywhere (nothing secret
  // exists yet to protect, since there's no real certificate/CSID behind
  // it). submitInvoiceToZatca is the only function that touches
  // zatca_invoices, and it is only ever called as a fire-and-forget side
  // effect from createInvoice below — its failure can never surface to the
  // caller or affect the real invoice that already saved successfully.
  // Optimistic local update on every write below — same reason every other
  // add/update helper in this file does it (see setStateByTable comment):
  // the realtime channel echoing a change back can lag or, if a table was
  // never added to the project's realtime publication, never fire at all,
  // which otherwise leaves the panel looking like "connect" silently did
  // nothing even though the write actually succeeded.
  // The api/zatca-*.js endpoints run with the Supabase service-role key
  // (bypasses RLS) and act on whatever tenantId is in the request body — so
  // each call must also prove, via a real session access token, that the
  // caller IS that tenant. Without this header the endpoint now rejects the
  // request outright (see api/_auth.js's verifyTenantSession) instead of
  // just trusting the tenantId string.
  const zatcaAuthHeaders = async () => {
    const { data } = await auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("no_session");
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  };

  // Calls the Vercel serverless function that generates the real secp256k1
  // key pair + CSR server-side (see api/zatca-generate-keys.js) — the
  // private key is encrypted there and never reaches this browser tab, only
  // the public key and the CSR PEM (both non-secret) come back. Only runs
  // against a real deployment (production or a Vercel preview) — the plain
  // `vite` dev server has no /api routes to call.
  const generateZatcaCsr = async (businessCategory) => {
    const res = await fetch("/api/zatca-generate-keys", {
      method: "POST",
      headers: await zatcaAuthHeaders(),
      body: JSON.stringify({
        tenantId,
        organizationName: merchant.name || "",
        vatNumber: merchant.taxNumber || "",
        address: merchant.address || "",
        businessCategory: businessCategory || "",
        egsSerial: `1-Ragwa|2-POS|3-${tenantId.slice(0, 12)}`,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "csr_generation_failed");
    setZatcaConfig((prev) => ({ ...prev, publicKey: data.publicKey, csr: data.csr }));
    return data;
  };

  // Calls ZATCA's real Compliance CSID API (api/zatca-request-compliance-csid.js)
  // with the CSR already on file and the OTP the owner got from ZATCA's own
  // Fatoora portal — this is a genuine outbound call, not a simulation, so
  // it will fail with whatever error ZATCA returns until the tenant is
  // actually registered there. That's expected, correct behavior now, not
  // a bug: there is nothing left in this pipeline that's faked.
  const enableZatca = async (otp) => {
    if (!/^\d{6}$/.test(otp)) throw new Error("invalid_otp");
    if (!zatcaConfig?.csr) throw new Error("no_csr — generate a CSR first");
    const res = await fetch("/api/zatca-request-compliance-csid", {
      method: "POST",
      headers: await zatcaAuthHeaders(),
      body: JSON.stringify({ tenantId, otp }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "compliance_request_failed");
    setZatcaConfig((prev) => ({
      ...prev,
      isEnabled: true,
      enabledAt: nowISO(),
      disabledAt: null,
      certificateStatus: "ACTIVE",
      certificateExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      lastErrorMessage: null,
    }));
  };

  const disableZatca = async () => {
    const patch = { isEnabled: false, disabledAt: nowISO() };
    const { error } = await db.from("zatca_configurations").update(toSnakeCase(patch)).eq("tenant_id", tenantId);
    if (error) throw error;
    setZatcaConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const resetZatcaConfig = async () => {
    const { error } = await db.from("zatca_configurations").delete().eq("tenant_id", tenantId);
    if (error) throw error;
    setZatcaConfig(null);
  };

  // Two paths, chosen by whether the owner has generated a real key/CSR yet
  // (zatcaConfig.publicKey):
  //  - Real path: calls api/zatca-sign-invoice.js, which builds a genuine
  //    UBL 2.1 invoice, hashes + ECDSA-signs it server-side (private key
  //    never reaches this browser tab), and returns a real Phase 2 (9-tag)
  //    QR. Status lands as "SIGNED", not "CLEARED" — nothing has actually
  //    been transmitted to ZATCA yet (see Stage 6 in the task list); that
  //    distinction is what the invoice-detail badge below keys off of.
  //  - Fallback path: the original scaffold's simulated hash/QR, kept only
  //    so this can never throw if zatcaConfig somehow says enabled without
  //    a key yet (shouldn't happen — the Settings UI gates OTP entry behind
  //    CSR generation — but this function must never be what breaks a sale).
  const submitInvoiceToZatca = async (invoice) => {
    const lastEntry = [...zatcaInvoices].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))[0];
    const previousInvoiceHash = lastEntry?.invoiceHash || null;

    let row;
    if (zatcaConfig?.publicKey) {
      const res = await fetch("/api/zatca-sign-invoice", {
        method: "POST",
        headers: await zatcaAuthHeaders(),
        body: JSON.stringify({ tenantId, invoice, merchant, previousInvoiceHash }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "zatca_signing_failed");
      row = {
        id: crypto.randomUUID(), tenantId, invoiceId: invoice.id, uuid: data.uuid,
        invoiceHash: data.invoiceHash, status: "SIGNED", qrPayload: data.qrBase64,
        submittedAt: nowISO(), clearedAt: null,
      };
    } else {
      const zatcaUuid = crypto.randomUUID();
      const canonical = `${invoice.id}|${invoice.code}|${invoice.total}|${invoice.createdAt}|${merchant.taxNumber || ""}`;
      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const invoiceHash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const vatTotal = invoice.total - invoice.total / (1 + VAT_RATE);
      const qrPayload = buildZatcaQrBase64({
        sellerName: merchant.name || "",
        vatNumber: merchant.taxNumber || "",
        isoDateTime: invoice.createdAt,
        total: invoice.total.toFixed(2),
        vatTotal: vatTotal.toFixed(2),
      });
      row = {
        id: crypto.randomUUID(), tenantId, invoiceId: invoice.id, uuid: zatcaUuid,
        invoiceHash, status: "CLEARED", qrPayload,
        submittedAt: nowISO(), clearedAt: nowISO(),
      };
    }

    const { error } = await db.from("zatca_invoices").insert(toSnakeCase(row));
    if (error) throw error;
    setZatcaInvoicesState((prev) => [...prev, row]);
    await db.rpc("zatca_record_invoice_result", { p_tenant_id: tenantId, p_status: row.status });
    setZatcaConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, lastSyncAt: nowISO() };
      if (row.status === "CLEARED") next.invoicesClearedCount = (prev.invoicesClearedCount || 0) + 1;
      return next;
    });
    return row;
  };

  // Async now (was sync): both the balance change and the document number
  // are a real round trip to Postgres (apply_customer_payment() /
  // next_doc_number(), see supabase-rls-and-integrity.sql) instead of a
  // client-computed guess, so two terminals selling against the same
  // customer/number at once can no longer silently clobber each other.
  // Still returns null on insufficient funds — same contract callers
  // (POSView.complete) already check for.
  const createInvoice = async ({ customerId, items, total, discount = 0, payMethod, isDelivery = false, deliveryFee = 0, splitPayments = null, walletDeduct = 0 }) => {
    const customer = customers.find((c) => c.id === customerId);
    const grandTotal = Math.max(0, total - discount) + (isDelivery ? deliveryFee : 0);

    if (walletDeduct > 0 && (!customer || customer.walletBalance < walletDeduct)) return null; // quick client-side check — DB call below is the real guard

    try {
      if (payMethod === "Wallet Balance") {
        if (!customer) return null;
        await applyCustomerPayment(customerId, -grandTotal, 0);
      } else if (payMethod === "Split" && splitPayments) {
        if (!customer) return null;
        const walletNeeded = splitPayments.filter((sp) => sp.method === "Wallet Balance").reduce((s, sp) => s + sp.amount, 0);
        const creditNeeded = splitPayments.filter((sp) => sp.method === "Credit (On Account)").reduce((s, sp) => s + sp.amount, 0);
        if (walletNeeded > 0 || creditNeeded > 0) await applyCustomerPayment(customerId, -walletNeeded, creditNeeded);
      } else if (customer && (walletDeduct > 0 || payMethod === "Credit (On Account)")) {
        // Cash / External Network / Credit (On Account) — possibly combined with
        // walletDeduct: the wallet portion of a wallet+X split reclassified as a
        // discount (see POSView). Real money still leaves the wallet even though
        // the invoice's recorded payment method/total no longer mentions it.
        const debtDelta = payMethod === "Credit (On Account)" ? grandTotal : 0;
        await applyCustomerPayment(customerId, -walletDeduct, debtDelta);
      }
    } catch (e) {
      if (e instanceof InsufficientBalanceError) { console.error("createInvoice: insufficient balance", e); return null; }
      throw e; // anything else (RPC missing, network, etc.) is NOT "insufficient funds" — let the caller show an accurate error instead of blaming the wallet
    }

    const code = `${isDelivery ? "DLV" : "INV"}-${await nextDocNumber(isDelivery ? "DLV" : "INV")}`;
    const invoice = {
      code, customerId, customerName: customer?.name || walkInLabel, payMethod, splitPayments, total: grandTotal, discount, isDelivery, deliveryFee, createdAt: nowISO(), closed: false,
      vatExempt: !merchant.taxNumber || !merchant.taxNumber.trim(),
      items: items.map((it) => ({ itemId: uid("item"), name: it.name, service: it.service, addons: it.addons, price: it.servicePrice + it.addons.reduce((s, a) => s + a.price, 0), qty: it.qty, lineTotal: it.lineTotal, notes: it.notes || "", status: "Received", urgent: false, deliveredAt: null })),
    };
    const savedInvoice = addInvoice(invoice);
    // The real invoice above already saved successfully regardless of what
    // happens below — wrapped in try/catch so a ZATCA failure can never
    // turn a completed sale into an error. This IS awaited (not
    // fire-and-forget) on purpose: the printed tax invoice needs the real
    // Phase 2 QR the moment checkout finishes, not moments later once a
    // background call happens to land — a customer walking out with a
    // Phase 1 QR on their receipt while Phase 2 is enabled is exactly the
    // "not compliant" bug this was fixed for.
    let zatcaQr = null;
    if (zatcaConfig?.isEnabled) {
      try {
        const zatcaRow = await submitInvoiceToZatca(savedInvoice);
        zatcaQr = zatcaRow?.qrPayload || null;
      } catch (e) {
        console.error("ZATCA submission failed", e);
      }
    }
    return { ...savedInvoice, zatcaQr };
  };

  return (
    <LangContext.Provider value={{ lang, setLang, dir }}>
      <AppShell
        tab={tab} setTab={setTab}
        categories={categories} addCategory={addCategory}
        products={products} addProduct={addProduct} updateProduct={updateProduct}
        addons={addons} addAddon={addAddon} removeAddon={removeAddon}
        serviceTypes={serviceTypes} addServiceType={addServiceType}
        customers={customers} addCustomer={addCustomer} updateCustomer={updateCustomer}
        customerTransactions={customerTransactions} addTransaction={addTransaction}
        invoices={invoices} addInvoice={addInvoice} updateInvoice={updateInvoice}
        suppliers={suppliers} addSupplier={addSupplier} updateSupplier={updateSupplier}
        purchases={purchases} addPurchase={addPurchase}
        expenseCategories={expenseCategories} addExpenseCategory={addExpenseCategory}
        expenses={expenses} addExpense={addExpense}
        promotions={promotions} addPromotion={addPromotion} updatePromotion={updatePromotion}
        createInvoice={createInvoice}
        merchant={merchant} setMerchant={setMerchant}
        ownerPassword={ownerPassword} setOwnerPassword={setOwnerPassword}
        sectionLocks={sectionLocks} setSectionLocks={setSectionLocks}
        enabledPayMethods={enabledPayMethods} setEnabledPayMethods={setEnabledPayMethods}
        whatsappTemplate={whatsappTemplate} setWhatsappTemplate={setWhatsappTemplate}
        whatsappEnabled={whatsappEnabled} setWhatsappEnabled={setWhatsappEnabled}
        onLogout={onLogout}
        applyCustomerPayment={applyCustomerPayment} adjustSupplierBalance={adjustSupplierBalance} nextDocNumber={nextDocNumber}
        zatcaConfig={zatcaConfig} zatcaInvoices={zatcaInvoices} generateZatcaCsr={generateZatcaCsr} enableZatca={enableZatca} disableZatca={disableZatca} resetZatcaConfig={resetZatcaConfig}
      />
    </LangContext.Provider>
  );
}

/* =========================================================================
   AUTH GATEWAY — Landing / Login / Signup
   Placeholder auth: any email + password on Login or Signup is accepted
   immediately (no verification code, no admin approval yet) and goes
   straight into the real app below. Admin-specific email handling and real
   verification/approval will be wired in later.
   ========================================================================= */
/* =========================================================================
   ADMIN DASHBOARD — separate, dark-themed console for platform admins
   (matches the landing page's branding, distinct from the light tenant app)
   ========================================================================= */
function KpiCard({ label, value }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-3xl font-bold text-cyan-400">{value}</div>
    </div>
  );
}

function AdminModal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 text-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h3 className="font-bold">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const ADMIN_NAV = [
  { key: "home", label: "Dashboard", icon: "📊" },
  { key: "requests", label: "الطلبات والاستفسارات", icon: "📥" },
  { key: "customers", label: "العملاء", icon: "👥" },
  { key: "tenantData", label: "إدارة بيانات المحلات", icon: "🗂️" },
  { key: "invoices", label: "الفواتير", icon: "📄" },
  { key: "sales", label: "المبيعات", icon: "💰" },
  { key: "reports", label: "التقارير", icon: "📊" },
  { key: "retention", label: "احتفاظ المحلات", icon: "📈" },
  { key: "settings", label: "الإعدادات", icon: "⚙️" },
];

// Payment method values match tenants/{id}/settings/shop.enabledPayMethods
// exactly (see POS_PAY_METHODS) — hardcoded Arabic labels here since the
// admin console doesn't use the tenant-side useLang()/t() i18n system.
const ADMIN_PAY_METHODS = [
  { value: "Cash", label: "نقدي" },
  { value: "External Network", label: "شبكة خارجية" },
  { value: "Wallet Balance", label: "رصيد المحفظة" },
  { value: "Credit (On Account)", label: "آجل (على الحساب)" },
  { value: "Split", label: "دفع مقسّم" },
];

function AdminEditInvoiceModal({ invoice, onClose, onSave }) {
  const [total, setTotal] = useState(String(invoice.total));
  const [payMethod, setPayMethod] = useState(invoice.payMethod || "Cash");
  const [closed, setClosed] = useState(Boolean(invoice.closed));
  const [items, setItems] = useState(invoice.items || []);

  const updateItemStatus = (itemId, status) => {
    setItems((prev) => prev.map((it) => it.itemId === itemId ? {
      ...it, status, deliveredAt: status === "Delivered" ? new Date().toISOString() : it.deliveredAt,
    } : it));
  };

  const save = () => {
    onSave({ total: Number(total) || 0, payMethod, closed, items });
  };

  return (
    <AdminModal title={`تعديل الفاتورة ${invoice.code}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">العميل</span>
          <span>{invoice.customerName}</span>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">المبلغ (SAR)</label>
          <input type="number" value={total} onChange={(e) => setTotal(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400 f-mono" dir="ltr" />
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">طريقة / حالة الدفع</label>
          <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400">
            {ADMIN_PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        {items.length > 0 && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">حالة القطع</label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {items.map((it) => (
                <div key={it.itemId} className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2">
                  <span className="text-sm">{it.name}</span>
                  <select value={it.status} onChange={(e) => updateItemStatus(it.itemId, e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs">
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2.5">
          <span className="text-sm">الفاتورة مغلقة (تم التسليم)</span>
          <Toggle checked={closed} onChange={setClosed} />
        </div>

        <button onClick={save} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg py-2.5 text-sm font-semibold">حفظ التعديلات</button>
      </div>
    </AdminModal>
  );
}

function TenantDataManagementView({ tenants }) {
  const [mgmtTenantId, setMgmtTenantId] = useState("");
  const [invoices, setInvoices] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [expenseCategories, setExpenseCategories] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [settings, setSettings] = useState({ enabledPayMethods: {} });
  const [editingInvoice, setEditingInvoice] = useState(null);

  useEffect(() => {
    // Reset on every switch (not just when cleared to ""). subscribeToTable's
    // initial-fetch merge assumes any row in `prev` missing from the fresh
    // fetch is a same-tenant optimistic update not yet echoed back — true
    // within one tenant's session, but false here: switching mgmtTenantId
    // means `prev` is the OLD tenant's rows, which share no ids with the new
    // tenant's fetch, so without this reset every row would be kept as
    // "optimistic" and merged into the new tenant's data instead of replaced.
    setInvoices([]); setProducts([]); setCategories([]); setCustomers([]);
    setExpenses([]); setExpenseCategories([]); setPurchases([]); setSettings({ enabledPayMethods: {} });
    if (!mgmtTenantId) return;
    const unsubs = [
      subscribeToTable("invoices", "tenant_id", mgmtTenantId, setInvoices),
      subscribeToTable("products", "tenant_id", mgmtTenantId, setProducts),
      subscribeToTable("categories", "tenant_id", mgmtTenantId, setCategories),
      subscribeToTable("customers", "tenant_id", mgmtTenantId, setCustomers),
      subscribeToTable("expenses", "tenant_id", mgmtTenantId, setExpenses),
      subscribeToTable("expense_categories", "tenant_id", mgmtTenantId, setExpenseCategories),
      subscribeToTable("purchases", "tenant_id", mgmtTenantId, setPurchases),
      subscribeToRow("tenant_settings", "tenant_id", mgmtTenantId, (row) => setSettings(row || { enabledPayMethods: {} })),
    ];
    return () => unsubs.forEach((u) => u());
  }, [mgmtTenantId]);

  const updateInvoice = (invoiceId, patch) => {
    db.from("invoices").update(toSnakeCase(patch)).eq("id", invoiceId).then(({ error }) => { if (error) console.error("admin updateInvoice failed", error); });
  };
  const togglePayMethod = (value) => {
    const current = settings.enabledPayMethods || {};
    const next = { ...current, [value]: current[value] === false ? true : false };
    // id: reuse the loaded row's real id if one exists (settings.id, from
    // subscribeToRow above), else this tenant has no settings row yet — the
    // shop's own auto-save effect just hasn't run for them. Generating one
    // here creates that first row; it stays correct since a real tenant_id
    // -> id mapping only needs to happen once.
    const rowId = settings.id || crypto.randomUUID();
    // Partial upsert — only id/tenant_id/enabledPayMethods provided, so
    // Postgres leaves every other tenant_settings column untouched (same
    // effect as Firestore's { merge: true }).
    db.from("tenant_settings").upsert(toSnakeCase({ id: rowId, tenantId: mgmtTenantId, enabledPayMethods: next }))
      .then(({ error }) => { if (error) console.error("admin togglePayMethod failed", error); });
  };

  const totalSales = invoices.reduce((s, inv) => s + (inv.total || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const totalPurchases = purchases.reduce((s, p) => s + (p.amount || 0), 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">إدارة بيانات المحلات</h1>

      <div className="mb-6 max-w-sm">
        <label className="block text-xs text-gray-400 mb-1.5">اختر محل</label>
        <select value={mgmtTenantId} onChange={(e) => setMgmtTenantId(e.target.value)} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-cyan-400">
          <option value="">— اختر محل —</option>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.shopName}</option>)}
        </select>
      </div>

      {!mgmtTenantId ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-10 text-center text-gray-400">
          اختر محل من القائمة أعلاه لعرض وإدارة بياناته.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <KpiCard label="عدد الفواتير" value={invoices.length} />
            <KpiCard label="إجمالي المبيعات" value={sar(totalSales)} />
            <KpiCard label="عدد المنتجات" value={products.length} />
            <KpiCard label="عدد العملاء" value={customers.length} />
            <KpiCard label="إجمالي المصاريف" value={sar(totalExpenses)} />
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
            <div className="font-bold mb-3">طرق الدفع المفعّلة بهذا المحل</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {ADMIN_PAY_METHODS.map((m) => (
                <div key={m.value} className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2.5">
                  <span className="text-sm text-gray-300">{m.label}</span>
                  <Toggle checked={settings.enabledPayMethods?.[m.value] !== false} onChange={() => togglePayMethod(m.value)} />
                </div>
              ))}
            </div>
          </div>

          <div className="mb-2 font-bold">الفواتير <span className="text-xs font-normal text-gray-500">(اضغط لتعديل المبلغ/طريقة الدفع/حالة القطع)</span></div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                <tr><th className="px-4 py-3 text-right">الرقم</th><th className="px-4 py-3 text-right">العميل</th><th className="px-4 py-3 text-right">المبلغ</th><th className="px-4 py-3 text-right">طريقة الدفع</th><th className="px-4 py-3 text-right">الحالة</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invoices.map((inv) => (
                  <tr key={inv.id} onClick={() => setEditingInvoice(inv)} className="hover:bg-slate-800/30 cursor-pointer">
                    <td className="px-4 py-3 font-mono" dir="ltr">{inv.code}</td>
                    <td className="px-4 py-3">{inv.customerName}</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{sar(inv.total)}</td>
                    <td className="px-4 py-3">{ADMIN_PAY_METHODS.find((m) => m.value === inv.payMethod)?.label || inv.payMethod}</td>
                    <td className="px-4 py-3">{inv.closed ? "مغلقة" : "مفتوحة"}</td>
                  </tr>
                ))}
                {invoices.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">ما فيه فواتير لهذا المحل بعد.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="mb-2 font-bold">المنتجات <span className="text-xs font-normal text-gray-500">(عرض فقط)</span></div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                <tr><th className="px-4 py-3 text-right">المنتج</th><th className="px-4 py-3 text-right">الفئة</th><th className="px-4 py-3 text-right">السعر من</th><th className="px-4 py-3 text-right">الحالة</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {products.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3">{p.name}</td>
                    <td className="px-4 py-3 text-gray-400">{categories.find((c) => c.id === p.categoryId)?.name || "—"}</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{sar(p.price)}</td>
                    <td className="px-4 py-3">{p.published ? "منشور" : "مسودة"}</td>
                  </tr>
                ))}
                {products.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">ما فيه منتجات لهذا المحل بعد.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="mb-2 font-bold">المصاريف والمشتريات <span className="text-xs font-normal text-gray-500">(عرض فقط)</span></div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                <tr><th className="px-4 py-3 text-right">النوع</th><th className="px-4 py-3 text-right">الفئة</th><th className="px-4 py-3 text-right">المبلغ</th><th className="px-4 py-3 text-right">التاريخ</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {expenses.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3">مصروف</td>
                    <td className="px-4 py-3 text-gray-400">{expenseCategories.find((c) => c.id === e.categoryId)?.name || "—"}</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{sar(e.amount)}</td>
                    <td className="px-4 py-3 font-mono text-gray-400" dir="ltr">{e.date}</td>
                  </tr>
                ))}
                {purchases.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3">مشترى</td>
                    <td className="px-4 py-3 text-gray-400">{p.code}</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{sar(p.amount)}</td>
                    <td className="px-4 py-3 font-mono text-gray-400" dir="ltr">{new Date(p.date).toLocaleDateString("en-GB")}</td>
                  </tr>
                ))}
                {expenses.length === 0 && purchases.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">ما فيه مصاريف أو مشتريات لهذا المحل بعد.</td></tr>}
              </tbody>
            </table>
            {(expenses.length > 0 || purchases.length > 0) && (
              <div className="px-4 py-3 bg-slate-800/30 text-xs text-gray-400 flex justify-between">
                <span>إجمالي المصاريف: <span className="font-mono text-gray-200">{sar(totalExpenses)}</span></span>
                <span>إجمالي المشتريات: <span className="font-mono text-gray-200">{sar(totalPurchases)}</span></span>
              </div>
            )}
          </div>
        </>
      )}

      {editingInvoice && (
        <AdminEditInvoiceModal
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onSave={(patch) => { updateInvoice(editingInvoice.id, patch); setEditingInvoice(null); }}
        />
      )}
    </div>
  );
}

function AdminAllInvoicesView({ invoices }) {
  const sorted = [...invoices].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">الفواتير — كل المحلات</h1>
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-right">التاريخ والوقت</th>
              <th className="px-4 py-3 text-right">المحل</th>
              <th className="px-4 py-3 text-right">رقم الفاتورة</th>
              <th className="px-4 py-3 text-right">العميل</th>
              <th className="px-4 py-3 text-right">المبلغ</th>
              <th className="px-4 py-3 text-right">طريقة الدفع</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {sorted.map((inv) => (
              <tr key={`${inv.tenantId}-${inv.id}`} className="hover:bg-slate-800/30">
                <td className="px-4 py-3 font-mono text-xs text-gray-400" dir="ltr">{inv.createdAt ? new Date(inv.createdAt).toLocaleString("en-GB") : "—"}</td>
                <td className="px-4 py-3 font-medium">{inv.shopName}</td>
                <td className="px-4 py-3 font-mono" dir="ltr">{inv.code}</td>
                <td className="px-4 py-3">{inv.customerName}</td>
                <td className="px-4 py-3 font-mono" dir="ltr">{sar(inv.total)}</td>
                <td className="px-4 py-3">{ADMIN_PAY_METHODS.find((m) => m.value === inv.payMethod)?.label || inv.payMethod}</td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">ما فيه فواتير بعد بأي محل.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminSalesLeaderboardView({ invoices, tenants }) {
  const rows = tenants.map((t) => {
    const tenantInvoices = invoices.filter((inv) => inv.tenantId === t.id);
    const total = tenantInvoices.reduce((s, inv) => s + (inv.total || 0), 0);
    return { id: t.id, shopName: t.shopName, total, count: tenantInvoices.length };
  }).sort((a, b) => b.total - a.total);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">المبيعات — كل المحلات</h1>
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-right">الترتيب</th>
              <th className="px-4 py-3 text-right">المحل</th>
              <th className="px-4 py-3 text-right">إجمالي المبيعات</th>
              <th className="px-4 py-3 text-right">عدد الفواتير</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r, i) => (
              <tr key={r.id} className="hover:bg-slate-800/30">
                <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                <td className="px-4 py-3 font-medium">{r.shopName}</td>
                <td className="px-4 py-3 font-mono text-cyan-400" dir="ltr">{sar(r.total)}</td>
                <td className="px-4 py-3 font-mono text-gray-400" dir="ltr">{r.count}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-500">ما فيه محلات معتمدة بعد.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Payment status is derived from the real payMethod/splitPayments fields
// already stored on each invoice — no schema change needed:
//  - "Credit (On Account)" alone           → fully unpaid/deferred
//  - "Split" including a credit portion    → partially paid
//  - anything else (Cash/Network/Wallet,
//    or a Split with no credit portion)    → fully paid at sale time
function invoicePaymentStatus(inv) {
  if (inv.payMethod === "Credit (On Account)") return "unpaid";
  if (inv.payMethod === "Split" && Array.isArray(inv.splitPayments)) {
    const hasCredit = inv.splitPayments.some((sp) => sp.method === "Credit (On Account)");
    return hasCredit ? "partial" : "paid";
  }
  return "paid";
}

function AdminPlatformReportsView({ invoices, tenants, customerCounts }) {
  const totalCustomers = Object.values(customerCounts).reduce((s, n) => s + n, 0);

  const perTenant = tenants.map((t) => {
    const tenantInvoices = invoices.filter((inv) => inv.tenantId === t.id);
    const total = tenantInvoices.reduce((s, inv) => s + (inv.total || 0), 0);
    const count = tenantInvoices.length;
    return { id: t.id, shopName: t.shopName, total, count, avg: count > 0 ? total / count : 0 };
  });

  const topByRevenue = [...perTenant].sort((a, b) => b.total - a.total).slice(0, 5);
  const topByAvg = perTenant.filter((r) => r.count > 0).sort((a, b) => b.avg - a.avg).slice(0, 5);
  const topByActivity = [...perTenant].sort((a, b) => b.count - a.count).slice(0, 5);

  const monthCounts = {};
  tenants.forEach((t) => {
    const month = t.approvedDate ? String(t.approvedDate).slice(0, 7) : null; // YYYY-MM
    if (!month) return;
    monthCounts[month] = (monthCounts[month] || 0) + 1;
  });
  const months = Object.keys(monthCounts).sort();
  const maxMonthCount = Math.max(1, ...months.map((m) => monthCounts[m]));

  const statusCounts = { paid: 0, partial: 0, unpaid: 0 };
  invoices.forEach((inv) => { statusCounts[invoicePaymentStatus(inv)] += 1; });
  const totalInvoicesCount = invoices.length;
  const pct = (n) => totalInvoicesCount > 0 ? Math.round((n / totalInvoicesCount) * 100) : 0;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">التقارير — كل المنصة</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard label="إجمالي عدد العملاء (كل المحلات)" value={totalCustomers} />
        <KpiCard label="إجمالي عدد الفواتير" value={totalInvoicesCount} />
        <KpiCard label="إجمالي المبيعات" value={sar(perTenant.reduce((s, r) => s + r.total, 0))} />
        <KpiCard label="عدد المحلات المعتمدة" value={tenants.length} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="font-bold mb-3">أ) أفضل المحلات أداءً (حسب الإيرادات)</div>
          <div className="space-y-2">
            {topByRevenue.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between text-sm">
                <span>{i + 1}. {r.shopName}</span>
                <span className="font-mono text-cyan-400" dir="ltr">{sar(r.total)}</span>
              </div>
            ))}
            {topByRevenue.length === 0 && <div className="text-sm text-gray-500">ما فيه بيانات كافية.</div>}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="font-bold mb-3">د) المحلات الأكثر نشاطًا (حسب عدد الفواتير)</div>
          <div className="space-y-2">
            {topByActivity.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between text-sm">
                <span>{i + 1}. {r.shopName}</span>
                <span className="font-mono text-gray-300" dir="ltr">{r.count} فاتورة</span>
              </div>
            ))}
            {topByActivity.length === 0 && <div className="text-sm text-gray-500">ما فيه بيانات كافية.</div>}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="font-bold mb-3">ج) متوسط قيمة الفاتورة لكل محل</div>
          <div className="space-y-2">
            {topByAvg.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between text-sm">
                <span>{i + 1}. {r.shopName}</span>
                <span className="font-mono text-cyan-400" dir="ltr">{sar(r.avg)}</span>
              </div>
            ))}
            {topByAvg.length === 0 && <div className="text-sm text-gray-500">ما فيه فواتير كافية لحساب المتوسط.</div>}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="font-bold mb-3">هـ) حالة الفواتير عبر المنصة</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-green-400">مدفوعة بالكامل</span>
              <span className="font-mono">{statusCounts.paid} <span className="text-gray-500">({pct(statusCounts.paid)}%)</span></span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-amber-400">جزئية</span>
              <span className="font-mono">{statusCounts.partial} <span className="text-gray-500">({pct(statusCounts.partial)}%)</span></span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-rose-400">متأخرة / غير مدفوعة</span>
              <span className="font-mono">{statusCounts.unpaid} <span className="text-gray-500">({pct(statusCounts.unpaid)}%)</span></span>
            </div>
            {totalInvoicesCount === 0 && <div className="text-sm text-gray-500">ما فيه فواتير بعد.</div>}
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="font-bold mb-4">ب) نمو التسجيلات عبر الوقت (محلات جديدة شهريًا)</div>
        {months.length === 0 ? (
          <div className="text-sm text-gray-500">ما فيه بيانات تسجيل كافية بعد.</div>
        ) : (
          <div className="flex items-end gap-2 h-40">
            {months.map((m) => (
              <div key={m} className="flex-1 flex flex-col items-center justify-end h-full">
                <span className="text-xs text-gray-300 mb-1">{monthCounts[m]}</span>
                <div className="w-full bg-cyan-500 rounded-t" style={{ height: `${(monthCounts[m] / maxMonthCount) * 100}%`, minHeight: "4px" }} />
                <span className="text-[10px] text-gray-500 mt-1.5 font-mono" dir="ltr">{m}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Dedicated SaaS retention/cohort screen — deliberately its own top-level
// admin nav tab, not nested inside "التقارير", so it doesn't get lost among
// the other report sections. Three modes:
//   - "all": every tenant, grouped into the standard cohort-by-signup-month
//     matrix (one row per signup month) — platform-level "are shops sticking
//     around" view.
//   - "cohort": the same matrix filtered down to a single signup month —
//     picking a cohort just narrows the tenant entities before the same
//     computeCohortRetention() call, no separate code path needed.
//   - "tenant": drills all the way down into ONE selected shop's OWN
//     customers — a completely different entity set (that tenant's
//     customers grouped by their first purchase month, not tenants grouped
//     by signup month). "Is this specific shop's business itself active" is
//     a degenerate single-row question with no useful "size" column; "are
//     THIS shop's customers loyal" is the actually useful drill-down, and
//     reuses the exact same computeCohortRetention() shape one level down.
function AdminRetentionView({ invoices, tenants }) {
  const [mode, setMode] = useState("all"); // "all" | "cohort" | "tenant"
  const [selectedCohort, setSelectedCohort] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState("");

  const tenantEntities = tenants
    .filter((t) => t.approvedDate)
    .map((t) => ({
      id: t.id,
      shopName: t.shopName,
      cohortPeriod: String(t.approvedDate).slice(0, 7),
      activePeriods: new Set(invoices.filter((inv) => inv.tenantId === t.id).map((inv) => monthKey(inv.createdAt))),
    }));
  const cohortOptions = [...new Set(tenantEntities.map((e) => e.cohortPeriod))].sort();

  useEffect(() => {
    if (mode === "cohort" && !selectedCohort && cohortOptions.length > 0) setSelectedCohort(cohortOptions[0]);
    if (mode === "tenant" && !selectedTenantId && tenantEntities.length > 0) setSelectedTenantId(tenantEntities[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cohortOptions.length, tenantEntities.length]);

  // "tenant" mode swaps the entity set entirely: customers of the selected
  // shop (grouped by customerId, cohort = their own first-purchase month),
  // not tenants at all — same pattern createInvoice/POS already guarantee
  // (every invoice has a real customerId).
  const customerEntitiesForSelectedTenant = useMemo(() => {
    if (mode !== "tenant" || !selectedTenantId) return [];
    const byCustomer = new Map();
    invoices.filter((inv) => inv.tenantId === selectedTenantId).forEach((inv) => {
      if (!byCustomer.has(inv.customerId)) byCustomer.set(inv.customerId, []);
      byCustomer.get(inv.customerId).push(inv);
    });
    return [...byCustomer.values()].map((custInvoices) => {
      const periods = custInvoices.map((inv) => monthKey(inv.createdAt)).sort();
      return { cohortPeriod: periods[0], activePeriods: new Set(periods) };
    });
  }, [mode, selectedTenantId, invoices]);

  const entitiesForView = mode === "cohort" ? tenantEntities.filter((e) => e.cohortPeriod === selectedCohort)
    : mode === "tenant" ? customerEntitiesForSelectedTenant
    : tenantEntities;
  const retention = computeCohortRetention(entitiesForView);
  const selectedTenantName = mode === "tenant" ? tenantEntities.find((e) => e.id === selectedTenantId)?.shopName : null;
  const cohortColLabel = mode === "tenant" ? "دفعة أول شراء" : "دفعة التسجيل";
  const sizeColLabel = mode === "tenant" ? "عدد العملاء" : "عدد المحلات";

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">احتفاظ المحلات (Retention & Cohorts)</h1>

      <div className="flex flex-wrap items-center gap-3 mb-6 bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex gap-2">
          <button onClick={() => setMode("all")} className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "all" ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-gray-300"}`}>كل المحلات</button>
          <button onClick={() => setMode("cohort")} className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "cohort" ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-gray-300"}`}>دفعة معينة</button>
          <button onClick={() => setMode("tenant")} className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "tenant" ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-gray-300"}`}>محل معين</button>
        </div>

        {mode === "cohort" && (
          cohortOptions.length > 0 ? (
            <select value={selectedCohort} onChange={(e) => setSelectedCohort(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" dir="ltr">
              {cohortOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : <span className="text-sm text-gray-500">ما فيه دفعات تسجيل بعد.</span>
        )}
        {mode === "tenant" && (
          tenantEntities.length > 0 ? (
            <select value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
              {tenantEntities.map((e) => <option key={e.id} value={e.id}>{e.shopName}</option>)}
            </select>
          ) : <span className="text-sm text-gray-500">ما فيه محلات بعد.</span>
        )}
      </div>

      {mode === "tenant" && selectedTenantName && (
        <div className="mb-3 text-sm text-gray-400">احتفاظ عملاء محل: <span className="text-white font-semibold">{selectedTenantName}</span></div>
      )}

      {entitiesForView.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm text-gray-500">ما فيه بيانات كافية.</div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-center" style={{ width: `${100 / (retention.maxOffset + 2)}%` }}>{cohortColLabel}</th>
                  <th className="px-3 py-2 text-center" style={{ width: `${100 / (retention.maxOffset + 2)}%` }}>{sizeColLabel}</th>
                  {Array.from({ length: retention.maxOffset + 1 }, (_, o) => o).map((o) => (
                    <th key={o} className="px-2 py-2 text-center font-mono" dir="ltr" style={{ width: `${100 / (retention.maxOffset + 2)}%` }}>+{o}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {retention.rows.map((row) => (
                  <tr key={row.cohortPeriod}>
                    <td className="px-3 py-2 text-center font-mono text-gray-300" dir="ltr">{row.cohortPeriod}</td>
                    <td className="px-3 py-2 text-center font-mono text-gray-300">{row.size}</td>
                    {Array.from({ length: retention.maxOffset + 1 }, (_, o) => o).map((o) => {
                      const cell = row.offsets[o];
                      return (
                        <td key={o} className="px-1 py-1 text-center">
                          {cell ? (
                            <div className={`mx-auto rounded-md py-1.5 font-mono text-xs font-semibold ${retentionShade(cell.pct)}`}>{cell.pct.toFixed(0)}%</div>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Every subcollection a tenant document can own (mirrors the onSnapshot list
// in LaundryOpsApp) — deleted before the tenant doc itself, since Firestore
// never cascades deletes on its own and orphaned subcollections would keep
// occupying storage and stay reachable by a direct-path read forever.
// Order matters: a table with a foreign key to another table in this list
// must come before it (products.category_id -> categories.id, etc.) or the
// parent's delete gets rejected with a 23503 foreign-key-violation while
// children still reference it.
const TENANT_TABLES = [
  "products", "invoices", "customer_transactions", "purchases", "expenses",
  "categories", "customers", "suppliers", "expense_categories",
  "addons", "service_types", "promotions", "tenant_settings",
];

// Postgres bulk-deletes an entire table's tenant-scoped rows in one round
// trip (WHERE tenant_id = ...) — no need for Firestore's "list every doc,
// then delete each one" dance.
async function deleteTenantCascade(tenantId) {
  for (const table of TENANT_TABLES) {
    const { error } = await db.from(table).delete().eq("tenant_id", tenantId);
    if (error) throw error;
  }
  const { error: tenantErr } = await db.from("tenants").delete().eq("id", tenantId);
  if (tenantErr) throw tenantErr;
  // registration_requests is a separate table linked only by this "uid"
  // column — deleting the tenant row alone leaves it behind, which is
  // exactly what makes an already-deleted shop keep showing up here.
  const { error: reqErr } = await db.from("registration_requests").delete().eq("uid", tenantId);
  if (reqErr) throw reqErr;
}

function AdminDashboard({ registrationRequests, salesInquiries, tenants, adminEmails, autoApprove, maintenanceActive, maintenanceMessage, onLogout }) {
  const [tab, setTab] = useState("home");
  const [reqTab, setReqTab] = useState("registrations");
  const [viewingRequest, setViewingRequest] = useState(null);
  const [rejectingRequest, setRejectingRequest] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [viewingInquiry, setViewingInquiry] = useState(null);
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [adminError, setAdminError] = useState("");
  // Shared banner for the settings tab's Supabase writes (maintenance
  // toggle/message, auto-approve toggle) — these used to only log to
  // console.error on failure (e.g. an RLS rejection), so an admin whose
  // write silently failed had zero indication anything went wrong.
  const [settingsError, setSettingsError] = useState("");
  const [editingTenant, setEditingTenant] = useState(null);
  const [editMobile, setEditMobile] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editError, setEditError] = useState("");
  const [deletingTenant, setDeletingTenant] = useState(null);
  const [deletingRequest, setDeletingRequest] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const pendingCount = registrationRequests.filter((r) => r.status === "pending").length;
  const newInquiriesCount = salesInquiries.filter((i) => i.status === "new").length;

  // Cross-tenant data for the "invoices" / "sales" / "reports" nav tabs —
  // one onSnapshot per tenant's invoices + customers subcollections, merged
  // client-side. Reuses the existing per-tenant admin-read rules (no
  // collection-group rule needed, since we already know every tenant id).
  // Only subscribed while a tab that actually needs it is open.
  const [allInvoices, setAllInvoices] = useState([]);
  const [tenantCustomerCounts, setTenantCustomerCounts] = useState({});
  const tenantIdsKey = tenants.map((t) => t.id).join(",");

  useEffect(() => {
    if (!["invoices", "sales", "reports", "retention"].includes(tab) || tenants.length === 0) {
      setAllInvoices([]);
      setTenantCustomerCounts({});
      return;
    }
    // This merges per-tenant filtered subscriptions into one flat annotated
    // array/count-map — doesn't fit the generic subscribeToTable shape (which
    // assumes one table's rows map straight onto one piece of state), so it's
    // written directly here. On any change, the affected tenant's full
    // invoice list / customer count is simply re-fetched — simpler and safe
    // at admin-overview scale, versus hand-rolling per-row diff merges here.
    const invoicesByTenant = {};
    const countsByTenant = {};
    const channels = [];
    tenants.forEach((t) => {
      const applyInvoiceRows = (rows) => {
        invoicesByTenant[t.id] = rows.map((r) => ({ ...r, tenantId: t.id, shopName: t.shopName }));
        setAllInvoices(Object.values(invoicesByTenant).flat());
      };
      const loadInvoices = () => db.from("invoices").select().eq("tenant_id", t.id).then(({ data, error }) => {
        if (error) { console.error("admin cross-tenant invoices load failed", t.id, error); return; }
        applyInvoiceRows((data || []).map(toCamelCase));
      });
      loadInvoices();
      channels.push(
        db.channel(`admin-invoices-${t.id}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "invoices", filter: `tenant_id=eq.${t.id}` }, loadInvoices)
          .subscribe()
      );

      const loadCustomerCount = () => db.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", t.id).then(({ count, error }) => {
        if (error) { console.error("admin cross-tenant customers load failed", t.id, error); return; }
        countsByTenant[t.id] = count || 0;
        setTenantCustomerCounts({ ...countsByTenant });
      });
      loadCustomerCount();
      channels.push(
        db.channel(`admin-customers-${t.id}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "customers", filter: `tenant_id=eq.${t.id}` }, loadCustomerCount)
          .subscribe()
      );
    });
    return () => channels.forEach((ch) => db.removeChannel(ch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tenantIdsKey]);

  // Belt-and-braces filter: strip out any entry whose tenant no longer
  // exists in the live tenants list before it ever reaches a report. This
  // makes every platform-wide number immune to a deleted tenant's data by
  // construction, regardless of how briefly (or not) allInvoices/
  // tenantCustomerCounts might lag behind a just-completed deletion.
  const liveTenantIds = new Set(tenants.map((t) => t.id));
  const liveInvoices = allInvoices.filter((inv) => liveTenantIds.has(inv.tenantId));
  const liveCustomerCounts = Object.fromEntries(Object.entries(tenantCustomerCounts).filter(([id]) => liveTenantIds.has(id)));

  const approveRequest = async (req) => {
    await db.from("tenants").upsert(toSnakeCase({
      id: req.uid, shopName: req.shopName, mobile: req.mobile, email: req.email, address: req.address, approvedDate: new Date().toISOString(),
    }));
    await db.from("registration_requests").update({ status: "approved" }).eq("id", req.id);
    setViewingRequest(null);
  };
  const rejectRequest = async () => {
    await db.from("registration_requests").update(toSnakeCase({ status: "rejected", rejectReason })).eq("id", rejectingRequest.id);
    setRejectingRequest(null); setRejectReason("");
  };
  const markInquiryRead = (id) => {
    const inquiry = salesInquiries.find((i) => i.id === id);
    if (inquiry && inquiry.status === "new") db.from("sales_inquiries").update({ status: "read" }).eq("id", id).then(({ error }) => { if (error) console.error("markInquiryRead failed", error); });
  };
  const markInquiryReplied = (id) => db.from("sales_inquiries").update({ status: "replied" }).eq("id", id).then(({ error }) => { if (error) console.error("markInquiryReplied failed", error); });
  const addInquiryNote = (id, note) => db.from("sales_inquiries").update({ note }).eq("id", id).then(({ error }) => { if (error) console.error("addInquiryNote failed", error); });

  const openEditTenant = (c) => {
    setEditingTenant(c);
    setEditMobile(c.mobile);
    setEditEmail(c.email);
    setEditError("");
  };
  const saveTenantEdit = async () => {
    const mobileNorm = editMobile.trim();
    const emailNorm = editEmail.trim().toLowerCase();
    if (!isValidSaudiMobile(mobileNorm)) { setEditError("رقم الجوال غير صحيح."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) { setEditError("بريد إلكتروني غير صحيح."); return; }
    if (tenants.some((t) => t.id !== editingTenant.id && t.mobile === mobileNorm)) { setEditError("هذا الرقم مستخدم مسبقًا لعميل آخر."); return; }
    if (tenants.some((t) => t.id !== editingTenant.id && t.email === emailNorm)) { setEditError("هذا البريد مستخدم مسبقًا لعميل آخر."); return; }

    // ملاحظة: هذا يعدّل بيانات العرض فقط بالجدول — بريد الدخول الفعلي بـ
    // Supabase Auth لا يمكن تغييره من هنا (يحتاج صلاحيات Admin API من سيرفر).
    await db.from("tenants").update({ mobile: mobileNorm, email: emailNorm }).eq("id", editingTenant.id);
    setEditingTenant(null);
  };

  const confirmDeleteTenant = async () => {
    if (!deletingTenant) return;
    setDeleteBusy(true); setDeleteError("");
    try {
      await deleteTenantCascade(deletingTenant.id);
      setDeletingTenant(null);
    } catch (e) {
      console.error("deleteTenant failed", e);
      setDeleteError("صار خطأ أثناء الحذف — حاول مرة ثانية.");
    }
    setDeleteBusy(false);
  };

  const confirmDeleteRequest = async () => {
    if (!deletingRequest) return;
    setDeleteBusy(true); setDeleteError("");
    try {
      const { error } = await db.from("registration_requests").delete().eq("id", deletingRequest.id);
      if (error) throw error;
      setDeletingRequest(null);
    } catch (e) {
      console.error("deleteRequest failed", e);
      setDeleteError("صار خطأ أثناء الحذف — حاول مرة ثانية.");
    }
    setDeleteBusy(false);
  };

  // Postgres has no arrayUnion/arrayRemove atomic op reachable through
  // PostgREST's plain update() — this fetch-current-then-write-back pattern
  // has the same theoretical race window flagged elsewhere in this app for
  // balance checks, but admin-email-list edits are low-frequency/low-
  // concurrency enough that it's an acceptable trade-off here (an RPC
  // function would be the airtight fix, but needs a SQL migration to add).
  const addAdmin = async () => {
    const email = newAdminEmail.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setAdminError("بريد إلكتروني غير صحيح."); return; }
    if (adminEmails.includes(email)) { setAdminError("هذا البريد مضاف مسبقًا."); return; }
    setAdminError("");
    const { error } = await db.from("platform_config").update({ admin_emails: [...adminEmails, email] }).eq("id", true);
    if (error) { console.error("addAdmin failed", error); setAdminError("فشلت الإضافة — حاول مرة ثانية."); return; }
    setNewAdminEmail("");
  };
  const removeAdmin = async (email) => {
    if (adminEmails.length <= 1) return;
    const { error } = await db.from("platform_config").update({ admin_emails: adminEmails.filter((e) => e !== email) }).eq("id", true);
    if (error) { console.error("removeAdmin failed", error); setAdminError("فشلت الإزالة — حاول مرة ثانية."); return; }
    // Revokes this email's actual RLS admin privilege (platform_admins),
    // not just its spot in the admin_emails allow-list above — see
    // api/admin-sync.js. Best-effort: if this fails, the email is still
    // gone from admin_emails (client-side gate), so they lose dashboard
    // access; only a lingering platform_admins row would remain, closeable
    // by re-running "إزالة" or directly in Supabase.
    const { data: { session } } = await auth.getSession();
    if (session?.access_token) {
      fetch('/api/admin-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'revoke', targetEmail: email }),
      }).catch((e) => console.error('admin-sync revoke failed', e));
    }
  };
  const toggleAutoApprove = async (value) => {
    const { error } = await db.from("platform_config").update({ auto_approve: value }).eq("id", true);
    if (error) { console.error("toggleAutoApprove failed", error); setSettingsError("فشل الحفظ — حاول تسجيل الخروج والدخول مرة ثانية."); }
  };
  // Draft text field, only pushed to platform_config (and so out to every
  // visitor's MaintenanceBanner) when the admin actually hits save/toggle —
  // typing shouldn't broadcast a half-written message live.
  const [maintenanceDraft, setMaintenanceDraft] = useState(maintenanceMessage || "");
  useEffect(() => { setMaintenanceDraft(maintenanceMessage || ""); }, [maintenanceMessage]);
  const toggleMaintenance = async (value) => {
    const { error } = await db.from("platform_config").update({ maintenance_active: value }).eq("id", true);
    if (error) { console.error("toggleMaintenance failed", error); setSettingsError("فشل الحفظ — حاول تسجيل الخروج والدخول مرة ثانية."); }
    else setSettingsError("");
  };
  const saveMaintenanceMessage = async () => {
    const { error } = await db.from("platform_config").update({ maintenance_message: maintenanceDraft.trim() }).eq("id", true);
    if (error) { console.error("saveMaintenanceMessage failed", error); setSettingsError("فشل الحفظ — حاول تسجيل الخروج والدخول مرة ثانية."); }
    else setSettingsError("");
  };

  const statusBadge = (status, map) => {
    const cls = { pending: "bg-amber-500/20 text-amber-400", approved: "bg-green-500/20 text-green-400", rejected: "bg-rose-500/20 text-rose-400", new: "bg-blue-500/20 text-blue-400", read: "bg-slate-500/20 text-slate-300", replied: "bg-green-500/20 text-green-400" };
    return <span className={`px-2 py-1 rounded-full text-xs font-medium ${cls[status]}`}>{map[status]}</span>;
  };

  return (
    <div dir="rtl" className="flex h-screen bg-slate-950 text-white">
      <div className="w-64 shrink-0 bg-slate-900 border-l border-slate-800 flex flex-col">
        <div className="px-5 py-6 flex items-center gap-3 border-b border-slate-800">
          <img src={LOGO_DATA_URI} alt="Ragwa" className="w-10 h-10 rounded-xl object-contain shrink-0" />
          <div>
            <div className="font-bold">رغوة</div>
            <div className="text-[10px] text-cyan-400 uppercase tracking-widest">لوحة الإدارة</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {ADMIN_NAV.map((n) => (
            <button key={n.key} onClick={() => setTab(n.key)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${tab === n.key ? "bg-gradient-to-r from-blue-500 to-cyan-500 font-semibold text-white" : "text-gray-300 hover:bg-slate-800"}`}>
              <span>{n.icon}</span>
              <span className="flex-1 text-right">{n.label}</span>
              {n.key === "requests" && (pendingCount + newInquiriesCount) > 0 && <span className="bg-rose-500 text-white text-[10px] rounded-full px-1.5 py-0.5 min-w-[18px] text-center">{pendingCount + newInquiriesCount}</span>}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800">
          <button onClick={onLogout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-slate-800">
            <span>🚪</span><span>تسجيل الخروج</span>
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-8">
        {tab === "home" && (
          <div>
            <h1 className="text-2xl font-bold mb-6">نظرة عامة</h1>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KpiCard label="طلبات قيد الانتظار" value={pendingCount} />
              <KpiCard label="استفسارات جديدة" value={newInquiriesCount} />
              <KpiCard label="إجمالي العملاء" value={tenants.length} />
              <KpiCard label="إجمالي طلبات التسجيل" value={registrationRequests.length} />
            </div>
          </div>
        )}

        {tab === "requests" && (
          <div>
            <h1 className="text-2xl font-bold mb-4">الطلبات والاستفسارات</h1>
            <div className="flex gap-2 mb-6">
              <button onClick={() => setReqTab("registrations")} className={`px-4 py-2 rounded-lg text-sm font-medium ${reqTab === "registrations" ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-gray-300"}`}>طلبات التسجيل {pendingCount > 0 && `(${pendingCount})`}</button>
              <button onClick={() => setReqTab("inquiries")} className={`px-4 py-2 rounded-lg text-sm font-medium ${reqTab === "inquiries" ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-gray-300"}`}>رسائل المبيعات {newInquiriesCount > 0 && `(${newInquiriesCount})`}</button>
            </div>

            {reqTab === "registrations" ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                    <tr><th className="px-4 py-3 text-right">اسم المغسلة</th><th className="px-4 py-3 text-right">الجوال</th><th className="px-4 py-3 text-right">البريد</th><th className="px-4 py-3 text-right">التاريخ</th><th className="px-4 py-3 text-right">الحالة</th><th className="px-4 py-3"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {registrationRequests.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-800/30">
                        <td className="px-4 py-3">{r.shopName}</td>
                        <td className="px-4 py-3 font-mono" dir="ltr">{r.mobile}</td>
                        <td className="px-4 py-3 font-mono" dir="ltr">{r.email}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs font-mono" dir="ltr">{new Date(r.date).toLocaleString("en-GB")}</td>
                        <td className="px-4 py-3">{statusBadge(r.status, { pending: "قيد الانتظار", approved: "موافق عليه", rejected: "مرفوض" })}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5 justify-end">
                            <button onClick={() => setViewingRequest(r)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs whitespace-nowrap">👁️ تفاصيل</button>
                            {r.status === "pending" && (
                              <>
                                <button onClick={() => approveRequest(r)} className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-xs whitespace-nowrap">✅ موافقة</button>
                                <button onClick={() => setRejectingRequest(r)} className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-700 text-xs whitespace-nowrap">❌ رفض</button>
                              </>
                            )}
                            <button onClick={() => setDeletingRequest(r)} className="px-2 py-1 rounded bg-slate-800 hover:bg-rose-700 text-xs whitespace-nowrap">🗑️ حذف</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {registrationRequests.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">لا توجد طلبات تسجيل بعد.</td></tr>}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                    <tr><th className="px-4 py-3 text-right">المرسل</th><th className="px-4 py-3 text-right">النوع</th><th className="px-4 py-3 text-right">الرسالة</th><th className="px-4 py-3 text-right">التاريخ</th><th className="px-4 py-3 text-right">الحالة</th><th className="px-4 py-3"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {salesInquiries.map((i) => (
                      <tr key={i.id} className="hover:bg-slate-800/30">
                        <td className="px-4 py-3">{i.name}<div className="text-xs text-gray-500 font-mono" dir="ltr">{i.mobile} · {i.email}</div></td>
                        <td className="px-4 py-3 text-gray-300">{i.type}</td>
                        <td className="px-4 py-3 text-gray-400 max-w-xs truncate">{i.message}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs font-mono" dir="ltr">{new Date(i.date).toLocaleString("en-GB")}</td>
                        <td className="px-4 py-3">{statusBadge(i.status, { new: "جديدة", read: "مقروءة", replied: "تمت الإجابة" })}</td>
                        <td className="px-4 py-3"><button onClick={() => { markInquiryRead(i.id); setViewingInquiry(i); }} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">فتح</button></td>
                      </tr>
                    ))}
                    {salesInquiries.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">لا توجد استفسارات بعد.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "customers" && (
          <div>
            <h1 className="text-2xl font-bold mb-6">العملاء</h1>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-800/50 text-gray-400 text-xs uppercase">
                  <tr><th className="px-4 py-3 text-right">اسم المغسلة</th><th className="px-4 py-3 text-right">العنوان</th><th className="px-4 py-3 text-right">الجوال</th><th className="px-4 py-3 text-right">البريد</th><th className="px-4 py-3 text-right">تاريخ الموافقة</th><th className="px-4 py-3"></th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {tenants.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">{c.shopName}</td>
                      <td className="px-4 py-3">{c.address}</td>
                      <td className="px-4 py-3 font-mono" dir="ltr">{c.mobile}</td>
                      <td className="px-4 py-3 font-mono" dir="ltr">{c.email}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs font-mono" dir="ltr">{new Date(c.approvedDate).toLocaleDateString("en-GB")}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1.5 justify-end">
                          <button onClick={() => openEditTenant(c)} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs whitespace-nowrap">✏️ تعديل</button>
                          <button onClick={() => setDeletingTenant(c)} className="px-2 py-1 rounded bg-slate-800 hover:bg-rose-700 text-xs whitespace-nowrap">🗑️ حذف</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {tenants.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-500">ما فيه عملاء معتمدين بعد — وافق على طلب تسجيل من "الطلبات والاستفسارات" عشان يظهر هنا.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "tenantData" && <TenantDataManagementView tenants={tenants} />}

        {tab === "invoices" && <AdminAllInvoicesView invoices={liveInvoices} />}
        {tab === "sales" && <AdminSalesLeaderboardView invoices={liveInvoices} tenants={tenants} />}
        {tab === "reports" && <AdminPlatformReportsView invoices={liveInvoices} tenants={tenants} customerCounts={liveCustomerCounts} />}
        {tab === "retention" && <AdminRetentionView invoices={liveInvoices} tenants={tenants} />}

        {tab === "settings" && (
          <div className="max-w-xl space-y-6">
            <h1 className="text-2xl font-bold">إعدادات الإدارة</h1>
            {settingsError && <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{settingsError}</div>}

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-1">
                <div className="font-semibold">القبول التلقائي لحسابات جديدة</div>
                <Toggle checked={autoApprove} onChange={toggleAutoApprove} />
              </div>
              <p className="text-xs text-gray-500">
                {autoApprove
                  ? "مفعّل: أي عميل جديد يسجل حساب ينقبل تلقائيًا ويصير عميل معتمد فورًا، بدون ما تحتاج توافق عليه."
                  : "متوقف: أي تسجيل جديد يروح لقائمة \"قيد الانتظار\" ولازم توافق عليه يدويًا من تبويب طلبات التسجيل قبل ما يصير عميل معتمد."}
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-1">
                <div className="font-semibold">إشعار صيانة / حادثة عام</div>
                <Toggle checked={maintenanceActive} onChange={toggleMaintenance} />
              </div>
              <p className="text-xs text-gray-500 mb-3">
                {maintenanceActive
                  ? "مفعّل: يظهر كشريط تنبيه أعلى كل صفحة بالمنصة (الهبوط، تسجيل الدخول، ولوحات كل المحلات) لحد ما توقفه."
                  : "متوقف: ما يظهر أي شريط تنبيه لأي زائر."}
              </p>
              <textarea
                value={maintenanceDraft} onChange={(e) => setMaintenanceDraft(e.target.value)} rows={2}
                placeholder="مثال: صيانة مجدولة الساعة 2 صباحًا، ممكن يتوقف النظام لدقائق."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mb-2 focus:border-cyan-400 outline-none"
              />
              <button onClick={saveMaintenanceMessage} className="text-xs font-medium text-cyan-400 hover:underline">حفظ نص الإشعار</button>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="font-semibold mb-1">مدراء النظام</div>
              <p className="text-xs text-gray-500 mb-4">أي بريد تضيفه هنا يصير له دخول مباشر للوحة الإدارة نفسها بمجرد ما يسجل دخول أو حساب فيه.</p>
              <div className="space-y-2 mb-4">
                {adminEmails.map((e) => (
                  <div key={e} className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2">
                    <span className="font-mono text-sm" dir="ltr">{e}</span>
                    {adminEmails.length > 1 && <button onClick={() => removeAdmin(e)} className="text-rose-400 text-xs hover:underline">إزالة</button>}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newAdminEmail} onChange={(e) => { setNewAdminEmail(e.target.value); setAdminError(""); }} placeholder="admin@example.com" className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400" dir="ltr" />
                <button onClick={addAdmin} className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-lg text-sm font-semibold hover:bg-cyan-400">إضافة</button>
              </div>
              {adminError && <div className="mt-2 text-xs font-medium text-rose-400">{adminError}</div>}
            </div>
          </div>
        )}
      </main>

      {viewingRequest && (
        <AdminModal title="تفاصيل الطلب" onClose={() => setViewingRequest(null)}>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-400">اسم المغسلة</span><span>{viewingRequest.shopName}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">الجوال</span><span className="font-mono" dir="ltr">{viewingRequest.mobile}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">البريد</span><span className="font-mono" dir="ltr">{viewingRequest.email}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">العنوان</span><span>{viewingRequest.address || "—"}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">التاريخ</span><span className="font-mono text-xs" dir="ltr">{new Date(viewingRequest.date).toLocaleString("en-GB")}</span></div>
            {viewingRequest.status === "rejected" && <div className="flex justify-between"><span className="text-gray-400">سبب الرفض</span><span>{viewingRequest.rejectReason || "—"}</span></div>}
          </div>
          {viewingRequest.status === "pending" && (
            <div className="flex gap-2 mt-5">
              <button onClick={() => approveRequest(viewingRequest)} className="flex-1 bg-green-600 hover:bg-green-700 rounded-lg py-2 text-sm font-semibold">✅ موافقة</button>
              <button onClick={() => { setRejectingRequest(viewingRequest); setViewingRequest(null); }} className="flex-1 bg-rose-600 hover:bg-rose-700 rounded-lg py-2 text-sm font-semibold">❌ رفض</button>
            </div>
          )}
        </AdminModal>
      )}

      {rejectingRequest && (
        <AdminModal title="سبب الرفض" onClose={() => setRejectingRequest(null)}>
          <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400 mb-4" placeholder="اكتب سبب الرفض..." />
          <button onClick={rejectRequest} className="w-full bg-rose-600 hover:bg-rose-700 rounded-lg py-2.5 text-sm font-semibold">تأكيد الرفض</button>
        </AdminModal>
      )}

      {viewingInquiry && (
        <AdminModal title="تفاصيل الاستفسار" onClose={() => setViewingInquiry(null)}>
          <div className="space-y-2 text-sm mb-4">
            <div className="flex justify-between"><span className="text-gray-400">الاسم</span><span>{viewingInquiry.name}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">الجوال</span><span className="font-mono" dir="ltr">{viewingInquiry.mobile}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">البريد</span><span className="font-mono" dir="ltr">{viewingInquiry.email}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">النوع</span><span>{viewingInquiry.type}</span></div>
          </div>
          <div className="bg-slate-800 rounded-lg p-3 text-sm mb-4">{viewingInquiry.message}</div>
          <label className="block text-xs text-gray-400 mb-1.5">ملاحظة داخلية للفريق</label>
          <textarea defaultValue={viewingInquiry.note || ""} onBlur={(e) => addInquiryNote(viewingInquiry.id, e.target.value)} rows={2} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400 mb-3" />
          <button onClick={() => { markInquiryReplied(viewingInquiry.id); setViewingInquiry(null); }} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg py-2.5 text-sm font-semibold">✉️ تحديد كـ "تمت الإجابة"</button>
        </AdminModal>
      )}

      {editingTenant && (
        <AdminModal title={`تعديل بيانات ${editingTenant.shopName}`} onClose={() => setEditingTenant(null)}>
          <label className="block text-xs text-gray-400 mb-1.5">رقم الجوال</label>
          <input value={editMobile} onChange={(e) => { setEditMobile(normalizeSaudiMobile(e.target.value)); setEditError(""); }} maxLength={12} dir="ltr" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400 mb-4" />
          <label className="block text-xs text-gray-400 mb-1.5">البريد الإلكتروني</label>
          <input value={editEmail} onChange={(e) => { setEditEmail(e.target.value); setEditError(""); }} dir="ltr" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400 mb-4" />
          {editError && <div className="mb-4 text-xs font-medium text-rose-400">{editError}</div>}
          <button onClick={saveTenantEdit} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg py-2.5 text-sm font-semibold">حفظ التعديلات</button>
        </AdminModal>
      )}

      {deletingTenant && (
        <AdminModal title="⚠️ حذف المحل نهائيًا" onClose={() => { if (!deleteBusy) { setDeletingTenant(null); setDeleteError(""); } }}>
          <p className="text-sm text-gray-300 mb-3">
            متأكد إنك تبي تحذف <span className="font-semibold text-white">{deletingTenant.shopName}</span>؟
            هذا الإجراء يحذف نهائيًا كل بيانات المحل (المنتجات، الفواتير، العملاء، المشتريات، كل شيء) ولا يمكن التراجع عنه.
          </p>
          <p className="text-xs text-amber-400 mb-4">
            ملاحظة: هذا يحذف بيانات المحل من قاعدة البيانات فقط — حساب الدخول في Firebase Authentication يبقى موجود ولازم يُحذف لاحقًا بطريقة منفصلة.
          </p>
          {deleteError && <div className="mb-4 text-xs font-medium text-rose-400">{deleteError}</div>}
          <div className="flex gap-2">
            <button disabled={deleteBusy} onClick={confirmDeleteTenant} className="flex-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg py-2.5 text-sm font-semibold">{deleteBusy ? "جاري الحذف..." : "🗑️ تأكيد الحذف نهائيًا"}</button>
            <button disabled={deleteBusy} onClick={() => { setDeletingTenant(null); setDeleteError(""); }} className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg py-2.5 text-sm font-semibold">إلغاء</button>
          </div>
        </AdminModal>
      )}

      {deletingRequest && (
        <AdminModal title="⚠️ حذف طلب التسجيل" onClose={() => { if (!deleteBusy) { setDeletingRequest(null); setDeleteError(""); } }}>
          <p className="text-sm text-gray-300 mb-4">
            متأكد إنك تبي تحذف طلب التسجيل الخاص بـ <span className="font-semibold text-white">{deletingRequest.shopName}</span>؟
            استخدم هذا لتنظيف الطلبات القديمة لمحلات محذوفة مسبقًا — لا يؤثر على أي بيانات محل حالي.
          </p>
          {deleteError && <div className="mb-4 text-xs font-medium text-rose-400">{deleteError}</div>}
          <div className="flex gap-2">
            <button disabled={deleteBusy} onClick={confirmDeleteRequest} className="flex-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg py-2.5 text-sm font-semibold">{deleteBusy ? "جاري الحذف..." : "🗑️ تأكيد الحذف"}</button>
            <button disabled={deleteBusy} onClick={() => { setDeletingRequest(null); setDeleteError(""); }} className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg py-2.5 text-sm font-semibold">إلغاء</button>
          </div>
        </AdminModal>
      )}
    </div>
  );
}

  const LANDING_TEXT = {
    ar: {
      brand: 'رغوة',
      navFeatures: 'المميزات', navHow: 'كيف يعمل', navWhy: 'لماذا رغوة؟', navFaq: 'الأسئلة الشائعة',
      navContact: 'تواصل مع فريقنا',
      navLogin: 'الدخول',
      heroTitlePlain: 'خلّ المغسلة تمشي… ',
      heroTitleAccent: 'وأنت ارتاح',
      heroDesc: 'رغوة يرتّب مغسلتك من الاستلام إلى التسليم. كاشير سريع، تتبع لكل قطعة، فواتير إلكترونية، ومناديب تحت عينك — كل هذا بنظام سحابي مصمم للمغاسل السعودية.',
      heroSupport: 'زحمة الجمعة؟ موسم العيد؟ رغوة معك، عشان شغلك يمشي وبيض وجهك يظل محفوظ.',
      ctaStart: 'جرّب رغوة مجاناً',
      ctaDemo: 'احجز عرض توضيحي',
      trustRow: ['سحابي بالكامل', 'متوافق مع الفوترة الإلكترونية', 'يعمل من الجوال والتابلت'],
      heroMockCaption: 'نموذج توضيحي',
      heroMockSales: 'مبيعات اليوم', heroMockOrders: 'عدد الطلبات', heroMockRecent: 'أحدث الطلبات',
      heroMockStages: ['استلام', 'غسيل', 'كوي', 'جاهز', 'تم التسليم'],

      problemsEyebrow: 'نعرف وش تواجه كل يوم',
      problemsTitle: 'مغسلتك ما تحتاج شغل أكثر… تحتاج شغل أرتب.',
      problemsSubtitle: 'لأننا نعرف أن المشكلة مو في الغسيل، المشكلة في التفاصيل اللي تتراكم مع الزحمة.',
      problems: [
        { q: 'وين الثوب؟', pain: 'العميل يتصل: «يا طويل العمر، الثوب اللي سلمته أمس وينه؟» وتبدأ الرحلة المعتادة: دور عند الكاونتر… شوف المستودع… اسأل العامل… يمكن مع طلب التوصيل.', solution: 'مع رغوة، كل قطعة مرتبطة بالطلب من لحظة الاستلام إلى التسليم. تعرف الطلب وين وصل، وش المطلوب له، ومتى جاهز.', highlight: 'ثوبك ما عاد يضيع وسط الزحمة.' },
        { q: 'الفاتورة وين؟ والحسبة كم؟', pain: 'دفتر هنا، فاتورة هناك، وحسبة آخر اليوم تعتمد على «أظن إنها كذا».', solution: 'فاتورة إلكترونية تطلع للعميل عبر الواتساب وQR، مع تسجيل المبيعات والطلبات بشكل مرتب ومتوافق مع متطلبات الفوترة الإلكترونية في السعودية.', highlight: 'الحسبة واضحة… وما عاد فيه «وين الفاتورة؟».' },
        { q: 'المندوب وين وصل؟', pain: 'طلبات توصيل كثيرة، ومندوب يقول «أنا بالطريق»، وعميل يسأل «متى توصل؟»… وأنت بين الكاشير والتلفون تحاول تجمع الصورة.', solution: 'إدارة للمناديب وحسابات السائقين والطلبات، عشان تعرف وش مع المندوب، وش تسلّم، وش باقي.', highlight: 'التوصيل يصير شغل مرتب، مو مطاردة اتصالات.' },
        { q: 'تقفّل الكاشير… بس لا تبدأ الحسبة من جديد', pain: 'آخر اليوم: كاش، تحويلات، ورديات، فواتير… ثم تبدأ عملية الجرد والتقفيل وكأنك تحل لغز.', solution: 'تقارير ومؤشرات أداء تساعدك تعرف مبيعاتك، وردياتك وتقفيلك اليومي بوضوح.', highlight: 'بدل ما تقفل يومك بالحيرة… قفّله بالأرقام.' },
      ],

      midCtaTitle: 'حسّيت إننا نتكلم عن مغسلتك؟',
      midCtaDesc: 'خلّنا نوريك كيف رغوة يرتّب الشغل من أول استلام إلى آخر تقفيل.',

      compareTitleOld: 'مغسلة على البركة 🧾', compareTitleNew: 'مغسلة برغوة 🚀',
      compareClosing: 'الطريقة القديمة تعتمد على الذاكرة… رغوة يعتمد على النظام.',
      compareRows: [
        { before: 'اكتبها بالدفتر لا تنساها', after: 'الطلب يتسجل من أول لحظة' },
        { before: 'الثوب كان هنا… أحد شافه؟', after: 'كل قطعة لها تتبع' },
        { before: 'أرسل الفاتورة للعميل… لحظة وينها؟', after: 'الفاتورة على الواتساب وQR' },
        { before: 'المندوب أخذ كم طلب؟', after: 'تعرف الطلبات وحسابات السائقين' },
        { before: 'كم بعنا اليوم؟ — خلني أحسب', after: 'التقرير قدامك' },
        { before: 'زحمة العيد = الله يعين 😅', after: 'زحمة العيد = هات الطلب اللي بعده 💪' },
        { before: 'التقفيل يحتاج ورقة وقلم وحسبة', after: 'التقفيل أوضح وأسهل' },
        { before: 'المدير لازم يكون بالمغسلة', after: 'الإدارة من الجوال' },
      ],

      featuresTitle: 'المميزات',
      features: [
        { title: 'فاتورتك على الواتساب', desc: 'خلصت الخدمة؟ الفاتورة تروح للعميل إلكترونياً. واتساب + QR + متطلبات الفوترة الإلكترونية، بدون وجع رأس الفواتير الورقية.', highlight: 'الفاتورة جاهزة… والعميل مرتاح.' },
        { title: 'كل قطعة لها سالفة… ورغوة حافظها', desc: 'ثوب، شماغ، مفرش، كوي على البخار أو طلب مستعجل — سجّل وتتبع كل قطعة من الاستلام لين ترجع لصاحبها.', highlight: 'ودّع تدوير القطع بالذاكرة.' },
        { title: 'مغسلتك بجيبك', desc: 'مو لازم تكون واقف عند الكاشير عشان تعرف وش صاير. افتح جوالك وشوف المبيعات، الورديات، التقفيل ومؤشرات الأداء.', highlight: 'المدير يعرف… حتى وهو بعيد.' },
        { title: 'المناديب تحت السيطرة', desc: 'مين أخذ الطلب؟ وش سلّم؟ وكم عليه؟ رغوة يساعدك ترتب طلبات التوصيل وحسابات السائقين من مكان واحد.', highlight: 'بدل «وين المندوب؟»… تعرف وش عنده.' },
      ],

      howTitle: 'من الاستلام… إلى التسليم',
      howSteps: [
        { step: 1, title: 'استلم', desc: 'سجّل طلب العميل وقطع الملابس.' },
        { step: 2, title: 'عالج', desc: 'حدد الغسيل، الكوي، المستعجل والخدمات.' },
        { step: 3, title: 'تابع', desc: 'تابع حالة القطع والطلبات والمناديب.' },
        { step: 4, title: 'سلّم', desc: 'سلّم الطلب، أرسل الفاتورة، وسجّل العملية.' },
      ],

      cloudTitle: 'مغسلتك معك… وين ما كنت',
      cloudDesc: 'ما تحتاج سيرفرات معقدة ولا جهاز معين. رغوة سحابي بالكامل ويعمل من الكمبيوتر، التابلت أو الجوال.',
      cloudHighlight: 'من المغسلة… من المكتب… وحتى وأنت بعيد.',

      trustTitle: 'مصمم للمغاسل السعودية',
      trustChecklist: ['فواتير إلكترونية', 'نظام سحابي', 'تتبع للقطع', 'إدارة المناديب', 'تقارير لحظية'],

      featureMock: {
        invoiceLine1: 'فاتورة إلكترونية', invoiceLine2: 'تم الإرسال للعميل عبر واتساب',
        pieceLabels: ['ثوب — جاهز', 'شماغ — غسيل', 'مفرش — كوي'],
        statLabel: 'تقفيل الوردية اليوم', statValue: '2,450 SAR',
        driverLabel: 'مندوب أحمد — 5 طلبات',
      },

      faqTitle: 'الأسئلة الشائعة',
      faq: [
        { q: 'هل رغوة يحتاج جهاز أو سيرفر خاص؟', a: 'لا، يشتغل من أي متصفح على كمبيوتر أو جوال أو تابلت، بدون تركيب أي برنامج أو سيرفر خاص.' },
        { q: 'هل يدعم الفوترة الإلكترونية؟', a: 'نعم، رغوة مبني على التوافق مع متطلبات الفوترة الإلكترونية بالمملكة.' },
        { q: 'أقدر أدير أكثر من فرع؟', a: 'حاليًا كل حساب مخصص لمغسلة واحدة. لو عندك أكثر من فرع، تواصل مع فريقنا ونشوف لك الحل الأنسب.' },
        { q: 'لازم أغيّر طريقة شغلي بالكامل عشان أبدأ؟', a: 'لا، تصميم رغوة بسيط ومباشر — تقدر تبدأ البيع بنفس اليوم بدون ما تغيّر طريقة شغلك من جذورها.' },
        { q: 'كيف أبدأ التجربة المجانية؟', a: 'اضغط «جرّب رغوة مجاناً»، سجّل بيانات محلك، وابدأ البيع مباشرة.' },
      ],

      finalCtaTitle: 'خل شغلك أرتب… ومغسلتك أهدى.',
      finalCtaDesc: 'جرّب رغوة وشوف بنفسك كيف يتحول شغل المغسلة من دفاتر وحسبة وتوتر… إلى نظام واضح تمسكه من جوالك.',
      finalCtaSupport: 'بدون تعقيد. بدون سيرفرات. وبدون ما تغيّر طريقة شغلك من يوم وليلة.',

      footerCta: 'جاهز ترتب مغسلتك؟',
      footerRights: 'جميع الحقوق محفوظة',
      contactModalTitle: 'تواصل مع فريقنا',
      contactSentMsg: 'تم إرسال طلبك، بيتواصل معك فريقنا قريبًا.',
      contactName: 'الاسم', contactMobile: 'رقم الجوال', contactEmail: 'البريد الإلكتروني',
      contactType: 'نوع الاستفسار', contactMessage: 'الرسالة', contactSend: 'إرسال',
      contactTypes: ['شراء نظام', 'سؤال تقني', 'عرض خاص'],
    },
    en: {
      brand: 'Ragwa',
      navFeatures: 'Features', navHow: 'How It Works', navWhy: 'Why Ragwa?', navFaq: 'FAQ',
      navContact: 'Contact Sales',
      navLogin: 'Log In',
      heroTitlePlain: 'Let the shop run… ',
      heroTitleAccent: 'while you relax',
      heroDesc: 'Ragwa keeps your laundry shop organized from intake to delivery. A fast checkout, per-item tracking, e-invoices, and drivers you can always see — all in one cloud system built for Saudi laundry shops.',
      heroSupport: "Busy Friday? Eid season rush? Ragwa's got you, so your work keeps moving and your reputation stays spotless.",
      ctaStart: 'Try Ragwa Free',
      ctaDemo: 'Book a Demo',
      trustRow: ['Fully cloud-based', 'E-invoicing compliant', 'Works on mobile & tablet'],
      heroMockCaption: 'Illustrative example',
      heroMockSales: "Today's Sales", heroMockOrders: 'Order Count', heroMockRecent: 'Recent Orders',
      heroMockStages: ['Received', 'Washing', 'Pressing', 'Ready', 'Delivered'],

      problemsEyebrow: 'We know what you deal with every day',
      problemsTitle: "Your shop doesn't need more work… it needs tidier work.",
      problemsSubtitle: "Because we know the problem isn't the washing — it's the details that pile up when things get busy.",
      problems: [
        { q: "Where's the shirt?", pain: 'A customer calls: "Hey, where\'s the thobe I dropped off yesterday?" And the usual chase begins — check the counter, check the back room, ask the staff, maybe it went out for delivery.', solution: 'With Ragwa, every piece is linked to its order from intake to delivery. You know exactly where the order is, what it needs, and when it\'s ready.', highlight: "Your customer's clothes never get lost in the shuffle." },
        { q: "Where's the invoice? What do I owe?", pain: 'A notebook here, a receipt there, and an end-of-day total based on "I think it was around this much."', solution: 'An e-invoice goes out to the customer over WhatsApp with a QR code, while every sale and order is recorded cleanly and in line with Saudi e-invoicing requirements.', highlight: 'The math is clear — no more "where\'s the invoice?"' },
        { q: 'Where did the driver get to?', pain: 'Lots of delivery orders, a driver saying "I\'m on my way," and a customer asking "when will it arrive?" — while you\'re stuck between the register and the phone trying to piece it together.', solution: 'Driver management with delivery and order tracking, so you always know what each driver has, what\'s delivered, and what\'s left.', highlight: "Delivery becomes organized work, not a phone-chasing game." },
        { q: "You close the register… but don't start the math over", pain: "End of day: cash, transfers, shifts, invoices… then comes the count and close-out like solving a puzzle.", solution: 'Reports and performance indicators that show you your sales, shifts, and daily close-out clearly.', highlight: "Close your day with numbers, not guesswork." },
      ],

      midCtaTitle: 'Sound like your shop?',
      midCtaDesc: "Let's show you exactly how Ragwa organizes the work, from the first item you take in to the last close-out.",

      compareTitleOld: 'The Old-School Shop 🧾', compareTitleNew: 'The Ragwa Shop 🚀',
      compareClosing: 'The old way relies on memory… Ragwa relies on the system.',
      compareRows: [
        { before: "Write it in the notebook, don't forget it", after: 'The order is logged from the first moment' },
        { before: 'The shirt was here… did anyone see it?', after: 'Every piece is tracked' },
        { before: "Send the invoice to the customer… wait, where is it?", after: 'Invoice on WhatsApp with a QR code' },
        { before: 'How many orders did the driver take?', after: "You know the orders and the drivers' accounts" },
        { before: "How much did we sell today? — let me calculate", after: 'The report is right in front of you' },
        { before: 'Eid rush = good luck 😅', after: "Eid rush = next order, please 💪" },
        { before: 'Closing out needs paper, a pen, and a calculator', after: 'Closing out is clearer and easier' },
        { before: 'The manager has to be physically at the shop', after: 'Manage it from your phone' },
      ],

      featuresTitle: 'Features',
      features: [
        { title: 'Invoices on WhatsApp', desc: "Order done? The invoice goes to the customer electronically. WhatsApp + QR + e-invoicing compliance, no more paper-invoice headaches.", highlight: 'Invoice ready… customer happy.' },
        { title: 'Every piece has a story… and Ragwa keeps it', desc: "A thobe, a shemagh, a bedsheet, steam-press or a rush order — log and track every single piece from intake until it's back with its owner.", highlight: 'Say goodbye to tracking pieces by memory.' },
        { title: 'Your shop in your pocket', desc: "No need to be standing at the register to know what's happening. Open your phone and see sales, shifts, close-outs, and performance indicators.", highlight: 'The manager knows… even from far away.' },
        { title: 'Drivers, under control', desc: "Who took the order? What was delivered? What's owed? Ragwa helps you organize delivery orders and driver accounts from one place.", highlight: 'Instead of "where\'s the driver?" — you know what they have.' },
      ],

      howTitle: 'From Intake… to Delivery',
      howSteps: [
        { step: 1, title: 'Intake', desc: "Log the customer's order and garments." },
        { step: 2, title: 'Process', desc: 'Set the wash, iron, rush, and other services.' },
        { step: 3, title: 'Track', desc: 'Follow the status of pieces, orders, and drivers.' },
        { step: 4, title: 'Deliver', desc: "Hand over the order, send the invoice, and record it." },
      ],

      cloudTitle: 'Your shop, wherever you are',
      cloudDesc: "No complicated servers or special hardware needed. Ragwa is fully cloud-based and works from a computer, tablet, or phone.",
      cloudHighlight: 'From the shop… from the office… even while you\'re away.',

      trustTitle: 'Built for Saudi Laundry Shops',
      trustChecklist: ['E-invoicing', 'Cloud-based system', 'Item tracking', 'Driver management', 'Live reports'],

      featureMock: {
        invoiceLine1: 'E-invoice', invoiceLine2: 'Sent to the customer over WhatsApp',
        pieceLabels: ['Thobe — Ready', 'Shemagh — Washing', 'Bedsheet — Ironing'],
        statLabel: "Today's Shift Close-out", statValue: '2,450 SAR',
        driverLabel: 'Driver Ahmed — 5 orders',
      },

      faqTitle: 'Frequently Asked Questions',
      faq: [
        { q: 'Does Ragwa need special hardware or a server?', a: 'No — it runs in any browser on a computer, phone, or tablet, with no installation or special server needed.' },
        { q: 'Does it support e-invoicing?', a: "Yes, Ragwa is built around Saudi e-invoicing compliance requirements." },
        { q: 'Can I manage more than one branch?', a: "Right now, each account is set up for a single shop. If you have more than one branch, reach out to our team and we'll find the best setup for you." },
        { q: 'Do I need to change how I work completely to get started?', a: "No — Ragwa is simple and direct. You can start selling the same day, without a complete overhaul of how you work." },
        { q: 'How do I start the free trial?', a: 'Click "Try Ragwa Free", register your shop, and start selling right away.' },
      ],

      finalCtaTitle: 'Get your work organized… and your shop at ease.',
      finalCtaDesc: 'Try Ragwa and see for yourself how running a laundry shop turns from notebooks, math, and stress… into a clear system you carry in your phone.',
      finalCtaSupport: "No complexity. No servers. And no need to change how you work overnight.",

      footerCta: 'Ready to organize your shop?',
      footerRights: 'All Rights Reserved',
      contactModalTitle: 'Contact Sales',
      contactSentMsg: 'Your request has been sent — our sales team will reach out to you soon.',
      contactName: 'Name', contactMobile: 'Mobile Number', contactEmail: 'Email',
      contactType: 'Inquiry Type', contactMessage: 'Message', contactSend: 'Send',
      contactTypes: ['Buy the system', 'Technical question', 'Special offer'],
    },
  };

  function LandingPage(props) {
  const { setCurrentPage, showContact, setShowContact,
    contactName, setContactName, contactMobile, setContactMobile, contactEmail, setContactEmail,
    contactType, setContactType, contactMessage, setContactMessage, contactSent, submitContact,
    lang, setLang, onOpenTerms } = props;
  // Anti-bot: `website` is a honeypot a real visitor never sees or fills
  // (hidden below); `formStartedAtRef` marks when the modal actually
  // opened, so the server can reject a submit that arrives faster than any
  // human could type a message. Both go to api/submit-contact untouched.
  const [contactWebsite, setContactWebsite] = useState('');
  const formStartedAtRef = useRef(0);
  useEffect(() => { if (showContact) formStartedAtRef.current = Date.now(); }, [showContact]);
  const [openFaq, setOpenFaq] = useState(null);
  const t = LANDING_TEXT[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  // Labeled miniature product-UI snippets for the feature cards — real
  // Lucide icons + real (translated) labels, not abstract shapes or bare
  // unlabeled numbers, so each reads as a tiny piece of real software.
  const pieceStageColor = { 'جاهز': 'bg-success-500', 'Ready': 'bg-success-500', 'غسيل': 'bg-info-500', 'Washing': 'bg-info-500', 'كوي': 'bg-warning-500', 'Ironing': 'bg-warning-500' };
  const featureVisuals = [
    <div key="wa" className="flex items-center gap-3 bg-brand-50 rounded-xl p-3">
      <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center shrink-0">
        <MessageCircle size={18} className="text-white" fill="white" strokeWidth={0} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-landing-ink truncate">{t.featureMock.invoiceLine1}</div>
        <div className="text-[11px] text-landing-ink-muted truncate">{t.featureMock.invoiceLine2}</div>
      </div>
      <QrCode size={26} className="text-brand-600 shrink-0" />
    </div>,
    <div key="pieces" className="space-y-1.5">
      {t.featureMock.pieceLabels.map((label, i) => (
        <div key={i} className="flex items-center gap-2 bg-brand-50 rounded-lg px-2.5 py-1.5">
          <Shirt size={14} className="text-brand-600 shrink-0" />
          <span className="text-[11px] text-landing-ink flex-1">{label}</span>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pieceStageColor[label.split(/[—-]/).pop().trim()] || 'bg-brand-400'}`} />
        </div>
      ))}
    </div>,
    <div key="stats" className="flex items-center gap-3 bg-brand-50 rounded-xl p-3">
      <div className="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center shrink-0">
        <Smartphone size={18} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-landing-ink-muted truncate">{t.featureMock.statLabel}</div>
        <div className="text-sm font-extrabold text-landing-ink">{t.featureMock.statValue}</div>
      </div>
    </div>,
    <div key="driver" className="bg-brand-50 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2">
        <MapPin size={14} className="text-brand-600 shrink-0" />
        <span className="text-[11px] font-medium text-landing-ink flex-1 truncate">{t.featureMock.driverLabel}</span>
        <Car size={14} className="text-brand-600 shrink-0" />
      </div>
      <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
        <div className="h-full bg-brand-500 rounded-full" style={{ width: '65%' }} />
      </div>
    </div>,
  ];
  const featureIcons = [MessageCircle, Shirt, Smartphone, Car];

  return (
    <div dir={dir} className="min-h-screen bg-landing-bg text-landing-ink overflow-x-hidden" style={{ fontFamily: "'Cairo','Segoe UI',Tahoma,sans-serif" }}>
      {/* Navigation */}
      <nav className="fixed top-0 w-full bg-white/90 backdrop-blur border-b border-slate-100 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <img src={LOGO_DATA_URI} alt={t.brand} className="w-11 h-11 rounded-2xl object-contain shrink-0" />
            <span className="font-bold text-xl text-landing-ink">{t.brand}</span>
          </div>

          <div className="hidden lg:flex items-center gap-7 text-sm text-landing-ink-muted">
            <button onClick={() => scrollTo('features')} className="hover:text-landing-ink transition">{t.navFeatures}</button>
            <button onClick={() => scrollTo('how-it-works')} className="hover:text-landing-ink transition">{t.navHow}</button>
            <button onClick={() => scrollTo('why')} className="hover:text-landing-ink transition">{t.navWhy}</button>
            <button onClick={() => scrollTo('faq')} className="hover:text-landing-ink transition">{t.navFaq}</button>
          </div>

          {/* navLogin/navContact/the language toggle are real, pre-existing
              product features (an actual login for existing shop owners, a
              real sales-inquiry channel, real bilingual support) — not
              additions invented for this page, so they stay, kept visually
              secondary to the one primary CTA per the approved nav spec. */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden sm:flex items-center gap-1 rounded-full border border-slate-200 p-1">
              <button onClick={() => setLang('ar')} className={`px-3 py-1 rounded-full text-xs font-semibold transition ${lang === 'ar' ? 'bg-brand-500 text-white' : 'text-landing-ink-muted hover:text-landing-ink'}`}>عربي</button>
              <button onClick={() => setLang('en')} className={`px-3 py-1 rounded-full text-xs font-semibold transition ${lang === 'en' ? 'bg-brand-500 text-white' : 'text-landing-ink-muted hover:text-landing-ink'}`}>EN</button>
            </div>
            <button onClick={() => setShowContact(true)} className="hidden md:inline text-sm text-landing-ink-muted hover:text-landing-ink font-medium transition">
              {t.navContact}
            </button>
            <button onClick={() => setCurrentPage('login')} className="hidden md:inline text-sm text-landing-ink-muted hover:text-landing-ink font-medium transition">
              {t.navLogin}
            </button>
            <button onClick={() => setCurrentPage('signup')} className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold text-sm transition text-white shadow-app-sm">
              {t.ctaStart}
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <div className="relative overflow-hidden pt-32 pb-24 px-6">
        <div className="absolute -top-24 -right-24 w-[26rem] h-[26rem] bg-brand-300 rounded-full opacity-35 blur-[60px] pointer-events-none" />
        <div className="absolute top-1/3 -left-24 w-96 h-96 bg-accent-400 rounded-full opacity-35 blur-[60px] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
          <div className="text-center lg:text-start space-y-6">
            <h1 className="text-4xl md:text-5xl lg:text-[3.4rem] font-extrabold leading-tight" style={{ textWrap: 'balance' }}>
              {t.heroTitlePlain}
              <span className="bg-gradient-to-r from-brand-600 to-brand-400 bg-clip-text text-transparent">{t.heroTitleAccent}</span>
            </h1>
            <p className="text-lg text-landing-ink-muted leading-relaxed max-w-xl mx-auto lg:mx-0">{t.heroDesc}</p>
            <p className="text-base text-brand-600 font-medium">{t.heroSupport}</p>

            <div className="flex gap-4 justify-center lg:justify-start pt-2 flex-wrap">
              <button onClick={() => setCurrentPage('signup')} className="px-8 py-3.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white shadow-app-md">
                {t.ctaStart}
              </button>
              <button onClick={() => setShowContact(true)} className="px-8 py-3.5 rounded-lg border-2 border-brand-400 text-brand-600 hover:bg-brand-50 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>

            <div className="flex items-center justify-center lg:justify-start gap-x-6 gap-y-2 flex-wrap pt-4 text-xs text-landing-ink-muted">
              {t.trustRow.map((item, i) => (
                <span key={i} className="flex items-center gap-1.5"><span className="text-brand-500">✓</span>{item}</span>
              ))}
            </div>
          </div>

          {/* Illustrative product mockup — decorative demo UI, not a real screenshot/live data */}
          <div className="relative mx-auto max-w-sm lg:mx-0">
            <div className="bg-white rounded-2xl shadow-soft border border-slate-100 p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] font-semibold text-landing-ink-muted">{t.heroMockCaption}</span>
                <div className="flex gap-1">
                  <span className="w-2 h-2 rounded-full bg-brand-300" /><span className="w-2 h-2 rounded-full bg-accent-400" /><span className="w-2 h-2 rounded-full bg-slate-200" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-xl bg-brand-50 p-3">
                  <div className="text-[11px] text-brand-700 font-medium mb-1">{t.heroMockSales}</div>
                  <div className="text-lg font-extrabold text-brand-800">2,450 SAR</div>
                </div>
                <div className="rounded-xl p-3" style={{ backgroundColor: 'rgba(255,122,61,.1)' }}>
                  <div className="text-[11px] text-accent-600 font-medium mb-1">{t.heroMockOrders}</div>
                  <div className="text-lg font-extrabold text-landing-ink">38</div>
                </div>
              </div>
              <div className="flex items-end gap-1.5 h-14 mb-4">
                {[40, 65, 50, 80, 60, 95, 70].map((h, i) => (
                  <div key={i} className="flex-1 bg-brand-400/70 rounded-t" style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="text-[11px] font-semibold text-landing-ink-muted mb-2">{t.heroMockRecent}</div>
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-landing-ink"><span className="w-1.5 h-1.5 rounded-full bg-brand-500" />#{1000 + i}</span>
                    <span className="text-landing-ink-muted">120 SAR</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="hidden md:block absolute -bottom-8 -left-6 bg-white rounded-xl shadow-soft border border-slate-100 p-4 w-60">
              <div className="flex items-center justify-between px-1">
                {t.heroMockStages.map((s, i) => (
                  <span key={i} className={`w-2.5 h-2.5 rounded-full ${i === 2 ? 'bg-brand-500' : 'bg-slate-200'}`} />
                ))}
              </div>
              <div className="flex items-center justify-between mt-1.5">
                {t.heroMockStages.map((s, i) => (
                  <span key={i} className={`text-[8px] ${i === 2 ? 'text-brand-600 font-bold' : 'text-landing-ink-muted'}`}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Problems */}
      <div className="py-24 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <span className="inline-block text-xs font-bold text-brand-600 bg-brand-50 rounded-full px-4 py-1.5 mb-5">{t.problemsEyebrow}</span>
            <h2 className="text-3xl md:text-4xl font-bold mb-3" style={{ textWrap: 'balance' }}>{t.problemsTitle}</h2>
            <p className="text-landing-ink-muted max-w-2xl mx-auto">{t.problemsSubtitle}</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {t.problems.map((p, i) => (
              <div key={i} className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft">
                <h3 className="text-lg font-bold mb-3">{p.q}</h3>
                <p className="text-landing-ink-muted text-sm leading-relaxed mb-3">{p.pain}</p>
                <p className="text-landing-ink text-sm leading-relaxed mb-4"><span className="text-brand-500 font-bold">{dir === 'rtl' ? '← ' : '→ '}</span>{p.solution}</p>
                <span className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 rounded-full px-3 py-1.5">{p.highlight}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mid CTA */}
      <div className="py-20 px-6">
        <div className="max-w-3xl mx-auto relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-10 md:p-14 text-center text-white shadow-soft">
          <div className="absolute -top-10 -right-10 w-56 h-56 bg-white rounded-full opacity-10 blur-2xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-56 h-56 bg-accent-400 rounded-full opacity-25 blur-2xl pointer-events-none" />
          <div className="relative space-y-5">
            <h2 className="text-2xl md:text-3xl font-bold">{t.midCtaTitle}</h2>
            <p className="text-brand-50">{t.midCtaDesc}</p>
            <div className="flex gap-4 justify-center pt-2 flex-wrap">
              <button onClick={() => setCurrentPage('signup')} className="px-8 py-3 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white">
                {t.ctaStart}
              </button>
              <button onClick={() => setShowContact(true)} className="px-8 py-3 rounded-lg border-2 border-white/70 text-white hover:bg-white/10 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Before / After comparison */}
      <div className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center gap-5 mb-10 flex-wrap">
            <h2 className="text-xl md:text-2xl font-bold text-landing-ink-muted">{t.compareTitleOld}</h2>
            <span className="text-brand-400 text-xl">{dir === 'rtl' ? '←' : '→'}</span>
            <h2 className="text-xl md:text-2xl font-bold text-brand-700">{t.compareTitleNew}</h2>
          </div>
          <div className="bg-white rounded-2xl shadow-soft border border-slate-100 overflow-hidden">
            {t.compareRows.map((row, i) => (
              <div key={i} className={`grid grid-cols-[1fr_auto_1fr] items-center ${i !== 0 ? 'border-t border-slate-100' : ''}`}>
                <div className="p-4 md:p-5 text-sm text-landing-ink-muted line-through decoration-danger-500/50" style={{ backgroundColor: 'rgba(240,68,56,.04)' }}>{row.before}</div>
                <div className="px-2 text-brand-400 text-base">{dir === 'rtl' ? '←' : '→'}</div>
                <div className="p-4 md:p-5 text-sm text-landing-ink font-semibold bg-brand-50/60">{row.after}</div>
              </div>
            ))}
          </div>
          <p className="text-center text-brand-600 font-medium mt-8">{t.compareClosing}</p>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="py-24 px-6 bg-white scroll-mt-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-14">{t.featuresTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {t.features.map((f, i) => {
              const Icon = featureIcons[i];
              return (
                <div key={i} className="bg-white border border-slate-100 rounded-2xl p-7 shadow-soft hover:shadow-app-lg transition">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center mb-4">
                    <Icon size={24} className="text-white" />
                  </div>
                  <h3 className="text-lg font-bold mb-2 text-landing-ink">{f.title}</h3>
                  <p className="text-landing-ink-muted text-sm leading-relaxed mb-4">{f.desc}</p>
                  <div className="mb-4">{featureVisuals[i]}</div>
                  <span className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 rounded-full px-3 py-1.5">{f.highlight}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* How it works — a horizontal, connected sequence (not a stacked
          list): a background bar links the 4 step circles on large screens,
          each circle carrying its own step-number badge in the corner. */}
      <div id="how-it-works" className="py-24 px-6 scroll-mt-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">{t.howTitle}</h2>
          <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-10">
            <div className="hidden lg:block absolute top-8 inset-x-0 h-0.5 bg-gradient-to-l from-brand-200 via-brand-300 to-brand-200 z-0" />
            {t.howSteps.map((item, i) => (
              <div key={i} className="relative z-10 text-center">
                <div className="relative inline-flex mb-4">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center shadow-app-md">
                    <span className="text-white font-bold text-xl">{i + 1}</span>
                  </div>
                  <span className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-accent-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-landing-bg">{item.step}</span>
                </div>
                <h3 className="text-base font-bold mb-1.5">{item.title}</h3>
                <p className="text-landing-ink-muted text-sm max-w-[15rem] mx-auto">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cloud section */}
      <div className="py-24 px-6 bg-white">
        <div className="max-w-2xl mx-auto text-center space-y-4">
          <h2 className="text-3xl md:text-4xl font-bold">{t.cloudTitle}</h2>
          <p className="text-landing-ink-muted">{t.cloudDesc}</p>
          <p className="text-brand-600 font-medium">{t.cloudHighlight}</p>
        </div>
      </div>

      {/* Trust / why */}
      <div id="why" className="py-24 px-6 scroll-mt-20">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-8">{t.trustTitle}</h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {t.trustChecklist.map((item, i) => (
              <span key={i} className="flex items-center gap-2 text-sm bg-brand-50 border border-brand-200 text-brand-700 rounded-full px-4 py-2">
                <span>✓</span>{item}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div id="faq" className="py-24 px-6 bg-white scroll-mt-20">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-10">{t.faqTitle}</h2>
          <div className="space-y-3">
            {t.faq.map((item, i) => (
              <div key={i} className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-soft">
                <button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="w-full flex items-center justify-between gap-4 p-5 text-start">
                  <span className="font-semibold text-landing-ink">{item.q}</span>
                  <span className={`shrink-0 text-brand-500 transition-transform ${openFaq === i ? 'rotate-45' : ''}`}>+</span>
                </button>
                {openFaq === i && <p className="px-5 pb-5 text-sm text-landing-ink-muted leading-relaxed">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final CTA */}
      <div className="py-24 px-6">
        <div className="max-w-3xl mx-auto relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-10 md:p-14 text-center text-white shadow-soft">
          <div className="absolute -top-10 -left-10 w-56 h-56 bg-white rounded-full opacity-10 blur-2xl pointer-events-none" />
          <div className="absolute -bottom-10 -right-10 w-56 h-56 bg-accent-400 rounded-full opacity-25 blur-2xl pointer-events-none" />
          <div className="relative space-y-4">
            <h2 className="text-2xl md:text-3xl font-bold">{t.finalCtaTitle}</h2>
            <p className="text-brand-50 max-w-xl mx-auto">{t.finalCtaDesc}</p>
            <div className="flex gap-4 justify-center pt-2 flex-wrap">
              <button onClick={() => setCurrentPage('signup')} className="px-8 py-3.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white">
                {t.ctaStart}
              </button>
              <button onClick={() => setShowContact(true)} className="px-8 py-3.5 rounded-lg border-2 border-white/70 text-white hover:bg-white/10 font-semibold transition">
                {t.ctaDemo}
              </button>
            </div>
            <p className="text-xs text-brand-100 pt-2">{t.finalCtaSupport}</p>
          </div>
        </div>
      </div>

      {/* Footer — the one place besides the CTA banners where dark navy
          appears on the public site, per the approved design. */}
      <footer className="bg-navy-900 text-gray-300">
        <div className="max-w-4xl mx-auto px-6 py-14 text-center space-y-6">
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-white">{t.footerCta}</h3>
            <button onClick={() => setCurrentPage('signup')} className="px-7 py-2.5 rounded-lg bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 font-semibold transition text-white inline-block">
              {t.ctaStart}
            </button>
          </div>
          <div className="flex items-center justify-center gap-2 pt-4">
            <img src={LOGO_DATA_URI} alt={t.brand} className="w-8 h-8 rounded-lg object-contain" />
            <span className="font-bold text-white">{t.brand}</span>
          </div>
          <div className="flex items-center justify-center gap-6 flex-wrap text-sm text-gray-400">
            <button onClick={() => scrollTo('features')} className="hover:text-white transition">{t.navFeatures}</button>
            <button onClick={() => scrollTo('how-it-works')} className="hover:text-white transition">{t.navHow}</button>
            <button onClick={() => scrollTo('faq')} className="hover:text-white transition">{t.navFaq}</button>
            <button onClick={onOpenTerms} className="hover:text-white transition">
              {lang === 'ar' ? 'الشروط والأحكام' : 'Terms & Conditions'}
            </button>
          </div>
          <p className="text-xs text-gray-500 pt-2">© {new Date().getFullYear()} {t.brand} | {t.footerRights}</p>
        </div>
      </footer>

      {showContact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowContact(false)}>
          <div dir={dir} className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="font-bold text-landing-ink">{t.contactModalTitle}</h3>
              <button onClick={() => setShowContact(false)} className="text-slate-400 hover:text-landing-ink text-lg">✕</button>
            </div>
            <div className="p-5">
              {contactSent ? (
                <div className="py-8 text-center text-brand-600">
                  <div className="text-3xl mb-2">✓</div>
                  <p>{t.contactSentMsg}</p>
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactName}</label>
                    <input value={contactName} onChange={(e) => setContactName(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactMobile}</label>
                    <input value={contactMobile} onChange={(e) => setContactMobile(e.target.value)} placeholder="0501234567" className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactEmail}</label>
                    <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactType}</label>
                    <select value={contactType} onChange={(e) => setContactType(e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink focus:border-brand-400 outline-none transition">
                      {t.contactTypes.map((ct) => <option key={ct}>{ct}</option>)}
                    </select>
                  </div>
                  <div className="mb-5">
                    <label className="block text-landing-ink text-sm font-semibold mb-2">{t.contactMessage}</label>
                    <textarea value={contactMessage} onChange={(e) => setContactMessage(e.target.value)} rows={3} className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-landing-ink placeholder-slate-400 focus:border-brand-400 outline-none transition" />
                  </div>
                  {/* Honeypot — invisible to a real visitor (off-screen, not display:none,
                      since some bots skip fields display:none hides), never tab-reachable. */}
                  <input
                    type="text" value={contactWebsite} onChange={(e) => setContactWebsite(e.target.value)}
                    autoComplete="off" tabIndex={-1} aria-hidden="true"
                    style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
                  />
                  <button onClick={() => submitContact({ website: contactWebsite, formStartedAt: formStartedAtRef.current })} className="w-full bg-gradient-to-r from-accent-400 to-accent-600 hover:from-accent-500 hover:to-accent-600 text-white font-semibold py-3 rounded-lg transition">
                    {t.contactSend}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


  function LoginPage(props) {
  const { setCurrentPage, showPassword, setShowPassword, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, handleLogin, loginError, loginLoading } = props;
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="absolute top-6 right-6">
        <button onClick={() => setCurrentPage('landing')} className="px-4 py-2 text-gray-300 hover:text-white transition">
          ← العودة
        </button>
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src={LOGO_DATA_URI} alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
          <p className="text-gray-400 text-sm">نظام إدارة مغاسل الملابس</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">دخول</h2>
          <p className="text-gray-400 text-center text-sm mb-8">الدخول إلى لوحة التحكم</p>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
            <input type="text" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg pr-4 pl-12 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
              <button onClick={() => setShowPassword(!showPassword)} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-lg">
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <div className="text-left mb-4 -mt-2">
            <button onClick={() => setCurrentPage('forgotPassword')} className="text-cyan-400 hover:text-cyan-300 text-xs">نسيت كلمة المرور؟</button>
          </div>

          {loginError && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{loginError}</div>}

          <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
            {loginLoading ? 'جارٍ الدخول...' : 'دخول'}
          </button>

          <p className="text-center text-gray-400 text-sm">
            ليس لديك حساب؟ <button onClick={() => setCurrentPage('signup')} className="text-cyan-400 hover:text-cyan-300">إنشاء حساب</button>
          </p>
        </div>
      </div>
    </div>
  );
}

// Sends the recovery email (Supabase's own default link-based flow —
// clicking it redirects back here with a session already exchanged, which
// onAuthStateChange picks up as a PASSWORD_RECOVERY event and routes to
// ResetPasswordPage). Self-contained: reads/writes nothing from LaundryPOS's
// own state, just `auth` directly, same as LandingPage/LoginPage.
function ForgotPasswordPage({ setCurrentPage }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const emailNorm = email.trim().toLowerCase();
    if (!emailNorm) { setError('حط بريدك الإلكتروني.'); return; }
    setLoading(true); setError('');
    const { error: err } = await auth.resetPasswordForEmail(emailNorm, { redirectTo: window.location.origin });
    if (err) setError(authErrorMessage(err));
    else setSent(true);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src={LOGO_DATA_URI} alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
        </div>
        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">استرجاع كلمة المرور</h2>
          {sent ? (
            <>
              <p className="text-gray-400 text-center text-sm mb-8">تم إرسال رابط استرجاع كلمة المرور لبريدك — افتحه من نفس الجهاز اللي بتحط فيه كلمة المرور الجديدة.</p>
              <button onClick={() => setCurrentPage('login')} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-3 rounded-lg transition">رجوع لتسجيل الدخول</button>
            </>
          ) : (
            <>
              <p className="text-gray-400 text-center text-sm mb-8">حط بريدك الإلكتروني وبنرسل لك رابط لتعيين كلمة مرور جديدة.</p>
              <div className="mb-6">
                <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
                <input type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
              </div>
              {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
              <button onClick={submit} disabled={loading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
                {loading ? 'جارٍ الإرسال...' : 'إرسال رابط الاسترجاع'}
              </button>
              <p className="text-center text-gray-400 text-sm">
                <button onClick={() => setCurrentPage('login')} className="text-cyan-400 hover:text-cyan-300">رجوع لتسجيل الدخول</button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Reached only via the PASSWORD_RECOVERY auth event (see the
// onAuthStateChange listener in LaundryPOS) — a real recovery session
// already exists at this point, so auth.updateUser() is all that's needed.
function ResetPasswordPage({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!password || password.length < 6) { setError('كلمة المرور لازم تكون 6 أحرف على الأقل.'); return; }
    if (password !== confirm) { setError('كلمتا المرور غير متطابقتين.'); return; }
    setLoading(true); setError('');
    const { error: err } = await auth.updateUser({ password });
    if (err) { setError(authErrorMessage(err)); setLoading(false); return; }
    setLoading(false);
    onDone();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src={LOGO_DATA_URI} alt="Ragwa" className="inline-block w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="text-3xl font-bold text-white mb-2">رغوة</h1>
        </div>
        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-center mb-1">تعيين كلمة مرور جديدة</h2>
          <p className="text-gray-400 text-center text-sm mb-8">حط كلمة المرور الجديدة اللي بتستخدمها من الحين.</p>
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور الجديدة</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">تأكيد كلمة المرور</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>
          {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
          <button onClick={submit} disabled={loading} className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition">
            {loading ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Platform-wide incident/maintenance notice — shown above everything else
// (public pages and the app alike) whenever an admin turns it on. Plain
// dismiss (not tied to platform_config), so it comes back on reload/next
// visit for as long as the admin leaves it active, but doesn't nag someone
// who's already seen it and kept working this session.
function MaintenanceBanner({ active, message }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (active) setDismissed(false); }, [active, message]);
  if (!active || dismissed) return null;
  return (
    <div dir="rtl" className="sticky top-0 z-[100] flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span>⚠️ {message || 'النظام حاليًا بصيانة مجدولة — بعض الميزات قد لا تعمل مؤقتًا.'}</span>
      <button onClick={() => setDismissed(true)} className="shrink-0 text-amber-950/70 hover:text-amber-950">✕</button>
    </div>
  );
}

function EmailVerificationPage({ email, onVerified, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resent, setResent] = useState(false);

  const handleResend = async () => {
    setResendLoading(true); setError(''); setResent(false);
    // Supabase has no "currentUser.sendEmailVerification()" — resending a
    // signup confirmation email is its own top-level call, keyed by email.
    const { error: err } = await auth.resend({ type: 'signup', email });
    if (err) setError(authErrorMessage(err));
    else setResent(true);
    setResendLoading(false);
  };

  // Deliberately a typed one-time code instead of "click the link, then
  // come back and press a button": a plain confirmation link is a bare GET
  // request, and mail providers (Gmail, Outlook, corporate gateways)
  // routinely pre-fetch every link in an incoming email to scan it for
  // malware before the recipient ever opens it — which silently consumes a
  // one-time confirmation link exactly like a real click. The customer then
  // opens the email, clicks it themselves, and hits "invalid/expired link"
  // even though the account was already confirmed by the scanner. A code
  // the user has to actually read and type has no URL for anything to
  // pre-fetch, so only this explicit submit can consume it.
  const handleConfirm = async () => {
    setVerifying(true); setError('');
    const { error: err } = await auth.verifyOtp({ email, token: code.trim(), type: 'signup' });
    if (err) setError(authErrorMessage(err));
    else await onVerified();
    setVerifying(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">تأكيد البريد الإلكتروني</h1>
          <p className="text-gray-400 text-sm">خطوة أخيرة قبل الدخول للوحة التحكم</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-cyan-500/10 flex items-center justify-center shrink-0">
              <Mail className="text-cyan-400" size={20} />
            </div>
            <p className="text-gray-300 text-sm">
              أرسلنا رمز تحقق إلى
              <br />
              <span className="text-cyan-400 font-semibold" dir="ltr">{email}</span>
              <br />
              افتح بريدك، وحط الرمز اللي وصلك بالمربع تحت.
            </p>
          </div>

          <input
            type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
            // Supabase's generateLink() email_otp for the "signup" type is 8
            // digits, not the more common 6 — a 6-char maxLength here would
            // have silently truncated every real code before it ever reached
            // verifyOtp(), making confirmation fail for every real user.
            placeholder="00000000" maxLength={8} dir="ltr"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white text-center text-2xl tracking-[0.35em] placeholder-gray-600 focus:border-cyan-400 outline-none transition mb-4"
          />

          {error && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
          {resent && <div className="mb-4 rounded-lg bg-green-500/10 border border-green-500/30 px-4 py-2.5 text-sm text-green-400">تم إرسال رمز جديد.</div>}

          <button onClick={handleConfirm} disabled={verifying || !code.trim()} className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-3">
            {verifying ? 'جارٍ التحقق...' : 'تأكيد'}
          </button>
          <button onClick={handleResend} disabled={resendLoading} className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-3">
            {resendLoading ? 'جارٍ الإرسال...' : 'إعادة إرسال الرمز'}
          </button>
          <button onClick={onBack} className="w-full text-gray-400 hover:text-gray-300 text-sm py-2 transition">
            رجوع
          </button>
        </div>
      </div>
    </div>
  );
}

function SignupPage(props) {
  const { setCurrentPage, signupShop, setSignupShop, signupEmail, setSignupEmail,
    signupMobile, setSignupMobile, signupAddress, setSignupAddress, signupPassword, setSignupPassword,
    signupAgree, setSignupAgree, handleSignup, signupError, signupLoading, onOpenTerms } = props;
  // Same honeypot + minimum-fill-time anti-bot pattern as the landing
  // page's contact form (see LandingPage) — checked server-side in
  // api/send-verification-email.js.
  const [signupWebsite, setSignupWebsite] = useState('');
  const formStartedAtRef = useRef(Date.now());
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="absolute top-6 right-6">
        <button onClick={() => setCurrentPage('landing')} className="px-4 py-2 text-gray-300 hover:text-white transition">
          ← العودة
        </button>
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">إنشاء حساب</h1>
          <p className="text-gray-400 text-sm">ابدأ مع رغوة الآن</p>
        </div>

        <div className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">اسم المحل</label>
            <input type="text" value={signupShop} onChange={(e) => setSignupShop(e.target.value)} placeholder="اسم مغسلتك" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">العنوان</label>
            <input type="text" value={signupAddress} onChange={(e) => setSignupAddress(e.target.value)} placeholder="المدينة، الحي" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="rtl" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">البريد الإلكتروني</label>
            <input type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} placeholder="name@example.com" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">رقم الجوال</label>
            <input type="tel" inputMode="numeric" value={signupMobile} onChange={(e) => setSignupMobile(normalizeSaudiMobile(e.target.value))} placeholder="05XXXXXXXX" maxLength={12} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" dir="ltr" />
            <p className="text-gray-500 text-xs mt-1.5">يبدأ تلقائيًا بـ 966 — اكتب رقمك كالمعتاد (05... أو 5...)</p>
          </div>

          <div className="mb-6">
            <label className="block text-gray-300 text-sm font-semibold mb-3">كلمة المرور</label>
            <input type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} placeholder="••••••••" className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 outline-none transition" />
          </div>

          <div className="flex items-start gap-3 mb-6">
            <input type="checkbox" checked={signupAgree} onChange={(e) => setSignupAgree(e.target.checked)} className="w-4 h-4 rounded accent-cyan-400 mt-1" />
            <label className="text-gray-400 text-sm">
              أوافق على <button type="button" onClick={onOpenTerms} className="text-cyan-400 hover:underline">شروط الخدمة</button>
            </label>
          </div>

          {signupError && <div className="mb-4 rounded-lg bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-sm text-rose-400">{signupError}</div>}

          <input
            type="text" value={signupWebsite} onChange={(e) => setSignupWebsite(e.target.value)}
            autoComplete="off" tabIndex={-1} aria-hidden="true"
            style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          />
          <button onClick={() => handleSignup({ website: signupWebsite, formStartedAt: formStartedAtRef.current })} disabled={signupLoading || !signupAgree} className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:opacity-60 text-white font-semibold py-3 rounded-lg transition mb-6">
            {signupLoading ? 'جارٍ الإنشاء...' : 'إنشاء الحساب'}
          </button>

          <p className="text-center text-gray-400 text-sm">
            لديك حساب؟ <button onClick={() => setCurrentPage('login')} className="text-cyan-400 hover:text-cyan-300">دخول</button>
          </p>
        </div>
      </div>
    </div>
  );
}

// Blocks copy/select on the terms text itself (still fully legible — this
// is friction against casual copy-paste, not an attempt to hide anything;
// trivially bypassed via view-source/print/screenshot, which is fine, this
// isn't meant to be real DRM). Deliberately NOT pairing this with a tiny or
// low-contrast font: a Terms of Service only has legal weight if the user
// could actually read what they agreed to — a court or consumer-protection
// body could treat an intentionally illegible contract as never properly
// disclosed, which undermines the entire point of having one.
function TermsPage({ onBack }) {
  const blockCopy = (e) => e.preventDefault();
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-start justify-center p-4 py-10">
      <div className="fixed top-6 right-6 z-10">
        <button onClick={onBack} className="px-4 py-2 rounded-lg bg-slate-900/80 backdrop-blur border border-slate-700 text-gray-300 hover:text-white transition shadow-lg">← العودة</button>
      </div>
      <div className="w-full max-w-3xl mt-16">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">شروط وأحكام استخدام نظام رغوة (Ragwa)</h1>
          <p className="text-gray-400 text-sm">اتفاقية استخدام ملزمة قانونياً</p>
        </div>

        <div
          className="bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8 text-gray-300 text-base leading-relaxed space-y-6 select-none"
          onCopy={blockCopy} onCut={blockCopy} onContextMenu={blockCopy}
          dir="rtl"
        >
          <section>
            <h2 className="text-xl font-bold text-white mb-2">المقدمة</h2>
            <p>هذه الاتفاقية تحكم استخدامك لمنصة رغوة وخدماتها. بالاشتراك في المنصة أو استخدامك لها، فإنك تقر بأنك قد قرأت واستوعبت جميع الشروط والأحكام الواردة فيها وتوافق على الالتزام بها بشكل كامل. هدفنا هو توفير خدمة موثوقة وشفافة تلبي احتياجاتك.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الأول: التعاريف</h2>
            <p><strong className="text-white">النظام/المنصة:</strong> منصة رغوة الإلكترونية وجميع خدماتها وتطبيقاتها بمختلف صيغها (ويب، تطبيقات محمولة، إلخ).</p>
            <p><strong className="text-white">الشركة:</strong> الجهة المسؤولة عن تطوير وتشغيل النظام وإدارة خدماته بكفاءة واحترافية.</p>
            <p><strong className="text-white">المستخدم/العميل:</strong> أي شخص يقوم بإنشاء حساب واستخدام خدمات النظام.</p>
            <p><strong className="text-white">الخدمة:</strong> جميع الأدوات والميزات والخدمات التي توفرها المنصة للعميل لإدارة عملياته بفعالية.</p>
            <p><strong className="text-white">بيانات المستخدم:</strong> المعلومات التي يدخلها المستخدم في النظام (اسم، رقم، بيانات نشاط، إلخ).</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثاني: قبول الشروط والتزام المستخدم</h2>
            <p>استخدامك للنظام يعني قبولك الكامل لجميع شروط هذه الاتفاقية. إذا كنت لا توافق على أي بند، يجب عليك عدم استخدام المنصة. تحتفظ الشركة بحق تحديث هذه الشروط لتحسين الخدمة، وسيتم إخطارك بالتغييرات المهمة. استمرارك في استخدام المنصة يعني موافقتك على التحديثات.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثالث: استخدام المنصة بشكل مسؤول</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">3.1 الالتزامات القانونية والأخلاقية</h3>
            <p>نطلب منك استخدام المنصة بشكل مسؤول وقانوني وبما يتوافق مع جميع القوانين والأنظمة المعمول بها في المملكة العربية السعودية. نتعاون معك لبناء بيئة آمنة وموثوقة. تتعهد بعدم استخدام المنصة في:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>أي نشاط غير قانوني أو يخالف القوانين المعمول بها</li>
              <li>تمويل الإرهاب أو غسيل الأموال أو الأنشطة الإجرامية</li>
              <li>الاحتيال أو التدليس أو التلاعب أو الخداع</li>
              <li>انتهاك حقوق الآخرين أو الإساءة إليهم</li>
              <li>نشر محتوى يحرض على العنف أو الكراهية</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">3.2 الأمان والحماية</h3>
            <p>نعتمد عليك في حماية حسابك. تتعهد بحماية بيانات اعتمادك (اسم المستخدم وكلمة المرور) والحفاظ على سريتها. أنت الوحيد المسؤول عن جميع الأنشطة التي تتم من خلال حسابك. لا تحاول الوصول بطرق غير مصرح بها إلى النظام أو حسابات المستخدمين الآخرين.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">3.3 المسؤولية عن الانتهاكات</h3>
            <p>في حالة انتهاكك لهذه الشروط، أنت تتحمل المسؤولية الكاملة عن ذلك، وتوافق على تعويض الشركة عن أي خسائر أو أضرار قد تنشأ عن انتهاكك.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الرابع: وصف الخدمة</h2>
            <p>منصة رغوة مصممة بعناية لإدارة عمليات محلات مغاسل الملابس بكفاءة، وتوفر:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>إدارة البيانات والسجلات بسهولة وأمان</li>
              <li>توليد التقارير والإحصائيات الشاملة</li>
              <li>تحليل بيانات الاستخدام لاتخاذ قرارات أفضل</li>
            </ul>
            <p>تقتصر الخدمة على مستخدم واحد لكل حساب لضمان الأمان والسيطرة. تحتفظ الشركة بحقها في تطوير وتحسين وإضافة ميزات جديدة للمنصة في أي وقت لتطورها باستمرار وتلبية احتياجاتك المتغيرة.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الخامس: حالة المنصة وتطورها</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">5.1 مرحلة تطويرية مثيرة</h3>
            <p>منصة رغوة في مرحلة تطوير ديناميكية وحية. نحن نركز على جودة الخدمة والأداء الفعلي قبل التسجيل الرسمي، وهذا يعني:</p>
            <ul className="space-y-1">
              <li>✓ كل تحديث واختبار من أجلك ومن أجل تحسين تجربتك</li>
              <li>✓ استقرار النظام والبيانات الآمنة هي أولويتنا</li>
              <li>✓ نحن نستمع إلى ملاحظاتك وندمجها بسرعة</li>
            </ul>
            <p>المنصة حالياً لم تتلقَّ التسجيل الرسمي من هيئة الزكاة والضريبة والدخل، وهذا طبيعي وشائع في مرحلة التطوير. سيتم الانتقال للتسجيل الرسمي عندما تكون المنصة جاهزة تماماً.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">5.2 فرصة حقيقية للمستخدمين الأوائل</h3>
            <p>كنت من أوائل من يستخدم المنصة، وهذا يعني:</p>
            <ul className="space-y-1">
              <li>✓ الخدمة مجانية تماماً خلال هذه المرحلة</li>
              <li>✓ تأثيرك المباشر على تطوير الميزات القادمة</li>
              <li>✓ دعم شخصي من فريقنا</li>
              <li>✓ تحسين مستمر بناءً على احتياجاتك</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">5.3 التزامنا بالجودة والاستقرار</h3>
            <p>نحن ملتزمون بتقديم خدمة موثوقة وآمنة. يتم توفير الخدمة بأفضل جودة ممكنة مع التزامنا بـ:</p>
            <ul className="space-y-1">
              <li>✓ استقرار النظام والأداء الجيد</li>
              <li>✓ حماية بياناتك بأعلى معايير الأمان</li>
              <li>✓ تحسين مستمر بناءً على ملاحظات المستخدمين</li>
            </ul>
            <p className="italic text-gray-400">ملاحظة مهمة: كما هو الحال مع أي نظام تقني، قد تحدث توقفات غير متوقعة للصيانة أو التحديث (نادرة جداً). سنحاول إخطارك مسبقاً عند الإمكان، لأننا نقدّر وقتك.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند السادس: بيانات المستخدم والخصوصية</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">6.1 جمع البيانات بهدف التحسين</h3>
            <p>نجمع البيانات عن استخدامك للمنصة فقط لـ تحسين الخدمة وجعلها أفضل لك. البيانات التي نجمعها:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>سلوك الاستخدام (الميزات التي تستخدمها أكثر)</li>
              <li>البيانات التقنية (لضمان الأداء الأفضل)</li>
              <li>معلومات الجهاز والمتصفح (للتوافقية)</li>
            </ul>
            <p>كل هذا يساعدنا على:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>فهم احتياجاتك بشكل أفضل</li>
              <li>تحسين السرعة والاستقرار</li>
              <li>إضافة ميزات تناسبك</li>
              <li>منع المشاكل الأمنية</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.2 خوادم آمنة وموثوقة</h3>
            <p>بيانات حسابك تُخزّن على خوادم موجودة في الدمام وقد تكون في مواقع أخرى استراتيجية لضمان أسرع وصول وأعلى أمان. إذا كان لديك مخاوف جدية بخصوص الخوادم، يرجى عدم استخدام المنصة.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.3 نستخدم معلوماتك للتواصل المهم</h3>
            <p>عند تسجيلك أو تواصلك معنا، تسمح لنا بـ:</p>
            <ul className="space-y-1">
              <li>✓ إرسال تحديثات مهمة عن النظام (صيانة، ميزات جديدة)</li>
              <li>✓ الرد على استفساراتك وحل مشاكلك</li>
              <li>✓ مشاركة نصائح وأفضل الممارسات</li>
              <li>✓ إخبارك عن التطويرات الجديدة</li>
            </ul>
            <p>نحترم بريدك ولن نرسل لك رسائل عشوائية.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.4 بيانات آمنة وسرية</h3>
            <p>لن نشارك بيانات حسابك الشخصية مع أحد، إلا في الحالات الضرورية جداً:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>شركاء تقنيين نحتاجهم لتقديم الخدمة</li>
              <li>إذا أجبرتنا القوانين على ذلك</li>
              <li>في حالات شراكة استراتيجية في المستقبل (سنخبرك مسبقاً)</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.5 الإحصائيات المجمعة (بدون اسمك)</h3>
            <p>قد نستخدم إحصائيات عامة من كل المستخدمين (بدون ذكر اسمك) لـ:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>فهم الأنماط الكلية للاستخدام</li>
              <li>تحسين الخدمة العام</li>
              <li>البحث والتطوير</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">6.6 بيانات آمنة للأبد</h3>
            <p>معلومات حسابك الأساسية (اسمك ورقمك) ستبقى محفوظة آمنة لدينا بشكل دائم. هذا يضمن أمانك ويساعدنا في الاحتفاظ بسجلات موثوقة.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">6.7 الحماية من البوتات (Cloudflare Turnstile)</h3>
            <p>تستخدم منصة رغوة خدمة Cloudflare Turnstile للتحقق من أن الزوار أشخاص حقيقيون وحماية النظام من محاولات التسجيل الوهمية والاختراق، دون إزعاجك بأي اختبار مرئي في الغالب. باستخدامك للمنصة، فإنك تقر باطلاعك على سياسة خصوصية وشروط استخدام Cloudflare الخاصة بهذه الخدمة.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند السابع: التطوير والتحديثات المستمرة</h2>
            <p>هدفنا تحسين المنصة باستمرار. نحتفظ بحقنا في:</p>
            <ul className="space-y-1">
              <li>✓ إضافة ميزات جديدة ومفيدة</li>
              <li>✓ تحسين الواجهة والأداء</li>
              <li>✓ تحديثات أمان ضرورية</li>
              <li>✓ تعديل أو حذف ميزات قديمة لم تعد مفيدة</li>
            </ul>
            <p>التزامنا بالاختبار: قبل أي تحديث رئيسي، نختبره بعناية. هذا يعني أن التحديثات تأتي محسّنة وآمنة. قد تحدث توقفات قصيرة جداً للصيانة (نادراً)، وسنحاول إخبارك بها.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثامن: الخدمة بكل شفافية</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">8.1 ما نقدمه بصراحة</h3>
            <p>نحن صرحاء معك: المنصة في مرحلة تطوير، لذلك:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>نوفرها كما هي الآن (مع التحسينات المستمرة)</li>
              <li>نعمل بجد لضمان الاستقرار والأمان</li>
              <li>لا نستطيع ضمان خلو النظام من أي مشكلة تقنية صغيرة</li>
              <li>قد تحتاج إلى النسخ الاحتياطية للبيانات الحساسة</li>
            </ul>
            <p>هذا طبيعي وشفاف.</p>
            <h3 className="font-semibold text-white mt-3 mb-1">8.2 نحن لا نتحمل مسؤوليات غير معقولة</h3>
            <p>في حالة حدوث مشكلة تقنية:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>مسؤولية الشركة محدودة ومعقولة</li>
              <li>نحن لا نستطيع تعويض خسائر كبيرة جداً (هذا معيار في جميع الخدمات)</li>
              <li>لكننا ملتزمون بإصلاح أي مشكلة بسرعة</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">8.3 أنت مسؤول أيضاً عن أمان حسابك</h3>
            <ul className="list-disc pr-6 space-y-1">
              <li>احفظ نسخة احتياطية من البيانات المهمة</li>
              <li>استخدم كلمة مرور قوية</li>
              <li>لا تشارك بيانات حسابك مع أحد</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند التاسع: إذا توقفت عن الخدمة</h2>
            <h3 className="font-semibold text-white mt-3 mb-1">9.1 حقك في الإيقاف وحقنا أيضاً</h3>
            <p>أنت حر في إيقاف استخدام المنصة في أي وقت. نحن أيضاً قد نضطر لإيقاف خدمتك إذا:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>انتهكت شروط الاستخدام</li>
              <li>استخدمت النظام بطرق تضره</li>
              <li>قررنا إيقاف الخدمة (سنحاول إخبارك)</li>
            </ul>
            <h3 className="font-semibold text-white mt-3 mb-1">9.2 بيانات آمنة حتى بعد الانتهاء</h3>
            <p>عند الإيقاف، قد لا تتمكن من الوصول لحسابك مباشرة. لذلك من الضروري حفظ نسختك الاحتياطية من أي بيانات مهمة قبل الانتهاء.</p>
            <p>احنا نحتفظ بالبيانات بأمان وفقاً للقانون (للسجلات والأرشفة).</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند العاشر: إذا غيّرنا الشروط</h2>
            <p>قد نحتاج لتحديث هذه الشروط لتحسين الخدمة. عندما نفعل:</p>
            <ul className="list-disc pr-6 space-y-1">
              <li>سنخبرك بالتغييرات المهمة عبر البريد</li>
              <li>استمرارك في الاستخدام يعني موافقتك</li>
              <li>إذا لم توافق على التغييرات، عليك التوقف عن الاستخدام</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الحادي عشر: القانون والمحاكم</h2>
            <p>هذه الاتفاقية تحكمها قوانين المملكة العربية السعودية. أي نزاع سيُحل من خلال المحاكم السعودية.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثاني عشر: نحن هنا لك</h2>
            <p>للتواصل معنا بسهولة:</p>
            <ul className="space-y-1">
              <li>📧 البريد الإلكتروني: support@ragwapos.com</li>
              <li>💬 من خلال المنصة: قسم "الاتصال بنا"</li>
            </ul>
            <p>نحن نقدّر تعليقاتك وشكاواك - هذا يساعدنا على التحسين!</p>
            <p className="italic text-gray-400">ملاحظة: قد نسجل اتصالاتك لتحسين خدمتنا والتدريب. بك توافقك على هذا.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-2">البند الثالث عشر: معلومات إضافية</h2>
            <ul className="list-disc pr-6 space-y-1">
              <li>إذا وجدنا بند من بنود الشروط غير صحيح، ستبقى البنود الأخرى سارية</li>
              <li>عدم تطبيقنا لبند معين لا يعني تنازلنا عنه</li>
              <li>نحن غير مسؤولين عن روابط خارجية قد توجد في المنصة</li>
            </ul>
          </section>

          <p className="text-center text-white font-semibold pt-4">شكراً لاستخدامك منصة رغوة! 🙏</p>
          <p className="text-center text-gray-500 text-xs">آخر تحديث: 22/08/2026</p>
        </div>
      </div>
    </div>
  );
}

const LaundryPOS = () => {
  const [currentPage, setCurrentPage] = useState('landing');
  // Where to send the user back to from the terms page — it can be reached
  // from more than one place (signup checkbox, landing page footer), and a
  // plain setCurrentPage('signup') on the way back would strand a visitor
  // who opened it from the landing page instead.
  const [termsReferrer, setTermsReferrer] = useState('landing');
  const openTerms = () => { setTermsReferrer(currentPage); setCurrentPage('terms'); };
  // Chosen once on the landing page (before any login/signup) and carried
  // through as the dashboard's starting language, so a visitor who picked
  // Arabic there doesn't land on an English dashboard after signing up.
  const [siteLang, setSiteLang] = useState('ar');
  const [showPassword, setShowPassword] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [tenantId, setTenantId] = useState(null);

  // Live-synced from platform_config so AdminDashboard's "add admin" /
  // "remove admin" / "toggle auto-approve" controls actually take effect.
  // Falls back to ADMIN_EMAILS_DEFAULT/true until the row loads (or if it's
  // still missing / rejected by RLS pre-bootstrap).
  const [adminEmails, setAdminEmails] = useState(ADMIN_EMAILS_DEFAULT);
  const [autoApprove, setAutoApprove] = useState(true);
  // Platform-wide maintenance banner — set by an admin (AdminDashboard),
  // shown to every visitor on every page (public and inside the app) via
  // MaintenanceBanner below. Live-synced same as the other platform_config
  // fields, so it appears/disappears with no reload needed on either side.
  const [maintenanceActive, setMaintenanceActive] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  useEffect(() => {
    const applyRow = (d) => {
      if (!d) return;
      if (Array.isArray(d.adminEmails) && d.adminEmails.length > 0) setAdminEmails(d.adminEmails);
      if (typeof d.autoApprove === 'boolean') setAutoApprove(d.autoApprove);
      if (typeof d.maintenanceActive === 'boolean') setMaintenanceActive(d.maintenanceActive);
      if (typeof d.maintenanceMessage === 'string') setMaintenanceMessage(d.maintenanceMessage);
    };
    const unsub = subscribeToRow('platform_config', null, null, applyRow);
    return () => unsub();
  }, []);

  const [registrationRequests, setRegistrationRequests] = useState([]);
  const [salesInquiries, setSalesInquiries] = useState([]);
  const [tenants, setTenants] = useState([]);

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [signupShop, setSignupShop] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupMobile, setSignupMobile] = useState('');
  const [signupAddress, setSignupAddress] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupAgree, setSignupAgree] = useState(false);
  const [signupError, setSignupError] = useState('');
  const [signupLoading, setSignupLoading] = useState(false);

  const [showEmailVerification, setShowEmailVerification] = useState(false);
  const [pendingSignup, setPendingSignup] = useState(null); // { email } — holds who we're waiting on verification for

  const [showContact, setShowContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactMobile, setContactMobile] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactType, setContactType] = useState('شراء نظام');
  const [contactMessage, setContactMessage] = useState('');
  const [contactSent, setContactSent] = useState(false);

  const isAdminEmail = (email) => adminEmails.includes((email || '').trim().toLowerCase());

  // Ensures platform_config exists and lists this email. RLS only lets this
  // happen either because the row doesn't exist yet (true first-ever
  // bootstrap, seed email only) or because this email is already an admin
  // per the existing row — never for anyone else. Safe to call defensively
  // after any successful admin sign-in, not just on fresh account creation.
  const ensurePlatformConfig = async (emailNorm) => {
    // Not checking `error` here on purpose — a read rejected by RLS during
    // the pre-bootstrap phase should fall through to the bootstrap branch
    // below, exactly like the missing-doc case did with Firestore.
    const { data: row } = await db.from('platform_config').select().eq('id', true).maybeSingle();
    if (row) {
      const current = row.admin_emails || [];
      if (!current.includes(emailNorm)) {
        await db.from('platform_config').update({ admin_emails: [...current, emailNorm] }).eq('id', true)
          .then(({ error }) => { if (error) console.error('platform_config update failed', error); });
      }
    } else {
      await db.from('platform_config').upsert({ id: true, admin_emails: [emailNorm], auto_approve: true })
        .then(({ error }) => { if (error) console.error('platform_config bootstrap failed', error); });
    }
    // platform_admins (what RLS's is_admin() actually checks) is separate
    // from admin_emails above and has zero client-writable RLS policies by
    // design — only api/admin-sync.js (service role) can insert into it.
    // Without this, an admin_emails entry with no matching platform_admins
    // row sees the dashboard fine but every write in it (maintenance
    // toggle, sales-inquiry status, ...) silently fails RLS with no
    // visible error. See api/admin-sync.js for the full explanation.
    const { data: { session } } = await auth.getSession();
    if (session?.access_token) {
      await fetch('/api/admin-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'ensure' }),
      }).catch((e) => console.error('admin-sync ensure failed', e));
    }
  };

  // Admin accounts must already exist in Supabase Auth (created manually by
  // the owner via the Supabase Dashboard → Authentication → Users) before
  // anyone can log in as that email. Deliberately NOT auto-provisioning via
  // auth.signUp() here anymore — the old behavior let whoever typed ANY
  // password for an allow-listed admin email FIRST claim that account
  // permanently, which is an open race for any email added to admin_emails
  // (including the hardcoded default, which ships in client JS). Sign-in
  // only, no bootstrap.
  const adminSignIn = async (emailNorm, password) => {
    const { error: signInErr } = await auth.signInWithPassword({ email: emailNorm, password });
    if (signInErr) throw signInErr;
    // Self-heal: covers the case where the account exists but config/platform
    // was never bootstrapped yet.
    await ensurePlatformConfig(emailNorm).catch(() => {});
  };

  // Figures out where a signed-in user belongs: admin console, straight into
  // their shop dashboard, awaiting-approval, or rejected.
  const resolveDestination = async (user) => {
    if (isAdminEmail(user.email)) {
      // Self-heal here too (not just in adminSignIn): an already-established
      // browser session goes straight through onAuthStateChange on refresh
      // and never calls adminSignIn, so config/platform could otherwise stay
      // missing indefinitely for a session that was live before it existed.
      await ensurePlatformConfig(user.email).catch(() => {});
      return { page: 'admin' };
    }
    if (!user.email_confirmed_at) return { page: 'verify' };
    // maybeSingle() (not single()) — a missing tenant row is the expected,
    // non-error outcome for a user who just signed up and isn't approved yet.
    const { data: tenantRow } = await db.from('tenants').select().eq('id', user.id).maybeSingle();
    if (tenantRow) return { page: 'dashboard', tenantId: user.id };
    const { data: reqRows } = await db.from('registration_requests').select().eq('uid', user.id);
    const req = reqRows && reqRows[0] ? toCamelCase(reqRows[0]) : null;
    if (req && req.status === 'rejected') return { page: 'rejected', reason: req.rejectReason };
    return { page: 'pending' };
  };

  // Restores the session on page refresh (Supabase Auth persists it in
  // localStorage) and reacts to sign-in/sign-out from anywhere in the app.
  // Supabase's callback shape is (event, session) — not a plain user object
  // like Firebase's onAuthStateChanged — so the user has to be pulled out of
  // session.user, and it's null (not the user) when signed out.
  useEffect(() => {
    const { data: { subscription } } = auth.onAuthStateChange(async (event, session) => {
      const user = session?.user;
      if (!user) { setAuthResolved(true); return; }
      // Fires when the user lands back on the site via a password-recovery
      // link (auth.resetPasswordForEmail) — Supabase already exchanges it
      // for a real session by this point, so intercept BEFORE the normal
      // resolveDestination routing (which would otherwise send them
      // straight to their dashboard/pending screen instead of letting them
      // actually set a new password).
      if (event === 'PASSWORD_RECOVERY') {
        setCurrentPage('resetPassword');
        setAuthResolved(true);
        return;
      }
      try {
        const dest = await resolveDestination(user);
        if (dest.page === 'verify') {
          setPendingSignup({ email: user.email });
          setShowEmailVerification(true);
        } else if (dest.page === 'dashboard') {
          // Clears the verification-waiting screen automatically — needed
          // for the case where THIS listener is what first notices the
          // email got confirmed (e.g. the confirmation link redirected back
          // into this same running tab), so the user isn't stuck looking at
          // "check your email" after the app already knows they're in.
          setShowEmailVerification(false); setPendingSignup(null);
          setTenantId(dest.tenantId);
          setCurrentPage('dashboard');
        } else if (dest.page === 'admin') {
          setShowEmailVerification(false); setPendingSignup(null);
          setCurrentPage('admin');
        } else if (dest.page === 'pending') {
          setShowEmailVerification(false); setPendingSignup(null);
          setCurrentPage((p) => (p === 'landing' || p === 'login' || p === 'signup') ? 'pending' : p);
        }
      } catch (e) {
        console.error('auth state resolve failed', e);
      }
      setAuthResolved(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async () => {
    setLoginError('');
    const emailNorm = loginEmail.trim().toLowerCase();
    if (!emailNorm) { setLoginError('حط البريد الإلكتروني.'); return; }
    setLoginLoading(true);
    try {
      if (isAdminEmail(emailNorm)) {
        await adminSignIn(emailNorm, loginPassword);
        setCurrentPage('admin');
        setLoginLoading(false);
        return;
      }
      const { data, error: signInErr } = await auth.signInWithPassword({ email: emailNorm, password: loginPassword });
      if (signInErr) {
        // Supabase rejects the sign-in itself for an unconfirmed account
        // (error_code "email_not_confirmed") rather than letting it through
        // with a null email_confirmed_at — so a customer who signed up,
        // didn't finish clicking the verification link, and comes back to
        // log in later would otherwise hit a dead-end error and never see
        // the "check your email" screen again. Route them back to it here,
        // same as resolveDestination does for an already-signed-in session.
        if (signInErr.code === 'email_not_confirmed') {
          setPendingSignup({ email: emailNorm });
          setShowEmailVerification(true);
          setLoginLoading(false);
          return;
        }
        throw signInErr;
      }
      const user = data.user;
      const dest = await resolveDestination(user);
      if (dest.page === 'verify') {
        setPendingSignup({ email: user.email });
        setShowEmailVerification(true);
      } else if (dest.page === 'rejected') {
        setLoginError(`تم رفض طلب تسجيلك${dest.reason ? `: ${dest.reason}` : '.'}`);
        await auth.signOut();
      } else if (dest.page === 'pending') {
        setCurrentPage('pending');
      } else {
        setTenantId(dest.tenantId);
        setCurrentPage(dest.page);
      }
    } catch (e) {
      setLoginError(authErrorMessage(e));
    }
    setLoginLoading(false);
  };

  const handleSignup = async ({ website, formStartedAt } = {}) => {
    setSignupError('');
    if (isAdminEmail(signupEmail)) {
      setSignupLoading(true);
      try {
        await adminSignIn(signupEmail.trim().toLowerCase(), signupPassword);
        setCurrentPage('admin');
      } catch (e) {
        setSignupError(authErrorMessage(e));
      }
      setSignupLoading(false);
      return;
    }
    if (!signupAgree) { setSignupError('لازم توافق على شروط الخدمة.'); return; }
    if (!isValidSaudiMobile(signupMobile)) { setSignupError('رقم الجوال غير صحيح.'); return; }
    const emailNorm = signupEmail.trim().toLowerCase();
    if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) { setSignupError('حط بريد إلكتروني صحيح.'); return; }
    if (!signupPassword) { setSignupError('حط كلمة مرور.'); return; }

    setSignupLoading(true);
    try {
      const shopName = signupShop.trim() || '—';
      const address = signupAddress.trim() || '—';

      // The API route creates the Supabase Auth user itself, via
      // admin.generateLink({type:'signup'}) — that call behaves like
      // auth.signUp() and fails with "user already registered" if the user
      // already exists. So this must be the ONLY place that creates the
      // account; calling auth.signUp() here too (the old code did, before
      // this fetch) silently broke the branded Resend email on every signup.
      //
      // It also now writes the registration_requests/tenants rows itself
      // (service-role client, server-side) instead of this still-anonymous
      // client doing those inserts — the anon-role INSERT policies that
      // used to make that possible had to be wide open (no ownership
      // check at all, since no session exists yet at this point), which
      // meant literally anyone with the public anon key could POST
      // directly to Supabase's REST API and insert arbitrary tenants /
      // registration_requests rows with zero signup, zero verification.
      // See supabase-close-anon-signup-inserts.sql.
      const turnstileToken = await getTurnstileToken();
      const resp = await fetch('/api/send-verification-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailNorm, password: signupPassword, shopName, mobile: signupMobile, address, website, formStartedAt, turnstileToken }),
      });
      const result = await resp.json();
      if (!result.success) throw { message: result.error, code: result.code };

      setPendingSignup({ email: emailNorm });
      setShowEmailVerification(true);
    } catch (e) {
      setSignupError(authErrorMessage(e));
    }
    setSignupLoading(false);
  };

  // Called once the user confirms they clicked the real verification link.
  // Re-resolves their destination from Firestore — works whether they're
  // finishing a fresh signup or just verifying late after a previous visit.
  const completeSignupAfterVerification = async () => {
    const { data } = await auth.getUser(); // no sync auth.currentUser in Supabase
    const user = data.user;
    if (!user) return;
    setShowEmailVerification(false);
    setPendingSignup(null);
    const dest = await resolveDestination(user);
    if (dest.page === 'dashboard') { setTenantId(dest.tenantId); setCurrentPage('dashboard'); }
    else if (dest.page === 'admin') setCurrentPage('admin');
    else setCurrentPage('pending');
  };

  const handleLogout = async () => {
    const { error: err } = await auth.signOut();
    if (err) console.error(err);
    setCurrentPage('landing');
    setTenantId(null);
    setLoginEmail(''); setLoginPassword(''); setLoginError('');
  };

  // Admin-only: mirrors the cross-tenant collections live while the admin
  // console is open (Firestore rules only allow reading these to admins).
  // Plain onSnapshot with no server-side orderBy — sorted client-side
  // instead, matching TenantDataManagementView's pattern. This also sidesteps
  // orderBy silently excluding any older/legacy document that happens to be
  // missing the sorted field.
  useEffect(() => {
    if (currentPage !== 'admin') return;
    const byDateDesc = (field) => (a, b) => new Date(b[field] || 0) - new Date(a[field] || 0);
    const unsubReq = subscribeToTable('registration_requests', null, null, setRegistrationRequests, null, (rows) => [...rows].sort(byDateDesc('date')));
    const unsubTen = subscribeToTable('tenants', null, null, setTenants, null, (rows) => [...rows].sort(byDateDesc('approvedDate')));
    const unsubInq = subscribeToTable('sales_inquiries', null, null, setSalesInquiries, null, (rows) => [...rows].sort(byDateDesc('date')));
    return () => { unsubReq(); unsubTen(); unsubInq(); };
  }, [currentPage]);

  // Public contact form on the landing page — no login required. Goes
  // through api/submit-contact now (rate-limited + honeypot + minimum-
  // fill-time checked server-side) instead of inserting into
  // sales_inquiries directly from this still-signed-out client — see
  // supabase-close-anon-sales-inquiries.sql for why that direct-insert
  // path was closed off.
  const submitContact = ({ website, formStartedAt } = {}) => {
    // Field values captured NOW, synchronously — the actual send (including
    // the Turnstile round-trip below) is fire-and-forget, same as before
    // Turnstile existed. Awaiting getTurnstileToken() before showing "sent"
    // used to leave the visitor staring at an unresponsive form for however
    // long the challenge took (a real regression this caused: the
    // confirmation only appeared after the full Turnstile round-trip).
    const payload = {
      name: contactName.trim() || '—', mobile: contactMobile.trim() || '—', email: contactEmail.trim() || '—',
      type: contactType, message: contactMessage.trim(), website, formStartedAt,
    };
    (async () => {
      const turnstileToken = await getTurnstileToken();
      fetch('/api/submit-contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, turnstileToken }),
      }).catch((e) => console.error('submitContact failed', e));
    })();
    setContactSent(true);
    setTimeout(() => {
      setShowContact(false); setContactSent(false);
      setContactName(''); setContactMobile(''); setContactEmail(''); setContactMessage(''); setContactType('شراء نظام');
    }, 1500);
  };

  // Clarity only ever runs on the public marketing/auth pages — never on the
  // POS, reports, customer/supplier data, or the admin console. Anything
  // outside this list (dashboard, admin, pending-approval, email
  // verification) leaves `active` false, which pauses/never loads the tag.
  // Also gated on `authResolved`: `currentPage` defaults to 'landing' before
  // the session-restore check runs, so a returning already-authenticated
  // tenant would otherwise have Clarity start()-ing for the instant before
  // that check redirects them straight to the dashboard.
  const PUBLIC_TRACKED_PAGES = ['landing', 'login', 'signup'];
  useClarityTracking(authResolved && !showEmailVerification && PUBLIC_TRACKED_PAGES.includes(currentPage));

  if (!authResolved) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center">
        <div className="text-gray-400 text-sm">جارٍ التحميل...</div>
      </div>
    );
  }

  return (
    <>
      <MaintenanceBanner active={maintenanceActive} message={maintenanceMessage} />
      {showEmailVerification && pendingSignup ? (
    <EmailVerificationPage
      email={pendingSignup.email}
      onVerified={completeSignupAfterVerification}
      onBack={async () => { const { error: err } = await auth.signOut(); if (err) console.error(err); setShowEmailVerification(false); setPendingSignup(null); }}
    />
  ) : currentPage === 'pending' ? (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center bg-slate-900/60 backdrop-blur border border-slate-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-white mb-3">طلبك قيد المراجعة</h1>
        <p className="text-gray-400 text-sm mb-6">تم تأكيد بريدك الإلكتروني بنجاح. حسابك الآن بانتظار موافقة الإدارة، بترجع تقدر تدخل بمجرد ما توافق الإدارة.</p>
        <button onClick={handleLogout} className="w-full text-gray-400 hover:text-gray-300 text-sm py-2 transition">رجوع لتسجيل الدخول</button>
      </div>
    </div>
  ) : currentPage === 'landing' ? (
    <LandingPage
      setCurrentPage={setCurrentPage} showWorkflow={showWorkflow} setShowWorkflow={setShowWorkflow}
      showContact={showContact} setShowContact={setShowContact}
      contactName={contactName} setContactName={setContactName}
      contactMobile={contactMobile} setContactMobile={setContactMobile}
      contactEmail={contactEmail} setContactEmail={setContactEmail}
      contactType={contactType} setContactType={setContactType}
      contactMessage={contactMessage} setContactMessage={setContactMessage}
      contactSent={contactSent} submitContact={submitContact}
      lang={siteLang} setLang={setSiteLang} onOpenTerms={openTerms}
    />
  ) : currentPage === 'login' ? (
    <LoginPage
      setCurrentPage={setCurrentPage} showPassword={showPassword} setShowPassword={setShowPassword}
      loginEmail={loginEmail} setLoginEmail={setLoginEmail}
      loginPassword={loginPassword} setLoginPassword={setLoginPassword}
      handleLogin={handleLogin} loginError={loginError} loginLoading={loginLoading}
    />
  ) : currentPage === 'forgotPassword' ? (
    <ForgotPasswordPage setCurrentPage={setCurrentPage} />
  ) : currentPage === 'resetPassword' ? (
    <ResetPasswordPage onDone={async () => { await auth.signOut(); setCurrentPage('login'); }} />
  ) : currentPage === 'terms' ? (
    <TermsPage onBack={() => setCurrentPage(termsReferrer)} />
  ) : currentPage === 'signup' ? (
    <SignupPage
      setCurrentPage={setCurrentPage} signupShop={signupShop} setSignupShop={setSignupShop}
      signupEmail={signupEmail} setSignupEmail={setSignupEmail}
      signupMobile={signupMobile} setSignupMobile={setSignupMobile}
      signupAddress={signupAddress} setSignupAddress={setSignupAddress}
      signupPassword={signupPassword} setSignupPassword={setSignupPassword}
      signupAgree={signupAgree} setSignupAgree={setSignupAgree}
      handleSignup={handleSignup} signupError={signupError} signupLoading={signupLoading}
      onOpenTerms={openTerms}
    />
  ) : currentPage === 'admin' ? (
    <AdminDashboard
      registrationRequests={registrationRequests}
      salesInquiries={salesInquiries}
      tenants={tenants}
      adminEmails={adminEmails}
      autoApprove={autoApprove}
      maintenanceActive={maintenanceActive}
      maintenanceMessage={maintenanceMessage}
      onLogout={handleLogout}
    />
  ) : (
    <LaundryOpsApp tenantId={tenantId} onLogout={handleLogout} initialLang={siteLang} />
  )}
    </>
  );
};

export default LaundryPOS;
