import { describe, it, expect } from "vitest";
import { makeCard } from "../cards.js";
import { type Combo, Range } from "../range.js";
import {
  comboScore,
  allCombos,
  sortedCombos,
  topSlice,
  middleSlice,
} from "../hand-strength.js";

function combo(r1: number, s1: number, r2: number, s2: number): Combo {
  const a = makeCard(r1, s1);
  const b = makeCard(r2, s2);
  return a <= b ? [a, b] : [b, a];
}

describe("comboScore (Chen formula)", () => {
  it("pairs score correctly", () => {
    expect(comboScore(combo(12, 0, 12, 1))).toBe(20); // AA
    expect(comboScore(combo(11, 0, 11, 1))).toBe(16); // KK
    expect(comboScore(combo(10, 0, 10, 1))).toBe(14); // QQ
    expect(comboScore(combo(9, 0, 9, 1))).toBe(12); // JJ
    expect(comboScore(combo(8, 0, 8, 1))).toBe(10); // TT
    expect(comboScore(combo(7, 0, 7, 1))).toBe(9); // 99
    expect(comboScore(combo(4, 0, 4, 1))).toBe(6); // 66
    expect(comboScore(combo(0, 0, 0, 1))).toBe(5); // 22 (min 5)
  });

  it("suited connectors get bonuses", () => {
    const aks = comboScore(combo(12, 0, 11, 0)); // AKs
    const ako = comboScore(combo(12, 0, 11, 1)); // AKo
    expect(aks).toBe(12);
    expect(ako).toBe(10);
    expect(aks).toBeGreaterThan(ako);
  });

  it("gaps apply penalties", () => {
    const ats = comboScore(combo(12, 0, 8, 0)); // ATs — gap 3
    const a9s = comboScore(combo(12, 0, 7, 0)); // A9s — gap 4
    expect(ats).toBeLessThan(comboScore(combo(12, 0, 11, 0))); // < AKs
    expect(a9s).toBeLessThanOrEqual(ats);
  });

  it("straight potential bonus for small connected", () => {
    // QJs: hi=Q(10), lo=J(9), gap=0, suited, both ≤ Q → +1
    const qjs = comboScore(combo(10, 0, 9, 0));
    // KQs: hi=K(11), lo=Q(10), gap=0, suited, hi > Q → no bonus
    const kqs = comboScore(combo(11, 0, 10, 0));
    expect(qjs).toBe(kqs); // Both 10
  });
});

describe("allCombos", () => {
  it("returns 1326 combos", () => {
    expect(allCombos().size).toBe(1326);
  });

  it("is cached", () => {
    expect(allCombos()).toBe(allCombos());
  });
});

describe("sortedCombos", () => {
  it("sorts strongest first", () => {
    const sorted = sortedCombos(allCombos());
    expect(sorted.length).toBe(1326);
    // First combo should be AA (score 20)
    expect(comboScore(sorted[0]!)).toBe(20);
    // Last should be low
    expect(comboScore(sorted[sorted.length - 1]!)).toBeLessThanOrEqual(3);
  });

  it("scores are non-increasing", () => {
    const sorted = sortedCombos(allCombos());
    for (let i = 1; i < sorted.length; i++) {
      expect(comboScore(sorted[i]!)).toBeLessThanOrEqual(
        comboScore(sorted[i - 1]!),
      );
    }
  });
});

describe("topSlice", () => {
  it("10% of all combos ≈ 133", () => {
    const sliced = topSlice(allCombos(), 0.1);
    expect(sliced.size).toBe(Math.round(1326 * 0.1));
  });

  it("100% returns all", () => {
    const sliced = topSlice(allCombos(), 1);
    expect(sliced.size).toBe(1326);
  });

  it("0% returns empty", () => {
    const sliced = topSlice(allCombos(), 0);
    expect(sliced.size).toBe(0);
  });

  it("top slice contains strongest combos", () => {
    const top10 = topSlice(allCombos(), 0.1);
    // AA must be in the top 10%
    const aa = combo(12, 0, 12, 1);
    expect(top10.has(aa)).toBe(true);
  });
});

describe("middleSlice", () => {
  it("middle 20-40% has correct size", () => {
    const mid = middleSlice(allCombos(), 0.2, 0.4);
    const expected = Math.round(1326 * 0.4) - Math.round(1326 * 0.2);
    expect(mid.size).toBe(expected);
  });

  it("empty when fromPct >= toPct", () => {
    expect(middleSlice(allCombos(), 0.5, 0.3).size).toBe(0);
  });

  it("excludes top combos", () => {
    const mid = middleSlice(allCombos(), 0.2, 0.5);
    const aa = combo(12, 0, 12, 1);
    expect(mid.has(aa)).toBe(false); // AA is in top 1%, not 20-50%
  });
});
