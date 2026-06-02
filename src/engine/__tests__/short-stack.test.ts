import { describe, it, expect } from "vitest";
import { makeCard, parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";

// Helper: a 6-max game with a chosen effective stack (in BB) for everyone.
function sixMax(heroCards: readonly [number, number], heroSeat: number, positions: string[], bbStack: number) {
  const bb = 2;
  return new GameState({
    tableSize: 6,
    bb,
    stacks: Array(6).fill(bbStack * bb),
    positions,
    heroSeat,
    heroCards,
    dealerSeat: 3,
  });
}
const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];

describe("short-stack preflop push/fold", () => {
  it("open-JAMS a strong ace from the button at 15bb (no min-raise)", () => {
    const gs = sixMax([parseCard("As"), parseCard("9s")], 3, POS, 15); // BTN A9s, 15bb
    gs.applyAction({ seat: 0, type: "fold", amount: 0 });
    gs.applyAction({ seat: 1, type: "fold", amount: 0 });
    gs.applyAction({ seat: 2, type: "fold", amount: 0 });
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    // All-in = the full stack, not a 2.5bb min-raise.
    expect(rec.amount).toBe(gs.stacks[3]! + gs.streetInvested[3]!);
    expect(rec.reasoning.toLowerCase()).toContain("all-in");
  });

  it("FOLDS a marginal offsuit hand from UTG at 15bb (position cap)", () => {
    const gs = sixMax([parseCard("Kc"), parseCard("9d")], 0, POS, 15); // UTG K9o
    const rec = recommend(gs);
    expect(rec.action).toBe("fold");
  });

  it("still jams AA from UTG at 15bb (premiums clear any cap)", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 0, POS, 12);
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.amount).toBe(gs.stacks[0]! + gs.streetInvested[0]!);
  });

  it("does NOT jam when deep (100bb) — normal open raise", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 3, POS, 100);
    gs.applyAction({ seat: 0, type: "fold", amount: 0 });
    gs.applyAction({ seat: 1, type: "fold", amount: 0 });
    gs.applyAction({ seat: 2, type: "fold", amount: 0 });
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.amount).toBeLessThan(gs.stacks[3]! * 0.25); // a raise, not a shove
  });

  it("re-jams or folds (never flats) facing a raise when short", () => {
    const gs = sixMax([parseCard("Ah"), parseCard("Qh")], 3, POS, 13); // BTN AQs vs open
    gs.applyAction({ seat: 0, type: "raise", amount: 5 }); // UTG opens
    gs.applyAction({ seat: 1, type: "fold", amount: 0 });
    gs.applyAction({ seat: 2, type: "fold", amount: 0 });
    const rec = recommend(gs);
    expect(["raise", "fold"]).toContain(rec.action);
    if (rec.action === "raise") {
      expect(rec.amount).toBe(gs.stacks[3]! + gs.streetInvested[3]!); // a jam
    }
  });
});

describe("effective-stack-aware sizing", () => {
  it("never bets more than the shortest live opponent can call", () => {
    // Hero very deep, single villain very short.
    const gs = new GameState({
      tableSize: 2,
      bb: 2,
      stacks: [400, 14], // hero 200bb, villain 7bb
      positions: ["BTN", "BB"],
      heroSeat: 0,
      heroCards: [parseCard("Ac"), parseCard("Ad")],
      dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    gs.advanceStreet([parseCard("Ah"), parseCard("7c"), parseCard("2d")]); // top set
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    const rec = recommend(gs);
    if (rec.action === "bet") {
      // Can't get called for more than the villain's remaining stack.
      expect(rec.amount).toBeLessThanOrEqual(gs.stacks[1]!);
    }
  });
});
