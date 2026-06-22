# RevenueCat IAP — go-live checklist

The native payment rail (StoreKit on iOS, Play Billing on Android) is **fully coded** but inert
until the store + RevenueCat accounts exist. Until the SDK keys are filled, native falls back to the
"Soon" / Stripe behaviour, so the app stays shippable. Do these steps at the "Apple Developer" stage
to flip it live.

## Prerequisites (the real blockers)
- **LLC** (Apple/Google Org accounts + tax/banking need a legal entity) + **D-U-N-S** for Apple Org.
- **Apple Developer Program** ($99/yr) → App Store Connect.
- **Google Play Console** ($25 one-time).
- **RevenueCat account** (free up to $2.5k/mo tracked revenue).

## Product IDs — must match the code exactly
Defined in [`functions/src/revenuecat-grants.ts`](../functions/src/revenuecat-grants.ts) (server grants)
and `PLAY_PACKS` / `EDGE_TIERS` in [`src/ui/main.ts`](../src/ui/main.ts) (store UI).

| Product ID | Type | Grants |
|---|---|---|
| `chips_500` | Consumable | +500 play chips |
| `chips_1000` | Consumable | +1,000 |
| `chips_2400` | Consumable | +2,400 |
| `chips_7000` | Consumable | +7,000 |
| `chips_16000` | Consumable | +16,000 |
| `chips_40000` | Consumable | +40,000 |
| `edge_1mo` | Non-renewing | Edge Pass, 1 month (entitlement `edge`) |
| `edge_monthly` | Auto-renewing sub | Edge Pass (entitlement `edge`) |
| `edge_annual` | Auto-renewing sub | Edge Pass (entitlement `edge`) |

## Steps
1. **App Store Connect** → create the app (bundle `com.montecarloedge.app`) → create the 9 IAPs above
   with matching product IDs. Set the **18+** age rating. Add the required paid-apps agreement + banking.
2. **Google Play Console** → create the app → create the same 9 products (managed products for chips,
   subscriptions for `edge_monthly`/`edge_annual`).
3. **RevenueCat dashboard**:
   - New project → add an **App Store** app and a **Play Store** app (upload the App Store shared
     secret + Play service-account JSON).
   - Create one **Entitlement** with identifier **`edge`**. Attach `edge_1mo`, `edge_monthly`,
     `edge_annual` to it. (Chip packs are consumables — no entitlement.)
   - Create an **Offering** (e.g. `default`) with a Package per product (so `getOfferings()` returns
     them). The store maps purchases by **store product identifier**, so each package's product must
     be one of the IDs above.
   - Copy the **public API keys**: `appl_…` (iOS) and `goog_…` (Android).
4. **Paste the keys** into `RC_KEYS` in [`src/mp/revenuecat.ts`](../src/mp/revenuecat.ts) (they're
   public, like the Firebase apiKey — safe to commit). Rebuild + `npx cap sync`.
5. **Webhook** (the only server-authoritative writer of grants):
   - Set the shared secret: `firebase functions:secrets:set REVENUECAT_WEBHOOK_AUTH` (pick a long
     random token).
   - Deploy: `cd functions && firebase deploy --only functions:revenueCatWebhook --project montecarloedge`.
   - Get the URL (`https://us-central1-montecarloedge.cloudfunctions.net/revenueCatWebhook`).
   - RevenueCat → Project → Integrations → **Webhooks** → URL = that, **Authorization header** = the
     same token you set as the secret.
6. **Sandbox test** (iOS sandbox tester / Play license tester):
   - **First set `RC_ALLOW_SANDBOX=true` in `functions/.env` and redeploy** — the webhook BLOCKS
     sandbox-environment grants by default (so a StoreKit-test client can't mint real chips/Edge Pass
     in production). With the flag on, sandbox purchases credit normally for testing. **Remove the flag
     (or set it false) and redeploy before public launch.**
   - Buy each product, confirm the webhook fires (Functions logs) and `users/{uid}.chipsPlay` /
     `.edgePass` update, the wallet refreshes live, and **Restore purchases** re-grants the sub.
   - Refund an Edge Pass in the sandbox → confirm `edgePass` flips false (delivered as `CANCELLATION`
     with `cancel_reason=CUSTOMER_SUPPORT`).
   - Re-send a webhook event → confirm no double-credit (idempotency via `rcEvents/{eventId}`).

## Known deferred items (from the 2026-06-22 code audit)
- **`TRANSFER` events** (entitlement moves between Apple/Google accounts, e.g. family sharing) are
  recorded but not yet acted on — handling them needs the RevenueCat **secret REST API key** to
  re-derive the destination user's entitlement. Add that key + a reconcile when wiring the dashboard.
- **Consumable chip-pack refunds** are intentionally not clawed back (chips may already be spent).
- The webhook is `us-central1` (its URL is registered in RC) — do not move it once configured.

## Architecture notes
- **Web is untouched** — it keeps Stripe (`stripe.ts`). Only native uses RevenueCat.
- Grants are **server-authoritative**: the client only launches the purchase UI; the webhook writes
  the entitlement to Firestore; `subscribeWallet` reflects it. The client never credits itself.
- Idempotency: every RC event is recorded at `rcEvents/{eventId}` inside the grant transaction;
  retries are no-ops (critical for consumable chip credits).
- Pure grant logic is unit-tested: `npx tsx functions/test-grants.mts` (15 assertions, no emulator).
- **Washington geo-block** for chip sales is still TODO (Kater v. Churchill Downs) — gate the chip
  packs (not Edge Pass) behind a region check before public launch.
