-- Rollback for supabase-credit-partial-handover.sql: back to refusing ANY
-- piece handed over while something is owed (only safe together with the
-- app code that asks for payment on every hand-over).
create or replace function invoices_credit_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.credit_due := invoice_credit_portion(new.pay_method, new.split_payments, new.total);
    return new;
  end if;
  if coalesce(current_setting('ragwa.credit_write', true), '') <> 'on' then
    new.credit_due := old.credit_due;
  end if;
  if new.credit_due > 0 and (
       (new.closed and not coalesce(old.closed, false))
       or invoice_delivered_count(new.items) > invoice_delivered_count(old.items)) then
    raise exception 'credit_unpaid' using errcode = 'P0001';
  end if;
  return new;
end $$;
