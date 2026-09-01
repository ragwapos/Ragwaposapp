-- WhatsApp "Order Ready" message settings — adds three tenant_settings
-- columns (behind the same single upsert effect that already writes every
-- other tracked settings field together, src/App.jsx LaundryOpsApp).
--
-- Every new column has a DEFAULT on purpose: an earlier migration
-- (supabase-owner-pin-hardening.sql, see PROJECT_REFERENCE.md §20) added a
-- NOT NULL column with no default and broke every tenant_settings upsert
-- (400 on ALL settings saves, not just the new feature) until fixed with
-- `alter column ... set default`. Giving every new column a default here
-- avoids that failure class from the start.
--
-- Applied 2026-09-01 via the Supabase connection linked through Composio.

alter table tenant_settings
  add column if not exists ready_message_enabled boolean not null default false,
  add column if not exists ready_message_template text,
  add column if not exists whatsapp_ready_send_mode text not null default 'ask'
    check (whatsapp_ready_send_mode in ('auto', 'ask', 'off'));
