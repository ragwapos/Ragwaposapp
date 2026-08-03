-- =========================================================================
-- Ragwa POS — defense-in-depth CHECK on promotions.value (run once in
-- Supabase Dashboard → SQL Editor → New Query → Run).
-- =========================================================================
-- src/App.jsx's PromotionModal now rejects a value <= 0 (and a percentage
-- value > 100) client-side before save — a negative discount value would
-- otherwise INCREASE the customer's total instead of reducing it, since
-- promoDiscount()/Math.min() at POS assume value is always a genuine
-- reduction. This constraint is the same client-can't-be-trusted-alone
-- backstop already applied to wallet_balance/debt/supplier balance in
-- supabase-rls-and-integrity.sql, so a direct API call (bypassing the UI)
-- can't sneak an invalid value in either.
-- =========================================================================

alter table promotions drop constraint if exists promotions_value_positive;
alter table promotions add constraint promotions_value_positive check (value > 0);

alter table promotions drop constraint if exists promotions_percent_max_100;
alter table promotions add constraint promotions_percent_max_100
  check (not is_percent or value <= 100);
