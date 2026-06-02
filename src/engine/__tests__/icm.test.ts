import { describe, it, expect } from "vitest";
import { icmEquityExact, icmEquityMonteCarlo, requiredCallEquityICM, bubbleFactor } from "../icm.js";
import { mulberry32 } from "../rng.js";

describe("ICM equity (Malmuth–Harville)", () => {
  it("winner-take-all = chip share (chips are money)", () => {
    const eq = icmEquityExact([5000, 3000, 2000], [1]);
    expect(eq[0]).toBeCloseTo(0.5, 5);
    expect(eq[1]).toBeCloseTo(0.3, 5);
    expect(eq[2]).toBeCloseTo(0.2, 5);
  });

  it("equal stacks split equity equally", () => {
    const eq = icmEquityExact([1000, 1000], [0.65, 0.35]);
    expect(eq[0]).toBeCloseTo(0.5, 6);
    expect(eq[1]).toBeCloseTo(0.5, 6);
  });

  it("2-player known case (3:1 stacks, 65/35)", () => {
    const eq = icmEquityExact([3000, 1000], [0.65, 0.35]);
    expect(eq[0]).toBeCloseTo(0.575, 4);
    expect(eq[1]).toBeCloseTo(0.425, 4);
  });

  it("ICM tax: the big stack is worth LESS than its chip share, short stacks MORE", () => {
    const stacks = [5000, 2500, 2500];
    const total = 10000;
    const eq = icmEquityExact(stacks, [0.65, 0.35]);
    expect(eq[0]!).toBeLessThan(stacks[0]! / total); // leader penalised
    expect(eq[1]!).toBeGreaterThan(stacks[1]! / total); // short rewarded
    // Equities sum to the prize pool.
    expect(eq.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 5);
  });

  it("Monte-Carlo ICM approximates the exact result", () => {
    const stacks = [5000, 3000, 2000];
    const payouts = [0.5, 0.3, 0.2];
    const exact = icmEquityExact(stacks, payouts);
    const mc = icmEquityMonteCarlo(stacks, payouts, 40000, mulberry32(1));
    for (let i = 0; i < 3; i++) expect(mc[i]).toBeCloseTo(exact[i]!, 2);
  });
});

describe("bubble factor / required call equity", () => {
  it("winner-take-all has bubble factor ~1 (no ICM pressure)", () => {
    const bf = bubbleFactor([4000, 3000, 3000], [1], 1, 3000, 3000);
    expect(bf).toBeCloseTo(1, 2);
  });

  it("on a pay-jump bubble, calling needs MORE equity than chip-EV (bf > 1)", () => {
    // 4 left, top 3 paid — classic bubble. Hero (idx 1) flat-ish stack faces a
    // shove for their whole stack.
    const stacks = [5000, 3000, 1000, 1000];
    const payouts = [0.5, 0.3, 0.2];
    const req = requiredCallEquityICM(stacks, payouts, 1, 3000, 3000);
    expect(req).toBeGreaterThan(0.5); // chip-EV would be 3000/6000 = 0.5
    const bf = bubbleFactor(stacks, payouts, 1, 3000, 3000);
    expect(bf).toBeGreaterThan(1);
  });
});
