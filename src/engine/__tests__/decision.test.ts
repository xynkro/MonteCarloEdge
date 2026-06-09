import { describe, it, expect } from "vitest";
import { makeCard, parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";
import { TAG, STATION, NIT, comboPercentile } from "../opponent.js";
import { type Combo } from "../range.js";

function huState(
  heroCards: readonly [number, number],
  heroSeat = 0,
) {
  return new GameState({
    tableSize: 2,
    bb: 2,
    stacks: [200, 200],
    positions: ["BTN", "BB"],
    heroSeat,
    heroCards,
    dealerSeat: 0,
  });
}

function sixMaxState(
  heroCards: readonly [number, number],
  heroSeat: number,
  positions: string[],
) {
  return new GameState({
    tableSize: 6,
    bb: 2,
    stacks: [200, 200, 200, 200, 200, 200],
    positions,
    heroSeat,
    heroCards,
    dealerSeat: 3,
  });
}

describe("preflop first-in", () => {
  it("AA raises from BTN", () => {
    const gs = huState([makeCard(12, 0), makeCard(12, 1)]); // AcAd
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.amount).toBeGreaterThan(0);
  });

  it("AA raises from UTG 6-max", () => {
    const gs = sixMaxState(
      [makeCard(12, 0), makeCard(12, 1)],
      0,
      ["UTG", "MP", "CO", "BTN", "SB", "BB"],
    );
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
  });

  it("72o folds from UTG 6-max", () => {
    const gs = sixMaxState(
      [makeCard(5, 0), makeCard(0, 1)], // 7c2d
      0,
      ["UTG", "MP", "CO", "BTN", "SB", "BB"],
    );
    const rec = recommend(gs);
    expect(rec.action).toBe("fold");
  });

  it("KTs raises from BTN 6-max", () => {
    const gs = sixMaxState(
      [makeCard(11, 2), makeCard(8, 2)], // KhTh
      3,
      ["UTG", "MP", "CO", "BTN", "SB", "BB"],
    );
    // Others fold first
    gs.applyAction({ seat: 0, type: "fold", amount: 0 }); // UTG
    gs.applyAction({ seat: 1, type: "fold", amount: 0 }); // MP
    gs.applyAction({ seat: 2, type: "fold", amount: 0 }); // CO
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
  });
});

describe("preflop facing raise", () => {
  it("BB defends AKo vs BTN open", () => {
    const gs = huState([makeCard(12, 0), makeCard(11, 1)], 1); // AcKd, hero is BB
    gs.applyAction({ seat: 0, type: "raise", amount: 5 }); // BTN raises
    const rec = recommend(gs);
    expect(["call", "raise"]).toContain(rec.action);
  });

  it("BB folds 72o vs BTN open", () => {
    const gs = huState([makeCard(5, 0), makeCard(0, 1)], 1); // 7c2d, hero is BB
    gs.applyAction({ seat: 0, type: "raise", amount: 5 });
    const rec = recommend(gs);
    expect(rec.action).toBe("fold");
  });
});

describe("postflop decisions", () => {
  it("bets with strong equity on dry board", () => {
    const gs = huState([makeCard(12, 0), makeCard(11, 0)]); // AcKc
    gs.applyAction({ seat: 0, type: "raise", amount: 5 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    // Flop: Ah 7d 2s — hero has TPTK
    gs.advanceStreet([makeCard(12, 2), makeCard(5, 1), makeCard(0, 3)]);
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    const rec = recommend(gs, TAG);
    expect(["bet", "raise"]).toContain(rec.action);
    expect(rec.equity).toBeGreaterThan(0.5);
  });

  it("folds with no equity facing a bet", () => {
    const gs = huState([makeCard(5, 0), makeCard(4, 1)]); // 7c6d
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    // Flop: As Kh Qd — hero has nothing
    gs.advanceStreet([makeCard(12, 3), makeCard(11, 2), makeCard(10, 1)]);
    gs.applyAction({ seat: 1, type: "bet", amount: 4 });
    const rec = recommend(gs, TAG);
    // Should fold or check — definitely not raise
    expect(rec.equity).toBeLessThan(0.5);
    if (rec.action !== "fold") {
      // If calling, equity should at least cover pot odds
      expect(rec.equity).toBeGreaterThanOrEqual(rec.potOdds);
    }
  });

  // Regression: on the RIVER there are no future streets, so realized equity ==
  // all-in equity — the OOP realization discount must NOT apply (it was wrongly
  // folding marginal OOP river calls near the pot-odds threshold).
  it("does not over-discount a clear OOP river call (river realization = 1)", () => {
    const gs = huState([makeCard(11, 0), makeCard(10, 0)], 1); // hero = BB (OOP) KcQc
    gs.applyAction({ seat: 0, type: "raise", amount: 5 }); // BTN
    gs.applyAction({ seat: 1, type: "call", amount: 0 });  // BB calls
    // Flop K♠ 9♦ 3♣ — hero top pair, good kicker
    gs.advanceStreet([makeCard(11, 3), makeCard(7, 1), makeCard(1, 3)]);
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    // Turn 4♥
    gs.advanceStreet([makeCard(2, 2)]);
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    // River 2♠ — hero still top pair KQ; faces a smallish bet with good pot odds.
    gs.advanceStreet([makeCard(0, 3)]);
    gs.applyAction({ seat: 0, type: "bet", amount: 4 });
    const rec = recommend(gs, TAG);
    // Top pair good kicker OOP vs a small river bet must not be folded; and any
    // call must still respect pot odds (which the river fix preserves).
    expect(rec.action).not.toBe("fold");
    if (rec.action === "call") expect(rec.equity).toBeGreaterThanOrEqual(rec.potOdds);
  });
});

describe("comboPercentile", () => {
  it("AA is in top 1%", () => {
    const aa: Combo = [makeCard(12, 0), makeCard(12, 1)];
    expect(comboPercentile(aa)).toBeLessThan(0.01);
  });

  it("72o is in bottom 20%", () => {
    const c: Combo = [makeCard(0, 0), makeCard(5, 1)];
    expect(comboPercentile(c)).toBeGreaterThan(0.8);
  });

  it("stronger hands have lower percentile", () => {
    const aa: Combo = [makeCard(12, 0), makeCard(12, 1)];
    const kk: Combo = [makeCard(11, 0), makeCard(11, 1)];
    const t2o: Combo = [makeCard(0, 0), makeCard(8, 1)];
    expect(comboPercentile(aa)).toBeLessThan(comboPercentile(kk));
    expect(comboPercentile(kk)).toBeLessThan(comboPercentile(t2o));
  });
});

describe("recommendation has valid fields", () => {
  it("includes reasoning string", () => {
    const gs = huState([makeCard(12, 0), makeCard(12, 1)]);
    const rec = recommend(gs);
    expect(rec.reasoning.length).toBeGreaterThan(0);
  });

  it("equity is between 0 and 1", () => {
    const gs = huState([makeCard(12, 0), makeCard(11, 0)]);
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(8, 0), makeCard(5, 1), makeCard(2, 2)]);
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    const rec = recommend(gs, TAG);
    expect(rec.equity).toBeGreaterThanOrEqual(0);
    expect(rec.equity).toBeLessThanOrEqual(1);
  });
});
