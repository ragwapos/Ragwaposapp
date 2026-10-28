// Random UUID v4 that works on every browser we support. crypto.randomUUID()
// only exists from Chrome 92 / Safari 15.4 — on an older browser calling it
// directly throws "crypto.randomUUID is not a function" and takes down the
// whole app (a new shop's first dashboard load creates its settings row with
// one, so it crashed on every login). The fallback builds the same RFC 4122
// v4 format from crypto.getRandomValues, the same CSPRNG source.
export function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}
