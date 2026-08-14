-- Adds the on/off switch for WhatsApp invoice sharing (Settings → "واتس").
-- Off by default for every existing tenant — nobody's behavior changes
-- until they explicitly turn it on. Run once in the Supabase SQL editor.

alter table tenant_settings add column if not exists whatsapp_enabled boolean not null default false;
