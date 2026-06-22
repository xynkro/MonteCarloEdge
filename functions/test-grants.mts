// Pure-logic tests for the RevenueCat grant decision. Run: `npx tsx functions/test-grants.mts`
// (from repo root). No firebase / emulator needed.
import assert from "node:assert/strict";
import { grantForEvent } from "./src/revenuecat-grants.js";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

// — Chip packs: consumable credit on purchase —
ok("chips_500 credits 500", JSON.stringify(grantForEvent({ type: "NON_RENEWING_PURCHASE", product_id: "chips_500" })) === JSON.stringify({ kind: "chips", amount: 500 }));
ok("chips_40000 credits 40000", grantForEvent({ type: "INITIAL_PURCHASE", product_id: "chips_40000" })?.["kind"] === "chips");
ok("chips amount correct", (grantForEvent({ type: "NON_RENEWING_PURCHASE", product_id: "chips_7000" }) as any).amount === 7000);

// — Edge Pass subscription lifecycle —
const buy = grantForEvent({ type: "INITIAL_PURCHASE", product_id: "edge_monthly", entitlement_ids: ["edge"], expiration_at_ms: 1234 });
ok("edge purchase → active", buy?.kind === "edge" && (buy as any).active === true && (buy as any).status === "active");
ok("edge purchase carries expiry", (buy as any).expiresAt === 1234);
ok("edge RENEWAL → active", (grantForEvent({ type: "RENEWAL", product_id: "edge_annual" }) as any)?.active === true);
ok("edge UNCANCELLATION → active", (grantForEvent({ type: "UNCANCELLATION", entitlement_ids: ["edge"] }) as any)?.active === true);
ok("edge EXPIRATION → inactive", (grantForEvent({ type: "EXPIRATION", product_id: "edge_monthly" }) as any)?.active === false);
ok("edge BILLING_ISSUE → inactive+status", (() => { const g = grantForEvent({ type: "BILLING_ISSUE", product_id: "edge_monthly" }) as any; return g?.active === false && g?.status === "billing_issue"; })());

// — edge_1mo one-time pass grants edge (entitlement via product membership, no entitlement_ids) —
ok("edge_1mo non-renewing → edge active (not chips)", (grantForEvent({ type: "NON_RENEWING_PURCHASE", product_id: "edge_1mo" }) as any)?.kind === "edge");

// — Refunds: CANCELLATION revokes only for refund/forced reasons, not voluntary unsubscribe —
ok("CANCELLATION/UNSUBSCRIBE → no change (entitled until expiry)", grantForEvent({ type: "CANCELLATION", product_id: "edge_monthly", entitlement_ids: ["edge"], cancel_reason: "UNSUBSCRIBE" }) === null);
ok("CANCELLATION/PRICE_INCREASE → no change", grantForEvent({ type: "CANCELLATION", product_id: "edge_monthly", cancel_reason: "PRICE_INCREASE" }) === null);
ok("CANCELLATION (no reason) → no change", grantForEvent({ type: "CANCELLATION", product_id: "edge_monthly", entitlement_ids: ["edge"] }) === null);
ok("CANCELLATION/CUSTOMER_SUPPORT (refund) → edge revoked", (() => { const g = grantForEvent({ type: "CANCELLATION", product_id: "edge_monthly", entitlement_ids: ["edge"], cancel_reason: "CUSTOMER_SUPPORT" }) as any; return g?.kind === "edge" && g.active === false && g.status === "refunded"; })());
ok("CANCELLATION/BILLING_ERROR → edge revoked", (grantForEvent({ type: "CANCELLATION", product_id: "edge_annual", entitlement_ids: ["edge"], cancel_reason: "BILLING_ERROR" }) as any)?.active === false);
ok("CANCELLATION/DEVELOPER_INITIATED → edge revoked", (grantForEvent({ type: "CANCELLATION", product_id: "edge_monthly", entitlement_ids: ["edge"], cancel_reason: "DEVELOPER_INITIATED" }) as any)?.active === false);
ok("unknown product → null", grantForEvent({ type: "INITIAL_PURCHASE", product_id: "mystery_box" }) === null);
ok("empty event → null", grantForEvent({}) === null);
ok("chip pack RENEWAL (impossible) → null", grantForEvent({ type: "RENEWAL", product_id: "chips_500" }) === null);

// — Entitlement-driven: edge entitlement on an unknown product still grants edge —
ok("edge entitlement on unknown product → edge", (grantForEvent({ type: "RENEWAL", product_id: "edge_weekly_future", entitlement_ids: ["edge"] }) as any)?.kind === "edge");

console.log(`\n✅ all ${n} RevenueCat grant assertions passed`);
