import { auth, db } from '../supabase';

// Product images (and the WhatsApp-shared invoice PDFs, see
// supabase-whatsapp-feature.sql) stay in this public bucket — nothing in
// them is sensitive, and invoice PDFs specifically need to be openable by
// a customer with zero login. Purchase invoice attachments and expense
// receipts are different: those are financial documents that were only
// ever meant to be seen by this tenant (or an admin), so they live in a
// separate PRIVATE bucket instead and are only ever reached through a
// short-lived signed URL — never a permanent link.
const PUBLIC_BUCKET = 'invoice-pdfs';
const PRIVATE_BUCKET = 'tenant-documents';

function safeFileName(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

async function uploadTo(bucket, file, folder) {
  const { data: userData, error: userErr } = await auth.getUser();
  if (userErr || !userData?.user) throw new Error('no_session');
  const uid = userData.user.id;
  const path = `${uid}/${folder}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadErr } = await db.storage.from(bucket).upload(path, file, { contentType: file.type || undefined });
  if (uploadErr) throw uploadErr;
  return path;
}

// Uploads straight from the browser to the PUBLIC bucket — no app-server
// hop for the file payload — and returns the permanent public URL. That
// URL is the only thing callers should persist to a database row for
// files uploaded this way; never the file's bytes.
export async function uploadTenantFile(file, folder) {
  const path = await uploadTo(PUBLIC_BUCKET, file, folder);
  const { data: pub } = db.storage.from(PUBLIC_BUCKET).getPublicUrl(path);
  return { url: pub?.publicUrl || '', path };
}

// Uploads to the PRIVATE bucket. Unlike uploadTenantFile, there is no
// public URL — callers must persist the returned PATH (not a URL) and
// call getSignedUrl() to actually view it later.
export async function uploadPrivateFile(file, folder) {
  const path = await uploadTo(PRIVATE_BUCKET, file, folder);
  return { path };
}

// Best-effort cleanup for a file this tenant previously uploaded through
// uploadTenantFile. Silently no-ops on anything that isn't one of our own
// PUBLIC-bucket Storage URLs — a legacy base64 string still sitting in an
// old row, or an empty value — so callers can pass whatever's already on
// the record without checking its shape first. Never throws: a stray
// orphaned file is harmless, so a failed delete shouldn't block whatever
// the caller was actually trying to do (save a product, record a purchase...).
export async function deleteTenantFile(url) {
  if (!url || typeof url !== 'string') return;
  const marker = `/storage/v1/object/public/${PUBLIC_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const path = decodeURIComponent(url.slice(idx + marker.length));
  await db.storage.from(PUBLIC_BUCKET).remove([path]).catch(() => {});
}

// Same idea as deleteTenantFile, but for the PRIVATE bucket, where the
// stored value is already a bare path (never a URL) — no marker-parsing
// needed. No-ops on anything that isn't a private-bucket path (a legacy
// base64 string, an old public-bucket URL from before this bucket
// existed, or empty).
export async function deletePrivateFile(path) {
  if (!path || typeof path !== 'string' || path.startsWith('data:') || path.startsWith('http')) return;
  await db.storage.from(PRIVATE_BUCKET).remove([path]).catch(() => {});
}

// A 60-second signed URL is plenty — callers (DocumentViewerModal in
// App.jsx) use it immediately to render the document inline and never
// persist it; regenerating one is one click away. Viewing used to open a
// blank tab and redirect it once this resolved, but several ad-blockers
// and anti-redirect extensions silently block exactly that pattern (it's
// also how malvertising redirects work) — the tab would open and just stay
// blank forever, no error anywhere. DocumentViewerModal renders the result
// inline instead, so there's no external tab involved in the primary path.
export async function getSignedUrl(path, expiresIn = 60) {
  const { data, error } = await db.storage.from(PRIVATE_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
