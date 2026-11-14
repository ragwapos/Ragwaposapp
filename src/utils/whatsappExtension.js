// Page side of the link to the Ragwa WhatsApp Chrome extension
// (ragwa-whatsapp-extension/). The two talk only through window.postMessage:
// the extension's bridge script runs on this page and relays to its own
// background worker. The extension holds no database keys — every database
// write happens here, in the signed-in dashboard.
//
// Page → extension            Extension → page
//   PING                        PONG { version, pending }
//   SEND_QUEUE { items }        QUEUE_ACCEPTED { count }
//   ACK { ids }                 CONFIRMATIONS { items }
//
// A confirmation is one reminder the employee actually sent in WhatsApp Web.
// The extension keeps it until this page ACKs it, so nothing is lost when the
// dashboard tab was closed at the time.

const TO_EXTENSION = "ragwa-page";
const FROM_EXTENSION = "ragwa-extension";

export function postToExtension(type, payload = {}) {
  window.postMessage({ source: TO_EXTENSION, type, ...payload }, window.location.origin);
}

// Calls `handler(type, data)` for every message from the extension's bridge.
// Returns the unsubscribe function.
export function onExtensionMessage(handler) {
  const listener = (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_EXTENSION || typeof data.type !== "string") return;
    handler(data.type, data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
