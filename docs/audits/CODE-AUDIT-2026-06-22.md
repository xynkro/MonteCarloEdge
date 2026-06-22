# Code audit — 2026-06-22 (overnight autonomous run)

Multi-agent audit of the native + RevenueCat payments work (branch `feat/native-capacitor`) and core
invariants. 22 agents, 5 review dimensions (RC server, RC client, server-authority, security,
session-diff), each finding adversarially verified (refute-by-default). **13 confirmed, 4 refuted.**
All confirmed findings are resolved or explicitly deferred below.

## Confirmed findings + resolution

| # | Sev | Finding | Resolution |
|---|-----|---------|-----------|
| 1 | **HIGH** | Web Edge Pass: my `data-pid` rewrite made the previously-dead "Monthly"/"Annual" buttons live, but on web all tiers route to the single $6.99/mo Stripe price — so "Annual $49.99/yr" would bill monthly (displayed price ≠ charged). | **FIXED** — web now renders only the `edge_monthly` tier (the one matching `EDGE_PASS_PRICE`); all three show only on native, where `rcPurchase(pid)` honours the distinct product. `src/ui/main.ts` renderStore. |
| 2 | MED | Subscription refunds never revoke `edgePass` — RC delivers refunds as `CANCELLATION` with `cancel_reason` (no REFUND event type), and that case was a no-op. | **FIXED** — `grantForEvent` now revokes on `CANCELLATION` when `cancel_reason ∈ {CUSTOMER_SUPPORT, BILLING_ERROR, DEVELOPER_INITIATED}`; voluntary `UNSUBSCRIBE`/`PRICE_INCREASE` stays entitled until `EXPIRATION`. +6 unit tests. |
| 3,7 | MED | SANDBOX / TestFlight purchases granted real chips & Edge Pass (env captured but never gated) — a StoreKit-test client could mint entitlements. | **FIXED** — webhook blocks `environment === SANDBOX` grants unless `RC_ALLOW_SANDBOX=true` (set in `functions/.env` only during go-live sandbox testing). Event still recorded. |
| 4 | MED | Out-of-order webhook delivery: a stale `EXPIRATION` arriving after a newer `RENEWAL` would wrongly deactivate an active pass. | **FIXED** — webhook reads the user doc + tracks `lastEdgeEventMs`; an edge event older than the last applied one is recorded but not applied. Chip credits stay order-independent (additive + idempotent). |
| 5 | MED | `TRANSFER` events (entitlement moves between accounts) carry no `app_user_id`/`product_id` and are silently dropped. | **DEFERRED** — correct handling needs the RevenueCat REST API (secret key, not yet provisioned) to re-derive the destination uid's entitlement. Documented in `REVENUECAT-SETUP.md`; rare (account transfer / family-sharing). Not exploitable; just an edge entitlement may not follow a transfer until the next RENEWAL. |
| 6 | MED | (Duplicate of #1, client-side view.) | **FIXED** with #1. |
| 8 | LOW | Successful native purchase gives no explicit client confirmation; balance only updates when the webhook lands. | **ACCEPTED** — the reactive `subscribeWallet` balance update *is* the confirmation, and there is no neutral toast field (only `S.net.err`). Adding one wasn't worth a render-path change for a sub-second delay. |
| 9 | LOW | `adminDeleteUser` comment claimed it wipes per-table seats — it doesn't; a seated deleted user strands a ghost seat + chips. | **PARTIALLY FIXED** — corrected the misleading comment + documented the precondition (don't delete a seated user). A safe seat-reconcile is deferred (needs the table schema + emulator testing; blind table mutation risks bricking a table, cf. the prior `leaveTable` bug). Admin-only, rare. |
| 10 | LOW | RevenueCat `app_user_id` is client-controlled. | **ACCEPTED** — not exploitable for gain (an attacker can only *pay* to credit a victim). `rcConfigure` always uses the live Firebase uid; grants merge onto an existing `users/{uid}`. Documented. |
| 11 | LOW | Native first-time Google/Apple sign-in skipped the onboarding flow the web redirect path runs. | **FIXED** — native `signInWithGoogle/Apple` now set `user.isNew` via `getAdditionalUserInfo`; `doSignIn` routes new accounts to `onboard`. |
| 12 | LOW | Launch splash could stay up forever if the native init chunk failed to import. | **FIXED** — `initNative` hides the splash first (before cosmetic status-bar work) + a 4s independent-import safety timeout in the bootstrap. |
| 13 | LOW | RevenueCat identity never logged out on sign-out (cross-account attribution leaned on the next sign-in). | **FIXED** — added `rcLogout()` (`Purchases.logOut()` + reset), called from both sign-out paths. |

## Refuted (4) — verified NOT defects
- **401 on bad webhook auth is "retryable"** — by design; an attacker can't forge the token, and a misconfigured token should retry, not silently drop. Correct as-is.
- **Consumable chip-pack refunds not clawed back** — intended; consumables may already be spent (clawback risks a negative balance). Same posture as the Stripe rail.
- **`rcConfigure` not idempotent under concurrent first-call** — structurally true but causes no incorrect behavior (RC tolerates it); not worth a lock.
- **`doRestore` lacked a sign-in guard** — the Store is unreachable signed-out (home tile routes to sign-in). Added `ensureSignedIn()` anyway for consistency with buy handlers.

## Verification
- `npx tsx functions/test-grants.mts` → 20/20 (incl. the 6 new refund cases).
- `functions` tsc build + `vite` web build clean.
- Engine gates + chip-conservation stress unaffected (no engine/mp-engine changes).
