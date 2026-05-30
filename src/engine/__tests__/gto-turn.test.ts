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

describe("turn solver (CFR with river runout)", () => {
  it("solves a 4-card board and returns a valid strategy", () => {
    const b = board("AhKd7s2c"); // turn
    const hero = combo("AsAc"); // top set — drawing to a boat / already ahead
    const res = solveSubgame({
      heroRange: Range.parse("AA,KK,77,AK,AQ,KQ"),
      villainRange: Range.parse("AK,AQ,KQ,KJ,QJ,JJ,TT,99"),
      board: b, pot: 60, stack: 150, iterations: 12000, rng: mulberry32(11),
    }, hero);
    const total = res.strategy.reduce((s, a) => s + a.freq, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);
    expect(Number.isFinite(res.heroEv)).toBe(true);
  });

  it("the effective nuts on the turn never loses (EV >= pot)", () => {
    // Board Ah Kh Qh Jh (turn). Hero Th = made Royal flush; no river changes it.
    // Vs a range that is drawing dead, hero can never lose the pot — whether it
    // bets (villain folds) or checks (wins at showdown), EV >= pot. (The solver
    // correctly treats bet vs check as indifferent here since there is nothing
    // to extract from a dead range.)
    const b = board("AhKhQhJh");
    const hero = combo("ThTd");
    const res = solveSubgame({
      heroRange: Range.fromCombos([hero]),
      villainRange: Range.parse("AA,KK,QQ,AKo"),
      board: b, pot: 100, stack: 200, iterations: 12000, rng: mulberry32(12),
    }, hero);
    expect(res.heroEv).toBeGreaterThan(100 * 0.99); // wins at least the pot
  });

  it("the nuts value-bets when villain has a calling range to pay it off", () => {
    // Hero has a polarized range; villain has bluff-catchers that call bets.
    // The actual nuts within hero's range should bet a meaningful share.
    const b = board("2h7d9sKc"); // turn, hero set of 9s is effectively nuts-ish
    const hero = combo("9c9h"); // top set
    const res = solveSubgame({
      heroRange: Range.parse("99,77,22,KK,AK,AQ,A5s,76s"), // value + some bluffs
      villainRange: Range.parse("KQ,KJ,KT,AK,QQ,JJ,TT,A9s,98s"), // pays off
      board: b, pot: 60, stack: 130, iterations: 14000, rng: mulberry32(22),
    }, hero);
    const betFreq = res.strategy.filter(a => a.action === "bet").reduce((s, a) => s + a.freq, 0);
    expect(betFreq).toBeGreaterThan(0.35);
    expect(res.heroEv).toBeGreaterThan(60 * 0.5);
  });

  it("is deterministic given the same seed", () => {
    const b = board("9h8d4s2c");
    const hero = combo("AhAs");
    const spot = {
      heroRange: Range.parse("AA,KK,QQ,99,88,AK"),
      villainRange: Range.parse("TT,JJ,QQ,98s,T9s,AK,AQ"),
      board: b, pot: 40, stack: 100, iterations: 6000,
    };
    const a = solveSubgame({ ...spot, rng: mulberry32(99) }, hero);
    const c = solveSubgame({ ...spot, rng: mulberry32(99) }, hero);
    expect(a.heroEv).toBeCloseTo(c.heroEv, 6);
    expect(a.strategy[0]!.freq).toBeCloseTo(c.strategy[0]!.freq, 6);
  });

  it("turn equity edge: strong made hand has positive EV vs worse range", () => {
    const b = board("Ah7d4s2c");
    const hero = combo("AcKc"); // top pair top kicker
    const res = solveSubgame({
      heroRange: Range.parse("AA,AK,AQ,A7s,77,44,KK"),
      villainRange: Range.parse("A9,A8,AT,KK,QQ,JJ,TT,99,77"),
      board: b, pot: 50, stack: 110, iterations: 10000, rng: mulberry32(13),
    }, hero);
    expect(res.heroEv).toBeGreaterThan(0);
  });
});
