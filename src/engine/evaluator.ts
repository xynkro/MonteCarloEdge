import { type Card, rankOf, suitOf } from "./cards.js";

// Hand category ordinals. Higher = stronger.
export const CATEGORY = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  TRIPS: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  QUADS: 8,
  STRAIGHT_FLUSH: 9,
} as const;

export const CATEGORY_NAMES: Record<number, string> = {
  1: "High Card",
  2: "Pair",
  3: "Two Pair",
  4: "Three of a Kind",
  5: "Straight",
  6: "Flush",
  7: "Full House",
  8: "Four of a Kind",
  9: "Straight Flush",
};

// Pack rank into a single integer for comparison.
// Layout (high to low): category (4 bits) | k1 | k2 | k3 | k4 | k5  (4 bits each)
function packRank(category: number, kickers: readonly number[]): number {
  let r = category;
  for (let i = 0; i < 5; i++) {
    const k = i < kickers.length ? kickers[i]! : 0;
    r = (r << 4) | k;
  }
  return r;
}

export function categoryOf(packed: number): number {
  return packed >> 20;
}

// Returns the high card (rank) of the best straight in `ranksDescUnique`, or -1.
// `ranksDescUnique` must be sorted descending, no duplicates.
function topStraight(ranksDescUnique: readonly number[]): number {
  const n = ranksDescUnique.length;
  for (let i = 0; i <= n - 5; i++) {
    if (ranksDescUnique[i]! - ranksDescUnique[i + 4]! === 4) {
      return ranksDescUnique[i]!;
    }
  }
  // Wheel: A-2-3-4-5  (ranks 12, 3, 2, 1, 0)
  if (
    ranksDescUnique.includes(12) &&
    ranksDescUnique.includes(3) &&
    ranksDescUnique.includes(2) &&
    ranksDescUnique.includes(1) &&
    ranksDescUnique.includes(0)
  ) {
    return 3; // 5-high straight (top card is rank 3 = '5')
  }
  return -1;
}

// Evaluate any number of cards >= 5 (we use 5, 6, or 7).
// Returns a packed integer; higher is stronger.
export function evaluate(cards: readonly Card[]): number {
  if (cards.length < 5) {
    throw new Error(`evaluate needs >=5 cards, got ${cards.length}`);
  }

  const rankCounts = new Array<number>(13).fill(0);
  const suitCounts = new Array<number>(4).fill(0);
  const ranksBySuit: number[][] = [[], [], [], []];

  for (const c of cards) {
    const r = rankOf(c);
    const s = suitOf(c);
    rankCounts[r]!++;
    suitCounts[s]!++;
    ranksBySuit[s]!.push(r);
  }

  // Flush check
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s]! >= 5) {
      flushSuit = s;
      break;
    }
  }

  // Straight flush
  if (flushSuit >= 0) {
    const sr = [...new Set(ranksBySuit[flushSuit]!)].sort((a, b) => b - a);
    const top = topStraight(sr);
    if (top >= 0) return packRank(CATEGORY.STRAIGHT_FLUSH, [top]);
  }

  // Find rank groupings, walking high to low
  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const c = rankCounts[r]!;
    if (c === 4) quad = r;
    else if (c === 3) trips.push(r);
    else if (c === 2) pairs.push(r);
  }

  // Quads
  if (quad >= 0) {
    let kicker = 0;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && rankCounts[r]! > 0) { kicker = r; break; }
    }
    return packRank(CATEGORY.QUADS, [quad, kicker]);
  }

  // Full house — either trips+pair, or two sets of trips
  if (trips.length > 0) {
    const topTrip = trips[0]!;
    let pairRank = -1;
    if (trips.length > 1) pairRank = trips[1]!;
    if (pairs.length > 0 && pairs[0]! > pairRank) pairRank = pairs[0]!;
    if (pairRank >= 0) {
      return packRank(CATEGORY.FULL_HOUSE, [topTrip, pairRank]);
    }
  }

  // Flush
  if (flushSuit >= 0) {
    const top5 = [...new Set(ranksBySuit[flushSuit]!)].sort((a, b) => b - a).slice(0, 5);
    return packRank(CATEGORY.FLUSH, top5);
  }

  // Straight
  const allRanksDesc: number[] = [];
  for (let r = 12; r >= 0; r--) if (rankCounts[r]! > 0) allRanksDesc.push(r);
  const straightTop = topStraight(allRanksDesc);
  if (straightTop >= 0) return packRank(CATEGORY.STRAIGHT, [straightTop]);

  // Trips
  if (trips.length > 0) {
    const t = trips[0]!;
    const kickers: number[] = [];
    for (let r = 12; r >= 0 && kickers.length < 2; r--) {
      if (r !== t && rankCounts[r]! > 0) kickers.push(r);
    }
    return packRank(CATEGORY.TRIPS, [t, ...kickers]);
  }

  // Two pair
  if (pairs.length >= 2) {
    const p1 = pairs[0]!;
    const p2 = pairs[1]!;
    let kicker = 0;
    for (let r = 12; r >= 0; r--) {
      if (r !== p1 && r !== p2 && rankCounts[r]! > 0) { kicker = r; break; }
    }
    return packRank(CATEGORY.TWO_PAIR, [p1, p2, kicker]);
  }

  // One pair
  if (pairs.length === 1) {
    const p = pairs[0]!;
    const kickers: number[] = [];
    for (let r = 12; r >= 0 && kickers.length < 3; r--) {
      if (r !== p && rankCounts[r]! > 0) kickers.push(r);
    }
    return packRank(CATEGORY.PAIR, [p, ...kickers]);
  }

  // High card
  return packRank(CATEGORY.HIGH_CARD, allRanksDesc.slice(0, 5));
}
