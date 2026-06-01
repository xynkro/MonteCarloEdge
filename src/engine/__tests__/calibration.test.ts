import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";
import { STATION } from "../opponent.js";
import { mulberry32 } from "../rng.js";

// Regression for the multiway-limped-pot equity bug: a near-nut hand (Kings
// full) on A-A-K-K, checked 5 ways to the river, must be VALUE-BET, not checked.
// The bug modeled passive limpers with a tight ace-heavy range, tanking equity
// to ~28% and checking the near-nuts.
describe("multiway limped-pot calibration", () => {
  it("value-bets Kings-full on AAKK 5-way (does not check the near-nuts)", () => {
    const hero: [number, number] = [parseCard("6h"), parseCard("Kd")];
    const board = ["Ah", "Kh", "7s", "Ad", "Ks"].map(parseCard);
    const gs = new GameState({
      tableSize: 6, bb: 2, stacks: [100, 100, 100, 100, 100, 100],
      positions: ["UTG", "MP", "CO", "BTN", "SB", "BB"],
      heroSeat: 3, heroCards: hero, dealerSeat: 3,
    });
    for (const s of [0, 1, 2, 3, 4]) {
      gs.applyAction({ seat: s, type: gs.toCall(s) > 0 ? "call" : "check", amount: 0 });
    }
    gs.applyAction({ seat: 5, type: "check", amount: 0 });
    gs.advanceStreet([board[0]!, board[1]!, board[2]!]);
    for (const s of [4, 5, 0, 1, 2, 3]) gs.applyAction({ seat: s, type: "check", amount: 0 });
    gs.advanceStreet([board[3]!]);
    for (const s of [4, 5, 0, 1, 2, 3]) gs.applyAction({ seat: s, type: "check", amount: 0 });
    gs.advanceStreet([board[4]!]);
    for (const s of [4, 5, 0, 1, 2]) gs.applyAction({ seat: s, type: "check", amount: 0 });

    const rec = recommend(gs, STATION, mulberry32(0x1234));
    // Equity must be far above the buggy ~28%, and the action a value bet.
    expect(rec.equity).toBeGreaterThan(0.42);
    expect(rec.action).toBe("bet");
  });
});
