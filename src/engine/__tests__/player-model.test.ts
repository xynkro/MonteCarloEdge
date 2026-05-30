import { describe, it, expect } from "vitest";
import { makeCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { emptyStats, observeHand, blendProfile, playerRead } from "../player-model.js";
import { TAG } from "../opponent.js";

function huState() {
  return new GameState({
    tableSize: 2, bb: 2, stacks: [200, 200], positions: ["BTN", "BB"],
    heroSeat: 0, heroCards: [makeCard(12, 0), makeCard(11, 0)], dealerSeat: 0,
  });
}

describe("observeHand", () => {
  it("counts VPIP when villain calls preflop", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    const stats = observeHand(emptyStats(), gs, 1);
    expect(stats.hands).toBe(1);
    expect(stats.vpipActs).toBe(1);
    expect(stats.vpipOpps).toBe(1);
  });

  it("does not count VPIP when villain folds preflop", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "fold", amount: 0 });
    const stats = observeHand(emptyStats(), gs, 1);
    expect(stats.vpipActs).toBe(0);
    expect(stats.vpipOpps).toBe(1);
  });

  it("counts PFR when villain raises", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    const stats = observeHand(emptyStats(), gs, 0);
    expect(stats.pfrActs).toBe(1);
  });

  it("counts a 3-bet", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "raise", amount: 18 });
    const stats = observeHand(emptyStats(), gs, 1);
    expect(stats.threeBetOpps).toBe(1);
    expect(stats.threeBetActs).toBe(1);
  });

  it("accumulates across hands", () => {
    let stats = emptyStats();
    for (let i = 0; i < 5; i++) {
      const gs = huState();
      gs.applyAction({ seat: 0, type: "raise", amount: 6 });
      gs.applyAction({ seat: 1, type: i < 3 ? "call" : "fold", amount: 0 });
      stats = observeHand(stats, gs, 1);
    }
    expect(stats.hands).toBe(5);
    expect(stats.vpipActs).toBe(3);
    expect(stats.vpipOpps).toBe(5);
  });
});

describe("blendProfile", () => {
  it("with no data returns prior values", () => {
    const p = blendProfile(TAG, emptyStats());
    expect(p.vpip).toBeCloseTo(TAG.vpip, 5);
    expect(p.pfr).toBeCloseTo(TAG.pfr, 5);
  });

  it("shifts toward observed with a large sample", () => {
    const stats = emptyStats();
    stats.vpipActs = 80; stats.vpipOpps = 100; // observed 80% VPIP (very loose)
    const p = blendProfile(TAG, stats);
    // Prior 22%, observed 80%, weight 12 -> (0.22*12 + 80)/(12+100) ≈ 0.738
    expect(p.vpip).toBeGreaterThan(0.6);
    expect(p.vpip).toBeLessThan(0.8);
  });

  it("small samples stay near the prior", () => {
    const stats = emptyStats();
    stats.vpipActs = 2; stats.vpipOpps = 2;
    const p = blendProfile(TAG, stats);
    expect(p.vpip).toBeLessThan(0.4); // 2 hands shouldn't swing it much
  });
});

describe("playerRead", () => {
  it("returns null with too few hands", () => {
    expect(playerRead(emptyStats())).toBeNull();
  });

  it("identifies a calling station", () => {
    const stats = emptyStats();
    stats.hands = 20;
    stats.vpipActs = 12; stats.vpipOpps = 20; // 60% vpip
    stats.pfrActs = 2; stats.pfrOpps = 20; // 10% pfr
    expect(playerRead(stats)).toContain("calls");
  });
});
