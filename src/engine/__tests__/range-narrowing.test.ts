import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { estimateVillainRange, TAG } from "../opponent.js";
import { monteCarloEquityVsRange } from "../equity.js";
import { mulberry32 } from "../rng.js";

// Build a HU single-raised-pot flop, then let the BB (villain, seat 1) either
// check or fire a pot-sized bet, and read hero's equity vs the estimated range.
function flopState(villainAction: "check" | "betbig") {
  const gs = new GameState({
    tableSize: 2,
    bb: 2,
    stacks: [200, 200],
    positions: ["BTN", "BB"],
    heroSeat: 0,
    heroCards: [parseCard("Kh"), parseCard("Kd")], // overpair
    dealerSeat: 0,
  });
  gs.applyAction({ seat: 0, type: "raise", amount: 6 });
  gs.applyAction({ seat: 1, type: "call", amount: 0 });
  gs.advanceStreet([parseCard("Qs"), parseCard("7d"), parseCard("2c")]); // dry
  if (villainAction === "check") {
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
  } else {
    gs.applyAction({ seat: 1, type: "bet", amount: gs.pot }); // pot-sized lead
  }
  return gs;
}

describe("postflop range narrowing (frozen-range fix)", () => {
  it("a big bet narrows the villain to a stronger range than a check", () => {
    const checkRange = estimateVillainRange(flopState("check"), 1, TAG);
    const betRange = estimateVillainRange(flopState("betbig"), 1, TAG);
    expect(checkRange.size).toBeGreaterThan(0);
    expect(betRange.size).toBeGreaterThan(0);

    const hero: [number, number] = [parseCard("Kh"), parseCard("Kd")];
    const board = [parseCard("Qs"), parseCard("7d"), parseCard("2c")];
    const eqVsCheck = monteCarloEquityVsRange({
      hero, villainRange: checkRange, board, iterations: 6000, rng: mulberry32(1),
    }).equity;
    const eqVsBet = monteCarloEquityVsRange({
      hero, villainRange: betRange, board, iterations: 6000, rng: mulberry32(1),
    }).equity;

    // Hero's overpair is worth materially LESS facing a pot bet than facing a
    // check — the whole point of the fix (no more frozen, over-optimistic range).
    expect(eqVsBet).toBeLessThan(eqVsCheck);
  });

  it("leaves the range unchanged before the villain acts postflop", () => {
    // Flop just dealt, villain hasn't acted → no narrowing applied.
    const gs = new GameState({
      tableSize: 2, bb: 2, stacks: [200, 200], positions: ["BTN", "BB"],
      heroSeat: 0, heroCards: [parseCard("Kh"), parseCard("Kd")], dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    gs.advanceStreet([parseCard("Qs"), parseCard("7d"), parseCard("2c")]);
    const r = estimateVillainRange(gs, 1, TAG);
    expect(r.size).toBeGreaterThan(20); // still the full continuing range
  });
});
