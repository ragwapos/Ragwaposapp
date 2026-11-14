// Ragwa WhatsApp Reminders — runs on Ragwa's own pages only (see manifest.json).
// Relays between the page (window.postMessage) and the background worker. The
// page-side counterpart is src/utils/whatsappExtension.js in the app.
//
//   page → here     { source: "ragwa-page", type: "PING" | "SEND_QUEUE" | "ACK", ... }
//   here → page     { source: "ragwa-extension", type: "PONG" | "QUEUE_ACCEPTED" | "CONFIRMATIONS", ... }

(() => {
  const FROM_PAGE = "ragwa-page";
  const TO_PAGE = "ragwa-extension";

  const toPage = (type, payload) => window.postMessage({ source: TO_PAGE, type, ...payload }, window.location.origin);

  // After the extension is reloaded or removed, this script is orphaned and
  // chrome.runtime throws; the page then simply sees no extension until it is
  // reloaded.
  const toWorker = async (message) => {
    try { return await chrome.runtime.sendMessage(message); } catch { return null; }
  };

  const deliver = (confirmations) => {
    if (Array.isArray(confirmations) && confirmations.length) toPage("CONFIRMATIONS", { items: confirmations });
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_PAGE) return;

    if (data.type === "PING") {
      const reply = await toWorker({ type: "ping" });
      if (!reply || reply.error) return;
      toPage("PONG", { version: reply.version });
      // Anything sent while no Ragwa tab was open is handed over now.
      deliver(reply.confirmations);
    } else if (data.type === "SEND_QUEUE") {
      const reply = await toWorker({ type: "sendQueue", items: data.items, labels: data.labels, dir: data.dir });
      if (reply && !reply.error) toPage("QUEUE_ACCEPTED", { count: reply.count });
    } else if (data.type === "ACK") {
      await toWorker({ type: "ack", ids: data.ids });
    }
  });

  // A reminder sent while this page is open reaches it straight away.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.confirmations) deliver(changes.confirmations.newValue);
    });
  } catch { /* orphaned script, see toWorker */ }
})();
