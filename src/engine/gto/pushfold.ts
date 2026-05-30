import { type Card, makeCard, rankOf, suitOf, RANK_CHARS, NUM_CARDS } from "../cards.js";
import { type Combo } from "../range.js";
import { evaluate } from "../evaluator.js";
import { type Rng, mulberry32 } from "../rng.js";
import { InfoSets } from "./regret.js";

// Heads-up preflop push/fold (jam-or-fold) Nash equilibrium via chance-sampled
// CFR. The small blind (button) jams or folds; the big blind calls or folds.
// This is the canonical solvable preflop game with published Nash ranges, so it
// both validates the approach and gives a genuinely GTO short-stack chart.
//
// Stacks are `stack` big blinds effective; blinds are 0.5 / 1.

export interface PushFoldResult {
  stack: number;
  jam: Map<string, number>; // class key -> SB jam frequency
  call: Map<string, number>; // class key -> BB call-vs-jam frequency
}

// Canonical 169-class key from two cards: "AA", "AKs", "AKo".
export function handClassKey(c0: Card, c1: Card): string {
  let r0 = rankOf(c0), r1 = rankOf(c1);
  const suited = suitOf(c0) === suitOf(c1);
  const hi = Math.max(r0, r1), lo = Math.min(r0, r1);
  if (hi === lo) return `${RANK_CHARS[hi]}${RANK_CHARS[hi]}`;
  return `${RANK_CHARS[hi]}${RANK_CHARS[lo]}${suited ? "s" : "o"}`;
}

// Canonical concrete combo for a class key (used to seed equity sampling).
function classToCombo(key: string, suitShift = 0): Combo {
  const ri = (ch: string) => RANK_CHARS.indexOf(ch as typeof RANK_CHARS[number]);
  if (key.length === 2) {
    const r = ri(key[0]!);
    return [makeCard(r, (0 + suitShift) % 4), makeCard(r, (1 + suitShift) % 4)];
  }
  const hi = ri(key[0]!), lo = ri(key[1]!), suited = key[2] === "s";
  if (suited) return [makeCard(hi, suitShift % 4), makeCard(lo, suitShift % 4)];
  return [makeCard(hi, suitShift % 4), makeCard(lo, (suitShift + 1) % 4)];
}

// Preflop all-in equity is stack-independent, so cache it once at module level
// and reuse across every stack depth solved.
const EQ_CACHE = new Map<string, { pWin: number; pTie: number }>();

// Cached class-vs-class preflop all-in equity (SB perspective): { pWin, pTie }.
function makeEquityOracle(rng: Rng, samples: number) {
  const cache = EQ_CACHE;
  const used = new Uint8Array(NUM_CARDS);

  function randCombo(key: string): Combo {
    // Draw a random concrete combo of the given class from unused cards.
    const isPair = key.length === 2;
    const ri = (ch: string) => RANK_CHARS.indexOf(ch as typeof RANK_CHARS[number]);
    for (let t = 0; t < 50; t++) {
      if (isPair) {
        const r = ri(key[0]!);
        const s1 = Math.floor(rng() * 4); let s2 = Math.floor(rng() * 4);
        if (s1 === s2) s2 = (s2 + 1) % 4;
        const a = makeCard(r, s1), b = makeCard(r, s2);
        if (!used[a] && !used[b]) return a <= b ? [a, b] : [b, a];
      } else {
        const hi = ri(key[0]!), lo = ri(key[1]!), suited = key[2] === "s";
        const s = Math.floor(rng() * 4);
        const a = makeCard(hi, s);
        const b = makeCard(lo, suited ? s : (s + 1 + Math.floor(rng() * 3)) % 4);
        if (a !== b && !used[a] && !used[b]) return a <= b ? [a, b] : [b, a];
      }
    }
    return classToCombo(key);
  }

  return function equity(sbKey: string, bbKey: string): { pWin: number; pTie: number } {
    const ck = `${sbKey}~${bbKey}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    let win = 0, tie = 0, n = 0;
    for (let s = 0; s < samples; s++) {
      used.fill(0);
      const sb = randCombo(sbKey);
      used[sb[0]] = 1; used[sb[1]] = 1;
      const bb = randCombo(bbKey);
      if (used[bb[0]] || used[bb[1]]) continue;
      used[bb[0]] = 1; used[bb[1]] = 1;
      const board: Card[] = [];
      for (let k = 0; k < 5; k++) {
        let c: number;
        do { c = Math.floor(rng() * NUM_CARDS); } while (used[c]);
        used[c] = 1; board.push(c);
      }
      const sr = evaluate([sb[0], sb[1], ...board]);
      const br = evaluate([bb[0], bb[1], ...board]);
      if (sr > br) win++; else if (sr === br) tie++;
      n++;
    }
    const res = { pWin: n ? win / n : 0.5, pTie: n ? tie / n : 0 };
    cache.set(ck, res);
    return res;
  };
}

export function solvePushFold(stack: number, iterations = 80000, rng: Rng = mulberry32(0x9111)): PushFoldResult {
  const info = new InfoSets();
  const S = stack;
  const equity = makeEquityOracle(rng, 200);

  const drawCombo = (): Combo => {
    let a = Math.floor(rng() * NUM_CARDS), b = Math.floor(rng() * NUM_CARDS);
    while (b === a) b = Math.floor(rng() * NUM_CARDS);
    return a <= b ? [a, b] : [b, a];
  };

  for (let it = 0; it < iterations; it++) {
    const sb = drawCombo();
    const bbKeyCombo = drawCombo();
    const sbKey = `SB:${handClassKey(sb[0], sb[1])}`;
    const bbKey = `BB:${handClassKey(bbKeyCombo[0], bbKeyCombo[1])}`;

    // Smooth all-in equity (SB perspective) for this class matchup.
    const { pWin, pTie } = equity(handClassKey(sb[0], sb[1]), handClassKey(bbKeyCombo[0], bbKeyCombo[1]));
    const pLose = 1 - pWin - pTie;

    const sbStrat = info.getStrategy(sbKey, 2); // [jam, fold]
    const bbStrat = info.getStrategy(bbKey, 2); // [call, fold]

    // BB node is only reached when SB jams: counterfactual reach = sbStrat[jam].
    const sbJamReach = sbStrat[0]!;
    const uBbCall = (pLose - pWin) * S; // BB wins when SB loses
    const uBbFold = -1;
    const bbNode = bbStrat[0]! * uBbCall + bbStrat[1]! * uBbFold;
    info.addRegret(bbKey, 0, sbJamReach * (uBbCall - bbNode));
    info.addRegret(bbKey, 1, sbJamReach * (uBbFold - bbNode));
    info.addStrategy(bbKey, bbStrat, sbJamReach);

    // SB acts at the root (counterfactual reach = 1).
    const uSbJamIfCall = (pWin - pLose) * S;
    const uSbJam = bbStrat[0]! * uSbJamIfCall + bbStrat[1]! * 1; // BB folds -> SB wins 1
    const uSbFold = -0.5;
    const sbNode = sbStrat[0]! * uSbJam + sbStrat[1]! * uSbFold;
    info.addRegret(sbKey, 0, uSbJam - sbNode);
    info.addRegret(sbKey, 1, uSbFold - sbNode);
    info.addStrategy(sbKey, sbStrat, 1);
  }

  const jam = new Map<string, number>();
  const call = new Map<string, number>();
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = 12; lo >= 0; lo--) {
      const key = hi === lo ? `${RANK_CHARS[hi]}${RANK_CHARS[hi]}`
        : hi > lo ? `${RANK_CHARS[hi]}${RANK_CHARS[lo]}s`
        : `${RANK_CHARS[lo]}${RANK_CHARS[hi]}o`;
      const sbAvg = info.average(`SB:${key}`);
      const bbAvg = info.average(`BB:${key}`);
      if (sbAvg) jam.set(key, sbAvg[0]!);
      if (bbAvg) call.set(key, bbAvg[0]!);
    }
  }
  return { stack: S, jam, call };
}

// Fraction of all 1326 combos that jam (combo-weighted), for sanity/aggregates.
export function jamFraction(res: PushFoldResult): number {
  return weightedFraction(res.jam);
}
export function callFraction(res: PushFoldResult): number {
  return weightedFraction(res.call);
}

function comboWeight(key: string): number {
  if (key.length === 2) return 6; // pair
  return key.endsWith("s") ? 4 : 12;
}

function weightedFraction(m: Map<string, number>): number {
  let num = 0, den = 0;
  for (const [k, v] of m) {
    const w = comboWeight(k);
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : 0;
}
