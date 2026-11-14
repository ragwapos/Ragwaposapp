// Builds the Chrome Web Store package of the Ragwa WhatsApp extension:
//   npm run build:extension  ->  dist-extension/ragwa-whatsapp-extension-<version>.zip
//
// ragwa-whatsapp-extension/manifest.json is the development manifest: it also
// reaches http://localhost and staging.ragwapos.com so the extension can be
// tested against a local or staging Ragwa. The store package keeps only the
// production sites (web.whatsapp.com, ragwapos.com, www.ragwapos.com), and only
// the files the extension runs (no README, store listing or screenshots).
// The zip is written here with node:zlib, so no extra dependency is needed.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'ragwa-whatsapp-extension');
const OUT = path.join(ROOT, 'dist-extension');
const FILES = ['background.js', 'bridge.js', 'whatsapp.js', 'icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png'];
const DEV_ONLY = /^(http:\/\/localhost\/|https:\/\/staging\.ragwapos\.com\/)/;
const ALLOWED = new Set(['https://web.whatsapp.com/*', 'https://ragwapos.com/*', 'https://www.ragwapos.com/*']);

const manifest = JSON.parse(readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
manifest.host_permissions = manifest.host_permissions.filter((p) => !DEV_ONLY.test(p));
for (const script of manifest.content_scripts) script.matches = script.matches.filter((m) => !DEV_ONLY.test(m));

// Refuse to build anything wider than intended, so a later edit to the dev
// manifest can't quietly widen what the store version is allowed to reach.
const reached = new Set([...manifest.host_permissions, ...manifest.content_scripts.flatMap((s) => s.matches)]);
const extra = [...reached].filter((p) => !ALLOWED.has(p));
if (extra.length) throw new Error(`[build-extension] غير مسموح بنسخة المتجر: ${extra.join(', ')}`);
if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])) throw new Error('[build-extension] الصلاحيات المتوقعة storage فقط.');
for (const file of FILES) if (!existsSync(path.join(SRC, file))) throw new Error(`[build-extension] ملف ناقص: ${file}`);

// ---- minimal zip writer (deflate, one central directory, no zip64) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  // Fixed timestamp (2026-01-01 00:00) so the same sources give the same zip.
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const entries = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
  ...FILES.map((file) => ({ name: file, data: readFileSync(path.join(SRC, file)) })),
];
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, `ragwa-whatsapp-extension-${manifest.version}.zip`);
writeFileSync(outFile, zip(entries));
console.log(`[build-extension] ${path.relative(ROOT, outFile)} (${entries.length} ملفات) — الصلاحيات: ${[...reached].join(', ')}`);
