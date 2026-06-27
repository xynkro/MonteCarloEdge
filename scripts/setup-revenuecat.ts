// Configure the RevenueCat project for MonteCarloEdge via the v2 REST API — idempotent.
//
// SECRET-SAFE: your RevenueCat SECRET key (sk_…) is read from the env, never hard-coded and
// never seen by anyone but you. Run it yourself:
//
//   RC_API_KEY=sk_xxx \
//   RC_PROJECT_ID=proj_xxx \           # optional — else resolved by listing /projects
//   RC_IOS_APP_ID=app_xxx \            # the RevenueCat app id for your iOS app (optional)
//   RC_ANDROID_APP_ID=app_yyy \        # the RevenueCat app id for your Android app (optional)
//   npx tsx scripts/setup-revenuecat.ts
//
// PREREQUISITES (this script can't do them — they need your Apple/Google + RevenueCat accounts):
//   1. App Store Connect + Play Console: create the in-app-purchase products with the EXACT ids
//      below (chips_* as consumables; edge_* as the subscriptions / 1-month pass).
//   2. RevenueCat: create the project, add the iOS + Android apps (linked to the stores). That
//      gives you RC_PROJECT_ID + RC_IOS_APP_ID/RC_ANDROID_APP_ID and the PUBLIC SDK keys.
//   3. Set the webhook in the RC dashboard (NOT available in the v2 API): see docs/revenuecat-setup.md.
//
// What this DOES create/ensure: the `edge` entitlement, every product (per app), the edge products
// attached to the entitlement, and a `default` offering with one package per product. Re-running is
// safe — it checks for existence by lookup_key/identifier/store_identifier before creating.
//
// The product ids + entitlement here MUST stay in lockstep with functions/src/revenuecat-grants.ts.

const API = "https://api.revenuecat.com/v2";
const KEY = process.env.RC_API_KEY;
if (!KEY || !KEY.startsWith("sk_")) {
  console.error("Set RC_API_KEY to your RevenueCat SECRET key (sk_…). Aborting — nothing was changed.");
  process.exit(1);
}

const ENTITLEMENT = "edge"; // EDGE_ENTITLEMENT in revenuecat-grants.ts
type ProdType = "consumable" | "non_consumable" | "subscription";
interface ProdDef { id: string; type: ProdType; name: string; duration?: string; }
// IDs MUST match revenuecat-grants.ts (CHIP_PACKS + EDGE_PRODUCTS) and the store IAP product ids.
const PRODUCTS: ProdDef[] = [
  { id: "chips_500", type: "consumable", name: "500 Chips" },
  { id: "chips_1000", type: "consumable", name: "1,000 Chips" },
  { id: "chips_2400", type: "consumable", name: "2,400 Chips" },
  { id: "chips_7000", type: "consumable", name: "7,000 Chips" },
  { id: "chips_16000", type: "consumable", name: "16,000 Chips" },
  { id: "chips_40000", type: "consumable", name: "40,000 Chips" },
  { id: "edge_monthly", type: "subscription", name: "Edge Pass — Monthly", duration: "P1M" },
  { id: "edge_annual", type: "subscription", name: "Edge Pass — Annual", duration: "P1Y" },
  { id: "edge_1mo", type: "non_consumable", name: "Edge Pass — 1 Month (non-renewing)" }, // one-time pass
];
const EDGE_IDS = new Set(["edge_monthly", "edge_annual", "edge_1mo"]);

async function rc<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { // basic backoff on rate limit
    const wait = Number(res.headers.get("Retry-After") ?? 5) * 1000;
    console.warn(`  rate-limited; waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return rc<T>(method, path, body);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status, json });
  return json as T;
}

// List all items (paginates with `next_page`) and find one by a key predicate.
async function listAll(path: string): Promise<any[]> {
  const items: any[] = [];
  let next: string | null = path;
  while (next) {
    const page: { items?: any[]; next_page?: string | null } = await rc("GET", next);
    items.push(...(page.items ?? []));
    next = page.next_page ?? null;
  }
  return items;
}

async function ensureProject(): Promise<string> {
  if (process.env.RC_PROJECT_ID) return process.env.RC_PROJECT_ID;
  const projects = await listAll("/projects");
  const mce = projects.find((p) => /montecarlo/i.test(p.name ?? "")) ?? projects[0];
  if (!mce) throw new Error("No RevenueCat projects found for this key.");
  console.log(`Using project: ${mce.name} (${mce.id})`);
  return mce.id;
}

async function ensureEntitlement(pid: string): Promise<string> {
  const ents = await listAll(`/projects/${pid}/entitlements`);
  const found = ents.find((e) => e.lookup_key === ENTITLEMENT);
  if (found) { console.log(`✓ entitlement "${ENTITLEMENT}" exists`); return found.id; }
  const created = await rc<{ id: string }>("POST", `/projects/${pid}/entitlements`, { lookup_key: ENTITLEMENT, display_name: "Edge Pass" });
  console.log(`+ created entitlement "${ENTITLEMENT}"`);
  return created.id;
}

// Create the products for one app; returns store_identifier → RevenueCat product id.
async function ensureProducts(pid: string, appId: string): Promise<Map<string, string>> {
  const existing = await listAll(`/projects/${pid}/products`);
  const byStoreId = new Map<string, string>();
  for (const p of existing) if (p.app_id === appId) byStoreId.set(p.store_identifier, p.id);
  for (const def of PRODUCTS) {
    if (byStoreId.has(def.id)) { console.log(`  ✓ ${def.id} (${appId})`); continue; }
    const body: Record<string, unknown> = { store_identifier: def.id, app_id: appId, type: def.type, display_name: def.name };
    if (def.type === "subscription" && def.duration) body.subscription = { duration: def.duration };
    const created = await rc<{ id: string }>("POST", `/projects/${pid}/products`, body);
    byStoreId.set(def.id, created.id);
    console.log(`  + ${def.id} (${appId})`);
  }
  return byStoreId;
}

async function attachToEntitlement(pid: string, entId: string, rcProductIds: string[]) {
  if (!rcProductIds.length) return;
  await rc("POST", `/projects/${pid}/entitlements/${entId}/actions/attach_products`, { product_ids: rcProductIds });
  console.log(`✓ attached ${rcProductIds.length} edge product(s) to "${ENTITLEMENT}"`);
}

async function ensureOffering(pid: string, productsByStoreId: Map<string, string>[]) {
  const offerings = await listAll(`/projects/${pid}/offerings`);
  let off = offerings.find((o) => o.identifier === "default");
  if (!off) { off = await rc("POST", `/projects/${pid}/offerings`, { identifier: "default", display_name: "MonteCarloEdge Store" }); console.log(`+ created offering "default"`); }
  else console.log(`✓ offering "default" exists`);
  const pkgs = await listAll(`/projects/${pid}/offerings/${off.id}/packages`);
  for (const def of PRODUCTS) {
    const rcIds = productsByStoreId.map((m) => m.get(def.id)).filter(Boolean) as string[];
    if (!rcIds.length) continue;
    let pkg = pkgs.find((p) => p.identifier === def.id);
    if (!pkg) { pkg = await rc("POST", `/projects/${pid}/offerings/${off.id}/packages`, { identifier: def.id, display_name: def.name }); console.log(`  + package ${def.id}`); }
    await rc("POST", `/projects/${pid}/offerings/${off.id}/packages/${pkg.id}/actions/attach_products`, { product_ids: rcIds }).catch((e) => console.warn(`  (attach ${def.id}: ${e.message})`));
  }
}

(async () => {
  const pid = await ensureProject();
  const entId = await ensureEntitlement(pid);
  const appIds = [process.env.RC_IOS_APP_ID, process.env.RC_ANDROID_APP_ID].filter(Boolean) as string[];
  if (!appIds.length) { console.error("Set RC_IOS_APP_ID and/or RC_ANDROID_APP_ID (the RevenueCat app ids). Aborting before product creation."); process.exit(1); }
  const maps: Map<string, string>[] = [];
  for (const appId of appIds) { console.log(`Products for app ${appId}:`); maps.push(await ensureProducts(pid, appId)); }
  const edgeRcIds = maps.flatMap((m) => [...m].filter(([storeId]) => EDGE_IDS.has(storeId)).map(([, rcId]) => rcId));
  await attachToEntitlement(pid, entId, edgeRcIds);
  await ensureOffering(pid, maps);
  console.log("\n✅ RevenueCat configured. Still TODO in the dashboard: the WEBHOOK (see docs/revenuecat-setup.md) and the public SDK keys → src/mp/revenuecat.ts.");
})().catch((e) => { console.error("\n❌", e.message ?? e); process.exit(1); });
