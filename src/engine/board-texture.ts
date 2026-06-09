import { type Card, rankOf, suitOf } from "./cards.js";

export interface BoardTexture {
  paired: boolean;
  trips: boolean;
  monotone: boolean;
  flushDraw: boolean;
  straightDraw: boolean;
  highBoard: boolean;
  dry: boolean;
  wet: boolean;
  desc: string;
}

export function analyzeBoard(board: Card[]): BoardTexture {
  if (board.length === 0) {
    return { paired: false, trips: false, monotone: false, flushDraw: false,
      straightDraw: false, highBoard: false, dry: true, wet: false, desc: "preflop" };
  }

  const ranks = board.map(rankOf);
  const suits = board.map(suitOf);

  // Pair / trips detection
  const rankCounts = new Map<number, number>();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  const maxCount = Math.max(...rankCounts.values());
  const paired = maxCount >= 2;
  const trips = maxCount >= 3;

  // Suit analysis
  const suitCounts = new Map<number, number>();
  for (const s of suits) suitCounts.set(s, (suitCounts.get(s) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const monotone = maxSuit >= 3 && board.length >= 3;
  const flushDraw = maxSuit >= 2 && !monotone;

  // Connectivity — how many cards within a 5-rank window?
  const sorted = [...new Set(ranks)].sort((a, b) => a - b);
  let maxConnected = 1;
  for (let i = 0; i < sorted.length; i++) {
    let count = 1;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]! - sorted[i]! <= 4) count++;
      else break;
    }
    maxConnected = Math.max(maxConnected, count);
  }
  // Also check A-2-3-4-5 wheel draw
  if (sorted.includes(12) && sorted.includes(0)) {
    const low = sorted.filter(r => r <= 3 || r === 12);
    maxConnected = Math.max(maxConnected, low.length);
  }
  const straightDraw = maxConnected >= 3;

  // High board: 2+ cards T(rank 8) or higher
  const highCards = ranks.filter(r => r >= 8).length;
  const highBoard = highCards >= 2;

  // Dry vs wet classification
  const wet = (flushDraw || monotone) && straightDraw;
  const dry = !paired && !flushDraw && !monotone && !straightDraw;

  // Build description
  const parts: string[] = [];
  if (monotone) parts.push("monotone");
  else if (flushDraw) parts.push("two-tone");
  else if (board.length >= 3) parts.push("rainbow");
  if (straightDraw) parts.push("connected");
  if (paired) parts.push(trips ? "trips on board" : "paired");
  if (highBoard) parts.push("high");
  else parts.push("low");
  if (wet) parts.push("(wet)");
  else if (dry) parts.push("(dry)");

  return {
    paired, trips, monotone, flushDraw, straightDraw,
    highBoard, dry, wet,
    desc: parts.join(", "),
  };
}

// How does hero connect to this board texture?
export function heroConnection(
  heroCards: readonly [Card, Card],
  board: Card[],
): { hasFlushDraw: boolean; hasStraightDraw: boolean; hasOverpair: boolean; hasPair: boolean } {
  if (board.length === 0) return { hasFlushDraw: false, hasStraightDraw: false, hasOverpair: false, hasPair: false };

  const hr = [rankOf(heroCards[0]), rankOf(heroCards[1])];
  const hs = [suitOf(heroCards[0]), suitOf(heroCards[1])];
  const boardRanks = board.map(rankOf);
  const boardSuits = board.map(suitOf);
  const maxBoardRank = Math.max(...boardRanks);

  // Flush draw: hero has 2 of same suit, and board has 2+ of that suit (4 to a flush)
  const samesuit = hs[0] === hs[1];
  const suitCounts = new Map<number, number>();
  for (const s of boardSuits) suitCounts.set(s, (suitCounts.get(s) ?? 0) + 1);
  const hasFlushDraw = samesuit && (suitCounts.get(hs[0]!) ?? 0) >= 2;

  // Straight draw: simplified — hero + board have 4 cards within 5 ranks
  const allRanks = [...new Set([...hr, ...boardRanks])].sort((a, b) => a - b);
  let maxWindow = 0;
  for (let i = 0; i < allRanks.length; i++) {
    let count = 0;
    for (let j = i; j < allRanks.length; j++) {
      if (allRanks[j]! - allRanks[i]! <= 4) count++;
    }
    maxWindow = Math.max(maxWindow, count);
  }
  const hasStraightDraw = maxWindow >= 4 && !boardRanks.includes(hr[0]!) && !boardRanks.includes(hr[1]!);

  // Pair / overpair
  const hasPair = boardRanks.includes(hr[0]!) || boardRanks.includes(hr[1]!);
  const isPocket = hr[0] === hr[1];
  const hasOverpair = isPocket && hr[0]! > maxBoardRank;

  return { hasFlushDraw, hasStraightDraw, hasOverpair, hasPair };
}

// ── Exact draw outs (replaces hardcoded draw odds) ──
function hasFlush5(cards: Card[]): boolean {
  const c = [0, 0, 0, 0];
  for (const card of cards) c[suitOf(card)]++;
  return c.some((n) => n >= 5);
}
function hasStraight5(cards: Card[]): boolean {
  const r = new Set(cards.map(rankOf));
  const inSet = (x: number) => (x === -1 ? r.has(12) : r.has(x)); // ace plays low for the wheel
  for (let hi = 3; hi <= 12; hi++) { // 5-high (A2345) up to A-high
    let ok = true;
    for (let k = 0; k < 5; k++) { if (!inSet(hi - k)) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
/** EXACT count of unseen cards that complete a flush or straight on the next card
 *  (flop or turn only). Handles gutshot (4) vs OESD (8) vs flush (9) vs combo (15)
 *  precisely, and accounts for hero/board blockers — no hardcoded approximations. */
export function drawOuts(hero: readonly [Card, Card], board: Card[]): number {
  if (board.length < 3 || board.length > 4) return 0; // flop or turn only
  const base: Card[] = [hero[0], hero[1], ...board];
  const haveFl = hasFlush5(base), haveStr = hasStraight5(base);
  if (haveFl && haveStr) return 0; // already made; not a draw
  const seen = new Set(base);
  let outs = 0;
  for (let c = 0; c < 52; c++) {
    if (seen.has(c)) continue;
    const withC = [...base, c];
    if ((hasFlush5(withC) && !haveFl) || (hasStraight5(withC) && !haveStr)) outs++;
  }
  return outs;
}
/** Exact probability of hitting ≥1 of `outs` by the river, given the board length
 *  (2 cards to come on the flop, 1 on the turn). The real formula, not the 2/4 rule. */
export function drawHitProb(outs: number, boardLen: number): number {
  const unseen = 50 - boardLen; // 52 − 2 hero − board
  const toCome = 5 - boardLen;
  if (outs <= 0 || unseen <= 0) return 0;
  if (toCome <= 1) return Math.min(1, outs / unseen);
  const miss = ((unseen - outs) / unseen) * ((unseen - outs - 1) / (unseen - 1));
  return 1 - miss;
}
