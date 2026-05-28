import { type Card, NUM_CARDS } from "./cards.js";
import { evaluate } from "./evaluator.js";
import { type Rng, mulberry32 } from "./rng.js";

export interface EquityInput {
  hero: readonly [Card, Card];
  // Each opponent is either a known 2-card hand or a list of possible combos (range).
  opponents: ReadonlyArray<readonly [Card, Card]>;
  // Existing community cards (0, 3, 4, or 5).
  board?: readonly Card[];
  iterations?: number;
  rng?: Rng;
}

export interface EquityResult {
  equity: number;      // hero's expected share of the pot, [0,1]
  wins: number;        // count of outright wins
  ties: number;        // count of ties (any size)
  losses: number;
  iterations: number;
  // 95% confidence half-width on equity, from Monte Carlo standard error.
  stderr95: number;
}

export function monteCarloEquity(input: EquityInput): EquityResult {
  const {
    hero,
    opponents,
    board = [],
    iterations = 50_000,
    rng = mulberry32(0xC0FFEE),
  } = input;

  if (board.length !== 0 && board.length !== 3 && board.length !== 4 && board.length !== 5) {
    throw new Error(`board must have 0, 3, 4, or 5 cards (got ${board.length})`);
  }

  // Build base deck excluding all known cards.
  const used = new Uint8Array(NUM_CARDS);
  const mark = (c: Card) => {
    if (c < 0 || c >= NUM_CARDS) throw new Error(`invalid card ${c}`);
    if (used[c]) throw new Error(`duplicate card ${c}`);
    used[c] = 1;
  };
  mark(hero[0]); mark(hero[1]);
  for (const opp of opponents) { mark(opp[0]); mark(opp[1]); }
  for (const c of board) mark(c);

  const baseDeck: Card[] = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!used[c]) baseDeck.push(c);

  const need = 5 - board.length;
  if (need < 0 || need > baseDeck.length) throw new Error("internal: bad deck/board sizing");

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let equitySum = 0;
  let equitySqSum = 0;

  const deck = baseDeck.slice();
  const drawn: Card[] = new Array(need);
  const finalBoard: Card[] = new Array(5);
  for (let i = 0; i < board.length; i++) finalBoard[i] = board[i]!;

  for (let it = 0; it < iterations; it++) {
    // Partial Fisher-Yates: draw `need` cards from `deck`.
    for (let j = 0; j < need; j++) {
      const idx = j + Math.floor(rng() * (deck.length - j));
      const tmp = deck[j]!;
      deck[j] = deck[idx]!;
      deck[idx] = tmp;
      drawn[j] = deck[j]!;
    }
    for (let j = 0; j < need; j++) finalBoard[board.length + j] = drawn[j]!;

    const heroHand: Card[] = [hero[0], hero[1], ...finalBoard];
    const heroRank = evaluate(heroHand);

    let bestOpp = -1;
    let tiers = 0;
    for (const opp of opponents) {
      const oppHand: Card[] = [opp[0], opp[1], ...finalBoard];
      const r = evaluate(oppHand);
      if (r > bestOpp) {
        bestOpp = r;
        tiers = 1;
      } else if (r === bestOpp) {
        tiers++;
      }
    }

    let share: number;
    if (heroRank > bestOpp) {
      share = 1;
      wins++;
    } else if (heroRank === bestOpp) {
      share = 1 / (tiers + 1);
      ties++;
    } else {
      share = 0;
      losses++;
    }
    equitySum += share;
    equitySqSum += share * share;
  }

  const equity = equitySum / iterations;
  const variance = Math.max(0, equitySqSum / iterations - equity * equity);
  const stderr = Math.sqrt(variance / iterations);
  // 1.96 ≈ 95% z-score
  const stderr95 = 1.96 * stderr;

  return { equity, wins, ties, losses, iterations, stderr95 };
}

export interface ExhaustiveResult {
  equity: number;
  wins: number;
  ties: number;
  losses: number;
  boards: number;
}

// Exhaustive heads-up preflop enumeration: try every possible 5-card board.
// For preflop this is C(48,5) = 1,712,304 boards — feasible (~tens of seconds).
// This is ground truth, no sampling error.
export function exhaustiveEquityHU(
  hero: readonly [Card, Card],
  villain: readonly [Card, Card],
  board: readonly Card[] = [],
): ExhaustiveResult {
  const used = new Uint8Array(NUM_CARDS);
  const mark = (c: Card) => {
    if (used[c]) throw new Error(`duplicate card ${c}`);
    used[c] = 1;
  };
  mark(hero[0]); mark(hero[1]);
  mark(villain[0]); mark(villain[1]);
  for (const c of board) mark(c);

  const deck: Card[] = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!used[c]) deck.push(c);

  const need = 5 - board.length;
  if (need < 0) throw new Error("board too long");
  if (need > deck.length) throw new Error("not enough cards");

  // Pre-fill a 7-card buffer to avoid allocations in the inner loop.
  const hHand: Card[] = [hero[0], hero[1], 0, 0, 0, 0, 0];
  const vHand: Card[] = [villain[0], villain[1], 0, 0, 0, 0, 0];
  for (let i = 0; i < board.length; i++) {
    hHand[2 + i] = board[i]!;
    vHand[2 + i] = board[i]!;
  }
  const off = 2 + board.length;

  let wins = 0, ties = 0, losses = 0, boards = 0;

  // Generic k-of-n combination iteration via index recursion (max k=5).
  const idx: number[] = new Array(need).fill(0);
  const n = deck.length;

  function emit() {
    for (let i = 0; i < need; i++) {
      const c = deck[idx[i]!]!;
      hHand[off + i] = c;
      vHand[off + i] = c;
    }
    const hr = evaluate(hHand);
    const vr = evaluate(vHand);
    if (hr > vr) wins++;
    else if (hr === vr) ties++;
    else losses++;
    boards++;
  }

  if (need === 0) {
    emit();
  } else {
    // initialize idx = [0,1,2,...,need-1]
    for (let i = 0; i < need; i++) idx[i] = i;
    while (true) {
      emit();
      // advance combination
      let i = need - 1;
      while (i >= 0 && idx[i]! === n - need + i) i--;
      if (i < 0) break;
      idx[i]!++;
      for (let j = i + 1; j < need; j++) idx[j] = idx[j - 1]! + 1;
    }
  }

  const equity = (wins + ties / 2) / boards;
  return { equity, wins, ties, losses, boards };
}
