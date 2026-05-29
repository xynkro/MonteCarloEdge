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

  it("bb/100 is within reasonable range", () => {
    const result = simulate({
      villainProfile: TAG,
      hands: 500,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(0xbeef),
    });
    // Even a bad run shouldn't lose more than 100bb/100 on average
    expect(result.bbPer100).toBeGreaterThan(-100);
    expect(result.bbPer100).toBeLessThan(100);
  });

  it("CI widens with fewer hands", () => {
    const small = simulate({
      villainProfile: TAG,
      hands: 50,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(0xaa),
    });
    const large = simulate({
      villainProfile: TAG,
      hands: 2000,
      startingStack: 100,
      bb: 1,
      rng: mulberry32(0xbb),
    });
    const smallWidth = small.ci95[1] - small.ci95[0];
    const largeWidth = large.ci95[1] - large.ci95[0];
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });
});
