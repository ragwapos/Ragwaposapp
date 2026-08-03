-- =========================================================================
-- Ragwa POS — invoice total self-consistency trigger (run once in Supabase
-- Dashboard → SQL Editor → New Query → Run).
-- =========================================================================
-- src/App.jsx computes an invoice's `total` (createInvoice: grandTotal =
-- max(0, sum(items[].lineTotal) - discount) + (isDelivery ? deliveryFee :
-- 0)) entirely client-side and writes it straight to the `invoices` table —
-- there was previously NOTHING on the server confirming that number
-- actually matches the invoice's own line items. A direct API call
-- (bypassing the POS UI entirely — e.g. from devtools, using the same
-- session a cashier already has) could insert or UPDATE an invoice with any
-- `total` at all, disconnected from its items/discount/delivery_fee, with
-- Cash/External Network sales in particular never touching any other
-- balance check (only Wallet/Split/Credit payments go through
-- apply_customer_payment()'s atomic check).
--
-- This trigger closes that specific gap: it recomputes the same formula
-- App.jsx uses from the row's own items/discount/delivery_fee and rejects
-- the write if `total` doesn't match within a 1-cent tolerance (floating
-- point rounding).
--
-- IMPORTANT — SCOPE: this only checks INTERNAL arithmetic consistency
-- (total reconciles with the items/discount/fee stored ON THE SAME ROW). It
-- does NOT re-verify that each item's line_total matches the real price in
-- `products`/`addons`, nor that `discount` corresponds to a real active
-- promotion. A fully self-consistent fabricated invoice (fake items priced
-- to match a fake total) would still pass. Closing that would require
-- recomputing pricing server-side against products/addons/promotions —
-- a larger follow-up, not attempted here. This trigger meaningfully raises
-- the bar (a lazy "just change the total" tamper now fails immediately)
-- without risking the full pricing/promotion logic having to be correctly
-- re-implemented twice (JS and SQL) in one pass.
-- =========================================================================

create or replace function validate_invoice_total()
returns trigger
language plpgsql
as $$
declare
  v_items_sum numeric;
  v_expected numeric;
begin
  select coalesce(sum((item->>'line_total')::numeric), 0) into v_items_sum
  from jsonb_array_elements(new.items) as item;

  v_expected := greatest(0, v_items_sum - coalesce(new.discount, 0))
    + (case when new.is_delivery then coalesce(new.delivery_fee, 0) else 0 end);

  if abs(new.total - v_expected) > 0.01 then
    raise exception 'invoice_total_mismatch: total=% expected=% (items_sum=%, discount=%, delivery_fee=%)',
      new.total, v_expected, v_items_sum, new.discount, new.delivery_fee;
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_validate_total on invoices;
create trigger invoices_validate_total
  before insert or update on invoices
  for each row execute function validate_invoice_total();
