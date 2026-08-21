-- Expense receipts used to store just the picked file's name as a plain
-- text label — the file itself was never actually uploaded anywhere, so
-- there was nothing behind it to open. Now that recordExpense uploads to
-- Storage (src/utils/storage.js) and `receipt` holds the real public URL,
-- this column keeps the original file name for display/download, mirroring
-- purchases.attachment_name. Run once in the Supabase SQL editor.

alter table expenses add column if not exists receipt_name text;
