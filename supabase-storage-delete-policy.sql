-- The 'invoice-pdfs' bucket (see supabase-whatsapp-feature.sql) only ever
-- got insert/update/select policies — nothing could actually delete an
-- object. Needed now that product images, purchase attachments, and
-- expense receipts all live there too (src/utils/storage.js) and get
-- replaced/re-picked before save, which should clean up the orphaned file
-- rather than leak it forever. Run once in the Supabase SQL editor.

create policy "tenant can delete own uploaded files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'invoice-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
