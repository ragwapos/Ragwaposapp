# ZATCA integration — paused

These four files used to live in `api/` as live Vercel serverless functions:
`zatca-generate-keys.js`, `zatca-request-compliance-csid.js`, `zatca-sign-invoice.js`,
and their shared `_auth.js` helper (used only by these three — every other shared
helper they need, `_rateLimit.js`/`_sentry.js`/`_cors.js`, stays in `api/` since
other endpoints depend on those too).

They're moved here — not deleted — because this project has no CSID actually
registered with ZATCA's Fatoora portal yet. `enableZatca`/`submitInvoiceToZatca`
make genuine outbound calls to ZATCA's real APIs, not simulated ones, so leaving
them live in `api/` exposed a not-yet-usable government integration as a callable
endpoint. The Settings UI panel (`ZatcaSettingsPanel` in `src/App.jsx`) already
shows a "coming soon" placeholder instead of the live connect flow
(`ZATCA_FEATURE_LIVE = false`).

**To bring this back once a tenant has real ZATCA onboarding completed:**
1. `git mv coming-soon/zatca/zatca-*.js api/` and `git mv coming-soon/zatca/_auth.js api/`
2. In the three moved files, change the `_rateLimit.js`/`_sentry.js`/`_cors.js`
   imports back from `../../api/_x.js` to `./_x.js`.
3. Flip `ZATCA_FEATURE_LIVE` to `true` in `src/App.jsx`.
