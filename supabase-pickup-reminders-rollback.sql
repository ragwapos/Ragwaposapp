-- Undoes supabase-pickup-reminders.sql.
-- WARNING: drops the pickup_reminders send log and the saved reminder
-- settings. Only run this after the code that names these columns is no longer
-- deployed against this database (its settings save would fail otherwise).

drop table if exists public.pickup_reminders;

alter table public.tenant_settings
  drop column if exists pickup_reminder_enabled,
  drop column if exists pickup_reminder_template,
  drop column if exists pickup_reminder_days;
