-- =========================================================================
-- Ragwa POS — a customer may take part of a pay-later order without paying;
-- what's owed is collected when the LAST piece is handed over or the
-- invoice is closed. Replaces invoices_credit_guard() from
-- supabase-credit-invoice-payment.sql (apply that one first).
-- Staging first, then production before merging the code that relies on it.
-- Rollback: supabase-credit-partial-handover-rollback.sql
-- =========================================================================
create or replace function invoices_credit_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  v_new_count int := case when jsonb_typeof(new.items) = 'array' then jsonb_array_length(new.items) else 0 end;
  v_old_count int := case when jsonb_typeof(old.items) = 'array' then jsonb_array_length(old.items) else 0 end;
begin
  if tg_op = 'INSERT' then
    new.credit_due := invoice_credit_portion(new.pay_method, new.split_payments, new.total);
    return new;
  end if;
  -- Only pay_invoice_credit() (which sets this flag for its own update)
  -- may change what is owed.
  if coalesce(current_setting('ragwa.credit_write', true), '') <> 'on' then
    new.credit_due := old.credit_due;
  end if;
  -- While anything is owed: no closing, and no handing over the last
  -- piece(s); single pieces may go out before that.
  if new.credit_due > 0 and (
       (new.closed and not coalesce(old.closed, false))
       or (v_new_count > 0 and invoice_delivered_count(new.items) = v_new_count
           and not (v_old_count > 0 and invoice_delivered_count(old.items) = v_old_count))) then
    raise exception 'credit_unpaid' using errcode = 'P0001';
  end if;
  return new;
end $$;
