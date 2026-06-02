import { type Card, rankOf, suitOf, RANK_CHARS, NUM_CARDS } from "./cards.js";
import { evaluate, categoryOf, CATEGORY } from "./evaluator.js";

export interface HandDescription {
  category: number; // 1-9 from CATEGORY
  label: string; // human-readable made hand: "Top Pair", "Set", "Flush"
  draws: string[]; // ["Flush draw", "Open-ended straight draw"]
  strong: boolean; // two pair or better, or a strong draw (FD / OESD)
}

const RANK_WORD = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
// Plural rank names ("Six" → "Sixes", not "Sixs").
const RANK_PLURAL = ["Twos", "Threes", "Fours", "Fives", "Sixes", "Sevens",
  "Eights", "Nines", "Tens", "Jacks", "Queens", "Kings", "Aces"];
const plur = (r: number): string => RANK_PLURAL[r]!;

// Does this set of ranks contain 5 consecutive (incl. wheel A-5)?
function hasStraight(ranks: Set<number>): boolean {
  for (let hi = 12; hi >= 4; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) if (!ranks.has(hi - k)) { ok = false; break; }
    if (ok) return true;
  }
  // wheel: A,2,3,4,5
  if (ranks.has(12) && ranks.has(0) && ranks.has(1) && ranks.has(2) && ranks.has(3)) return true;
  return false;
}

// Classify straight draw using hole + board ranks. Returns "oesd" | "gutshot" | null.
function straightDraw(holeRanks: number[], boardRanks: number[]): "oesd" | "gutshot" | null {
  const all = new Set<number>([...holeRanks, ...boardRanks]);
  if (hasStraight(all)) return null; // already made

  // Count completing ranks where the completed straight includes a hole card.
  const completing: number[] = [];
  for (let r = 0; r <= 12; r++) {
    if (all.has(r)) continue;
    const test = new Set(all);
    test.add(r);
    if (!hasStraight(test)) continue;
    // Verify a hole rank participates in some 5-window containing r.
    let participates = false;
    for (let hi = Math.min(12, r + 4); hi >= Math.max(4, r); hi--) {
      const window = [hi, hi - 1, hi - 2, hi - 3, hi - 4];
      if (!window.includes(r)) continue;
      if (window.every((w) => test.has(w)) && window.some((w) => holeRanks.includes(w))) {
        participates = true; break;
      }
    }
    // wheel window
    if (!participates) {
      const wheel = [12, 0, 1, 2, 3];
      if (wheel.includes(r) && wheel.every((w) => test.has(w)) &&
          wheel.some((w) => holeRanks.includes(w))) participates = true;
    }
    if (participates) completing.push(r);
  }

  if (completing.length >= 2) return "oesd";
  if (completing.length === 1) return "gutshot";
  return null;
}

// The best possible hand any two hole cards can make on this board ("the nuts"),
// plus every 2-card combo that makes it (for "chance someone holds it").
export function nutHand(
  board: readonly Card[],
  dead: readonly Card[] = [],
): { label: string; combos: [Card, Card][]; second: string | null; secondCombo: [Card, Card] | null } | null {
  if (board.length < 3) return null;
  const used = new Uint8Array(NUM_CARDS);
  for (const c of board) used[c] = 1;
  for (const c of dead) used[c] = 1;
  let best = -1;
  for (let a = 0; a < NUM_CARDS; a++) {
    if (used[a]) continue;
    for (let b = a + 1; b < NUM_CARDS; b++) {
      if (used[b]) continue;
      const r = evaluate([a, b, ...board]);
      if (r > best) best = r;
    }
  }
  // Collect all combos achieving the top rank, and track the best rank strictly
  // below it (the "second nuts") with a representative combo for its label.
  const combos: [Card, Card][] = [];
  let secondRank = -1;
  let secondCombo: [Card, Card] | null = null;
  for (let a = 0; a < NUM_CARDS; a++) {
    if (used[a]) continue;
    for (let b = a + 1; b < NUM_CARDS; b++) {
      if (used[b]) continue;
      const r = evaluate([a, b, ...board]);
      if (r === best) combos.push([a, b]);
      else if (r > secondRank) { secondRank = r; secondCombo = [a, b]; }
    }
  }
  if (combos.length === 0) return null;
  const second = secondCombo ? nutLabel(secondCombo, board) : null;
  return { label: nutLabel(combos[0]!, board), combos, second, secondCombo };
}

// A concise, specific label for a made hand — names the rank so the nuts and
// the second nuts are distinguishable ("Three Aces" vs "Three Eights").
export function nutLabel(combo: readonly [Card, Card], board: readonly Card[]): string {
  const cards = [combo[0], combo[1], ...board];
  const cat = categoryOf(evaluate(cards));
  const counts = new Array<number>(13).fill(0);
  for (const c of cards) counts[rankOf(c)]!++;
  const atLeast = (n: number): number[] => {
    const out: number[] = [];
    for (let r = 12; r >= 0; r--) if (counts[r]! >= n) out.push(r);
    return out;
  };
  const present = new Set(cards.map(rankOf));
  const straightTop = (): number => {
    for (let hi = 12; hi >= 4; hi--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!present.has(hi - k)) { ok = false; break; }
      if (ok) return hi;
    }
    return present.has(12) && [0, 1, 2, 3].every((r) => present.has(r)) ? 3 : -1; // wheel → 5-high
  };
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH: {
      const t = straightTop();
      return t >= 0 ? `${RANK_WORD[t]}-high straight flush` : "Straight flush";
    }
    case CATEGORY.QUADS: return `Quad ${plur(atLeast(4)[0]!)}`;
    case CATEGORY.FULL_HOUSE: {
      const trip = atLeast(3)[0]!;
      const pair = atLeast(2).find((r) => r !== trip);
      return pair !== undefined ? `${plur(trip)} full of ${plur(pair)}` : `${plur(trip)} full`;
    }
    case CATEGORY.FLUSH: {
      const suitCount = new Array<number>(4).fill(0);
      for (const c of cards) suitCount[suitOf(c)]!++;
      let fs = -1;
      for (let s = 0; s < 4; s++) if (suitCount[s]! >= 5) fs = s;
      let hi = -1;
      for (const c of cards) if (suitOf(c) === fs) hi = Math.max(hi, rankOf(c));
      return `${RANK_WORD[hi]}-high flush`;
    }
    case CATEGORY.STRAIGHT: {
      const t = straightTop();
      return t >= 0 ? `${RANK_WORD[t]}-high straight` : "Straight";
    }
    case CATEGORY.TRIPS: return `Three ${plur(atLeast(3)[0]!)}`;
    case CATEGORY.TWO_PAIR: {
      const ps = atLeast(2);
      return `${plur(ps[0]!)} & ${plur(ps[1]!)}`;
    }
    case CATEGORY.PAIR: return `Pair of ${plur(atLeast(2)[0]!)}`;
    default: {
      let hi = -1;
      for (const c of cards) hi = Math.max(hi, rankOf(c));
      return `${RANK_WORD[hi]} high`;
    }
  }
}

// Plain-English category names for "what beats you".
const THREAT_NAME: Record<number, string> = {
  [CATEGORY.STRAIGHT_FLUSH]: "Straight flush",
  [CATEGORY.QUADS]: "Quads",
  [CATEGORY.FULL_HOUSE]: "Full house",
  [CATEGORY.FLUSH]: "Flush",
  [CATEGORY.STRAIGHT]: "Straight",
  [CATEGORY.TRIPS]: "Trips / set",
  [CATEGORY.TWO_PAIR]: "Two pair",
  [CATEGORY.PAIR]: "Pair",
  [CATEGORY.HIGH_CARD]: "High card",
};

export interface Threat {
  label: string; // "Flush", "Higher two pair", "Set / trips"
  category: number;
  combos: number; // how many 2-card holdings make this and beat hero
}

// Every two-card holding an opponent could have that BEATS hero's current hand
// on this board, grouped into plain-English threats and ranked strongest-first.
// Card-removal aware (excludes hero's cards, the board, and any dead cards).
// `total` = all possible villain holdings; `beating` = how many of them beat hero.
export function handsThatBeat(
  hero: readonly [Card, Card],
  board: readonly Card[],
  dead: readonly Card[] = [],
): { threats: Threat[]; total: number; beating: number } {
  if (board.length < 3) return { threats: [], total: 0, beating: 0 };
  const heroRank = evaluate([hero[0], hero[1], ...board]);
  const heroCat = categoryOf(heroRank);
  const used = new Uint8Array(NUM_CARDS);
  used[hero[0]] = 1;
  used[hero[1]] = 1;
  for (const c of board) used[c] = 1;
  for (const c of dead) used[c] = 1;

  const groups = new Map<number, { combos: number; bestRank: number }>();
  let total = 0;
  let beating = 0;
  for (let a = 0; a < NUM_CARDS; a++) {
    if (used[a]) continue;
    for (let b = a + 1; b < NUM_CARDS; b++) {
      if (used[b]) continue;
      total++;
      const r = evaluate([a, b, ...board]);
      if (r <= heroRank) continue; // ties chop, not beat
      beating++;
      const cat = categoryOf(r);
      const g = groups.get(cat) ?? { combos: 0, bestRank: r };
      g.combos++;
      if (r > g.bestRank) g.bestRank = r;
      groups.set(cat, g);
    }
  }

  const threats: Threat[] = [...groups.entries()]
    .map(([cat, g]) => ({
      // A threat in the SAME category as hero is a bigger version of his hand.
      label: cat === heroCat ? `Higher ${THREAT_NAME[cat]!.toLowerCase()}` : THREAT_NAME[cat]!,
      category: cat,
      combos: g.combos,
    }))
    // Most-likely threat first (by number of combos), tie-break to the stronger
    // hand — so "the main way you're beaten" leads the list.
    .sort((x, y) => y.combos - x.combos || y.category - x.category);

  return { threats, total, beating };
}

export function describeHand(
  hero: readonly [Card, Card],
  board: readonly Card[],
): HandDescription {
  const holeRanks = [rankOf(hero[0]), rankOf(hero[1])];
  const boardRanks = board.map(rankOf);

  if (board.length === 0) {
    // Preflop: describe the starting hand.
    const hi = Math.max(holeRanks[0]!, holeRanks[1]!);
    const lo = Math.min(holeRanks[0]!, holeRanks[1]!);
    const suited = suitOf(hero[0]) === suitOf(hero[1]);
    if (hi === lo) return { category: CATEGORY.PAIR, label: `Pocket ${plur(hi)}`, draws: [], strong: hi >= 8 };
    const label = `${RANK_CHARS[hi]}${RANK_CHARS[lo]}${suited ? "s" : "o"}`;
    return { category: CATEGORY.HIGH_CARD, label, draws: [], strong: false };
  }

  const cards = [hero[0], hero[1], ...board];
  const packed = evaluate(cards);
  const cat = categoryOf(packed);

  // Rank counts across hole + board.
  const counts = new Array<number>(13).fill(0);
  for (const c of cards) counts[rankOf(c)]!++;
  const maxBoard = Math.max(...boardRanks);
  const sortedBoard = [...new Set(boardRanks)].sort((a, b) => b - a);

  let label = "";
  const isPocket = holeRanks[0] === holeRanks[1];

  // Ranks (high→low) held with at least n of a kind across hole+board.
  const atLeast = (n: number): number[] => {
    const out: number[] = [];
    for (let r = 12; r >= 0; r--) if (counts[r]! >= n) out.push(r);
    return out;
  };

  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH: label = "Straight Flush"; break;
    case CATEGORY.QUADS: label = `Quad ${plur(atLeast(4)[0]!)}`; break;
    case CATEGORY.FULL_HOUSE: {
      // Name it (e.g. "Kings full of Aces") so a WEAK full house is obvious.
      const trip = atLeast(3)[0]!;
      const pair = atLeast(2).find((r) => r !== trip);
      label = pair !== undefined ? `${plur(trip)} full of ${plur(pair)}` : `${plur(trip)} full`;
      break;
    }
    case CATEGORY.FLUSH: label = "Flush"; break;
    case CATEGORY.STRAIGHT: label = "Straight"; break;
    case CATEGORY.TRIPS: {
      // Set = pocket pair that hit the board; Trips = one hole card + paired board.
      if (isPocket && boardRanks.includes(holeRanks[0]!)) label = "Set";
      else label = "Trips";
      break;
    }
    case CATEGORY.TWO_PAIR: label = "Two Pair"; break;
    case CATEGORY.PAIR: {
      // Which rank is paired?
      let pairedRank = -1;
      for (let r = 12; r >= 0; r--) if (counts[r]! >= 2) { pairedRank = r; break; }
      if (isPocket && holeRanks[0] === pairedRank) {
        if (pairedRank > maxBoard) label = "Overpair";
        else label = `Pocket ${plur(pairedRank)}`;
      } else {
        // Paired a board card with a hole card.
        const kicker = holeRanks[0] === pairedRank ? holeRanks[1]! : holeRanks[0]!;
        if (pairedRank === sortedBoard[0]) {
          const kq = kicker >= 11 ? " Top Kicker" : kicker >= 8 ? " Good Kicker" : "";
          label = `Top Pair${kq}`;
        } else if (pairedRank === sortedBoard[1]) label = "Second Pair";
        else if (pairedRank === sortedBoard[2]) label = "Third Pair";
        else label = "Weak Pair";
      }
      break;
    }
    default: {
      const hiHole = Math.max(holeRanks[0]!, holeRanks[1]!);
      label = `${RANK_WORD[hiHole]} High`;
    }
  }

  // Draws (only if not already that made hand or better). On the river the board
  // is complete — there are no cards to come, so a "draw" is meaningless (a busted
  // gutshot is just your made hand, often air). Never report draws with 5 cards out.
  const draws: string[] = [];
  if (board.length < 5 && cat < CATEGORY.FLUSH) {
    // Flush draw: a suit with exactly 4 cards where hero holds >=1.
    const suitCount = new Array<number>(4).fill(0);
    for (const c of cards) suitCount[suitOf(c)]!++;
    const heroSuits = [suitOf(hero[0]), suitOf(hero[1])];
    for (let s = 0; s < 4; s++) {
      if (suitCount[s] === 4 && heroSuits.includes(s)) { draws.push("Flush draw"); break; }
    }
  }
  if (board.length < 5 && cat < CATEGORY.STRAIGHT) {
    const sd = straightDraw(holeRanks, boardRanks);
    if (sd === "oesd") draws.push("Open-ended straight draw");
    else if (sd === "gutshot") draws.push("Gutshot");
  }

  const strong = cat >= CATEGORY.TWO_PAIR ||
    draws.includes("Flush draw") || draws.includes("Open-ended straight draw");

  return { category: cat, label, draws, strong };
}
