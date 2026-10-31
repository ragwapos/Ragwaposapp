-- Rollback for supabase-subscriptions.sql (receipt files in storage are not touched).
drop table if exists payment_requests;
alter table platform_config drop column if exists bank_name, drop column if exists bank_beneficiary, drop column if exists bank_iban, drop column if exists bank_qr_url;
alter table registration_requests drop column if exists plan;
alter table tenants drop column if exists subscription_ends_at, drop column if exists plan;
