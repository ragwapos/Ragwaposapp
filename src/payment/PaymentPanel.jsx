import React, { useEffect, useState } from "react";
import { Building2, Check, Copy, Loader2, Upload } from "lucide-react";
import { auth, db } from "../supabase";
import { toCamelCase } from "../utils/transforms.js";
import { uploadPrivateFile } from "../utils/storage.js";
import { ANNUAL_PRICE, BRANCH_PRICE } from "./pricing.js";

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const WHATSAPP_URL = "https://wa.me/966592299405";

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
export default function PaymentPanel({ onRefresh, onLogout = null, onBack = null, renewal = false, planKind = null, kind = "annual", branchFee = 0, branchName = "" }) {
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
    if (!file) { setError("اختر صورة الإيصال أو ملف PDF أولًا."); return; }
    if (file.size > MAX_RECEIPT_BYTES) { setError("حجم الملف أكبر من 5 ميجا."); return; }
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
      setError("تعذر رفع الإيصال، حاول مرة ثانية.");
    }
    setSending(false);
  };

  const price = isBranch ? branchFee : ANNUAL_PRICE + extraBranches * BRANCH_PRICE;
  const hasBankInfo = bank && (bank.bankName || bank.bankBeneficiary || bank.bankIban);
  const hasQr = Boolean(bank?.bankQrUrl);
  const pending = latest && latest.status === "pending";
  const rejected = latest && latest.status === "rejected";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-cyan-500/15 text-cyan-300"><Building2 size={24} /></div>
          <h1 className="text-2xl font-bold text-white">{isBranch ? "إضافة فرع جديد" : renewal ? (planKind === "annual" ? "انتهى اشتراكك السنوي" : "انتهت تجربتك المجانية") : "الاشتراك السنوي"}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {isBranch ? `الفرع: ${branchName}. حوّل الرسوم وأرفق الإيصال، ويُضاف الفرع بعد تأكيد الدفع من فريقنا.` : renewal ? "بياناتك محفوظة. اشترك سنويًا لمتابعة استخدام رغوة بكل المميزات." : onBack ? "اشترك الآن وتستمر بكل المميزات بعد انتهاء التجربة." : "تم تأكيد بريدك. أكمل الدفع لتفعيل حسابك."}
          </p>
          <div className="mt-4 inline-flex items-baseline gap-1.5 rounded-xl bg-slate-800/80 px-5 py-2">
            <span className="text-3xl font-extrabold text-white">{price}</span>
            <span className="text-sm text-gray-300">{isBranch ? "ريال حتى نهاية اشتراكك" : "ريال / سنة"}</span>
            <span className="mr-2 text-xs text-gray-500">شامل الضريبة</span>
          </div>
        </div>

        {latest === undefined || bank === null ? (
          <div className="flex justify-center py-10 text-gray-400"><Loader2 className="animate-spin" /></div>
        ) : pending ? (
          <div className="space-y-4 text-center">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-200">
              {isBranch ? "استلمنا إيصالك وهو الآن قيد المراجعة. سيُضاف الفرع فور تأكيد الدفع." : "استلمنا إيصالك وهو الآن قيد المراجعة. سيتم تفعيل حسابك فور تأكيد الدفع."}
            </div>
            <button onClick={onRefresh} className="w-full rounded-xl bg-cyan-500 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-400">تحديث الحالة</button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm leading-relaxed text-gray-300">
              نعتذر، نعمل حاليًا على تفعيل الدفع الإلكتروني وسيتوفر قريبًا. في الوقت الحالي حوّل المبلغ على الحساب أدناه ثم أرفق الإيصال، وسيراجعه فريقنا ويفعّل اشتراكك.
            </p>

            {rejected && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                لم يُقبل الإيصال السابق{latest.rejectReason ? `: ${latest.rejectReason}` : "."} أرفق إيصالًا صحيحًا.
              </div>
            )}

            {hasBankInfo ? (
              <div className={`grid gap-4 ${hasQr ? "sm:grid-cols-[1fr_auto] sm:items-center" : ""}`}>
                <div className="space-y-2.5">
                  {bank.bankName && <CopyRow label="البنك" value={bank.bankName} />}
                  {bank.bankBeneficiary && <CopyRow label="اسم المستفيد" value={bank.bankBeneficiary} />}
                  {bank.bankIban && <CopyRow label="رقم الآيبان" value={bank.bankIban} mono />}
                </div>
                {hasQr && (
                  <div className="mx-auto w-40 shrink-0 rounded-2xl bg-white p-2.5 shadow-lg sm:w-44">
                    <img src={bank.bankQrUrl} alt="باركود الدفع" className="aspect-square w-full rounded-xl object-contain" />
                    <div className="mt-1.5 text-center text-[11px] font-medium text-slate-500">امسح من تطبيق البنك</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-5 text-center text-sm text-gray-300">
                بيانات الحساب قيد التجهيز. تواصل معنا على واتساب وسنرسلها لك.
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="mt-3 block rounded-lg bg-emerald-500 py-2.5 font-bold text-slate-950 hover:bg-emerald-400">واتساب</a>
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-300">إيصال التحويل</label>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-600 bg-slate-800/40 px-4 py-4 text-sm text-gray-300 transition hover:border-cyan-400">
                <Upload size={18} className="shrink-0 text-cyan-300" />
                <span className="min-w-0 flex-1 truncate">{file ? file.name : "اختر صورة الإيصال أو ملف PDF (حتى 5 ميجا)"}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(""); }} />
              </label>
            </div>

            {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-400">{error}</div>}
            <button onClick={submit} disabled={sending || !file} className="w-full rounded-xl bg-cyan-500 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50">
              {sending ? "جارٍ الإرسال..." : "إرسال الإيصال"}
            </button>
          </div>
        )}

        {onBack && <button onClick={onBack} className="mt-5 w-full rounded-xl border border-slate-700 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-cyan-400">رجوع للنظام</button>}
        {onLogout && <button onClick={onLogout} className="mt-3 w-full py-2 text-sm text-gray-400 transition hover:text-gray-300">تسجيل الخروج</button>}
      </div>
    </div>
  );
}
