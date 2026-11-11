import React, { useEffect, useState } from "react";
import { Building2, Check, Copy, Loader2, Upload } from "lucide-react";
import { auth, db } from "../supabase";
import { toCamelCase } from "../utils/transforms.js";
import { uploadPrivateFile } from "../utils/storage.js";
import { ANNUAL_PRICE, BRANCH_PRICE } from "./pricing.js";

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const WHATSAPP_URL = "https://wa.me/966592299405";

// Arabic and English only: the panel is seen by the shop owner, who picked
// one of the two on the landing page (Urdu is a staff-only UI language and
// falls back to English here).
const TEXT = {
  ar: {
    dir: "rtl",
    errNoFile: "اختر صورة الإيصال أو ملف PDF أولًا.", errTooBig: "حجم الملف أكبر من 5 ميجا.", errUpload: "تعذر رفع الإيصال، حاول مرة ثانية.",
    titleBranch: "إضافة فرع جديد", titleAnnualEnded: "انتهى اشتراكك السنوي", titleTrialEnded: "انتهت تجربتك المجانية", titleAnnual: "الاشتراك السنوي",
    subBranch: (name) => `الفرع: ${name}. حوّل الرسوم وأرفق الإيصال، ويُضاف الفرع بعد تأكيد الدفع من فريقنا.`,
    subRenewal: "بياناتك محفوظة. اشترك سنويًا لمتابعة استخدام رغوة بكل المميزات.",
    subUpgrade: "اشترك الآن وتستمر بكل المميزات بعد انتهاء التجربة.", subNew: "تم تأكيد بريدك. أكمل الدفع لتفعيل حسابك.",
    perBranch: "ريال حتى نهاية اشتراكك", perYear: "ريال / سنة", vatIncl: "شامل الضريبة",
    pendingBranch: "استلمنا إيصالك وهو الآن قيد المراجعة. سيُضاف الفرع فور تأكيد الدفع.",
    pendingAnnual: "استلمنا إيصالك وهو الآن قيد المراجعة. سيتم تفعيل حسابك فور تأكيد الدفع.",
    refresh: "تحديث الحالة",
    bankNote: "نعتذر، نعمل حاليًا على تفعيل الدفع الإلكتروني وسيتوفر قريبًا. في الوقت الحالي حوّل المبلغ على الحساب أدناه ثم أرفق الإيصال، وسيراجعه فريقنا ويفعّل اشتراكك.",
    rejected: (reason) => `لم يُقبل الإيصال السابق${reason ? `: ${reason}` : "."} أرفق إيصالًا صحيحًا.`,
    bank: "البنك", beneficiary: "اسم المستفيد", iban: "رقم الآيبان", qrAlt: "باركود الدفع", qrScan: "امسح من تطبيق البنك",
    noBank: "بيانات الحساب قيد التجهيز. تواصل معنا على واتساب وسنرسلها لك.", whatsapp: "واتساب",
    receipt: "إيصال التحويل", pickFile: "اختر صورة الإيصال أو ملف PDF (حتى 5 ميجا)",
    sending: "جارٍ الإرسال...", send: "إرسال الإيصال", back: "رجوع للنظام", logout: "تسجيل الخروج",
  },
  en: {
    dir: "ltr",
    errNoFile: "Choose a receipt image or PDF first.", errTooBig: "The file is larger than 5 MB.", errUpload: "Couldn't upload the receipt. Please try again.",
    titleBranch: "Add a new branch", titleAnnualEnded: "Your annual subscription has ended", titleTrialEnded: "Your free trial has ended", titleAnnual: "Annual subscription",
    subBranch: (name) => `Branch: ${name}. Transfer the fee and attach the receipt. The branch is added once our team confirms the payment.`,
    subRenewal: "Your data is safe. Subscribe annually to keep using Ragwa with every feature.",
    subUpgrade: "Subscribe now to keep every feature after your trial ends.", subNew: "Your email is confirmed. Complete the payment to activate your account.",
    perBranch: "SAR until your subscription ends", perYear: "SAR / year", vatIncl: "VAT included",
    pendingBranch: "We've received your receipt and it's under review. The branch will be added as soon as the payment is confirmed.",
    pendingAnnual: "We've received your receipt and it's under review. Your account will be activated as soon as the payment is confirmed.",
    refresh: "Refresh status",
    bankNote: "Online payment is coming soon. For now, transfer the amount to the account below and attach the receipt. Our team will review it and activate your subscription.",
    rejected: (reason) => `Your previous receipt wasn't accepted${reason ? `: ${reason}` : "."} Please attach a valid receipt.`,
    bank: "Bank", beneficiary: "Beneficiary name", iban: "IBAN", qrAlt: "Payment QR code", qrScan: "Scan from your bank app",
    noBank: "The account details are being prepared. Message us on WhatsApp and we'll send them to you.", whatsapp: "WhatsApp",
    receipt: "Transfer receipt", pickFile: "Choose a receipt image or PDF (up to 5 MB)",
    sending: "Sending...", send: "Send receipt", back: "Back to the system", logout: "Log out",
  },
};

function CopyRow({ label, value, mono }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
        <div className={`mt-0.5 break-all text-sm font-semibold text-white ${mono ? "font-mono tracking-wide" : ""}`} dir={mono ? "ltr" : undefined}>{value}</div>
      </div>
      <button type="button" onClick={copy} aria-label={label} className="shrink-0 rounded-lg border border-slate-600 p-2 text-gray-300 transition hover:border-cyan-400 hover:text-cyan-300">
        {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
      </button>
    </div>
  );
}

// Annual-plan payment by bank transfer: bank details (set by the platform admin),
// an optional bank QR image, and the receipt upload that lands in the admin
// console for approval. Used right after an annual sign-up and, from the
// dashboard, when a free trial has ended. With kind="branch" it collects the
// (pro-rated) fee for one extra branch instead; the branch is created only when
// the admin approves the receipt.
export default function PaymentPanel({ onRefresh, onLogout = null, onBack = null, renewal = false, planKind = null, kind = "annual", branchFee = 0, branchName = "", lang = "ar" }) {
  const T = TEXT[lang === "ar" ? "ar" : "en"];
  const isBranch = kind === "branch";
  const [bank, setBank] = useState(null);
  const [latest, setLatest] = useState(undefined); // undefined = loading, null = none
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [extraBranches, setExtraBranches] = useState(0);

  const load = async () => {
    const { data: user } = await auth.getUser();
    const uid = user?.user?.id;
    const [{ data: cfg }, { data: reqs }, { count }] = await Promise.all([
      db.from("platform_config").select("bank_name, bank_beneficiary, bank_iban, bank_qr_url").eq("id", true).maybeSingle(),
      uid ? db.from("payment_requests").select().eq("user_id", uid).eq("plan", isBranch ? "branch" : "annual").order("created_at", { ascending: false }).limit(1) : Promise.resolve({ data: [] }),
      // a renewal renews every extra branch together with the main plan
      renewal && !isBranch ? db.from("branches").select("id", { count: "exact", head: true }).eq("status", "active").gt("number", 1) : Promise.resolve({ count: 0 }),
    ]);
    setExtraBranches(count || 0);
    setBank(cfg ? toCamelCase(cfg) : {});
    setLatest(reqs && reqs[0] ? toCamelCase(reqs[0]) : null);
  };
  useEffect(() => { load().catch(() => { setBank({}); setLatest(null); }); }, []);

  const submit = async () => {
    setError("");
    if (!file) { setError(T.errNoFile); return; }
    if (file.size > MAX_RECEIPT_BYTES) { setError(T.errTooBig); return; }
    setSending(true);
    try {
      const { data: user } = await auth.getUser();
      const uid = user?.user?.id;
      if (!uid) throw new Error("no_session");
      const { path } = await uploadPrivateFile(file, "receipts");
      const { error: insErr } = await db.from("payment_requests").insert({ user_id: uid, plan: kind, amount: price, branch_name: isBranch ? branchName : "", receipt_path: path, receipt_name: file.name.slice(0, 120) });
      if (insErr) throw insErr;
      setFile(null);
      await load();
    } catch (e) {
      console.error("payment receipt upload failed", e);
      setError(T.errUpload);
    }
    setSending(false);
  };

  const price = isBranch ? branchFee : ANNUAL_PRICE + extraBranches * BRANCH_PRICE;
  const hasBankInfo = bank && (bank.bankName || bank.bankBeneficiary || bank.bankIban);
  const hasQr = Boolean(bank?.bankQrUrl);
  const pending = latest && latest.status === "pending";
  const rejected = latest && latest.status === "rejected";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4" dir={T.dir}>
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-cyan-500/15 text-cyan-300"><Building2 size={24} /></div>
          <h1 className="text-2xl font-bold text-white">{isBranch ? T.titleBranch : renewal ? (planKind === "annual" ? T.titleAnnualEnded : T.titleTrialEnded) : T.titleAnnual}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {isBranch ? T.subBranch(branchName) : renewal ? T.subRenewal : onBack ? T.subUpgrade : T.subNew}
          </p>
          <div className="mt-4 inline-flex items-baseline gap-1.5 rounded-xl bg-slate-800/80 px-5 py-2">
            <span className="text-3xl font-extrabold text-white">{price}</span>
            <span className="text-sm text-gray-300">{isBranch ? T.perBranch : T.perYear}</span>
            <span className="ms-2 text-xs text-gray-500">{T.vatIncl}</span>
          </div>
        </div>

        {latest === undefined || bank === null ? (
          <div className="flex justify-center py-10 text-gray-400"><Loader2 className="animate-spin" /></div>
        ) : pending ? (
          <div className="space-y-4 text-center">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-200">
              {isBranch ? T.pendingBranch : T.pendingAnnual}
            </div>
            <button onClick={onRefresh} className="w-full rounded-xl bg-cyan-500 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-400">{T.refresh}</button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm leading-relaxed text-gray-300">
              {T.bankNote}
            </p>

            {rejected && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                {T.rejected(latest.rejectReason)}
              </div>
            )}

            {hasBankInfo ? (
              <div className={`grid gap-4 ${hasQr ? "sm:grid-cols-[1fr_auto] sm:items-center" : ""}`}>
                <div className="space-y-2.5">
                  {bank.bankName && <CopyRow label={T.bank} value={bank.bankName} />}
                  {bank.bankBeneficiary && <CopyRow label={T.beneficiary} value={bank.bankBeneficiary} />}
                  {bank.bankIban && <CopyRow label={T.iban} value={bank.bankIban} mono />}
                </div>
                {hasQr && (
                  <div className="mx-auto w-40 shrink-0 rounded-2xl bg-white p-2.5 shadow-lg sm:w-44">
                    <img src={bank.bankQrUrl} alt={T.qrAlt} className="aspect-square w-full rounded-xl object-contain" />
                    <div className="mt-1.5 text-center text-[11px] font-medium text-slate-500">{T.qrScan}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-5 text-center text-sm text-gray-300">
                {T.noBank}
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="mt-3 block rounded-lg bg-emerald-500 py-2.5 font-bold text-slate-950 hover:bg-emerald-400">{T.whatsapp}</a>
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-300">{T.receipt}</label>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-600 bg-slate-800/40 px-4 py-4 text-sm text-gray-300 transition hover:border-cyan-400">
                <Upload size={18} className="shrink-0 text-cyan-300" />
                <span className="min-w-0 flex-1 truncate">{file ? file.name : T.pickFile}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(""); }} />
              </label>
            </div>

            {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
            <button onClick={submit} disabled={sending || !file} className="w-full rounded-xl bg-cyan-500 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50">
              {sending ? T.sending : T.send}
            </button>
          </div>
        )}

        {onBack && <button onClick={onBack} className="mt-5 w-full rounded-xl border border-slate-700 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-cyan-400">{T.back}</button>}
        {onLogout && <button onClick={onLogout} className="mt-3 w-full py-2 text-sm text-gray-400 transition hover:text-gray-300">{T.logout}</button>}
      </div>
    </div>
  );
}
