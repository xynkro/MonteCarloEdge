// Pure RevenueCat purchase-decision logic — NO firebase imports, so it is trivially unit-testable
// (see test-grants.mts) and reusable. revenuecat.ts wraps this in the auth + Firestore transaction.
//
// Product ids MUST match what's created in App Store Connect / Google Play Console and wired in the
// RevenueCat dashboard. Chip amounts mirror PLAY_PACKS in src/ui/main.ts — keep the two in sync.

export const CHIP_PACKS: Record<string, number> = {
  chips_5000: 5000,
  chips_10000: 10000,
  chips_24000: 24000,
  chips_70000: 70000,
  chips_160000: 160000,
  chips_400000: 400000,
};

// Edge Pass products (auto-renewing subs + the 1-month non-renewing pass). Any grants the "edge"
// entitlement. RevenueCat sends entitlement_ids too; the entitlement is the source of truth, with
// product-id membership as a fallback.
export const EDGE_PRODUCTS = new Set(["edge_monthly", "edge_annual", "edge_1mo"]);
export const EDGE_ENTITLEMENT = "edge";

export interface RcEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  cancel_reason?: string;
  environment?: string;
}

// CANCELLATION reasons that mean the entitlement is GONE NOW (refund / forced cancel) vs a voluntary
// auto-renew-off (UNSUBSCRIBE / PRICE_INCREASE) where the user stays entitled until EXPIRATION.
const REVOKING_CANCEL_REASONS = new Set(["CUSTOMER_SUPPORT", "BILLING_ERROR", "DEVELOPER_INITIATED"]);

export type RcGrant =
  | { kind: "chips"; amount: number }
  | { kind: "edge"; active: boolean; status: string; expiresAt: number | null }
  | null;

/** Decide what a RevenueCat event grants, or null for a no-op (e.g. CANCELLATION keeps entitlement
 *  until EXPIRATION, unmapped products, etc.). Pure — persistence/idempotency lives in the handler. */
export function grantForEvent(event: RcEvent): RcGrant {
  const type = event.type || "";
  const productId = event.product_id || "";
  const isEdge = (event.entitlement_ids ?? []).includes(EDGE_ENTITLEMENT) || EDGE_PRODUCTS.has(productId);
  const chips = CHIP_PACKS[productId];

  // Consumable chip pack — credit the play wallet. Consumables only ever INITIAL/NON_RENEWING.
  if (chips != null && (type === "NON_RENEWING_PURCHASE" || type === "INITIAL_PURCHASE")) {
    return { kind: "chips", amount: chips };
  }
  if (isEdge) {
    switch (type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "PRODUCT_CHANGE":
      case "NON_RENEWING_PURCHASE": // edge_1mo one-time pass
        return { kind: "edge", active: true, status: "active", expiresAt: event.expiration_at_ms ?? null };
      case "EXPIRATION":
        return { kind: "edge", active: false, status: "expired", expiresAt: null };
      case "BILLING_ISSUE":
        return { kind: "edge", active: false, status: "billing_issue", expiresAt: null };
      case "CANCELLATION":
        // A refund / chargeback / support-cancel revokes NOW (RC delivers refunds as CANCELLATION
        // with these reasons — there is no REFUND event type). A voluntary UNSUBSCRIBE / declined
        // PRICE_INCREASE keeps the user entitled until EXPIRATION → no change.
        return REVOKING_CANCEL_REASONS.has((event.cancel_reason ?? "").toUpperCase())
          ? { kind: "edge", active: false, status: "refunded", expiresAt: null }
          : null;
    }
  }
  return null;
}
