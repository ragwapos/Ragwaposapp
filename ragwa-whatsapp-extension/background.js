// Ragwa WhatsApp Reminders — background service worker.
//
// Owns the two things kept in chrome.storage.local, and is the only place that
// writes them (every write goes through `serial`, so two tabs can't overwrite
// each other's change):
//
//   queue          the list Ragwa handed over and how far the employee has got
//                  { items, index, sentCount, status, tabId, labels, dir }
//                  status: "active" | "stopped" | "done"
//                  Once a run is stopped or done, its items (names, numbers, texts)
//                  are wiped; only the counts the panel shows are kept.
//   confirmations  reminders the employee sent that Ragwa hasn't logged yet
//                  [{ id, log, sentAt }]
//
// It holds no database keys and makes no network requests. Ragwa's own page
// does every database write (see src/utils/whatsappExtension.js in the app).

const WHATSAPP_URL = "https://web.whatsapp.com/";
const MAX_ITEMS = 500;
const MAX_TEXT = 4000;
const MAX_LOG_BYTES = 20000;

let chain = Promise.resolve();
function serial(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

const read = async (key, fallback) => (await chrome.storage.local.get(key))[key] ?? fallback;
const write = (key, value) => chrome.storage.local.set({ [key]: value });

// Only what a reminder needs, in the shapes it should have. Anything else the
// page sent is dropped, and an item with a bad number or no text is refused.
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const clean = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (!item || typeof item.id !== "string" || typeof item.text !== "string") continue;
    const phone = String(item.phone || "").replace(/\D/g, "");
    const text = item.text.slice(0, MAX_TEXT);
    if (phone.length < 8 || phone.length > 15 || !text.trim()) continue;
    if (JSON.stringify(item.log ?? null).length > MAX_LOG_BYTES) continue;
    clean.push({ id: item.id.slice(0, 200), name: String(item.name || "").slice(0, 120), phone, text, log: item.log ?? null });
  }
  return clean;
}

function cleanLabels(labels) {
  const out = {};
  if (labels && typeof labels === "object") {
    for (const key of ["title", "counter", "hint", "skip", "stop", "opening", "done", "failed", "stopped"]) {
      if (typeof labels[key] === "string") out[key] = labels[key].slice(0, 200);
    }
  }
  return out;
}

// The WhatsApp Web tab the queue runs in: an open one if there is one,
// otherwise a new tab. Brought to the front either way.
async function focusWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  const tab = tabs[0] || (await chrome.tabs.create({ url: WHATSAPP_URL }));
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab.id;
}

const handlers = {
  // From Ragwa's page (through bridge.js).
  async ping() {
    return { version: chrome.runtime.getManifest().version, confirmations: await read("confirmations", []) };
  },
  async sendQueue(message) {
    const items = cleanItems(message.items);
    if (!items.length) return { count: 0 };
    const tabId = await focusWhatsAppTab();
    await write("queue", { items, index: 0, sentCount: 0, status: "active", tabId, labels: cleanLabels(message.labels), dir: message.dir === "ltr" ? "ltr" : "rtl" });
    return { count: items.length };
  },
  async ack(message) {
    const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
    await write("confirmations", (await read("confirmations", [])).filter((c) => !ids.has(c.id)));
    return { ok: true };
  },

  // From the WhatsApp Web tab (whatsapp.js).
  async whoAmI(_message, sender) {
    return { tabId: sender.tab ? sender.tab.id : null };
  },
  // The employee sent the current item, skipped it, or stopped the run.
  async progress(message) {
    const queue = await read("queue", null);
    if (!queue || queue.status !== "active") return { ok: false };
    const item = queue.items[queue.index];
    if (!item || item.id !== message.itemId) return { ok: false };
    if (message.outcome === "stopped") {
      await write("queue", { ...queue, items: [], status: "stopped" });
      return { ok: true };
    }
    if (message.outcome === "sent") {
      const confirmations = await read("confirmations", []);
      if (!confirmations.some((c) => c.id === item.id)) {
        await write("confirmations", [...confirmations, { id: item.id, log: item.log, sentAt: new Date().toISOString() }]);
      }
    }
    const index = queue.index + 1;
    const sentCount = queue.sentCount + (message.outcome === "sent" ? 1 : 0);
    const done = index >= queue.items.length;
    await write("queue", { ...queue, index, sentCount, items: done ? [] : queue.items, status: done ? "done" : "active" });
    return { ok: true };
  },
  async clearQueue() {
    await chrome.storage.local.remove("queue");
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && typeof message.type === "string" ? handlers[message.type] : null;
  if (!handler) return false;
  serial(() => handler(message, sender)).then(sendResponse, (error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
  return true;
});
