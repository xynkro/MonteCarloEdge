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
import { getAuth } from "firebase-admin/auth";

import {
  createAuthTable, sit, seatAi, leave, startHand as engineStartHand,
  act as engineAct, actSeat, publicState, toActTableSeat, toGsSeat, recommendForSeat, type AuthTable,
} from "../../src/mp/mp-engine.js";
import { serializeAuthTable, deserializeAuthTable, type AuthTableSnapshot } from "../../src/mp/auth-table-codec.js";
import type { MPAction } from "../../src/mp/types.js";
import { villainDecision } from "../../src/engine/villain-ai.js";
import { recommend } from "../../src/engine/decision.js";
import { AUTO, TAG, LAG, STATION, NIT, MANIAC, type OpponentProfile } from "../../src/engine/opponent.js";
import { cryptoRng } from "./crypto-rng.js";

// memory 1GiB → ~0.58 vCPU (the default 256MiB is only ~0.17 vCPU, which made the per-action
// bot Monte-Carlo tick slow). Higher CPU finishes the tick faster, so it roughly offsets the
// per-ms cost — net cost stays low at this (friends-app) volume. Cold starts still happen (no
// minInstances — that's an always-on bill, pending owner OK).
setGlobalOptions({ region: "asia-southeast1", maxInstances: 10, memory: "1GiB" });
initializeApp();
const db = getFirestore();

// Turn-by-turn replay: a snapshot of the PUBLIC table state captured right AFTER each bot
// action in a tick, paired with the action that produced it. The client replays these in
// sequence (paced by the speed tier) so a chain of bots looks like they took turns — exactly
// like the local trainer — instead of the table jumping straight to the final state. Each
// frame is server-authoritative truth, so there's no client-side simulation (one render path).
type BotFrame = { seat: number; type: string; amount: number; pub: ReturnType<typeof publicState> };

// Stripe Edge Pass paywall (createCheckoutSession / createBillingPortal / stripeWebhook).
export * from "./stripe.js";
// RevenueCat native IAP webhook (the sole server-authoritative writer of edgePass / chip grants
// on iOS & Android — mirrors stripeWebhook). Web keeps Stripe.
export * from "./revenuecat.js";
// Passkey / Face ID auth (register + authenticate → Firebase custom token).
export * from "./passkey.js";

const PROFILES: Record<string, OpponentProfile> = { Auto: AUTO, TAG, LAG, Station: STATION, Nit: NIT, Maniac: MANIAC };
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
const chatCol = (code: string) => db.collection(`tables/${code}/chat`);
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
function runBots(t: AuthTable, frames?: BotFrame[]): void {
  // Reset the trace at the START of this tick — clients use the diff to drive a
  // staggered "bots took turns" replay. A new client snapshot replaces the old trace.
  t.botTrace = [];
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
    let appliedType = dec.type, appliedAmount = dec.amount;
    if (!r.ok) { // safety: fall back to a legal no-op
      const ps = publicState(t);
      const toCall = ps.currentBet - (ps.seats[seat]?.bet ?? 0);
      const fallback = (toCall > 0 ? "fold" : "check") as MPAction["type"];
      r = actSeat(t, seat, { type: fallback });
      appliedType = fallback; appliedAmount = 0;
      if (!r.ok) break;
    }
    // Record the action the engine accepted (post-cap-to-allin). Bound the trace so
    // a runaway loop can't grow it without bound.
    if (t.botTrace.length < 32) t.botTrace.push({ seat, type: appliedType, amount: appliedAmount });
    // Capture the resulting PUBLIC state so the client can replay this exact step
    // turn-by-turn (no client simulation). botTrace is stripped and lastAction nulled so
    // intermediate frames don't re-render action callouts; the client stamps each frame's
    // version from finalPub before applying it. The array is bounded to match the trace cap.
    if (frames && frames.length < 32) {
      const snap = publicState(t);
      snap.botTrace = [];
      snap.lastAction = null; // Don't render action callout on intermediate frames
      frames.push({ seat, type: appliedType, amount: appliedAmount, pub: snap });
    }
  }
}

// Persist secret state + public projection + per-player holes, in one transaction.
// `settled` = a hand JUST resolved this call (act/startHand), which is the only time
// the chip-conservation tripwire is meaningful — join/leave legitimately change the
// table chips between hands, so we must NOT run the check there (it would brick the
// table after hand 1).
function persist(tx: Transaction, code: string, t: AuthTable, version: number, baseline: number, settled = false, currency: Currency = "play", frames?: BotFrame[]): void {
  if (settled && t.status === "hand_over") {
    const banked = t.seats.reduce((a, s) => a + (s.uid || s.ai ? s.chips : 0), 0);
    if (Math.abs(banked - baseline) > 0.5) {
      throw new HttpsError("internal", `chip conservation broken: ${banked} != ${baseline}`);
    }
  }
  // Non-tick callables (lobby cogs, kick, rebuy, join/leave) shouldn't surface a stale
  // bot trace from a previous tick — only act/startHand (settled=true) intend to ship one.
  if (!settled) t.botTrace = [];

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
    // Per-bot-action replay frames (act/startHand ticks only) — see BotFrame. Cleared on
    // non-tick writes so a client never replays a stale chain.
    botFrames: settled ? (frames ?? []) : [],
  });
  // Per-player hole cards — each human in the hand reads only their own doc.
  for (const ts of t.liveSeats) {
    const s = t.seats[ts];
    if (!s?.uid) continue;
    // Live MCE Strategy recommendation: only for an Edge-Pass "assisted" seat, in a
    // hand, on that seat's turn to act. Heuristics-only (see decision.ts ~L102) — no
    // solver — so this is ~villainDecision cost. Never let it break the hand-doc write.
    let rec: Record<string, unknown> | null = null;
    if (s.assisted === true && t.status === "in_hand" && ts === toActTableSeat(t)) {
      try {
        const style = s.recStyle ?? "balanced";
        const styleProfile =
          style === "lag"     ? PROFILES.LAG :
          style === "tag"     ? PROFILES.TAG :
          style === "nit"     ? PROFILES.Nit :
          style === "station" ? PROFILES.Station :
          style === "maniac"  ? PROFILES.Maniac :
          PROFILES.Auto;
        const r = recommendForSeat(t, ts, recommend, styleProfile ?? AUTO);
        rec = r ? { action: r.action, amount: r.amount, handLabel: r.handLabel ?? "", reasoning: r.reasoning, equity: r.equity, potOdds: r.potOdds, source: r.source ?? "heuristic" } : null;
      } catch { rec = null; }
    }
    tx.set(holeRef(code, s.uid), { handId: t.handId, holeCards: t.holes.get(ts) ?? null, rec });
  }
}

// ── callables ──

/** Create a private room. Returns the shareable code. Owner buys in from their wallet. */
export const createTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { tier = "5/10", buyIn, name = "Player", bots = [], currency = "play", assisted = false, isPublic = true } = (req.data ?? {}) as
    { tier?: string; buyIn?: number; name?: string; bots?: string[]; currency?: Currency; assisted?: boolean; isPublic?: boolean };
  const cur: Currency = currency === "premium" ? "premium" : "play";
  // Premium tables are human-only (for now): no AI seats allowed.
  if (cur === "premium" && bots.length > 0) {
    throw new HttpsError("failed-precondition", "Premium rooms can't add AI players.");
  }
  const T = TIERS[tier] ?? TIERS["5/10"]!;
  const stack = Math.max(20 * T.bb, Math.min(T.max, Math.round(buyIn ?? T.max)));
  // Full 12-max table: owner + up to 11 others (humans or bots). The engine's GTO charts
  // are real to 10-max; 11/12 use UTG-aliased ranges for the extra early seats (no real
  // 12-max solve exists, but it lets a big home game run).
  const seats = 12;

  return db.runTransaction(async (tx) => {
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = cur === "premium" ? w.premium : w.play;
    if (bal < stack) throw new HttpsError("failed-precondition", `Not enough ${cur === "premium" ? "premium" : "play"} chips for that buy-in.`);

    let code = newCode();
    // (collision check; codes are sparse so one retry is plenty)
    if ((await tx.get(stateRef(code))).exists) code = newCode();

    const t = createAuthTable(code, { uid, name }, { name: `${tier} Room`, blinds: { sb: T.sb, bb: T.bb }, startingStack: stack, maxSeats: Math.max(seats, 2), isPublic: isPublic !== false });
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
  const { code, name = "Player", spectate = false } = (req.data ?? {}) as { code?: string; name?: string; spectate?: boolean };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (t.seats.some((s) => s.uid === uid)) return { code, already: true }; // idempotent (already seated)
    // Spectate path: no buy-in, no seat, just join the watchers list. Fine mid-hand.
    if (spectate === true) {
      const list = (t.spectators ?? []).filter((s) => s.uid !== uid);
      list.push({ uid, name });
      t.spectators = list;
      persist(tx, code, t, version + 1, baseline, false, currency);
      return { code, spectator: true };
    }
    // WSOP-style: joining or REJOINING mid-hand is allowed — you take an open seat but are
    // dealt in on the NEXT hand (this hand's liveSeats are fixed at deal, so you just watch it
    // finish). No "try again" reject. If the room is full right now, fall back to spectating.
    const midHand = t.status === "in_hand";
    let seatIdx = t.seats.findIndex((s) => !s.uid && !s.ai);
    if (seatIdx < 0) {
      if (midHand) {
        const list = (t.spectators ?? []).filter((s) => s.uid !== uid); list.push({ uid, name });
        t.spectators = list; persist(tx, code, t, version + 1, baseline, false, currency);
        return { code, spectator: true, full: true };
      }
      throw new HttpsError("failed-precondition", "Room is full.");
    }
    // Leaving the spectators list when taking a seat (so the same user isn't double-listed).
    if ((t.spectators ?? []).some((s) => s.uid === uid)) {
      t.spectators = (t.spectators ?? []).filter((s) => s.uid !== uid);
    }
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = currency === "premium" ? w.premium : w.play;
    if (bal < t.startingStack) throw new HttpsError("failed-precondition", `Not enough ${currency === "premium" ? "premium" : "play"} chips to buy in.`);
    // Humans-before-bots while waiting: if a bot occupies a lower seat index, swap so
    // the human takes that lower seat and the bot shifts up. UI-only ergonomics — no
    // chip movement, no hand-state implication (status=waiting, no GS yet).
    if (t.status === "waiting") {
      const firstBotIdx = t.seats.findIndex((s) => s.ai);
      if (firstBotIdx >= 0 && firstBotIdx < seatIdx) {
        t.seats[seatIdx] = { ...t.seats[firstBotIdx]! };
        t.seats[firstBotIdx] = { uid: null, name: "", chips: 0, assisted: false, sittingOut: false, ai: null };
        seatIdx = firstBotIdx;
      }
    }
    sit(t, uid, name, seatIdx);
    if (t.seats[seatIdx]) t.seats[seatIdx]!.assisted = (u.exists ? u.data()?.edgePass : undefined) === true;
    tx.set(userRef(uid), { name, [balField(currency)]: bal - t.startingStack }, { merge: true });
    // Seated mid-hand → the table total just grew by the buy-in; bump the conservation
    // baseline so THIS hand's settle still balances (the next startHand recomputes it fresh).
    persist(tx, code, t, version + 1, midHand ? baseline + t.startingStack : baseline, false, currency);
    return { code, seatIdx, currency, nextHand: midHand };
  });
});

/** Owner seats an AI bot into an open seat of an EXISTING room. Play-currency rooms
 *  only (premium rooms are human-only); not while a hand is in progress. */
export const addBot = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, archetype } = (req.data ?? {}) as { code?: string; archetype?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  // Explicit valid archetype → use it. "rand" / unknown / missing → random personality, drawn
  // from PROFILES so a newly-added archetype is automatically eligible (no hardcoded drift).
  const pool = Object.keys(PROFILES);
  const arch = archetype && archetype !== "rand" && PROFILES[archetype]
    ? archetype
    : pool[Math.floor(cryptoRng() * pool.length)]!;
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (uid !== t.ownerUid) throw new HttpsError("permission-denied", "Only the host can add a bot.");
    if (currency !== "play") throw new HttpsError("failed-precondition", "Premium rooms can't add AI.");
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Finish the hand before adding a bot.");
    const seatIdx = t.seats.findIndex((s) => !s.uid && !s.ai);
    if (seatIdx < 0) throw new HttpsError("failed-precondition", "Room is full.");
    if (!seatAi(t, seatIdx, `Bot ${seatIdx}`, arch)) throw new HttpsError("failed-precondition", "Couldn't seat the bot.");
    persist(tx, code, t, version + 1, baseline, false, currency);
    return { ok: true, seatIdx, archetype: arch };
  });
});

/** Any seated human deals the next hand (clients also auto-deal after hand_over; the
 *  transaction's in_hand guard makes duplicate triggers harmless). */
export const startHand = onCall(async (req) => {
  const uid = uidOf(req);
  const { code } = (req.data ?? {}) as { code?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, currency } = await loadState(tx, code);
    if (!t.seats.some((s) => s.uid === uid)) throw new HttpsError("permission-denied", "Take a seat to deal.");
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Hand already in progress.");
    // Require at least one seated HUMAN with chips — never deal a bot-only hand
    // (blocks an owner-left startHand-spam grind).
    if (!t.seats.some((s) => s.uid && s.chips > 0 && !s.sittingOut)) {
      throw new HttpsError("failed-precondition", "Need a seated player with chips.");
    }
    // Clear out busted BOTS before dealing — a bot can't rebuy, so a 0-chip bot would
    // otherwise linger as a sidelined ghost seat forever. (Busted HUMANS keep their seat
    // so their rebuy puts them straight back in.)
    for (let i = 0; i < t.seats.length; i++) {
      const s = t.seats[i]!;
      if (s.ai && s.chips <= 0) t.seats[i] = { uid: null, name: "", chips: 0, assisted: false, sittingOut: false, ai: null };
    }
    if (!engineStartHand(t, cryptoRng)) throw new HttpsError("failed-precondition", "Need 2+ players with chips.");
    // Total chips at the table (blinds are now in the pot, but seats[].chips still
    // hold each buy-in until settle). Conserved across the whole hand.
    const baseline = t.seats.reduce((a, s) => a + (s.uid || s.ai ? s.chips : 0), 0);
    const _frames: BotFrame[] = [];
    runBots(t, _frames); // auto-play any leading bots up to the first human
    persist(tx, code, t, version + 1, baseline, true, currency, _frames);
    return { ok: true };
  });
});

/** A human acts. Actor derived from the verified token; version-locked; bots chain. */
export const act = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, action } = (req.data ?? {}) as { code?: string; action?: MPAction };
  if (!code || !action) throw new HttpsError("invalid-argument", "code + action required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    // No optimistic stale-reject: engineAct below validates turn (from the verified uid) +
    // action legality, so a version bump from a bot/opponent acting elsewhere never blocks a
    // still-legal action. (The old expectedVersion check surfaced to the player as a "stale"
    // hang even though their action was fine — the Firestore transaction already serializes
    // concurrent writes, and an out-of-turn/illegal retry is caught by engineAct.)
    const r = engineAct(t, uid, action); // validates turn (from uid) + legality + min-raise
    if (!r.ok) throw new HttpsError("failed-precondition", r.err ?? "illegal action");
    const frames: BotFrame[] = []; // per-attempt (retries get a fresh array)
    runBots(t, frames); // resolve any bots up to the next human / hand end
    persist(tx, code, t, version + 1, baseline, true, currency, frames);
    return { ok: true };
  });
});

/** Update YOUR own seat's prefs (assisted ↔ MCE strategy, recStyle). assisted is
 *  gated by Edge Pass — silently false if not entitled. */
export const setSeatPrefs = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, assisted, recStyle, heroStyle } = (req.data ?? {}) as
    { code?: string; assisted?: boolean;
      recStyle?: "balanced" | "tag" | "lag" | "nit" | "station" | "maniac";
      heroStyle?: "gto" | "tag" | "lag" | "nit" | "maniac" };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    const seatIdx = t.seats.findIndex((s) => s.uid === uid);
    if (seatIdx < 0) throw new HttpsError("permission-denied", "Take a seat first.");
    if (typeof assisted === "boolean") {
      const u = await tx.get(userRef(uid));
      const edgePass = (u.exists ? u.data()?.edgePass : undefined) === true;
      t.seats[seatIdx]!.assisted = assisted === true && edgePass;
    }
    if (recStyle === "balanced" || recStyle === "tag" || recStyle === "lag" || recStyle === "nit" || recStyle === "station" || recStyle === "maniac") {
      t.seats[seatIdx]!.recStyle = recStyle;
    }
    // Hero play-style (Bluff Lab) — validated against the closed set so a hostile client
    // can't push arbitrary strings into the table doc.
    if (heroStyle === "gto" || heroStyle === "tag" || heroStyle === "lag" || heroStyle === "nit" || heroStyle === "maniac") {
      t.seats[seatIdx]!.heroStyle = heroStyle;
    }
    persist(tx, code, t, version + 1, baseline, false, currency);
    return {
      ok: true,
      assisted: t.seats[seatIdx]!.assisted,
      recStyle: t.seats[seatIdx]!.recStyle ?? "balanced",
      heroStyle: t.seats[seatIdx]!.heroStyle ?? "gto",
    };
  });
});

/** Owner-only: flip room privacy. The Online Games list filters on isPublic. */
export const setRoomPrefs = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, isPublic } = (req.data ?? {}) as { code?: string; isPublic?: boolean };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (uid !== t.ownerUid) throw new HttpsError("permission-denied", "Only the host can change room prefs.");
    if (typeof isPublic === "boolean") t.isPublic = isPublic;
    persist(tx, code, t, version + 1, baseline, false, currency);
    return { ok: true, isPublic: t.isPublic !== false };
  });
});

/** Owner-only: remove a bot from a seat while waiting. */
export const kickBot = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, seatIdx } = (req.data ?? {}) as { code?: string; seatIdx?: number };
  if (!code || typeof seatIdx !== "number") throw new HttpsError("invalid-argument", "code + seatIdx required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (uid !== t.ownerUid) throw new HttpsError("permission-denied", "Only the host can kick a bot.");
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Finish the hand before kicking.");
    const s = t.seats[seatIdx];
    if (!s || !s.ai) throw new HttpsError("failed-precondition", "Not a bot seat.");
    t.seats[seatIdx] = { uid: null, name: "", chips: 0, assisted: false, sittingOut: false, ai: null };
    persist(tx, code, t, version + 1, baseline, false, currency);
    return { ok: true };
  });
});

/** Public lobby: ~20 open public rooms in waiting. Unauthenticated callers are fine —
 *  the data is the same projection already broadcast to subscribers. */
export const listPublicRooms = onCall(async (_req) => {
  const snap = await db.collection("tables")
    .where("status", "==", "waiting")
    .where("isPublic", "==", true)
    .limit(50)
    .get();
  const rooms: Array<{ code: string; name: string; sb: number; bb: number; occupied: number; max: number; currency: string }> = [];
  for (const doc of snap.docs) {
    const d = doc.data() as { id?: string; name?: string; blinds?: { sb: number; bb: number }; seats?: Array<{ uid: string | null; ai: string | null }>; currency?: string };
    const seats = d.seats ?? [];
    const occupied = seats.filter((x) => x.uid || x.ai).length;
    if (occupied >= seats.length) continue; // full → drop
    rooms.push({
      code: doc.id, name: d.name ?? "Room",
      sb: d.blinds?.sb ?? 0, bb: d.blinds?.bb ?? 0,
      occupied, max: seats.length,
      currency: d.currency ?? "play",
    });
    if (rooms.length >= 20) break;
  }
  return { rooms };
});

/** Lobby + table chat — seated players and spectators only. Server enforces length
 *  (≤120 chars), rate (1 msg / 2s), and authorship (uid + display name). Client never
 *  writes to the chat collection directly. */
export const sendChat = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, text } = (req.data ?? {}) as { code?: string; text?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) throw new HttpsError("invalid-argument", "Empty message.");
  if (clean.length > 120) throw new HttpsError("invalid-argument", "Keep it under 120 characters.");
  await db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(stateRef(code));
    if (!stateSnap.exists) throw new HttpsError("not-found", "Room not found.");
    const sd = stateSnap.data() as StateDoc | undefined;
    const t = sd ? sd.snap : null;
    if (!t) throw new HttpsError("not-found", "Room state missing.");
    const seated = (t.seats ?? []).some((s) => s.uid === uid);
    const watching = (t.spectators ?? []).some((s) => s.uid === uid);
    if (!seated && !watching) throw new HttpsError("permission-denied", "Join the room to chat.");
    const rl = await rlRead(tx, uid, "chat", 1, 2000); // 1 msg / 2s
    const userSnap = await tx.get(userRef(uid));
    const name = (userSnap.exists ? (userSnap.data()?.name as string | undefined) : undefined) ?? "Player";
    tx.set(rl.ref, rl.data);
    tx.set(chatCol(code).doc(), { uid, name, text: clean, ts: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

/** Top-up your seated stack (bust rebuy, or between-hand top up). Debits the room's
 *  currency wallet, bumps seat.chips + baseline atomically. NEVER allowed mid-hand. */
export const rebuy = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, amount } = (req.data ?? {}) as { code?: string; amount?: number };
  const amt = Math.round(Number(amount));
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpsError("invalid-argument", "Pick a positive amount.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline, currency } = await loadState(tx, code);
    if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Wait for the hand to end.");
    const seatIdx = t.seats.findIndex((s) => s.uid === uid);
    if (seatIdx < 0) throw new HttpsError("permission-denied", "Take a seat first.");
    const seat = t.seats[seatIdx]!;
    // Allowed when busted, OR while the room is still in the lobby.
    if (seat.chips > 0 && t.status !== "waiting") {
      throw new HttpsError("failed-precondition", "Top-ups only allowed when busted or while waiting.");
    }
    const tier = Object.values(TIERS).find((T) => T.bb === t.blinds.bb);
    const maxCap = tier?.max ?? t.startingStack;
    const minStack = 20 * t.blinds.bb;
    const newStack = seat.chips + amt;
    if (newStack < minStack) throw new HttpsError("invalid-argument", `Top up to at least ${minStack} chips.`);
    if (newStack > maxCap) throw new HttpsError("invalid-argument", `Stack would exceed table cap of ${maxCap}.`);
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = currency === "premium" ? w.premium : w.play;
    if (bal < amt) throw new HttpsError("failed-precondition", `Not enough ${currency === "premium" ? "premium" : "play"} chips.`);
    seat.chips = newStack;
    tx.set(userRef(uid), { [balField(currency)]: bal - amt }, { merge: true });
    // Bumping baseline keeps the stored conservation reference in sync — startHand will
    // recompute baseline from the live stacks at deal time, so this is belt-and-braces.
    persist(tx, code, t, version + 1, baseline + amt, false, currency);
    return { ok: true, stack: newStack };
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
    // Spectator-only path: just drop them from the watcher list.
    if (!seat) {
      const list = (t.spectators ?? []).filter((s) => s.uid !== uid);
      if (list.length === (t.spectators?.length ?? 0)) return { ok: true };
      t.spectators = list;
      persist(tx, code, t, version + 1, baseline, false, currency);
      return { ok: true };
    }
    if (t.status === "in_hand" && t.liveSeats.includes(t.seats.indexOf(seat))) {
      // Reject a mid-hand leave — the client's queued-leave (_pendingLeave) then folds on-turn
      // and banks safely at hand_over, where seat.chips holds the SETTLED stack. We must NOT
      // cash out here: mid-hand seat.chips is the full PRE-hand buy-in (it's only reconciled in
      // settle(), mp-engine.ts:299), and the chips already committed to the pot are still live —
      // banking the full stack would create chips and trip the conservation tripwire, bricking
      // the table for everyone. leave() also doesn't fold the seat in t.gs, so a non-folded
      // leaver would remain a live showdown contender on a blanked ghost seat. Machine-readable
      // `code` lets the client detect this WITHOUT regex-matching the (byte-stable) message.
      throw new HttpsError("failed-precondition", "Finish the hand before leaving.", { code: "IN_HAND" });
    }
    const back = seat.chips;
    const u = await tx.get(userRef(uid));
    const w = readWallet(u.exists ? u.data() : undefined);
    const bal = currency === "premium" ? w.premium : w.play;
    leave(t, uid);
    // Make sure they're not lingering in the spectator list either.
    t.spectators = (t.spectators ?? []).filter((s) => s.uid !== uid);
    tx.set(userRef(uid), { [balField(currency)]: bal + back }, { merge: true });
    // Leaving MID-HAND removes this (non-live) seat's stack from the table, so drop the
    // conservation baseline by the same amount — the symmetric counterpart to joinTable's
    // mid-hand baseline bump. Without it THIS hand's settle tripwire would brick (banked <
    // baseline). Between hands startHand recomputes the baseline fresh, so only in_hand needs it.
    const newBase = t.status === "in_hand" ? baseline - back : baseline;
    persist(tx, code, t, version + 1, newBase, false, currency);
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

/** Super-admin only (same gate as adminGift): grant/revoke the Edge Pass entitlement
 *  on a target user. Writes a ledger entry + an inbox note. */
export const adminSetEdgePass = onCall(async (req) => {
  uidOf(req);
  const tok = (req.auth?.token ?? {}) as { email?: string; email_verified?: boolean; admin?: boolean };
  const isAdmin = tok.admin === true || (ADMIN_EMAILS.has(tok.email ?? "") && tok.email_verified === true);
  if (!isAdmin) throw new HttpsError("permission-denied", "Admins only.");
  const { toUid, on } = (req.data ?? {}) as { toUid?: string; on?: boolean };
  if (!toUid) throw new HttpsError("invalid-argument", "Recipient required.");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef(toUid)); // read before write
    if (!snap.exists) throw new HttpsError("not-found", "Recipient not found.");
    tx.set(userRef(toUid), { edgePass: !!on }, { merge: true });
    tx.set(ledgerRef().doc(), { type: "edgepass", from: "admin", fromName: (req.auth?.token?.email as string) ?? "admin", to: toUid, on: !!on, at: FieldValue.serverTimestamp() });
    tx.set(inboxRef(toUid).doc(), { kind: "admin", from: "admin", fromName: "MonteCarloEdge", text: on ? "Edge Pass unlocked for you 🎉" : "Edge Pass removed", createdAt: FieldValue.serverTimestamp(), read: false });
    return { ok: true, edgePass: !!on };
  });
});

/** Super-admin only: delete a target user's Firestore footprint AND their Firebase Auth
 *  user record. Writes a ledger entry first so the action is auditable even after the
 *  user doc is gone. Inbox + presence + seats subcollections are wiped in batches. */
export const adminDeleteUser = onCall(async (req) => {
  uidOf(req);
  const tok = (req.auth?.token ?? {}) as { email?: string; email_verified?: boolean; admin?: boolean };
  const isAdmin = tok.admin === true || (ADMIN_EMAILS.has(tok.email ?? "") && tok.email_verified === true);
  if (!isAdmin) throw new HttpsError("permission-denied", "Admins only.");
  const { toUid } = (req.data ?? {}) as { toUid?: string };
  if (!toUid) throw new HttpsError("invalid-argument", "Recipient required.");
  if (toUid === req.auth?.uid) throw new HttpsError("failed-precondition", "Refusing to delete the calling admin.");

  // Audit trail BEFORE the data is gone (so we always have a record of who killed what).
  const snap = await userRef(toUid).get();
  const toName = (snap.exists ? (snap.data()?.name as string | undefined) : undefined) ?? "user";
  await ledgerRef().doc().set({
    type: "admin-delete", currency: "", amount: 0, from: "admin",
    fromName: (req.auth?.token?.email as string) ?? "admin",
    to: toUid, toName, at: FieldValue.serverTimestamp(),
  });

  // Wipe inbox + presence + profile + Auth. NOTE: this does NOT reconcile per-table seats — an
  // admin should only delete a user who is not currently seated (have them leave first), else a
  // ghost seat reference + their staked chips are stranded at that table. (Tracked in the code
  // audit; a safe seat-reconcile needs the table schema + emulator testing, like leaveTable.)
  const wipeCollection = async (snapDocs: FirebaseFirestore.DocumentSnapshot[]): Promise<void> => {
    if (snapDocs.length === 0) return;
    const batch = db.batch();
    snapDocs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  };
  await wipeCollection((await inboxRef(toUid).limit(500).get()).docs);
  await db.doc(`presence/${toUid}`).delete().catch(() => { /* may not exist */ });

  // Profile doc itself.
  await userRef(toUid).delete().catch(() => { /* may not exist */ });

  // Finally, the Auth user (so the email can be re-registered). Best-effort: if Auth is
  // already gone or the project doesn't have the user, swallow the error so the rest of
  // the cleanup still counts as a success.
  try { await getAuth().deleteUser(toUid); } catch (_e) { /* already gone or unknown */ }

  return { ok: true };
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
