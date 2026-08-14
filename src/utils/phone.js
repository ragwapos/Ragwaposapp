// Saudi mobile numbers are stored/displayed in full international format
// (9665XXXXXXXX, 12 digits) everywhere in this app — needed because wa.me
// links require the country code. Cashiers still type the number the way
// they always have (starting with 0 or 5); normalizeSaudiMobile converts
// that on the fly.
//
// The conversion is idempotent and operates on the FULL current digit
// string (not just "the first character ever typed"), which is what makes
// it safe to call on every keystroke's onChange value: once the string
// already starts with "966" it's a no-op, so it never re-mangles a number
// the cashier is still in the middle of typing or editing.
export function normalizeSaudiMobile(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "966" + digits.slice(1);
  else if (digits.startsWith("5")) digits = "966" + digits;
  return digits.slice(0, 12);
}

export function isValidSaudiMobile(raw) {
  return /^9665\d{8}$/.test(normalizeSaudiMobile(raw));
}

// Used at WhatsApp-share time (not just on input) so customer records saved
// before this feature existed — the old 10-digit 05XXXXXXXX format — still
// produce a correct wa.me link with no database backfill required.
export function cleanPhoneForWhatsApp(mobile) {
  return normalizeSaudiMobile(mobile);
}

export const DEFAULT_WHATSAPP_TEMPLATE =
  "مرحبًا {customer_name} 👋\nهذي فاتورتك من {store_name} — رقم الفاتورة {invoice_id}، بإجمالي {total_amount} ريال.\nتقدر تحمّل نسخة الفاتورة من هنا:\n{invoice_url}\n\nشكرًا لثقتك فينا!";

// Replaces every {tag} in the template with its value from `vars`; any tag
// with no matching key (or a null/undefined value) is left blank rather
// than left as literal "{tag}" text in the message the customer receives.
export function fillWhatsAppTemplate(template, vars) {
  const text = template && template.trim() ? template : DEFAULT_WHATSAPP_TEMPLATE;
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars ? vars[key] : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}
