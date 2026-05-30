import { type Card, rankOf, suitOf, RANK_CHARS } from "./cards.js";
import { evaluate, categoryOf, CATEGORY } from "./evaluator.js";

export interface HandDescription {
  category: number; // 1-9 from CATEGORY
  label: string; // human-readable made hand: "Top Pair", "Set", "Flush"
  draws: string[]; // ["Flush draw", "Open-ended straight draw"]
  strong: boolean; // two pair or better, or a strong draw (FD / OESD)
}

const RANK_WORD = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Jack", "Queen", "King", "Ace"];

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
    if (hi === lo) return { category: CATEGORY.PAIR, label: `Pocket ${RANK_WORD[hi]}s`, draws: [], strong: hi >= 8 };
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

  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH: label = "Straight Flush"; break;
    case CATEGORY.QUADS: label = "Four of a Kind"; break;
    case CATEGORY.FULL_HOUSE: label = "Full House"; break;
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
        else label = `Pocket ${RANK_WORD[pairedRank]}s`;
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

  // Draws (only if not already that made hand or better).
  const draws: string[] = [];
  if (cat < CATEGORY.FLUSH) {
    // Flush draw: a suit with exactly 4 cards where hero holds >=1.
    const suitCount = new Array<number>(4).fill(0);
    for (const c of cards) suitCount[suitOf(c)]!++;
    const heroSuits = [suitOf(hero[0]), suitOf(hero[1])];
    for (let s = 0; s < 4; s++) {
      if (suitCount[s] === 4 && heroSuits.includes(s)) { draws.push("Flush draw"); break; }
    }
  }
  if (cat < CATEGORY.STRAIGHT) {
    const sd = straightDraw(holeRanks, boardRanks);
    if (sd === "oesd") draws.push("Open-ended straight draw");
    else if (sd === "gutshot") draws.push("Gutshot");
  }

  const strong = cat >= CATEGORY.TWO_PAIR ||
    draws.includes("Flush draw") || draws.includes("Open-ended straight draw");

  return { category: cat, label, draws, strong };
}
