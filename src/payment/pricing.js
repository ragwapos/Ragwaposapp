// Subscription prices (SAR, VAT included). Extra branches are pro-rated to the
// time left on the shop's subscription, so every branch ends with the main plan.
export const ANNUAL_PRICE = 350;
export const BRANCH_PRICE = 200;

const DAY_MS = 86400000;

// `at` lets the admin recompute the fee as of the moment the customer filed the request.
export function branchFee(endsAt, at = Date.now()) {
  if (!endsAt) return BRANCH_PRICE;
  const daysLeft = Math.ceil((new Date(endsAt).getTime() - at) / DAY_MS);
  return Math.min(BRANCH_PRICE, Math.max(1, Math.round((BRANCH_PRICE * daysLeft) / 365)));
}
