import { describe, it, expect } from "vitest";
import { parseCard as P } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend, STYLE_GTO } from "../decision.js";
import { sizeClass, repsCapped, TAG, STATION } from "../opponent.js";

describe("sizeClass / repsCapped boundaries", () => {
  it("classifies pot-fractions into the 5 buckets", () => {
    expect(sizeClass(1.5)).toBe("overbet");
    expect(sizeClass(1.1)).toBe("overbet");
    expect(sizeClass(0.9)).toBe("pot");
    expect(sizeClass(0.8)).toBe("pot");
    expect(sizeClass(0.6)).toBe("merged");
    expect(sizeClass(0.4)).toBe("merged");
    expect(sizeClass(0.3)).toBe("small");
    expect(sizeClass(0.2)).toBe("small");
    expect(sizeClass(0.1)).toBe("min");
  });
  it("repsCapped only for small/min", () => {
    expect(repsCapped("small")).toBe(true);
    expect(repsCapped("min")).toBe(true);
    expect(["overbet","pot","merged"].every(c => !repsCapped(c as never))).toBe(true);
  });
});

// HU, ~30bb deep so SPR ≤ 6. Hero (BTN) faces a small LEAD bet from the BB on a
// dry brick, holding A-high (Ace blocker, low equity). Capped small bet → re-bluff.
function smallBetBrickSpot(heroCards: [number, number], betFrac: number) {
  const gs = new GameState({
    tableSize: 2, bb: 2, stacks: [60, 60],
    positions: ["BTN", "BB"], heroSeat: 0, heroCards, dealerSeat: 0,
  });
  gs.applyAction({ seat: 0, type: "raise", amount: 6 }); // BTN opens
  gs.applyAction({ seat: 1, type: "call", amount: 0 });  // BB calls
  gs.advanceStreet([P("Kd"), P("7s"), P("2c")]);         // flop — dry rainbow brick
  const bet = Math.round(gs.pot * betFrac);
  gs.applyAction({ seat: 1, type: "bet", amount: bet }); // BB leads
  return gs;
}

describe("counter-bluff (re-bluff)", () => {
  it("FIRES vs a TAG small lead bet on a brick with a blocker (heads-up, shallow)", () => {
    const gs = smallBetBrickSpot([P("Ah"), P("4h")], 0.45); // Ace blocker + backdoor, too weak to call
    const r = recommend(gs, TAG, undefined, undefined, undefined, STYLE_GTO);
    expect(r.action).toBe("raise");
    expect(r.reasoning.toLowerCase()).toContain("re-bluff");
  });

  it("NEVER re-bluffs a Station (clicks back, never folds)", () => {
    const gs = smallBetBrickSpot([P("Ah"), P("4h")], 0.45);
    const r = recommend(gs, STATION, undefined, undefined, undefined, STYLE_GTO);
    expect(r.reasoning.toLowerCase()).not.toContain("re-bluff");
  });

  it("NEVER re-bluffs an OVERBET (polar, not capped) — even vs a TAG", () => {
    const gs = smallBetBrickSpot([P("Ah"), P("4h")], 1.3);
    const r = recommend(gs, TAG, undefined, undefined, undefined, STYLE_GTO);
    expect(r.reasoning.toLowerCase()).not.toContain("re-bluff");
  });
});
