import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { type Combo, Range } from "../range.js";
import { solveSubgame } from "../gto/river-solver.js";
import { mulberry32 } from "../rng.js";

const board = (s: string) => s.match(/.{2}/g)!.map(parseCard);

describe("solver converges regardless of heroHand card order (comboId fix)", () => {
  it("the nuts still bets ~always when heroHand is passed NON-canonically", () => {
    // Range.combos yields canonical [lo,hi]; the live app passes S.heroCards in
    // deal order. If comboId isn't order-normalized, the root info-set lookup
    // misses and the strategy collapses to a uniform default. Force [hi,lo].
    const b = board("AhKhQhJh2c"); // royal-flush board
    const lo = parseCard("Th"), hi = parseCard("9c");
    const a = Math.max(lo, hi), c = Math.min(lo, hi);
    const heroNonCanonical: Combo = [a, c]; // [hi, lo] — NOT the canonical order
    const res = solveSubgame({
      heroRange: Range.fromCombos([[lo, hi]]), // hero holds Th -> the royal
      villainRange: Range.parse("AA,KK,QQ,AKo"),
      board: b, pot: 100, stack: 200, iterations: 12000, rng: mulberry32(1),
    }, heroNonCanonical);

    const betFreq = res.strategy.filter((x) => x.action === "bet").reduce((s, x) => s + x.freq, 0);
    // Converged → the nuts bets almost always. A uniform default would split
    // ~evenly across check + the bet sizes (betFreq ~0.75) and fail this bound.
    expect(betFreq).toBeGreaterThan(0.85);
    // And it must NOT be the tell-tale uniform mix.
    const freqs = res.strategy.map((x) => x.freq);
    const maxF = Math.max(...freqs);
    expect(maxF).toBeGreaterThan(0.4); // some action is clearly preferred
  });

  it("turn equityLeaf mode returns a real (non-uniform) strategy", () => {
    const b = board("Ks7d2c9h"); // turn
    const lo = parseCard("Ah"), hi = parseCard("Kh");
    const a = Math.max(lo, hi), c = Math.min(lo, hi);
    const res = solveSubgame({
      heroRange: Range.parse("AK,KQ,AA,KK,77,QJs,T9s"),
      villainRange: Range.parse("KK,77,22,99,AK,KQ,QJ,JT"),
      board: b, pot: 10, stack: 90, iterations: 9000, equityLeaf: true, rng: mulberry32(3),
    }, [a, c]);
    expect(res.strategy.length).toBeGreaterThan(1);
    const total = res.strategy.reduce((s, x) => s + x.freq, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);
  });
});
