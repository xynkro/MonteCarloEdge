import { describe, it, expect } from "vitest";
import { mulberry32 } from "../rng.js";
import { simulate } from "../simulator.js";
import { TAG, STATION, NIT } from "../opponent.js";

describe("simulator", () => {
  it("runs 100 hands without error", () => {
    const result = simulate({
      villainProfile: TAG,
      hands: 100,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(42),
    });
    expect(result.handsPlayed).toBe(100);
    expect(typeof result.bbPer100).toBe("number");
    expect(typeof result.stddev).toBe("number");
    expect(result.ci95.length).toBe(2);
  });

  it("PnL is finite", () => {
    const result = simulate({
      villainProfile: STATION,
      hands: 200,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(123),
    });
    expect(Number.isFinite(result.totalPnl)).toBe(true);
    expect(Number.isFinite(result.bbPer100)).toBe(true);
  });

  // VALIDATION: the engine must actually WIN, not just "not lose catastrophically".
  // Averaged over seeds (variance-robust), the recommend() line is +EV against every
  // opponent style — crushing a calling station and still beating a competent TAG reg.
  const winRate = (prof: typeof TAG, hands: number, seeds: number[]) =>
    seeds.map((s) => simulate({ villainProfile: prof, hands, startingStack: 100, bb: 1, rng: mulberry32(s) }).bbPer100)
      .reduce((a, b) => a + b, 0) / seeds.length;

  it("crushes a calling station (big +EV)", () => {
    expect(winRate(STATION, 2000, [11, 22, 33])).toBeGreaterThan(50);
  }, 120000);

  it("beats a competent TAG reg (+EV)", () => {
    expect(winRate(TAG, 1800, [11, 22, 33])).toBeGreaterThan(5);
  }, 120000);

  it("beats a nit by stealing (+EV)", () => {
    expect(winRate(NIT, 1500, [11, 22, 33])).toBeGreaterThan(0);
  }, 120000);

  it("CI widens with fewer hands", () => {
    const small = simulate({
      villainProfile: TAG,
      hands: 30,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(0xcc),
    });
    const large = simulate({
      villainProfile: TAG,
      hands: 5000,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(0xdd),
    });
    const smallWidth = small.ci95[1] - small.ci95[0];
    const largeWidth = large.ci95[1] - large.ci95[0];
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });
});
