-- Purchase invoice attachments and expense receipts were sharing the
-- 'invoice-pdfs' PUBLIC bucket (see supabase-whatsapp-feature.sql /
-- supabase-storage-delete-policy.sql) with customer-facing invoice PDFs.
-- Those are financial documents that were never meant to be reachable by
-- anyone with the link, unlike an invoice a cashier deliberately shares
-- over WhatsApp — so they move to their own PRIVATE bucket instead.
-- src/utils/storage.js only ever reaches this bucket through a
-- short-lived signed URL (createSignedUrl), never a permanent public one.
-- Run once in the Supabase SQL editor.

insert into storage.buckets (id, name, public)
values ('tenant-documents', 'tenant-documents', false)
on conflict (id) do nothing;

create policy "tenant can upload own documents"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "tenant can update own documents"
  on storage.objects for update to authenticated
  using (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- No `for select to public` policy at all — that's what makes this bucket
-- private. Only the owning tenant (or an admin, mirroring every other
-- tenant-scoped table's RLS in this project) can even generate a signed
-- URL for one of these objects in the first place.
create policy "tenant or admin can read own documents"
  on storage.objects for select to authenticated
  using (bucket_id = 'tenant-documents' and ((storage.foldername(name))[1] = auth.uid()::text or is_admin()));

create policy "tenant can delete own documents"
  on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = auth.uid()::text);
