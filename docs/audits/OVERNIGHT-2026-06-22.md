# Overnight autonomous run — 2026-06-22

Branch `feat/native-capacitor` (19 commits ahead of `main`). **Nothing was pushed or deployed** —
all work is local commits for your review. No secrets touched.

## What got done (your requested order: build → test → audit code → audit UI)

### Build
- **#34 RevenueCat native payments** (`fd21d86`) — server webhook (`revenueCatWebhook`) as the sole
  server-authoritative writer of `edgePass`/chip credits on native, idempotent, mirroring `stripeWebhook`;
  client bridge (`src/mp/revenuecat.ts`) + Store wiring; Restore Purchases. Web keeps Stripe. Pure grant
  logic unit-tested. Go-live checklist: `docs/REVENUECAT-SETUP.md`.
- **#35** folded in — purchased chips are permanent (no expiry); Restore button for subs.
- **#33 Android compile-check** (`7736f5c`) — installed JDK 21 + Android SDK (per your approval),
  `./gradlew assembleDebug` → **BUILD SUCCESSFUL**, `app-debug.apk` produced. All 4 plugins (RevenueCat +
  Firebase + splash + status-bar) compile for Android. Parity with the verified iOS SPM build.

### Test — all green
- Engine `validate:all` 19/19 · MP chip-conservation stress 15,000 hands `VIOLATIONS=0` · RevenueCat grant
  unit tests 20/20 · `functions` + web builds clean.

### Code audit (`bad93ea`) — `docs/audits/CODE-AUDIT-2026-06-22.md`
22-agent audit, 13 confirmed / 4 refuted, all resolved or deferred. Highlights:
- **Caught + fixed a HIGH billing-trust bug I'd introduced earlier this session**: the Edge Pass "Annual
  $49.99/yr" / "1-month" web buttons would all silently bill the single $6.99/mo Stripe price. Fixed —
  web shows only the monthly tier; all three only on native where each product id is honoured.
- Refund revocation (CANCELLATION reasons), SANDBOX-grant gating (`RC_ALLOW_SANDBOX`), out-of-order
  webhook guard, native social onboarding routing, splash-hang safety, RC logout on sign-out.

### UI audit (`11a64c0`) — `docs/audits/UI-AUDIT-2026-06-22.md`
39-agent audit, 29 confirmed, ~17 fixed + visually verified. Highlights:
- **CRITICAL fix**: `var(--green)`/`var(--red)` were used 13× but **never defined** — P&L colors, chart
  bars, and destructive-button colors were silently broken. Added the aliases. *Verified in preview:* the
  Stats screen now shows green P&L, a red all-time trend, and a red "Clear All History".
- Age-gate clipping on short/notched phones (legally load-bearing first screen) → scroll + safe-area.
- `--faint` contrast, label contrast, global `:focus-visible`, ✕-button aria-labels, bottom safe-area on
  sheets/chat/lobby, and the Store busy-spinner (scoped per-button — was global).

## What I deliberately did NOT do (needs you)
- **[UI #12/#13] Table seat crowding at 9–10 players** — confirmed real (screenshot @375px) but NOT
  fixed: `.poker-table` is the ONE render path shared by the trainer AND online table, so a responsive
  seat-scale change must be tuned across 2→10 players on both without regressing the 6-max default. Best
  done awake with device testing. *Top remaining UI item.*
- **Deploy / push** — held. `firebase deploy` also needs the `REVENUECAT_WEBHOOK_AUTH` secret (you set it).
- **RevenueCat go-live** — needs LLC → Apple Developer + Play Console + RevenueCat dashboard (create the 9
  products, paste the SDK keys into `RC_KEYS`, set the webhook). Full steps in `docs/REVENUECAT-SETUP.md`.
- Remaining LOW polish + a few a11y/refactor items are itemised in the two audit reports.

## Suggested next steps when you're back
1. Eyeball the 10-max table + decide the seat-scale approach ([UI #12]).
2. When ready to ship the audit fixes to web prod: bump `public/sw.js` CACHE, `firebase deploy`, push.
3. LLC / Apple Developer track to unblock payments go-live.
