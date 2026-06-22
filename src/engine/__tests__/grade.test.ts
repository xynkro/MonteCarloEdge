import { describe, it, expect } from "vitest";
import { gradeDecision, mixFreqOf } from "../grade.js";
import { type Recommendation } from "../decision.js";

function rec(over: Partial<Recommendation>): Recommendation {
  return {
    action: "check", amount: 0, equity: 0.5, potOdds: 0,
    ev: { fold: 0, call: 0, raise: 0 }, reasoning: "", ...over,
  };
}

describe("mixFreqOf", () => {
  const mix = [
    { action: "check" as const, amount: 0, freq: 0.68 },
    { action: "bet" as const, amount: 7, freq: 0.2 },
    { action: "bet" as const, amount: 95, freq: 0.04 },
  ];
  it("sums non-sized actions by type", () => {
    expect(mixFreqOf(mix, "check", 0)).toBeCloseTo(0.68);
  });
  it("matches a bet to the nearest solved size within tolerance", () => {
    expect(mixFreqOf(mix, "bet", 7)).toBeCloseTo(0.2);
    expect(mixFreqOf(mix, "bet", 9)).toBeCloseTo(0.2); // within 50% of 7
    expect(mixFreqOf(mix, "bet", 95)).toBeCloseTo(0.04);
  });
  it("a wildly wrong size matches nothing", () => {
    expect(mixFreqOf(mix, "bet", 40)).toBe(0); // not within 50% of 7 or 95
  });
});

describe("gradeDecision — frequency-aware (solver mix)", () => {
  const r = rec({
    source: "solver", action: "check", amount: 0,
    mix: [
      { action: "check", amount: 0, freq: 0.68 },
      { action: "bet", amount: 7, freq: 0.2 },
      { action: "bet", amount: 95, freq: 0.04 },
    ],
  });
  it("a high-frequency line grades as a GTO line (score 1)", () => {
    const g = gradeDecision({ chosen: "check", chosenAmt: 0, rec: r });
    expect(g.score).toBe(1);
    expect(g.bucket).toBe("gto");
  });
  it("a low-frequency mix line is legit, not a mistake (score 0.6)", () => {
    const g = gradeDecision({ chosen: "bet", chosenAmt: 95, rec: r });
    expect(g.score).toBe(0.6);
    expect(g.bucket).toBe("mixed");
  });
  it("an off-tree action is a mistake (score 0)", () => {
    const g = gradeDecision({ chosen: "bet", chosenAmt: 40, rec: r });
    expect(g.score).toBe(0);
    expect(g.bucket).toBe("off");
  });
});

describe("gradeDecision — match-based (heuristic / chart)", () => {
  it("matching the recommended action scores 1 (positive plain-language grade)", () => {
    const g = gradeDecision({ chosen: "raise", chosenAmt: 6, rec: rec({ source: "chart", action: "raise", amount: 6 }) });
    expect(g.score).toBe(1);
    expect(g.bucket).toBe("gto");
    expect(g.label.startsWith("✓")).toBe(true);
  });
  it("deviating from the heuristic scores 0", () => {
    const g = gradeDecision({ chosen: "fold", chosenAmt: 0, rec: rec({ source: "heuristic", action: "call" }) });
    expect(g.score).toBe(0);
    expect(g.bucket).toBe("off");
  });
});
