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

const PROFILES: Record<string, OpponentProfile> = { Auto: AUTO, TAG, LAG, Station: STATION, Nit: NIT };
const TURN_SECONDS = 40;
const DEFAULT_CHIPS = 1_000; // ~$9.90 of value at the ~100 chips/$ ratio
const TIERS: Record<string, { sb: number; bb: number; max: number }> = {
  Micro: { sb: 5, bb: 10, max: 1_000 },
  Mid: { sb: 50, bb: 100, max: 10_000 },
  High: { sb: 500, bb: 1_000, max: 100_000 },
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

function newCode(): string {
  const A = "ACDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/B/8
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(cryptoRng() * A.length)];
  return `MCE-${s}`;
}

interface StateDoc { snap: AuthTableSnapshot; version: number; baseline: number }

async function loadState(tx: Transaction, code: string): Promise<{ t: AuthTable; version: number; baseline: number }> {
  const snap = await tx.get(stateRef(code));
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");
  const d = snap.data() as StateDoc;
  return { t: deserializeAuthTable(d.snap), version: d.version, baseline: d.baseline };
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
function persist(tx: Transaction, code: string, t: AuthTable, version: number, baseline: number, settled = false): void {
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

  tx.set(stateRef(code), { snap: serializeAuthTable(t), version, baseline } satisfies StateDoc);
  tx.set(tableRef(code), {
    ...pub, version, deadlineMs, revealedHoles, updatedAt: FieldValue.serverTimestamp(),
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
  const { tier = "Micro", buyIn, name = "Player", bots = [] } = (req.data ?? {}) as
    { tier?: string; buyIn?: number; name?: string; bots?: string[] };
  const T = TIERS[tier] ?? TIERS.Micro!;
  const stack = Math.max(20 * T.bb, Math.min(T.max, Math.round(buyIn ?? T.max)));
  const seats = 2 + Math.min(7, bots.length); // owner + bots (+ room to join)

  return db.runTransaction(async (tx) => {
    const u = await tx.get(userRef(uid));
    const chips = u.exists ? ((u.data()!.chips as number) ?? DEFAULT_CHIPS) : DEFAULT_CHIPS;
    if (chips < stack) throw new HttpsError("failed-precondition", "Not enough chips for that buy-in.");

    let code = newCode();
    // (collision check; codes are sparse so one retry is plenty)
    if ((await tx.get(stateRef(code))).exists) code = newCode();

    const t = createAuthTable(code, { uid, name }, { name: `${tier} Room`, blinds: { sb: T.sb, bb: T.bb }, startingStack: stack, maxSeats: Math.max(seats, 2) });
    bots.slice(0, 7).forEach((arch, i) => seatAi(t, i + 1, `Bot ${i + 1}`, PROFILES[arch] ? arch : "TAG"));

    tx.set(userRef(uid), { name, chips: chips - stack }, { merge: true });
    persist(tx, code, t, 1, 0);
    return { code };
  });
});

/** Join an existing room (by code). Debits buy-in from the joiner's wallet. */
export const joinTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { code, name = "Player" } = (req.data ?? {}) as { code?: string; name?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version } = await loadState(tx, code);
    if (t.seats.some((s) => s.uid === uid)) return { code, already: true }; // idempotent
    const seatIdx = t.seats.findIndex((s) => !s.uid && !s.ai);
    if (seatIdx < 0) throw new HttpsError("failed-precondition", "Room is full.");
    const u = await tx.get(userRef(uid));
    const chips = u.exists ? ((u.data()!.chips as number) ?? DEFAULT_CHIPS) : DEFAULT_CHIPS;
    if (chips < t.startingStack) throw new HttpsError("failed-precondition", "Not enough chips to buy in.");
    sit(t, uid, name, seatIdx);
    tx.set(userRef(uid), { name, chips: chips - t.startingStack }, { merge: true });
    persist(tx, code, t, version + 1, 0);
    return { code, seatIdx };
  });
});

/** Owner deals the next hand. */
export const startHand = onCall(async (req) => {
  const uid = uidOf(req);
  const { code } = (req.data ?? {}) as { code?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version } = await loadState(tx, code);
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
    persist(tx, code, t, version + 1, baseline, true);
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
    const { t, version, baseline } = await loadState(tx, code);
    if (typeof expectedVersion === "number" && expectedVersion !== version) {
      throw new HttpsError("aborted", "stale"); // client retries with fresh snapshot
    }
    const r = engineAct(t, uid, action); // validates turn (from uid) + legality + min-raise
    if (!r.ok) throw new HttpsError("failed-precondition", r.err ?? "illegal action");
    runBots(t); // resolve any bots up to the next human / hand end
    persist(tx, code, t, version + 1, baseline, true);
    return { ok: true };
  });
});

/** Leave the table — bank your remaining stack back to your wallet. */
export const leaveTable = onCall(async (req) => {
  const uid = uidOf(req);
  const { code } = (req.data ?? {}) as { code?: string };
  if (!code) throw new HttpsError("invalid-argument", "Room code required.");
  return db.runTransaction(async (tx) => {
    const { t, version, baseline } = await loadState(tx, code);
    const seat = t.seats.find((s) => s.uid === uid);
    if (!seat) return { ok: true };
    if (t.status === "in_hand" && t.liveSeats.includes(t.seats.indexOf(seat))) {
      throw new HttpsError("failed-precondition", "Finish the hand before leaving.");
    }
    const back = seat.chips;
    const u = await tx.get(userRef(uid));
    const chips = u.exists ? ((u.data()!.chips as number) ?? 0) : 0;
    leave(t, uid);
    tx.set(userRef(uid), { chips: chips + back }, { merge: true });
    persist(tx, code, t, version + 1, baseline);
    return { ok: true, banked: back };
  });
});
