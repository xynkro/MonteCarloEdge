import { type Card, NUM_CARDS } from "./cards.js";
import { evaluate } from "./evaluator.js";
import { type Rng, mulberry32 } from "./rng.js";
import { type Range } from "./range.js";

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

export interface RangeEquityInput {
  hero: readonly [Card, Card];
  villainRange: Range;
  board?: readonly Card[];
  iterations?: number;
  rng?: Rng;
}

export function monteCarloEquityVsRange(input: RangeEquityInput): EquityResult {
  const {
    hero,
    villainRange,
    board = [],
    iterations = 50_000,
    rng = mulberry32(0xC0FFEE),
  } = input;

  if (
    board.length !== 0 &&
    board.length !== 3 &&
    board.length !== 4 &&
    board.length !== 5
  ) {
    throw new Error(`board must have 0, 3, 4, or 5 cards (got ${board.length})`);
  }

  const dead: Card[] = [hero[0], hero[1], ...board];
  const filtered = villainRange.filter(dead);
  if (filtered.size === 0)
    throw new Error("No valid villain combos after dead-card removal");

  const baseDead = new Uint8Array(NUM_CARDS);
  baseDead[hero[0]] = 1;
  baseDead[hero[1]] = 1;
  for (const c of board) baseDead[c] = 1;

  const baseDeck: Card[] = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!baseDead[c]) baseDeck.push(c);

  const need = 5 - board.length;

  let wins = 0,
    ties = 0,
    losses = 0;
  let eqSum = 0,
    eqSqSum = 0;

  const deck: Card[] = new Array(baseDeck.length);
  const finalBoard: Card[] = new Array(5);
  for (let i = 0; i < board.length; i++) finalBoard[i] = board[i]!;

  const hBuf: Card[] = [hero[0], hero[1], 0, 0, 0, 0, 0];
  const vBuf: Card[] = [0, 0, 0, 0, 0, 0, 0];

  for (let it = 0; it < iterations; it++) {
    const vill = filtered.sample(rng)!;

    let dLen = 0;
    for (let i = 0; i < baseDeck.length; i++) {
      const c = baseDeck[i]!;
      if (c !== vill[0] && c !== vill[1]) deck[dLen++] = c;
    }

    for (let j = 0; j < need; j++) {
      const idx = j + Math.floor(rng() * (dLen - j));
      const tmp = deck[j]!;
      deck[j] = deck[idx]!;
      deck[idx] = tmp;
      finalBoard[board.length + j] = deck[j]!;
    }

    hBuf[0] = hero[0];
    hBuf[1] = hero[1];
    vBuf[0] = vill[0];
    vBuf[1] = vill[1];
    for (let i = 0; i < 5; i++) {
      hBuf[2 + i] = finalBoard[i]!;
      vBuf[2 + i] = finalBoard[i]!;
    }

    const hr = evaluate(hBuf);
    const vr = evaluate(vBuf);

    let share: number;
    if (hr > vr) {
      share = 1;
      wins++;
    } else if (hr === vr) {
      share = 0.5;
      ties++;
    } else {
      share = 0;
      losses++;
    }

    eqSum += share;
    eqSqSum += share * share;
  }

  const equity = eqSum / iterations;
  const variance = Math.max(0, eqSqSum / iterations - equity * equity);
  const stderr = Math.sqrt(variance / iterations);
  const stderr95 = 1.96 * stderr;

  return { equity, wins, ties, losses, iterations, stderr95 };
}

export interface MultiwayEquityInput {
  hero: readonly [Card, Card];
  villainRanges: Range[];
  board?: readonly Card[];
  iterations?: number;
  rng?: Rng;
}

// Hero equity against multiple villains, each with their own range.
// Each iteration: sample one combo per villain (rejecting card conflicts),
// deal the remaining board, compare all hands. Hero's share is 1 if strictly
// best, 1/k if tied k-ways for best, 0 otherwise.
export function monteCarloEquityMultiway(input: MultiwayEquityInput): EquityResult {
  const {
    hero,
    villainRanges,
    board = [],
    iterations = 50_000,
    rng = mulberry32(0xC0FFEE),
  } = input;

  if (
    board.length !== 0 && board.length !== 3 &&
    board.length !== 4 && board.length !== 5
  ) {
    throw new Error(`board must have 0, 3, 4, or 5 cards (got ${board.length})`);
  }

  const dead: Card[] = [hero[0], hero[1], ...board];

  // Pre-filter each villain range; drop villains with no legal combos.
  const filtered = villainRanges
    .map((r) => r.filter(dead))
    .filter((r) => r.size > 0);

  if (filtered.length === 0) {
    // No contesting villains — hero wins outright every time.
    return { equity: 1, wins: iterations, ties: 0, losses: 0, iterations, stderr95: 0 };
  }

  const baseDead = new Uint8Array(NUM_CARDS);
  baseDead[hero[0]] = 1;
  baseDead[hero[1]] = 1;
  for (const c of board) baseDead[c] = 1;

  const baseDeck: Card[] = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!baseDead[c]) baseDeck.push(c);

  const need = 5 - board.length;

  let wins = 0, ties = 0, losses = 0;
  let eqSum = 0, eqSqSum = 0;

  const used = new Uint8Array(NUM_CARDS);
  const villCards: Card[] = new Array(filtered.length * 2);
  const deck: Card[] = new Array(baseDeck.length);
  const finalBoard: Card[] = new Array(5);
  for (let i = 0; i < board.length; i++) finalBoard[i] = board[i]!;

  const heroBuf: Card[] = [hero[0], hero[1], 0, 0, 0, 0, 0];
  const vBuf: Card[] = [0, 0, 0, 0, 0, 0, 0];

  let counted = 0;
  for (let it = 0; it < iterations; it++) {
    // Reset used to baseDead.
    used.set(baseDead);

    // Sample a non-conflicting combo for each villain.
    let ok = true;
    for (let v = 0; v < filtered.length; v++) {
      let placed = false;
      for (let attempt = 0; attempt < 16; attempt++) {
        const combo = filtered[v]!.sample(rng)!;
        if (!used[combo[0]] && !used[combo[1]]) {
          used[combo[0]] = 1;
          used[combo[1]] = 1;
          villCards[v * 2] = combo[0];
          villCards[v * 2 + 1] = combo[1];
          placed = true;
          break;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (!ok) continue;

    // Build the live deck (cards not used by hero/board/villains).
    let dLen = 0;
    for (let i = 0; i < baseDeck.length; i++) {
      const c = baseDeck[i]!;
      if (!used[c]) deck[dLen++] = c;
    }

    // Deal the remaining board.
    for (let j = 0; j < need; j++) {
      const idx = j + Math.floor(rng() * (dLen - j));
      const tmp = deck[j]!;
      deck[j] = deck[idx]!;
      deck[idx] = tmp;
      finalBoard[board.length + j] = deck[j]!;
    }

    for (let i = 0; i < 5; i++) heroBuf[2 + i] = finalBoard[i]!;
    const heroRank = evaluate(heroBuf);

    let bestVill = -1;
    let villTies = 0;
    for (let v = 0; v < filtered.length; v++) {
      vBuf[0] = villCards[v * 2]!;
      vBuf[1] = villCards[v * 2 + 1]!;
      for (let i = 0; i < 5; i++) vBuf[2 + i] = finalBoard[i]!;
      const r = evaluate(vBuf);
      if (r > bestVill) { bestVill = r; villTies = 1; }
      else if (r === bestVill) villTies++;
    }

    let share: number;
    if (heroRank > bestVill) { share = 1; wins++; }
    else if (heroRank === bestVill) { share = 1 / (villTies + 1); ties++; }
    else { share = 0; losses++; }

    eqSum += share;
    eqSqSum += share * share;
    counted++;
  }

  if (counted === 0) {
    return { equity: 0, wins: 0, ties: 0, losses: 0, iterations: 0, stderr95: 1 };
  }

  const equity = eqSum / counted;
  const variance = Math.max(0, eqSqSum / counted - equity * equity);
  const stderr = Math.sqrt(variance / counted);
  return { equity, wins, ties, losses, iterations: counted, stderr95: 1.96 * stderr };
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
