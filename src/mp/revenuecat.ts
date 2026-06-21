// RevenueCat native IAP bridge. WEB IS UNTOUCHED (Stripe). The @revenuecat plugin is dynamically
// imported only on native AND only once real keys are configured, so the web bundle never loads it
// (Vite code-splits the dynamic import into a chunk that's fetched lazily, never on web).
//
// Grants are SERVER-AUTHORITATIVE: the client only launches the StoreKit / Play Billing purchase UI.
// RevenueCat then POSTs functions/src/revenuecat.ts (the webhook), which writes the entitlement to
// Firestore, which flows back to the UI via subscribeWallet. The client never trusts itself with chips.

import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";

// Public SDK keys — safe to ship (like the Firebase apiKey; security is the webhook token + server
// receipt validation, not secrecy). Fill these from the RevenueCat dashboard (Project → API keys)
// once the App Store Connect / Play products exist. Until then the placeholders keep native on the
// current "Soon" fallback, so the app stays shippable.
const RC_KEYS = { ios: "appl_PLACEHOLDER", android: "goog_PLACEHOLDER" };

function nativePlatform(): "ios" | "android" | null {
  const cap = (globalThis as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const p = cap.getPlatform?.();
  return p === "android" ? "android" : p === "ios" ? "ios" : null;
}

function rcKey(): string | null {
  const plat = nativePlatform();
  if (!plat) return null;
  const k = RC_KEYS[plat];
  return k.includes("PLACEHOLDER") ? null : k;
}

/** True only on native AND when a real (non-placeholder) RevenueCat key is configured. The Store
 *  uses this to decide whether to offer native IAP or fall back to the "Soon" / Stripe path. */
export function rcConfigured(): boolean {
  return rcKey() != null;
}

let _configuredUid: string | null = null;

/** Configure RevenueCat with the Firebase uid as app_user_id, so the webhook maps grants to the
 *  right user. Safe no-op on web / placeholder keys. Idempotent per uid. */
export async function rcConfigure(uid: string): Promise<void> {
  const apiKey = rcKey();
  if (!apiKey || _configuredUid === uid) return;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  if (_configuredUid == null) await Purchases.configure({ apiKey, appUserID: uid });
  else await Purchases.logIn({ appUserID: uid });
  _configuredUid = uid;
}

/** Launch the native purchase UI for the package whose store product id matches `productId`
 *  (e.g. "edge_monthly", "chips_500"). Resolves true on a completed purchase (the webhook then
 *  credits the wallet reactively), false if the user cancelled; throws on any real error. */
export async function rcPurchase(productId: string): Promise<boolean> {
  if (!rcConfigured()) throw new Error("In-app purchases aren't available yet.");
  const { Purchases, PURCHASES_ERROR_CODE } = await import("@revenuecat/purchases-capacitor");

  const offerings = await Purchases.getOfferings();
  const packages: PurchasesPackage[] = [
    ...(offerings.current?.availablePackages ?? []),
    ...Object.values(offerings.all ?? {}).flatMap((o) => o.availablePackages ?? []),
  ];
  const pkg = packages.find((p) => p.product?.identifier === productId);
  if (!pkg) throw new Error("This item isn't available right now.");

  try {
    await Purchases.purchasePackage({ aPackage: pkg });
    return true;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return false;
    throw e;
  }
}

/** Restore purchases — Apple/Play require this for subscriptions & non-consumables. Re-syncs RC's
 *  view of the user's receipts; an active Edge Pass entitlement is reflected server-side via the
 *  webhook. Consumable chip packs are not restorable (they're permanent once granted). Resolves
 *  true if any entitlement is active. */
export async function rcRestore(): Promise<boolean> {
  if (!rcConfigured()) return false;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  const { customerInfo } = await Purchases.restorePurchases();
  return Object.keys(customerInfo?.entitlements?.active ?? {}).length > 0;
}
