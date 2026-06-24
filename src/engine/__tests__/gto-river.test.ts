import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { type Combo, Range } from "../range.js";
import { solveRiver } from "../gto/river-solver.js";
import { mulberry32 } from "../rng.js";

const combo = (s: string): Combo => {
  const a = parseCard(s.slice(0, 2)), b = parseCard(s.slice(2, 4));
  return a <= b ? [a, b] : [b, a];
};
const board = (s: string) => s.match(/.{2}/g)!.map(parseCard);

describe("river solver (CFR subgame)", () => {
  it("the nuts bets/raises at high frequency, never gives up", () => {
    // Board: Ah Kh Qh Jh 2c. Hero has Th = Royal flush (absolute nuts).
    const b = board("AhKhQhJh2c");
    const hero = combo("ThTd"); // Th makes the royal; the second card is irrelevant
    const res = solveRiver({
      heroRange: Range.fromCombos([hero]),
      villainRange: Range.parse("AA,KK,QQ,AKo"), // strong but drawing dead
      board: b,
      pot: 100,
      stack: 200,
      iterations: 15000,
      rng: mulberry32(1),
    }, hero);

    const betFreq = res.strategy.filter(a => a.action === "bet").reduce((s, a) => s + a.freq, 0);
    expect(betFreq).toBeGreaterThan(0.85);
    // Nuts always wins at least the pot.
    expect(res.heroEv).toBeGreaterThan(100 * 0.99);
  });

  it("strategy frequencies sum to 1", () => {
    const b = board("AhKd7s2c9h");
    const hero = combo("AsAc");
    const res = solveRiver({
      heroRange: Range.parse("AA,KK,AK,77,QQ"),
      villainRange: Range.parse("KK,AK,QQ,JJ,TT,99,AQ"),
      board: b, pot: 60, stack: 150, iterations: 8000, rng: mulberry32(2),
    }, hero);
    const total = res.strategy.reduce((s, a) => s + a.freq, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);
  });

  it("the worst hand cannot guarantee the pot (EV below pot) and mixes in checks", () => {
    // Hero has bottom of range with no showdown value; villain always has it beat.
    const b = board("AhKhQc7d2s");
    const hero = combo("3c4d"); // total air
    const res = solveRiver({
      heroRange: Range.parse("AA,KK,QQ,AK,33,44"), // hero range incl. air
      villainRange: Range.parse("AA,KK,QQ,AK,AQ"), // all beat 34o
      board: b, pot: 80, stack: 160, iterations: 12000, rng: mulberry32(3),
    }, hero);
    // Air can't win a showdown; its EV must be well under simply winning the pot.
    expect(res.heroEv).toBeLessThan(80);
    const checkFreq = res.strategy.filter(a => a.action === "check").reduce((s, a) => s + a.freq, 0);
    expect(checkFreq).toBeGreaterThan(0.1); // gives up at least sometimes
  });

  it("a value hand bets bigger against a calling range than it checks", () => {
    const b = board("Ah9d4s2c7h");
    const hero = combo("AcKd"); // top pair top kicker
    const res = solveRiver({
      heroRange: Range.parse("AA,AK,AQ,A9s,99,44,KK,QQ,JJ"),
      villainRange: Range.parse("AQ,AJ,AT,KK,QQ,JJ,TT,99"),
      board: b, pot: 50, stack: 120, iterations: 12000, rng: mulberry32(4),
    }, hero);
    const betFreq = res.strategy.filter(a => a.action === "bet").reduce((s, a) => s + a.freq, 0);
    // TPTK on a dry board should mostly value bet.
    expect(betFreq).toBeGreaterThan(0.4);
    expect(res.heroEv).toBeGreaterThan(0);
  });

  it("FACING a bet: the menu is fold/call/raise and resolves NON-uniform (the nuts continues)", () => {
    const b = board("AhKhQhJh2c");
    const nuts = combo("ThTd"); // royal flush
    const res = solveRiver({
      heroRange: Range.parse("AA,KK,QQ,ThTd,7c8c"),
      villainRange: Range.parse("AA,KK,QQ,AKo"),
      board: b, pot: 100, stack: 200, facingBet: 75, // villain bet 75 into 100
      iterations: 15000, rng: mulberry32(7),
    }, nuts);
    const acts = res.strategy.map(a => a.action);
    expect(acts).toContain("fold");
    expect(acts).toContain("call");
    expect(acts.some(a => a === "raise")).toBe(true);
    // The nuts continues (call+raise) almost always; folds ~never. If the root key didn't
    // resolve, average() would return a uniform ~1/n mix → continueFreq ≈ 0.66, not >0.9.
    const continueFreq = res.strategy.filter(a => a.action !== "fold").reduce((s, a) => s + a.freq, 0);
    expect(continueFreq).toBeGreaterThan(0.9);
  });

  it("FACING a bet: the solve resolves to a sharp (non-uniform) strategy", () => {
    // Hero's range here is nut-heavy, so the air actually bluff-RAISES (credibly repping the nuts) —
    // the point of this test is that the facing root RESOLVED: a dominant line, not the ~1/n uniform
    // mix that average() falls back to when the root key fails to match the traversal.
    const b = board("AhKhQc7d2s");
    const air = combo("3c4d");
    const res = solveRiver({
      heroRange: Range.parse("AA,KK,QQ,AK,3c4d"),
      villainRange: Range.parse("AA,KK,QQ,AK,AQ"),
      board: b, pot: 80, stack: 160, facingBet: 60,
      iterations: 12000, rng: mulberry32(8),
    }, air);
    const maxFreq = Math.max(...res.strategy.map(a => a.freq));
    expect(maxFreq).toBeGreaterThan(0.6); // a clear dominant action, not a uniform ~0.33 each
    expect(res.strategy.map(a => a.action)).toContain("fold"); // the facing menu exists
  });
});
