import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { type Combo, Range } from "../range.js";
import { solveSubgame } from "../gto/river-solver.js";
import { mulberry32 } from "../rng.js";

const combo = (s: string): Combo => {
  const a = parseCard(s.slice(0, 2)), b = parseCard(s.slice(2, 4));
  return a <= b ? [a, b] : [b, a];
};
const board = (s: string) => s.match(/.{2}/g)!.map(parseCard);

describe("flop solver (single-street CFR with all-in-equity leaves)", () => {
  it("solves a 3-card board and returns a valid strategy", () => {
    const b = board("Kh7d2s"); // dry flop
    const hero = combo("KsKc"); // top set
    const res = solveSubgame({
      heroRange: Range.parse("KK,77,22,AK,KQ,AA,QQ"),
      villainRange: Range.parse("AK,AQ,KQ,KJ,QQ,JJ,TT,99,AhJh"),
      board: b, pot: 20, stack: 100, iterations: 16000, rng: mulberry32(31),
    }, hero);
    const total = res.strategy.reduce((s, a) => s + a.freq, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);
    expect(Number.isFinite(res.heroEv)).toBe(true);
  });

  it("top set on a dry flop has positive EV and bets", () => {
    const b = board("Kh7d2s");
    const hero = combo("KsKc"); // top set, way ahead
    const res = solveSubgame({
      heroRange: Range.parse("KK,77,22,AK,KQ,AA,QQ,JJ"),
      villainRange: Range.parse("AK,AQ,KQ,KJ,QQ,JJ,TT,99"),
      board: b, pot: 20, stack: 100, iterations: 18000, rng: mulberry32(32),
    }, hero);
    const betFreq = res.strategy.filter(a => a.action === "bet").reduce((s, a) => s + a.freq, 0);
    expect(res.heroEv).toBeGreaterThan(0);
    expect(betFreq).toBeGreaterThan(0.3);
  });

  it("is deterministic given the same seed", () => {
    const b = board("9h8d4s");
    const hero = combo("AhAc");
    const spot = {
      heroRange: Range.parse("AA,KK,QQ,99,88,AK,T9s"),
      villainRange: Range.parse("TT,JJ,QQ,98s,T9s,AK,AQ,76s"),
      board: b, pot: 20, stack: 80, iterations: 8000,
    };
    const a = solveSubgame({ ...spot, rng: mulberry32(77) }, hero);
    const c = solveSubgame({ ...spot, rng: mulberry32(77) }, hero);
    expect(a.heroEv).toBeCloseTo(c.heroEv, 6);
    expect(a.strategy[0]!.freq).toBeCloseTo(c.strategy[0]!.freq, 6);
  });

  it("a dominated hand has lower EV than a strong hand on the same flop", () => {
    const b = board("Ah Kd 4s".replace(/ /g, ""));
    const strongHero = combo("AcKc"); // top two pair
    const weakHero = combo("5c6c"); // air
    const heroRange = Range.parse("AK,AQ,KQ,A4s,44,56s,T9s,QJ");
    const villainRange = Range.parse("AQ,AJ,KQ,KJ,QJ,JJ,TT,99,A4s");
    const common = { heroRange, villainRange, board: b, pot: 20, stack: 90, iterations: 12000 };
    const strong = solveSubgame({ ...common, rng: mulberry32(41) }, strongHero);
    const weak = solveSubgame({ ...common, rng: mulberry32(41) }, weakHero);
    expect(strong.heroEv).toBeGreaterThan(weak.heroEv);
  });
});
