# Standing rules for Claude on this project

These apply to every session in this repo, not just the one that wrote them.

## 1. Plan Mode before any implementation
Before writing or changing any code or config, enter plan mode and explain in plain terms what will change and how — then wait for approval before touching anything. This applies to actual code/config changes only; read-only investigation, research, and verification (including browser actions) don't need it.

## 2. Autonomous browser actions
Anything achievable through Chrome browser automation (Cloudflare dashboard, Vercel dashboard, live-site verification, etc.) should be done directly rather than asking permission first. The exceptions are the categories that already require explicit confirmation under Claude's own safety rules regardless of any project instruction — entering credentials, sending messages on the user's behalf, purchases, submitting forms, and similar irreversible/external-facing actions. Those stay gated no matter what.

## 3. Security-first by default
Every change must be evaluated for whether it could newly expose the site to compromise — secrets, RLS/authorization, injection, security headers, DNS/TLS. This is a live production app with a real user base and an active security-scanning relationship (Raqib) — treat security review as a default step, not an optional pass.

## 4. No dead code left behind
When editing or adding a feature, remove anything that becomes unused as a result in the same change — unused imports, now-orphaned helper functions, stale translation keys, leftover feature flags. Don't defer cleanup to later.

---

See `PROJECT_REFERENCE.md` for the full functional/architecture/security-posture reference — read it at the start of a new session before doing anything else on this project.
