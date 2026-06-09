// MonteCarloEdge Cloud Functions — the server-authoritative game host (Phase 2).
//
// The engine (src/engine/*, src/mp/mp-engine, auth-table-codec) is imported VERBATIM
// and runs here behind the Admin SDK. The deck + every player's hole cards live ONLY
// in tables/{code}/private/state (no client read rule); clients get the public
// projection + their own private/holes/{uid}. Bots decide HERE too (server-side
// villainDecision) so a bot's cards never reach a client. Chips are server-held in
// users/{uid}.chips. Every mutating call is a transaction with a monotonic
// stateVersion optimistic lock and a chip-conservation tripwire.

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, type Transaction } from "firebase-admin/firestore";

import {
  createAuthTable, sit, seatAi, leave, startHand as engineStartHand,
  act as engineAct, actSeat, publicState, toActTableSeat, toGsSeat, type AuthTable,
} from "../../src/mp/mp-engine.js";
import { serializeAuthTable, deserializeAuthTable, type AuthTableSnapshot } from "../../src/mp/auth-table-codec.js";
import type { MPAction } from "../../src/mp/types.js";
import { villainDecision } from "../../src/engine/villain-ai.js";
import { AUTO, TAG, LAG, STATION, NIT, type OpponentProfile } from "../../src/engine/opponent.js";
import { cryptoRng } from "./crypto-rng.js";

setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });
initializeApp();
const db = getFirestore();

// Stripe Edge Pass paywall (createCheckoutSession / createBillingPortal / stripeWebhook).
export * from "./stripe.js";

const PROFILES: Record<string, OpponentProfile> = { Auto: AUTO, TAG, LAG, Station: STATION, Nit: NIT };
const TURN_SECONDS = 40;
const DEFAULT_CHIPS = 1_000; // ~$9.90 of value at the ~100 chips/$ ratio
const TIERS: Record<string, { sb: number; bb: number; max: number }> = {
  "1/2": { sb: 1, bb: 2, max: 200 },
  "5/10": { sb: 5, bb: 10, max: 1_000 },
  "25/50": { sb: 25, bb: 50, max: 5_000 },
  "50/100": { sb: 50, bb: 100, max: 10_000 },
  "100/200": { sb: 100, bb: 200, max: 20_000 },
  "500/1000": { sb: 500, bb: 1_000, max: 100_000 },
};

// ── helpers ──
function uidOf(req: CallableRequest): string {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}
const stateRef = (code: string) => db.doc(`tables/${code}/private/state`);
const tableRef = (code: string) => db.doc(`tables/${code}`);
const holeRef = (code: string, uid: string) => db.doc(`tables/${code}/hands/${uid}`); // per-uid private hand
const userRef = (uid: string) => db.doc(`users/${uid}`);
const inboxRef = (uid: string) => db.collection(`users/${uid}/inbox`); // received messages/gifts
const ledgerRef = () => db.collection("ledger"); // immutable audit trail of every chip transfer

const WEEKLY_PLAY = 500;          // weekly free play-chip grant
const GIFT_MAX = 1_000_000;       // anti-abuse cap per single play-chip gift
const ADMIN_EMAILS = new Set(["the.disruptive.comp@gmail.com"]); // super-admin (gift premium, adjust balances)

function newCode(): string {
  const A = "ACDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/B/8
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(cryptoRng() * A.length)];
  return `MCE-${s}`;
}

type Currency = "play" | "premium";
interface StateDoc { snap: AuthTableSnapshot; version: number; baseline: number; currency: Currency }

async function loadState(tx: Transaction, code: string): Promise<{ t: AuthTable; version: number; baseline: number; currency: Currency }> {
  const snap = await tx.get(stateRef(code));
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");
  const d = snap.data() as StateDoc;
  return { t: deserializeAuthTable(d.snap), version: d.version, baseline: d.baseline, currency: d.currency ?? "play" };
}

// Two-wallet model: chipsPlay (free/earned/buyable, AI rooms, giftable) and
// chipsPremium (cash-bought or won only, store currency, NEVER giftable except by
// admin). Legacy single `chips` migrates into the Play balance on first read.
const balField = (c: Currency) => (c === "premium" ? "chipsPremium" : "chipsPlay");
function readWallet(d: Record<string, unknown> | undefined): { play: number; premium: number } {
  return {
    play: (d?.chipsPlay as number) ?? (d?.chips as number) ?? DEFAULT_CHIPS,
    premium: (d?.chipsPremium as number) ?? 0,
  };
}

// Bots decide server-side until it's a human's turn or the hand ends.
function runBots(t: AuthTable): void {
  let guard = 0;
  while (t.status === "in_hand" && guard++ < 400) {
    const seat = toActTableSeat(t);
    if (seat < 0) break;
    const s = t.seats[seat];
    if (!s || !s.ai) break; // human to act
    const g = toGsSeat(t, seat);
    const cards = t.holes.get(seat);
    if (g < 0 || !cards || !t.gs) break;
    const dec = villainDecision(t.gs, g, cards, PROFILES[s.ai] ?? TAG, cryptoRng);
    let r = actSeat(t, seat, { type: dec.type, amount: dec.amount });
    if (!r.ok) { // safety: fall back to a legal no-op
      const ps = publicState(t);
      const toCall = ps.currentBet - (ps.seats[seat]?.bet ?? 0);
      r = actSeat(t, seat, { type: toCall > 0 ? "fold" : "check" });
      if (!r.ok) break;
    }
  }
}

// Persist secret state + public projection + per-player holes, in one transaction.
// `settled` = a hand JUST resolved this call (act/startHand), which is the only time
// the chip-conservation tripwire is meaningful — join/leave legitimately change the
// table chips between hands, so we must NOT run the check there (it would brick the
// table after hand 1).
function persist(tx: Transaction, code: string, t: AuthTable, version: number, baseline: number, settled = false, currency: Currency = "play"): void {
  if (settled && t.status === "hand_over") {
    const banked = t.seats.reduce((a, s) => a + (s.uid || s.ai ? s.chips : 0), 0);
    if (Math.abs(banked - baseline) > 0.5) {
      throw new HttpsError("internal", `chip conservation broken: ${banked} != ${baseline}`);
    }
  }

  const pub = publicState(t);
  // Reveal hole cards ONLY at a genuine multi-way showdown. On a fold-out the lone
  // winner never has to show — publishing their cards would leak a confirmed bluff.
  const revealedHoles: Record<number, [number, number]> = {};
  if (t.status === "hand_over" && t.gs) {
    const contenders = t.liveSeats.filter((ts) => { const g = toGsSeat(t, ts); return g >= 0 && !t.gs!.folded[g]; });
    if (contenders.length > 1) {
      for (const ts of contenders) { const h = t.holes.get(ts); if (h) revealedHoles[ts] = h; }
    }
  }
  const deadlineMs = t.status === "in_hand" ? Date.now() + TURN_SECONDS * 1000 : 0;

  tx.set(stateRef(code), { snap: serializeAuthTable(t), version, baseline, currency } satisfies StateDoc);
  tx.set(tableRef(code), {
    ...pub, version, deadlineMs, revealedHoles, currency, updatedAt: FieldValue.serverTimestamp(),
  });
  // Per-player hole cards — each human in the hand reads only their own doc.
  for (const ts of t.liveSeats) {
    const s = t.seats[ts];
    if (s?.uid) tx.set(holeRef(code, s.uid), { handId: t.handId, holeCards: t.holes.get(ts) ?? null });
  }
}

// ── callables ──

/** Create a private room. Returns the shareable code. Owner buys in from their wallet. */
export const createTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { tier = "5/10", buyIn, name = "Player", bots = [], currency = "play", assisted = false } = (req.data ?? {}) as
    { tier?: string; buyIn?: number; name?: string; bots?: string[]; currency?: Currency; assisted?: boolean };
  const cur: Currency = currency === "premium" ? "premium" : "play";
  // Premium tables are human-only (for now): no AI seats allowed.
  if (cur === "premium" && bots.length > 0) {
    throw new HttpsError("failed-precondition", "Premium rooms can't add AI players.");
  }
  const T = TIERS[tier] ?? TIERS["5/10"]!;
  const stack = Math.max(20 * T.bb, Math.min(T.max, Math.round(buyIn ?? T.max)));
  const seats = 2 + Math.min(7, cur === "premium" ? 0 : bots.length); // owner + bots (+ room to join)

  return db.runTransaction(async (tx) => {
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = cur === "premium" ? w.premium : w.play;
    if (bal < stack) throw new HttpsError("failed-precondition", `Not enough ${cur === "premium" ? "premium" : "play"} chips for that buy-in.`);

    let code = newCode();
    // (collision check; codes are sparse so one retry is plenty)
    if ((await tx.get(stateRef(code))).exists) code = newCode();

    const t = createAuthTable(code, { uid, name }, { name: `${tier} Room`, blinds: { sb: T.sb, bb: T.bb }, startingStack: stack, maxSeats: Math.max(seats, 2) });
    if (cur !== "premium") bots.slice(0, 7).forEach((arch, i) => seatAi(t, i + 1, `Bot ${i + 1}`, PROFILES[arch] ? arch : "TAG"));

    // The owner's assisted (strategy-tool) seat flag is an Edge Pass entitlement.
    // The engine defaults it on for seats[0], so gate it explicitly here: only honor
    // assisted===true when the owner actually holds Edge Pass; otherwise leave it off.
    const edgePass = (u.exists ? u.data()?.edgePass : undefined) === true;
    if (t.seats[0]) t.seats[0].assisted = assisted === true && edgePass;

    tx.set(userRef(uid), { name, [balField(cur)]: bal - stack }, { merge: true });
    persist(tx, code, t, 1, 0, false, cur);
    return { code, currency: cur };
  });
});

/** Join an existing room (by code). Debits buy-in from the joiner's wallet. */
export const joinTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, name = "Player" } = (req.data ?? {}) as { code?: string; name?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, currency } = await loadState(tx, code);
    if (t.seats.some((s) => s.uid === uid)) return { code, already: true }; // idempotent
    const seatIdx = t.seats.findIndex((s) => !s.uid && !s.ai);
    if (seatIdx < 0) throw new HttpsError("failed-precondition", "Room is full.");
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = currency === "premium" ? w.premium : w.play;
    if (bal < t.startingStack) throw new HttpsError("failed-precondition", `Not enough ${currency === "premium" ? "premium" : "play"} chips to buy in.`);
    sit(t, uid, name, seatIdx);
    tx.set(userRef(uid), { name, [balField(currency)]: bal - t.startingStack }, { merge: true });
    persist(tx, code, t, version + 1, 0, false, currency);
    return { code, seatIdx, currency };
  });
});

/** Owner seats an AI bot into an open seat of an EXISTING room. Play-currency rooms
 *  only (premium rooms are human-only); not while a hand is in progress. */
export const addBot = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, archetype } = (req.data ?? {}) as { code?: string; archetype?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  const arch = archetype && PROFILES[archetype] ? archetype : "TAG";
  return db.runTransaction(async (tx) => {
    const { t, version, currency } = await loadState(tx, code);
    if (uid !== t.ownerUid) throw new HttpsError("permission-denied", "Only the host can add a bot.");
    if (currency !== "play") throw new HttpsError("failed-precondition", "Premium rooms can't add AI.");
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Finish the hand before adding a bot.");
    const seatIdx = t.seats.findIndex((s) => !s.uid && !s.ai);
    if (seatIdx < 0) throw new HttpsError("failed-precondition", "Room is full.");
    if (!seatAi(t, seatIdx, `Bot ${seatIdx}`, arch)) throw new HttpsError("failed-precondition", "Couldn't seat the bot.");
    persist(tx, code, t, version + 1, 0, false, currency);
    return { ok: true, seatIdx, archetype: arch };
  });
});

/** Owner deals the next hand. */
export const startHand = onCall(async (req) => {
  const uid = uidOf(req);
  const { code } = (req.data ?? {}) as { code?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, currency } = await loadState(tx, code);
    if (uid !== t.ownerUid) throw new HttpsError("permission-denied", "Only the host can deal.");
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Hand already in progress.");
    // Require at least one seated HUMAN with chips — never deal a bot-only hand
    // (blocks an owner-left startHand-spam grind).
    if (!t.seats.some((s) => s.uid && s.chips > 0 && !s.sittingOut)) {
      throw new HttpsError("failed-precondition", "Need a seated player with chips.");
    }
    if (!engineStartHand(t, cryptoRng)) throw new HttpsError("failed-precondition", "Need 2+ players with chips.");
    // Total chips at the table (blinds are now in the pot, but seats[].chips still
    // hold each buy-in until settle). Conserved across the whole hand.
    const baseline = t.seats.reduce((a, s) => a + (s.uid || s.ai ? s.chips : 0), 0);
    runBots(t); // auto-play any leading bots up to the first human
    persist(tx, code, t, version + 1, baseline, true, currency);
    return { ok: true };
  });
});

/** A human acts. Actor derived from the verified token; version-locked; bots chain. */
export const act = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, action, expectedVersion } = (req.data ?? {}) as
    { code?: string; action?: MPAction; expectedVersion?: number };
  if (!code || !action) throw new HttpsError("invalid-argument", "code + action required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (typeof expectedVersion === "number" && expectedVersion !== version) {
      throw new HttpsError("aborted", "stale"); // client retries with fresh snapshot
    }
    const r = engineAct(t, uid, action); // validates turn (from uid) + legality + min-raise
    if (!r.ok) throw new HttpsError("failed-precondition", r.err ?? "illegal action");
    runBots(t); // resolve any bots up to the next human / hand end
    persist(tx, code, t, version + 1, baseline, true, currency);
    return { ok: true };
  });
});

/** Leave the table — bank your remaining stack back to your wallet. */
export const leaveTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { code } = (req.data ?? {}) as { code?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    const seat = t.seats.find((s) => s.uid === uid);
    if (!seat) return { ok: true };
    if (t.status === "in_hand" && t.liveSeats.includes(t.seats.indexOf(seat))) {
      throw new HttpsError("failed-precondition", "Finish the hand before leaving.");
    }
    const back = seat.chips;
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = currency === "premium" ? w.premium : w.play;
    leave(t, uid);
    tx.set(userRef(uid), { [balField(currency)]: bal + back }, { merge: true });
    persist(tx, code, t, version + 1, baseline, false, currency);
    return { ok: true, banked: back };
  });
});

// Per-uid windowed rate limit. Reads in the txn's READ phase + returns a writer the
// caller commits in its WRITE phase (Firestore txns require all reads before writes).
async function rlRead(tx: Transaction, uid: string, bucket: string, max: number, windowMs: number) {
  const ref = db.doc(`rateLimits/${uid}__${bucket}`);
  const snap = await tx.get(ref);
  const now = Date.now();
  const d = snap.exists ? (snap.data() as { count?: number; windowStart?: number }) : null;
  let count = 1, windowStart = now;
  if (d && now - (d.windowStart ?? 0) < windowMs) { count = (d.count ?? 0) + 1; windowStart = d.windowStart ?? now; }
  if (count > max) throw new HttpsError("resource-exhausted", "Too many requests — slow down a moment.");
  return { ref, data: { count, windowStart } };
}

// ── economy: gifting, messaging, admin, weekly faucet ──

/** Gift PLAY chips to another player. PREMIUM is NEVER giftable here (only via admin
 *  or by winning at a table). Immediate transfer + an inbox note. */
export const giftChips = onCall(async (req) => {
  const uid = uidOf(req);
  const { toUid, amount, note = "" } = (req.data ?? {}) as { toUid?: string; amount?: number; note?: string };
  const amt = Math.floor(Number(amount));
  if (!toUid || toUid === uid) throw new HttpsError("invalid-argument", "Pick a different player.");
  if (!Number.isFinite(amt) || amt <= 0 || amt > GIFT_MAX) throw new HttpsError("invalid-argument", "Invalid amount.");
  return db.runTransaction(async (tx) => {
    const rl = await rlRead(tx, uid, "gift", 30, 60_000); // ≤30 gifts/min
    const fromSnap = await tx.get(userRef(uid));
    const toSnap = await tx.get(userRef(toUid));
    if (!toSnap.exists) throw new HttpsError("not-found", "Recipient not found.");
    const fromW = readWallet(fromSnap.data());
    const toW = readWallet(toSnap.data());
    if (fromW.play < amt) throw new HttpsError("failed-precondition", "Not enough play chips.");
    const fromName = (fromSnap.data()?.name as string) ?? "A player";
    const toName = (toSnap.data()?.name as string) ?? "player";
    tx.set(rl.ref, rl.data);
    tx.set(userRef(uid), { chipsPlay: fromW.play - amt }, { merge: true });
    tx.set(userRef(toUid), { chipsPlay: toW.play + amt }, { merge: true });
    tx.set(inboxRef(toUid).doc(), { kind: "gift", from: uid, fromName, chips: amt, text: String(note).slice(0, 200), createdAt: FieldValue.serverTimestamp(), read: false });
    tx.set(ledgerRef().doc(), { type: "gift", currency: "play", amount: amt, from: uid, fromName, to: toUid, toName, note: String(note).slice(0, 200), at: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

/** Send a text message to another player's inbox. */
export const sendMessage = onCall(async (req) => {
  const uid = uidOf(req);
  const { toUid, text } = (req.data ?? {}) as { toUid?: string; text?: string };
  const body = (text ?? "").trim().slice(0, 500);
  if (!toUid || toUid === uid) throw new HttpsError("invalid-argument", "Pick a different player.");
  if (!body) throw new HttpsError("invalid-argument", "Empty message.");
  return db.runTransaction(async (tx) => {
    const rl = await rlRead(tx, uid, "msg", 15, 60_000); // ≤15 messages/min
    const fromSnap = await tx.get(userRef(uid));
    const toSnap = await tx.get(userRef(toUid));
    if (!toSnap.exists) throw new HttpsError("not-found", "Recipient not found.");
    const fromName = (fromSnap.data()?.name as string) ?? "A player";
    tx.set(rl.ref, rl.data);
    tx.set(inboxRef(toUid).doc(), { kind: "text", from: uid, fromName, text: body, createdAt: FieldValue.serverTimestamp(), read: false });
    return { ok: true };
  });
});

/** Super-admin only (gated by verified email): gift PLAY or PREMIUM chips, or adjust
 *  a balance (amount may be negative). The ONLY way premium chips are granted off-table. */
export const adminGift = onCall(async (req) => {
  uidOf(req);
  // SECURITY: never trust an email claim that isn't verified — an attacker can
  // register an UNVERIFIED email/password account using the admin address and would
  // otherwise pass an email-only allowlist and mint premium chips. Require
  // email_verified, OR a custom {admin:true} claim (set offline on the real admin uid).
  const tok = (req.auth?.token ?? {}) as { email?: string; email_verified?: boolean; admin?: boolean };
  const isAdmin = tok.admin === true || (ADMIN_EMAILS.has(tok.email ?? "") && tok.email_verified === true);
  if (!isAdmin) throw new HttpsError("permission-denied", "Admins only.");
  const { toUid, currency = "play", amount } = (req.data ?? {}) as { toUid?: string; currency?: Currency; amount?: number };
  const amt = Math.floor(Number(amount));
  const cur: Currency = currency === "premium" ? "premium" : "play";
  if (!toUid) throw new HttpsError("invalid-argument", "Recipient required.");
  if (!Number.isFinite(amt) || amt === 0) throw new HttpsError("invalid-argument", "Invalid amount.");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef(toUid));
    if (!snap.exists) throw new HttpsError("not-found", "Recipient not found.");
    const w = readWallet(snap.data());
    const next = Math.max(0, (cur === "premium" ? w.premium : w.play) + amt);
    const toName = (snap.data()?.name as string) ?? "player";
    tx.set(userRef(toUid), { [balField(cur)]: next }, { merge: true });
    tx.set(inboxRef(toUid).doc(), { kind: "admin", from: "admin", fromName: "MonteCarloEdge", chips: amt, currency: cur, text: amt > 0 ? `You received ${amt} ${cur} chips` : `Balance adjustment: ${amt} ${cur} chips`, createdAt: FieldValue.serverTimestamp(), read: false });
    tx.set(ledgerRef().doc(), { type: "admin", currency: cur, amount: amt, from: "admin", fromName: (req.auth?.token?.email as string) ?? "admin", to: toUid, toName, at: FieldValue.serverTimestamp() });
    return { ok: true, balance: next };
  });
});

/** Claim the weekly free PLAY chips on a DETERMINISTIC streak ladder (no RNG / no loot
 *  box). Server-timed (anti-cheat). Streak grows if you return within 2 weeks. */
const WEEKLY_LADDER = [500, 600, 750, 1000]; // wk1, wk2, wk3, wk4+ (deterministic)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const claimWeekly = onCall(async (req) => {
  const uid = uidOf(req);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef(uid));
    const d = (snap.exists ? snap.data()! : {}) as Record<string, unknown>;
    const last = (d.lastWeekly as number) ?? 0;
    const now = Date.now();
    if (now - last < WEEK_MS) throw new HttpsError("failed-precondition", "Weekly chips already claimed — come back later.");
    // Streak continues if claimed within 2 weeks of the last; otherwise resets to 1.
    const streak = (last && now - last < 2 * WEEK_MS) ? ((d.weeklyStreak as number) ?? 0) + 1 : 1;
    const grant = WEEKLY_LADDER[Math.min(streak - 1, WEEKLY_LADDER.length - 1)]!;
    const w = readWallet(d);
    tx.set(userRef(uid), { chipsPlay: w.play + grant, lastWeekly: now, weeklyStreak: streak }, { merge: true });
    return { ok: true, granted: grant, balance: w.play + grant, streak };
  });
});

// Cosmetic collectibles catalog (server-authoritative prices, in PREMIUM chips).
// These are account-bound digital cosmetics — no cash value, not transferable.
const COLLECTIBLES: Record<string, number> = {
  squid: 2500, goldback: 1200, emerald: 1500, crown: 3000, squiddigital: 2000,
};
/** Buy a cosmetic collectible with PREMIUM chips. Account-bound; non-transferable. */
export const buyCollectible = onCall(async (req) => {
  const uid = uidOf(req);
  const { itemId } = (req.data ?? {}) as { itemId?: string };
  const price = itemId ? COLLECTIBLES[itemId] : undefined;
  if (!itemId || price == null) throw new HttpsError("invalid-argument", "Unknown item.");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef(uid));
    const d = (snap.exists ? snap.data()! : {}) as Record<string, unknown>;
    const owned = (d.collectibles as string[]) ?? [];
    if (owned.includes(itemId)) throw new HttpsError("failed-precondition", "Already owned.");
    const w = readWallet(d);
    if (w.premium < price) throw new HttpsError("failed-precondition", "Not enough premium chips.");
    tx.set(userRef(uid), { chipsPremium: w.premium - price, collectibles: [...owned, itemId] }, { merge: true });
    tx.set(ledgerRef().doc(), { type: "buy", item: itemId, currency: "premium", amount: price, from: uid, fromName: (d.name as string) ?? "player", to: "store", toName: "store", at: FieldValue.serverTimestamp() });
    return { ok: true, balance: w.premium - price };
  });
});
