import { auth, db } from '../supabase';

// Every user-uploaded file in this app (product image, purchase invoice
// attachment, expense receipt) lands in this one public Storage bucket,
// under <uid>/<folder>/<random>-<name> — same bucket the WhatsApp
// invoice-sharing feature already uses (see supabase-whatsapp-feature.sql).
// Reusing it, rather than provisioning a new bucket + RLS set per file
// kind, matches that file's own reasoning: the bucket name is just an
// identifier, not a content-type constraint.
const BUCKET = 'invoice-pdfs';

function safeFileName(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

// Uploads straight from the browser to Supabase Storage — the app has no
// server hop for the file payload itself, direct-to-storage same as any
// pre-signed-URL flow — and returns the public URL Supabase's storage CDN
// serves that bucket from. That URL is the only thing callers should ever
// persist to a database row; never the file's bytes.
export async function uploadTenantFile(file, folder) {
  const { data: userData, error: userErr } = await auth.getUser();
  if (userErr || !userData?.user) throw new Error('no_session');
  const uid = userData.user.id;
  const path = `${uid}/${folder}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadErr } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (uploadErr) throw uploadErr;
  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
  return { url: pub?.publicUrl || '', path };
}

// Best-effort cleanup for a file this tenant previously uploaded through
// uploadTenantFile. Silently no-ops on anything that isn't one of our own
// Storage URLs — a legacy base64 string still sitting in an old row, or an
// empty value — so callers can pass whatever's already on the record
// without checking its shape first. Never throws: a stray orphaned file is
// harmless, so a failed delete shouldn't block whatever the caller was
// actually trying to do (save a product, record a purchase, ...).
export async function deleteTenantFile(url) {
  if (!url || typeof url !== 'string') return;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const path = decodeURIComponent(url.slice(idx + marker.length));
  await db.storage.from(BUCKET).remove([path]).catch(() => {});
}
