// Authoritative multiplayer table engine.
//
// Runs ONLY on the authority (the host tab locally; a Cloud Function in prod).
// It holds the deck and every player's hole cards and chip balances — none of
// which ever go to a client except each player's own two cards. Clients receive
// PublicTableState (no holes) + their own PrivateHand. This is the security model
// the whole product depends on, implemented once here.
//
// Reuses the proven engine: GameState for betting/legality/street logic and the
// evaluator for showdown — the same code path the single-player trainer and the
// self-play backtest already trust.

import { type Card, NUM_CARDS } from "../engine/cards.js";
import { type Rng } from "../engine/rng.js";
import { evaluate } from "../engine/evaluator.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { positionsForButton } from "../engine/charts/index.js";
import type {
  PublicTableState, PrivateHand, MPSeat, MPAction, CreateTableOpts,
} from "./types.js";

export interface AuthSeat {
  uid: string | null;
  name: string;
  chips: number;          // stack at the table (play-money; never cashable)
  assisted: boolean;      // admin-set: does this seat get the strategy tool?
  sittingOut: boolean;
  ai: string | null;      // bot archetype (e.g. "TAG") if this is an AI seat; null = human/empty
}

export interface AuthTable {
  id: string;
  ownerUid: string;
  name: string;
  blinds: { sb: number; bb: number };
  startingStack: number;
  maxSeats: number;
  seats: AuthSeat[];
  buttonSeat: number;             // table-seat index of the dealer button
  status: "waiting" | "in_hand" | "hand_over";
  handId: string | null;
  handCount: number;
  lastResult: string;
  lastWinners?: number[]; // table-seat indices that won the last hand (for the client share/animation)
  lastPot?: number;       // size of the pot just won
  // Live hand (authority-only):
  gs: GameState | null;           // betting state over the LIVE seats
  liveSeats: number[];            // table-seat indices in this hand (gs idx → table idx)
  holes: Map<number, [Card, Card]>; // table-seat idx → hole cards (SECRET)
  fullBoard: Card[];              // the 5 board cards drawn for this hand (authority-only)
}

function shuffle(rng: Rng): Card[] {
  const d: Card[] = Array.from({ length: NUM_CARDS }, (_, i) => i);
  for (let i = NUM_CARDS - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}
const ordered = (a: Card, b: Card): [Card, Card] => (a <= b ? [a, b] : [b, a]);

export function createAuthTable(id: string, owner: { uid: string; name: string }, opts: CreateTableOpts): AuthTable {
  const seats: AuthSeat[] = Array.from({ length: opts.maxSeats }, () => ({
    uid: null, name: "", chips: 0, assisted: false, sittingOut: false, ai: null,
  }));
  seats[0] = { uid: owner.uid, name: owner.name, chips: opts.startingStack, assisted: true, sittingOut: false, ai: null };
  return {
    id, ownerUid: owner.uid, name: opts.name, blinds: opts.blinds,
    startingStack: opts.startingStack, maxSeats: opts.maxSeats, seats,
    buttonSeat: 0, status: "waiting", handId: null, handCount: 0, lastResult: "",
    gs: null, liveSeats: [], holes: new Map(), fullBoard: [],
  };
}

export function sit(t: AuthTable, uid: string, name: string, seatIdx: number): boolean {
  if (seatIdx < 0 || seatIdx >= t.seats.length) return false;
  if (t.seats.some((s) => s.uid === uid)) return false; // already seated
  const s = t.seats[seatIdx]!;
  if (s.uid || s.ai) return false; // taken
  s.uid = uid; s.name = name; s.chips = t.startingStack; s.assisted = false; s.sittingOut = false; s.ai = null;
  return true;
}

/** Seat a bot (no uid; identified by archetype). House chips, never a user wallet. */
export function seatAi(t: AuthTable, seatIdx: number, name: string, archetype: string): boolean {
  if (seatIdx < 0 || seatIdx >= t.seats.length) return false;
  const s = t.seats[seatIdx]!;
  if (s.uid || s.ai) return false; // taken
  s.uid = null; s.name = name; s.chips = t.startingStack; s.assisted = false; s.sittingOut = false; s.ai = archetype;
  return true;
}

export function leave(t: AuthTable, uid: string): void {
  const i = t.seats.findIndex((s) => s.uid === uid);
  if (i >= 0) t.seats[i] = { uid: null, name: "", chips: 0, assisted: false, sittingOut: false, ai: null };
}

export function setAssisted(t: AuthTable, requesterUid: string, seatIdx: number, assisted: boolean): boolean {
  if (requesterUid !== t.ownerUid) return false; // admin only
  const s = t.seats[seatIdx];
  if (!s || !s.uid) return false;
  s.assisted = assisted;
  return true;
}

/** Seats eligible to be dealt in: occupied (human OR bot), with chips, not sitting out. */
function eligible(t: AuthTable): number[] {
  return t.seats.map((s, i) => ((s.uid || s.ai) && s.chips > 0 && !s.sittingOut ? i : -1)).filter((i) => i >= 0);
}

export function startHand(t: AuthTable, rng: Rng): boolean {
  const live = eligible(t);
  if (live.length < 2) return false;
  // Rotate the button to the next eligible seat.
  let b = t.buttonSeat;
  for (let k = 1; k <= t.seats.length; k++) {
    const cand = (t.buttonSeat + k) % t.seats.length;
    if (live.includes(cand)) { b = cand; break; }
  }
  t.buttonSeat = b;
  // Order the live seats starting left of the button so gs indices read naturally.
  const ordd = [...live].sort((x, y) => x - y);
  const liveSeats = ordd; // gs seat i ↔ table seat liveSeats[i]
  const n = liveSeats.length;
  const gsButton = liveSeats.indexOf(b);

  const deck = shuffle(rng);
  let d = 0;
  t.holes = new Map();
  for (const ts of liveSeats) t.holes.set(ts, ordered(deck[d++]!, deck[d++]!));
  t.fullBoard = [deck[d++]!, deck[d++]!, deck[d++]!, deck[d++]!, deck[d++]!];

  const buttonHole = t.holes.get(b)!;
  t.gs = new GameState({
    tableSize: n,
    bb: t.blinds.bb,
    stacks: liveSeats.map((ts) => t.seats[ts]!.chips),
    positions: positionsForButton(n, gsButton), // labels ROTATE with the button (else recommend reads the wrong position)
    heroSeat: gsButton,          // metadata only (recommend perspective is set per-seat)
    heroCards: buttonHole,
    dealerSeat: gsButton,
  });
  t.liveSeats = liveSeats;
  t.handCount++;
  t.handId = `${t.id}-h${t.handCount}`;
  t.status = "in_hand";
  t.lastResult = ""; t.lastWinners = []; t.lastPot = 0;
  return true;
}

const tableToGs = (t: AuthTable, tableSeat: number): number => t.liveSeats.indexOf(tableSeat);
const gsToTable = (t: AuthTable, gsSeat: number): number => t.liveSeats[gsSeat]!;
/** gs-seat index for a table seat (-1 if not in the live hand). Lets the UI build
 *  an AI decision for that seat via villainDecision (AI is a local-only feature). */
export const toGsSeat = (t: AuthTable, tableSeat: number): number => tableToGs(t, tableSeat);

/** Whose table-seat is to act, or -1. */
export function toActTableSeat(t: AuthTable): number {
  if (!t.gs || t.status !== "in_hand") return -1;
  const g = t.gs.nextToAct();
  return g === null ? -1 : gsToTable(t, g);
}

/** Apply a HUMAN player's action (validates it's their turn + legal). */
export function act(t: AuthTable, uid: string, action: MPAction): { ok: boolean; err?: string } {
  const tableSeat = t.seats.findIndex((s) => s.uid === uid);
  if (tableSeat < 0) return { ok: false, err: "not seated" };
  return actSeat(t, tableSeat, action);
}

/** Apply an action for a specific table seat (used by act() and the server AI loop).
 *  Enforces turn order, legality, and min-bet/min-raise. */
export function actSeat(t: AuthTable, tableSeat: number, action: MPAction): { ok: boolean; err?: string } {
  if (!t.gs || t.status !== "in_hand") return { ok: false, err: "no hand in progress" };
  const g = tableToGs(t, tableSeat);
  if (g < 0) return { ok: false, err: "not in this hand" };
  if (t.gs.nextToAct() !== g) return { ok: false, err: "not your turn" };
  const legal = t.gs.legalActionsFor(g);
  const type = action.type as ActionType;
  let amount = action.amount ?? 0;
  if (!legal.includes(type)) return { ok: false, err: `illegal: ${type}` };
  if (type !== "bet" && type !== "raise") {
    amount = 0;
  } else {
    // Min-bet / min-raise enforcement: must meet the minimum OR be all-in.
    const allInTo = t.gs.stacks[g]! + t.gs.streetInvested[g]!;
    const minTo = type === "bet" ? t.gs.bb : t.gs.minRaiseTo();
    if (amount > allInTo) amount = allInTo;          // cap to all-in
    if (amount < minTo && amount < allInTo) return { ok: false, err: `below min ${type} (${minTo})` };
  }
  t.gs.applyAction({ seat: g, type, amount });
  advance(t);
  return { ok: true };
}

/** Drive street transitions / end-of-hand on the authority after each action. */
function advance(t: AuthTable): void {
  const gs = t.gs!;
  let guard = 0;
  while (!gs.isComplete() && gs.roundComplete() && gs.street !== "river" && guard++ < 4) {
    // Everyone all-in? run it out; else deal the next street from the held board.
    const liveStacks = t.liveSeats.map((ts, i) => ({ i, chips: gs.stacks[i]! }));
    const stillBetting = liveStacks.filter((s) => !gs.folded[s.i] && s.chips > 0).length;
    const next = dealNext(gs, t.fullBoard);
    gs.advanceStreet(next);
    if (stillBetting <= 1) { /* all-in: keep dealing remaining streets */ }
  }
  if (gs.isComplete() || gs.nextToAct() === null) settle(t);
}

function dealNext(gs: GameState, board: Card[]): Card[] {
  switch (gs.street) {
    case "preflop": return [board[0]!, board[1]!, board[2]!];
    case "flop": return [board[3]!];
    case "turn": return [board[4]!];
    default: return [];
  }
}

/** Showdown + award (layered side pots so chips are conserved), then bank chips. */
function settle(t: AuthTable): void {
  const gs = t.gs!;
  const n = t.liveSeats.length;
  // Run the board out to 5 if the hand ended all-in pre-river.
  const board = gs.board.length >= 5 ? gs.board.slice(0, 5) : t.fullBoard.slice(0, 5);

  const invested = Array.from({ length: n }, (_, i) => gs.invested[i]!);
  const folded = Array.from({ length: n }, (_, i) => gs.folded[i]!);
  const won = new Array<number>(n).fill(0);

  const contenders = folded.map((f, i) => (!f ? i : -1)).filter((i) => i >= 0);
  if (contenders.length === 1) {
    // Everyone else folded — the last player wins the whole pot.
    won[contenders[0]!] = invested.reduce((a, b) => a + b, 0);
    t.lastResult = `${t.seats[gsToTable(t, contenders[0]!)]!.name} won (all folded)`;
  } else {
    // Hand strengths for non-folded seats.
    const rank = new Array<number>(n).fill(-1);
    for (const i of contenders) {
      const h = t.holes.get(gsToTable(t, i))!;
      rank[i] = evaluate([h[0], h[1], ...board]);
    }
    // Layered side pots from distinct invested levels.
    const levels = [...new Set(invested.filter((x) => x > 0))].sort((a, b) => a - b);
    let prev = 0;
    for (const lvl of levels) {
      let layer = 0;
      for (let i = 0; i < n; i++) layer += Math.min(invested[i]!, lvl) - Math.min(invested[i]!, prev);
      const eligibleWinners = contenders.filter((i) => invested[i]! >= lvl);
      if (eligibleWinners.length > 0) {
        const best = Math.max(...eligibleWinners.map((i) => rank[i]!));
        const winners = eligibleWinners.filter((i) => rank[i]! === best);
        // Integer-exact split: floor share + odd chips to the first winners by
        // seat order (deterministic), so sum(awarded) === layer to the chip.
        const k = winners.length;
        const base = Math.floor(layer / k);
        let odd = layer - base * k;
        for (const w of [...winners].sort((a, b) => a - b)) {
          won[w] += base + (odd > 0 ? 1 : 0);
          if (odd > 0) odd--;
        }
      }
      prev = lvl;
    }
    const top = contenders.reduce((a, b) => (rank[b]! > rank[a]! ? b : a), contenders[0]!);
    t.lastResult = `${t.seats[gsToTable(t, top)]!.name} won the showdown`;
  }

  // Bank net results back to table chip stacks.
  for (let i = 0; i < n; i++) {
    const ts = gsToTable(t, i);
    t.seats[ts]!.chips = t.seats[ts]!.chips - invested[i]! + won[i]!;
  }
  // Record winners (table seats) + pot so the client can show the share/animation without
  // having to diff snapshots (instant fold-outs jump waiting→hand_over with no in_hand frame).
  t.lastWinners = won.map((w, i) => (w > 0 ? gsToTable(t, i) : -1)).filter((i) => i >= 0);
  t.lastPot = invested.reduce((a, b) => a + b, 0);
  t.status = "hand_over";
}

// ── Projections to the client (NO secrets) ──
export function publicState(t: AuthTable): PublicTableState {
  const gs = t.gs;
  const seats: MPSeat[] = t.seats.map((s, ts) => {
    // Only project the live engine stacks DURING a hand. At hand_over the hand has been
    // settle()d — the pot is already banked into s.chips — so show those settled totals
    // (else the winner's stack looks unchanged until the next deal, and the pot→winner
    // animation finds no chip delta).
    const g = t.status === "in_hand" ? tableToGs(t, ts) : -1;
    const inHand = g >= 0 && gs != null;
    return {
      uid: s.uid, name: s.name, ai: s.ai,
      chips: inHand ? gs!.stacks[g]! : s.chips, // stack BEHIND (the bet is separate, in the pot)
      bet: inHand ? gs!.streetInvested[g]! : 0,
      folded: inHand ? gs!.folded[g]! : false,
      sittingOut: !!s.uid && s.chips <= 0,
      assisted: s.assisted,
    };
  });
  return {
    id: t.id, ownerUid: t.ownerUid, name: t.name, blinds: t.blinds, status: t.status,
    seats, dealerSeat: t.buttonSeat,
    street: gs ? (gs.street as PublicTableState["street"]) : "preflop",
    board: gs ? gs.board.slice() : [],
    pot: t.status === "in_hand" && gs ? gs.pot : 0, // pot is distributed at hand_over
    toAct: toActTableSeat(t),
    currentBet: t.status === "in_hand" && gs ? gs.currentBet : 0,
    handId: t.handId,
    lastResult: t.lastResult,
    lastWinners: t.status === "hand_over" ? (t.lastWinners ?? []) : [],
    lastPot: t.status === "hand_over" ? (t.lastPot ?? 0) : 0,
  };
}

/** The strategy recommendation for a seat (only used when that seat is "assisted").
 * Builds a hero-perspective clone (its own hole cards) — mirrors villain-ai's flip. */
export function recommendForSeat(
  t: AuthTable,
  tableSeat: number,
  recommend: typeof import("../engine/decision.js").recommend,
  profile: import("../engine/opponent.js").OpponentProfile,
) {
  if (!t.gs || t.status !== "in_hand") return null;
  const g = tableToGs(t, tableSeat);
  if (g < 0) return null;
  const holes = t.holes.get(tableSeat);
  if (!holes) return null;
  const ps = t.gs.clone() as unknown as { heroSeat: number; heroCards: [Card, Card] };
  ps.heroSeat = g;
  ps.heroCards = holes;
  return recommend(ps as unknown as GameState, profile);
}

/** A single player's own hole cards — the ONLY secret a client ever receives. */
export function privateHandFor(t: AuthTable, uid: string): PrivateHand {
  const ts = t.seats.findIndex((s) => s.uid === uid);
  const holes = ts >= 0 ? t.holes.get(ts) ?? null : null;
  return { handId: t.handId ?? "", holeCards: t.status !== "waiting" ? holes : null };
}
