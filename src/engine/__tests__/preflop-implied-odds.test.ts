import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";
import { TAG } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];

function btnVsOpen(hero: [number, number], deepBB: number) {
  const gs = new GameState({
    tableSize: 6, bb: 2, stacks: Array(6).fill(deepBB * 2), positions: POS, heroSeat: 3,
    heroCards: hero, dealerSeat: 3,
  });
  gs.applyAction({ seat: 0, type: "raise", amount: 5 }); // UTG opens 2.5x
  gs.applyAction({ seat: 1, type: "fold", amount: 0 });
  gs.applyAction({ seat: 2, type: "fold", amount: 0 });
  return recommend(gs, TAG, mulberry32(1), new Map([[0, TAG]]));
}

describe("preflop implied odds (the 'pocket 2s asked to fold' fix)", () => {
  it("set-mines a small pair vs a single open when deep", () => {
    const rec = btnVsOpen([parseCard("2c"), parseCard("2d")], 100); // 100bb deep
    expect(rec.action).toBe("call");
    expect(rec.reasoning.toLowerCase()).toContain("implied");
  });

  it("does NOT set-mine the same pair when shallow (no implied odds / 5-10 rule)", () => {
    const rec = btnVsOpen([parseCard("2c"), parseCard("2d")], 14); // ~14bb, call is too big a % of stack
    expect(rec.action).not.toBe("call"); // jam or fold, not a deep set-mine flat
  });

  it("continues a suited ace vs an open (call or 3-bet, never fold)", () => {
    const rec = btnVsOpen([parseCard("Ad"), parseCard("Td")], 100);
    expect(rec.action).not.toBe("fold");
  });

  it("still folds true junk (72o) facing an open", () => {
    const rec = btnVsOpen([parseCard("7c"), parseCard("2d")], 100);
    expect(rec.action).toBe("fold");
  });
});
