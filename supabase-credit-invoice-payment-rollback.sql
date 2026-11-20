-- Rollback for supabase-credit-invoice-payment.sql. Only run together with
-- reverting the app code that uses it. Customer debts are kept; only the
-- per-invoice balances and the invoice link on payments go away.
drop function if exists pay_invoice_credit(uuid, jsonb);
drop trigger if exists customers_debt_guard on customers;
drop function if exists customers_debt_guard();
drop trigger if exists invoices_credit_guard on invoices;
drop function if exists invoices_credit_guard();
drop function if exists invoice_delivered_count(jsonb);
drop function if exists invoice_credit_portion(text, jsonb, numeric);
drop index if exists customer_transactions_invoice_id_idx;
alter table customer_transactions drop column if exists invoice_id;
alter table invoices drop constraint if exists invoices_credit_due_check;
alter table invoices drop column if exists credit_due;
