// MonteCarloEdge — Stripe "Edge Pass" subscription paywall.
//
// SECURITY: the Stripe secret + webhook signing secret + price id are read from
// Firebase SECRETS (set by the owner via `firebase functions:secrets:set ...`).
// They are NEVER in source, never logged, never sent to the client. The client only
// ever gets a Checkout redirect URL. Entitlement (users/{uid}.edgePass) is written
// ONLY here (Admin SDK) after Stripe confirms payment via the signed webhook.

import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import Stripe from "stripe";

const STRIPE_SECRET = defineSecret("STRIPE_SECRET");           // sk_live_… / sk_test_…
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET"); // whsec_…
const EDGE_PASS_PRICE = defineSecret("EDGE_PASS_PRICE");       // price_… (the $6.99/mo recurring price)

const FALLBACK_ORIGIN = "https://xynkro.github.io/MonteCarloEdge";

/** Create a Stripe Checkout Session for the Edge Pass subscription; returns its URL. */
export const createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET, EDGE_PASS_PRICE] },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const stripe = new Stripe(STRIPE_SECRET.value());
    const db = getFirestore();

    // Reuse the player's Stripe customer if we have one, else create + remember it.
    const userRef = db.doc(`users/${uid}`);
    const snap = await userRef.get();
    let customer = snap.exists ? (snap.data()?.stripeCustomerId as string | undefined) : undefined;
    if (!customer) {
      const c = await stripe.customers.create({ metadata: { uid } });
      customer = c.id;
      await userRef.set({ stripeCustomerId: customer }, { merge: true });
    }

    const origin = (typeof req.data?.origin === "string" && req.data.origin) || FALLBACK_ORIGIN;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: EDGE_PASS_PRICE.value(), quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${origin}?edgepass=success`,
      cancel_url: `${origin}?edgepass=cancel`,
      client_reference_id: uid,
      metadata: { uid },
      subscription_data: { metadata: { uid } },
    });
    return { url: session.url };
  },
);

/** Open the Stripe customer billing portal so a subscriber can manage/cancel. */
export const createBillingPortal = onCall(
  { secrets: [STRIPE_SECRET] },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const stripe = new Stripe(STRIPE_SECRET.value());
    const db = getFirestore();
    const snap = await db.doc(`users/${uid}`).get();
    const customer = snap.exists ? (snap.data()?.stripeCustomerId as string | undefined) : undefined;
    if (!customer) throw new HttpsError("failed-precondition", "No subscription on file.");
    const origin = (typeof req.data?.origin === "string" && req.data.origin) || FALLBACK_ORIGIN;
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: origin });
    return { url: portal.url };
  },
);

/** Stripe webhook: the ONLY thing that flips users/{uid}.edgePass. Signature-verified. */
export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET.value());
    const sig = req.headers["stripe-signature"] as string | undefined;
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig ?? "", STRIPE_WEBHOOK_SECRET.value());
    } catch (e) {
      res.status(400).send(`Webhook signature failed: ${(e as Error).message}`);
      return;
    }
    const db = getFirestore();
    const setByCustomer = async (customerId: string, active: boolean, extra: Record<string, unknown> = {}) => {
      const q = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
      if (!q.empty) await q.docs[0]!.ref.set({ edgePass: active, ...extra }, { merge: true });
    };

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object as Stripe.Checkout.Session;
          const uid = (s.metadata?.uid as string) || (s.client_reference_id as string) || "";
          if (uid) {
            await db.doc(`users/${uid}`).set(
              { edgePass: true, stripeCustomerId: s.customer, stripeSubId: s.subscription, subStatus: "active" },
              { merge: true },
            );
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          await setByCustomer(sub.customer as string, sub.status === "active" || sub.status === "trialing", { stripeSubId: sub.id, subStatus: sub.status });
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          await setByCustomer(sub.customer as string, false, { subStatus: "canceled" });
          break;
        }
      }
      res.json({ received: true });
    } catch (e) {
      res.status(500).send(`handler error: ${(e as Error).message}`);
    }
  },
);
