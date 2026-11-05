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

const DEFAULT_WHATSAPP_TEMPLATE =
  "مرحبًا {customer_name} 👋\nهذي فاتورتك من {store_name} — رقم الفاتورة {invoice_id}، بإجمالي {total_amount} ريال.\nتقدر تحمّل نسخة الفاتورة من هنا:\n{invoice_url}\n\nشكرًا لثقتك فينا!";

const DEFAULT_READY_MESSAGE_TEMPLATE =
  "مرحبًا {customer_name} 👋\nطلبك رقم {order_id} من {store_name} أصبح جاهزًا للاستلام.\nنسعد بخدمتك 🤍";

const DEFAULT_WHATSAPP_TEMPLATE_EN =
  "Hello {customer_name} 👋\nHere's your invoice from {store_name}: invoice {invoice_id}, total {total_amount} SAR.\nYou can download a copy here:\n{invoice_url}\n\nThank you for choosing us!";

const DEFAULT_READY_MESSAGE_TEMPLATE_EN =
  "Hello {customer_name} 👋\nYour order {order_id} from {store_name} is ready for pickup.\nWe're happy to serve you 🤍";

// Built-in message text for a shop that never customized it: English for an
// English UI, Arabic otherwise (Urdu-speaking staff still message Arabic customers).
export function whatsAppDefaults(lang) {
  return lang === "en"
    ? { invoice: DEFAULT_WHATSAPP_TEMPLATE_EN, ready: DEFAULT_READY_MESSAGE_TEMPLATE_EN }
    : { invoice: DEFAULT_WHATSAPP_TEMPLATE, ready: DEFAULT_READY_MESSAGE_TEMPLATE };
}

// Replaces every {tag} in the template with its value from `vars`; any tag
// with no matching key (or a null/undefined value) is left blank rather
// than left as literal "{tag}" text in the message the customer receives.
// `fallback` is the built-in text (see whatsAppDefaults) used when the shop
// hasn't saved its own template for this message kind.
export function fillWhatsAppTemplate(template, vars, fallback) {
  const text = template && template.trim() ? template : fallback;
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars ? vars[key] : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}
