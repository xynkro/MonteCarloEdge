import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { estimateVillainRange, TAG, MANIAC, type OpponentProfile } from "../opponent.js";
import { monteCarloEquityVsRange } from "../equity.js";
import { mulberry32 } from "../rng.js";

// Hero KK overpair equity vs the villain's ESTIMATED range on a dry Qs7d2c flop.
function heroEqVs(gs: GameState, profile: OpponentProfile): number {
  const range = estimateVillainRange(gs, 1, profile);
  return monteCarloEquityVsRange({
    hero: [parseCard("Kh"), parseCard("Kd")],
    villainRange: range,
    board: [parseCard("Qs"), parseCard("7d"), parseCard("2c")],
    iterations: 6000, rng: mulberry32(1),
  }).equity;
}
// seat0 (BTN) raises, seat1 (BB) calls, then the flop.
function flopBase() {
  const gs = new GameState({
    tableSize: 2, bb: 2, stacks: [200, 200], positions: ["BTN", "BB"],
    heroSeat: 0, heroCards: [parseCard("Kh"), parseCard("Kd")], dealerSeat: 0,
  });
  gs.applyAction({ seat: 0, type: "raise", amount: 6 });
  gs.applyAction({ seat: 1, type: "call", amount: 0 });
  gs.advanceStreet([parseCard("Qs"), parseCard("7d"), parseCard("2c")]);
  return gs;
}

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

describe("named exploit reads (heuristics-audit G1/G2)", () => {
  it("G1: a donk lead is read WEAKER than a raise (more hero equity)", () => {
    const donk = flopBase();
    donk.applyAction({ seat: 1, type: "bet", amount: donk.pot }); // BB caller donk-leads

    const raise = flopBase();
    raise.applyAction({ seat: 1, type: "check", amount: 0 });
    raise.applyAction({ seat: 0, type: "bet", amount: 4 });
    raise.applyAction({ seat: 1, type: "raise", amount: 12 }); // BB check-raises

    // The donk's capped/weak range leaves hero's overpair worth MORE than vs a raise.
    expect(heroEqVs(donk, TAG)).toBeGreaterThan(heroEqVs(raise, TAG));
  });

  it("G2: a passive (TAG) raise is read TIGHTER than an incoherent (Maniac) raise", () => {
    const mk = () => {
      const gs = flopBase();
      gs.applyAction({ seat: 1, type: "check", amount: 0 });
      gs.applyAction({ seat: 0, type: "bet", amount: 4 });
      gs.applyAction({ seat: 1, type: "raise", amount: 12 });
      return gs;
    };
    // Same raise, different villain type: the TAG's raise is value-heavy (hero crushed),
    // the Maniac's raise is wide + air (hero ahead more often).
    expect(heroEqVs(mk(), TAG)).toBeLessThan(heroEqVs(mk(), MANIAC));
  });
});
