// MonteCarloEdge — RevenueCat native IAP grants (StoreKit / Play Billing).
//
// The NATIVE payment rail. Web uses Stripe (stripe.ts); native apps cannot redirect to Stripe
// for digital goods (Apple/Google policy), so every in-app purchase on iOS/Android goes through
// RevenueCat. RevenueCat validates the StoreKit/Play receipt server-side, then POSTs a signed
// webhook here. THIS WEBHOOK IS THE ONLY THING that grants edgePass / credits chip packs on
// native — mirroring stripeWebhook's server-authoritative, idempotent model. Clients never write
// entitlements; they read the live projection via subscribeWallet.
//
// SECURITY: the webhook Authorization token is a Firebase SECRET (REVENUECAT_WEBHOOK_AUTH), set
// by the owner via `firebase functions:secrets:set REVENUECAT_WEBHOOK_AUTH` and pasted into the
// RevenueCat dashboard (Project → Integrations → Webhooks → Authorization header). We verify it on
// every request. The RC *public* SDK keys (client-side) are public by design, like the Firebase
// apiKey — secrecy is not the control; server-side receipt validation + this token are.
//
// Region: default (us-central1), like stripeWebhook — the deployed URL is registered in the
// RevenueCat dashboard, so region only determines that URL (do NOT move it once registered).

import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { timingSafeEqual } from "node:crypto";
import { grantForEvent, type RcEvent } from "./revenuecat-grants.js";

const REVENUECAT_WEBHOOK_AUTH = defineSecret("REVENUECAT_WEBHOOK_AUTH");

/** Constant-time header check (avoids leaking the token via timing). */
function authOk(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const revenueCatWebhook = onRequest(
  { secrets: [REVENUECAT_WEBHOOK_AUTH] },
  async (req, res) => {
    // 1) Verify the shared Authorization token (configured in the RevenueCat dashboard).
    if (!authOk(req.headers["authorization"], REVENUECAT_WEBHOOK_AUTH.value())) {
      res.status(401).send("unauthorized");
      return;
    }

    const event = (req.body?.event ?? {}) as RcEvent;
    const eventId = event.id;
    const uid = event.app_user_id || event.original_app_user_id || "";
    // Anonymous purchases ($RCAnonymousID:…) carry no Firebase uid — nothing to grant. Ack so RC
    // stops retrying. (The client always logs in with the Firebase uid before purchasing.)
    if (!eventId || !uid || uid.startsWith("$RCAnonymousID:")) {
      res.json({ received: true, skipped: true });
      return;
    }

    const db = getFirestore();
    const userRef = db.doc(`users/${uid}`);
    const eventRef = db.doc(`rcEvents/${eventId}`);

    try {
      await db.runTransaction(async (tx) => {
        // Idempotency: RevenueCat retries webhooks until it gets a 2xx; never double-apply an
        // event (critical for chip increments). The eventRef doubles as the processed-marker.
        if ((await tx.get(eventRef)).exists) return;

        const grant = grantForEvent(event);
        const update: Record<string, unknown> = {};
        if (grant?.kind === "chips") {
          update.chipsPlay = FieldValue.increment(grant.amount);
        } else if (grant?.kind === "edge") {
          update.edgePass = grant.active;
          update.subStatus = grant.status;
          if (grant.expiresAt) update.edgeExpiresAt = grant.expiresAt;
        }

        if (Object.keys(update).length) {
          update.iapProvider = "revenuecat";
          tx.set(userRef, update, { merge: true });
        }
        // Always record the event (even no-op types) so retries are cheap no-ops.
        tx.set(eventRef, { uid, type: event.type ?? "", productId: event.product_id ?? "", env: event.environment ?? null, at: FieldValue.serverTimestamp() });
      });
      res.json({ received: true });
    } catch (e) {
      // 5xx → RevenueCat retries with backoff (safe: idempotent).
      res.status(500).send(`handler error: ${(e as Error).message}`);
    }
  },
);
