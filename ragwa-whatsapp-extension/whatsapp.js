// Ragwa WhatsApp Reminders — runs inside the WhatsApp Web tab.
//
// For each reminder in the queue: opens that customer's chat in this same tab
// (no reload) and leaves the reminder text in the message box as a draft. The
// employee reads it and presses Enter. Once the message has gone, the next
// chat opens by itself. A small panel shows the count, with Skip and Stop.
//
// THIS SCRIPT NEVER SENDS A MESSAGE. It does not press Enter, does not click
// the send button, and has no code path that does either. "Sent" is only ever
// detected: the employee pressed Enter (or clicked send) on a non-empty box,
// and the box then emptied.
//
// WhatsApp Web's page structure is not a public interface and changes without
// notice. Everything that depends on it is in the SELECTORS block and the
// three functions right under it, so there is one place to adjust.

(() => {
  const SELECTORS = {
    // Present once WhatsApp Web has finished loading and is signed in.
    appReady: ["#pane-side", "[data-testid='chat-list']", "div[aria-label][role='grid']"],
    // The message box of the open chat.
    composer: [
      "#main footer div[contenteditable='true'][role='textbox']",
      "#main footer div[contenteditable='true']",
      "footer div[contenteditable='true'][data-lexical-editor='true']",
      "[data-testid='conversation-compose-box-input']",
    ],
    // The send button, watched only to notice the employee clicking it.
    sendButton: "[data-icon='send'], [data-icon='wds-ic-send-filled'], [data-testid='compose-btn-send'], button[aria-label='Send'], button[aria-label='إرسال']",
  };
  const OPEN_TIMEOUT_MS = 15000;
  const APP_READY_TIMEOUT_MS = 120000;
  const SENT_WINDOW_MS = 6000;

  const first = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  };
  const composerEl = () => first(SELECTORS.composer);
  const composerText = () => {
    const el = composerEl();
    return el ? el.innerText.replace(/​/g, "").trim() : "";
  };

  // Opens a chat the way WhatsApp Web opens a wa.me link clicked inside a
  // conversation: in place, with the text prefilled. If WhatsApp doesn't take
  // the click, it is cancelled here so the tab never navigates away, and the
  // caller reports the chat as not opened.
  function openChat(phone, text) {
    const link = document.createElement("a");
    link.href = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;
    link.style.display = "none";
    let handled = true;
    const guard = (event) => {
      if (event.target !== link) return;
      if (!event.defaultPrevented) { event.preventDefault(); handled = false; }
    };
    window.addEventListener("click", guard);
    (document.querySelector("#app") || document.body).appendChild(link);
    link.click();
    window.removeEventListener("click", guard);
    link.remove();
    return handled;
  }

  // Puts text into the message box as a draft, for the case where the chat
  // opened but WhatsApp didn't prefill it. Typing only; nothing is sent.
  function writeDraft(text) {
    const el = composerEl();
    if (!el) return;
    el.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    if (!composerText()) document.execCommand("insertText", false, text);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, timeoutMs, stillWanted) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!stillWanted()) return false;
      if (check()) return true;
      await sleep(250);
    }
    return false;
  }

  const toWorker = async (message) => {
    try { return await chrome.runtime.sendMessage(message); } catch { return null; }
  };

  // ---------------------------------------------------------------- panel
  const DEFAULT_LABELS = {
    title: "تذكيرات رغوة", counter: "{i} من {n}", hint: "راجع الرسالة ثم اضغط Enter للإرسال.", skip: "تخطي", stop: "إيقاف",
    opening: "جارٍ فتح المحادثة…", done: "انتهت القائمة. أُرسل {n}.", failed: "تعذّر فتح هذه المحادثة. تخطّها أو أوقف.", stopped: "تم الإيقاف.",
  };
  const host = document.createElement("div");
  host.id = "ragwa-reminders-panel";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .panel { position: fixed; top: 16px; inset-inline-end: 16px; z-index: 2147483000; width: 290px; box-sizing: border-box;
        background: #0d172a; color: #fff; border-radius: 14px; padding: 14px 16px; box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 14px/1.5 "Segoe UI", Tahoma, Arial, sans-serif; }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .title { font-weight: 700; color: #6fdad0; font-size: 13px; }
      .counter { font-weight: 800; font-size: 15px; }
      .name { margin-top: 8px; font-weight: 700; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .phone { direction: ltr; font: 12px ui-monospace, Consolas, monospace; color: rgba(255,255,255,.6); }
      .status { margin-top: 8px; font-size: 12.5px; color: rgba(255,255,255,.85); }
      .status.failed { color: #fda29b; }
      .actions { margin-top: 12px; display: flex; gap: 8px; }
      button { flex: 1; border: 0; border-radius: 9px; padding: 8px 10px; font: inherit; font-weight: 700; cursor: pointer; }
      .skip { background: rgba(255,255,255,.12); color: #fff; }
      .stop { background: #d92d20; color: #fff; }
      .close { flex: 0 0 auto; background: transparent; color: rgba(255,255,255,.7); padding: 0 4px; font-size: 18px; line-height: 1; }
      [hidden] { display: none !important; }
    </style>
    <div class="panel" hidden>
      <div class="head">
        <span class="title"></span>
        <span class="counter"></span>
        <button class="close" type="button" hidden aria-label="Close">×</button>
      </div>
      <div class="name"></div>
      <div class="phone"></div>
      <div class="status"></div>
      <div class="actions">
        <button class="skip" type="button"></button>
        <button class="stop" type="button"></button>
      </div>
    </div>`;
  const ui = Object.fromEntries(["panel", "title", "counter", "name", "phone", "status", "actions", "skip", "stop", "close"].map((c) => [c, shadow.querySelector(`.${c}`)]));
  document.documentElement.appendChild(host);

  // ---------------------------------------------------------------- state
  let myTabId = null;
  let queue = null;
  // Which item is on screen and how far it got: opening | waiting | failed.
  let current = { id: null, phase: null };
  // Set when the employee presses Enter or clicks send on a non-empty box.
  let sendIntentAt = 0;

  const label = (key, vars = {}) => {
    let text = (queue && queue.labels && queue.labels[key]) || DEFAULT_LABELS[key];
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
  const isMine = () => queue && queue.tabId === myTabId;
  const activeItem = () => (isMine() && queue.status === "active" ? queue.items[queue.index] : null);
  const stillOn = (id) => () => { const item = activeItem(); return Boolean(item) && item.id === id; };

  function render() {
    if (!isMine()) { ui.panel.hidden = true; return; }
    ui.panel.hidden = false;
    ui.panel.dir = queue.dir || "rtl";
    ui.title.textContent = label("title");
    ui.skip.textContent = label("skip");
    ui.stop.textContent = label("stop");
    const item = activeItem();
    const finished = !item;
    ui.actions.hidden = finished;
    ui.close.hidden = !finished;
    ui.name.hidden = ui.phone.hidden = finished;
    ui.status.classList.toggle("failed", !finished && current.phase === "failed");
    if (finished) {
      ui.counter.textContent = "";
      ui.status.textContent = queue.status === "done" ? label("done", { n: queue.sentCount }) : label("stopped");
      return;
    }
    ui.counter.textContent = label("counter", { i: queue.index + 1, n: queue.items.length });
    ui.name.textContent = item.name;
    ui.phone.textContent = `+${item.phone}`;
    ui.status.textContent = current.phase === "failed" ? label("failed") : current.phase === "waiting" ? label("hint") : label("opening");
  }

  async function report(outcome) {
    const item = activeItem();
    if (item) await toWorker({ type: "progress", itemId: item.id, outcome });
  }

  // Works through one item. Runs again for the next one when the queue in
  // storage moves on (see onQueueChanged), never by calling itself.
  async function runItem(item) {
    current = { id: item.id, phase: "opening" };
    sendIntentAt = 0;
    render();
    const on = stillOn(item.id);
    const fail = () => { if (on()) { current.phase = "failed"; render(); } };

    if (!(await waitFor(() => first(SELECTORS.appReady), APP_READY_TIMEOUT_MS, on))) return fail();
    if (!openChat(item.phone, item.text)) return fail();
    // The message box of the chat that just opened either already holds the
    // text or is empty; an old chat's box may still be on screen for a moment.
    await sleep(600);
    if (!(await waitFor(() => composerEl(), OPEN_TIMEOUT_MS, on))) return fail();
    await sleep(400);
    if (!on()) return;
    if (!composerText()) writeDraft(item.text);
    if (!(await waitFor(() => composerText(), 3000, on))) return fail();

    current.phase = "waiting";
    render();
    const el = composerEl();
    if (el) el.focus();
    // Wait, for as long as it takes, for the employee to send it themselves.
    while (on()) {
      if (sendIntentAt && Date.now() - sendIntentAt < SENT_WINDOW_MS && !composerText()) {
        await report("sent");
        return;
      }
      await sleep(250);
    }
  }

  function onQueueChanged(next) {
    queue = next || null;
    const item = activeItem();
    if (!item) { current = { id: null, phase: null }; render(); return; }
    if (current.id !== item.id) runItem(item);
    else render();
  }

  // The employee's own send: Enter without Shift in a non-empty message box,
  // or a click on the send button. Only noted here; nothing is triggered.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || !event.isTrusted) return;
    const el = composerEl();
    if (el && el.contains(event.target) && composerText()) sendIntentAt = Date.now();
  }, true);
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.closest(SELECTORS.sendButton) && composerText()) sendIntentAt = Date.now();
  }, true);

  ui.skip.addEventListener("click", () => report("skipped"));
  ui.stop.addEventListener("click", () => report("stopped"));
  ui.close.addEventListener("click", () => toWorker({ type: "clearQueue" }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.queue) onQueueChanged(changes.queue.newValue);
  });
  (async () => {
    const me = await toWorker({ type: "whoAmI" });
    myTabId = me ? me.tabId : null;
    onQueueChanged((await chrome.storage.local.get("queue")).queue);
  })();
})();
