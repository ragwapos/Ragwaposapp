// Recursive camelCase <-> snake_case object key converters, with a
// protected-keys exception: some fields hold DATA as their object keys
// (e.g. product.services is keyed by service type names the shop owner
// typed in, like "Iron Only"; enabledPayMethods is keyed by payment-method
// label strings like "External Network") rather than structural field
// names. Recursively case-converting THOSE would corrupt them (e.g.
// "External Network" -> "_external _network") and silently break every
// services[...] / enabledPayMethods[...] lookup in the app. The field's own
// key still converts normally either way (services / enabled_pay_methods
// are real column names) — only the VALUE under a protected key is left
// completely untouched, checked at any nesting depth by key name.
//
// invoice.items[].addons and splitPayments were considered for this list
// too, but both are arrays of objects with real structural field names —
// addons: [{id, name, price}], splitPayments: [{method, amount}] — verified
// against every read site in App.jsx (always accessed via .map()/.reduce()/
// .filter(), never as a dictionary). They are NOT data-as-keys maps, so they
// convert safely and are deliberately left OFF this list.
const PROTECTED_KEYS = new Set(["services", "enabledPayMethods", "enabled_pay_methods"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}

export function toSnakeCase(obj) {
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    out[snakeKey] = PROTECTED_KEYS.has(key) ? value : toSnakeCase(value);
  }
  return out;
}

export function toCamelCase(obj) {
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    out[camelKey] = PROTECTED_KEYS.has(key) ? value : toCamelCase(value);
  }
  return out;
}
