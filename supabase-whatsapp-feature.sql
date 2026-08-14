-- WhatsApp invoice sharing: a customizable message template on
-- tenant_settings, and a public Storage bucket + RLS policies for the
-- invoice PDFs generated client-side when a cashier taps "WhatsApp" on a
-- receipt. Run once in the Supabase SQL editor.

alter table tenant_settings add column if not exists whatsapp_template text;

-- Public bucket: anyone with the link can open the PDF with no login, same
-- as any ordinary invoice-sharing flow — links are permanent (no signed-URL
-- expiry) and unguessable (random suffix per file, see PrintDocumentModal's
-- shareOnWhatsApp).
insert into storage.buckets (id, name, public)
values ('invoice-pdfs', 'invoice-pdfs', true)
on conflict (id) do nothing;

-- Each tenant may only write into a folder named after their own auth.uid()
-- (the path shareOnWhatsApp uploads to is `${uid}/...`), mirroring every
-- other tenant-scoped RLS policy in this project.
create policy "tenant can upload own invoice pdfs"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "tenant can update own invoice pdfs"
  on storage.objects for update to authenticated
  using (bucket_id = 'invoice-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "anyone can read invoice pdfs"
  on storage.objects for select to public
  using (bucket_id = 'invoice-pdfs');
