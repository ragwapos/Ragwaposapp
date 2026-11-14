// "تذكير باستلام الطلب" — which ready-but-uncollected orders are due a reminder
// today. Pure functions (no React, no database) so the same rules can be run
// from a test script against real rows.

export const DEFAULT_REMINDER_DAYS = [7, 20, 30, 60];
const MAX_REMINDER_DAY = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Whatever is stored (or typed) → unique whole days from 1 to 365, ascending.
// Anything that isn't a list falls back to the defaults; an empty list stays
// empty, which is how a shop turns every stage off.
export function normalizeReminderDays(value) {
  if (!Array.isArray(value)) return DEFAULT_REMINDER_DAYS;
  const days = value.map((d) => Math.floor(Number(d))).filter((d) => d >= 1 && d <= MAX_REMINDER_DAY);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

// When the order became ready: the latest "ready" stamp on its items (set by
// InvoicesView when an item's status changes to Ready). Orders that were
// already ready before those stamps existed count from the invoice date.
export function invoiceReadyAt(invoice) {
  const stamps = (invoice.items || []).map((it) => (it.readyAt ? new Date(it.readyAt).getTime() : NaN)).filter((ms) => !Number.isNaN(ms));
  return stamps.length ? new Date(Math.max(...stamps)) : new Date(invoice.createdAt);
}

// One entry per order that is due, never more than one per order:
//   stage          the latest reminder day the order has reached
//   skippedStages  earlier days it also reached with nothing logged for them;
//                  they are logged as "skipped" when `stage` is sent
// An order whose latest reached stage is already logged (sent or skipped) is
// not due, even if an earlier stage was never logged.
//   invoices   already limited to ready, not collected, not delivery orders
//   logs       pickup_reminders rows ({ invoiceId, reminderDay })
export function dueReminders({ invoices, customers, logs, days, now = new Date() }) {
  const stages = normalizeReminderDays(days);
  const loggedByInvoice = new Map();
  for (const log of logs) {
    if (!loggedByInvoice.has(log.invoiceId)) loggedByInvoice.set(log.invoiceId, new Set());
    loggedByInvoice.get(log.invoiceId).add(log.reminderDay);
  }
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const due = [];
  for (const invoice of invoices) {
    const customer = customerById.get(invoice.customerId);
    if (!customer || !customer.mobile) continue;
    const readyAt = invoiceReadyAt(invoice);
    const daysSinceReady = Math.floor((now.getTime() - readyAt.getTime()) / DAY_MS);
    const reached = stages.filter((d) => d <= daysSinceReady);
    if (!reached.length) continue;
    const logged = loggedByInvoice.get(invoice.id) || new Set();
    const stage = reached[reached.length - 1];
    if (logged.has(stage)) continue;
    due.push({ invoice, customer, readyAt, daysSinceReady, stage, skippedStages: reached.slice(0, -1).filter((d) => !logged.has(d)) });
  }
  return due.sort((a, b) => b.daysSinceReady - a.daysSinceReady);
}

// The pickup_reminders rows for one sent reminder: the stage itself as "sent",
// plus every earlier stage it replaced as "skipped".
export function reminderLogRows({ tenantId, invoice, customer, stage, skippedStages, phone, message }) {
  const base = { tenantId, branchId: invoice.branchId || null, invoiceId: invoice.id, customerId: customer.id, customerName: customer.name || invoice.customerName || "", phone };
  return [
    ...skippedStages.map((day) => ({ ...base, reminderDay: day, status: "skipped", message: null })),
    { ...base, reminderDay: stage, status: "sent", message },
  ];
}
