import { describe, it, expect } from "vitest";
import { makeCard } from "../cards.js";
import { GameState } from "../game-state.js";

function huState(heroSeat = 0) {
  return new GameState({
    tableSize: 2,
    bb: 2,
    stacks: [100, 100],
    positions: ["BTN", "BB"],
    heroSeat,
    heroCards: [makeCard(12, 0), makeCard(11, 0)], // AcKc
    dealerSeat: 0,
  });
}

describe("blind posting", () => {
  it("HU: BTN posts SB, other posts BB", () => {
    const gs = huState();
    // BTN (seat 0) is dealer/SB: invested 1
    // BB (seat 1): invested 2
    expect(gs.invested[0]).toBe(1);
    expect(gs.invested[1]).toBe(2);
    expect(gs.pot).toBe(3);
    expect(gs.stacks[0]).toBe(99);
    expect(gs.stacks[1]).toBe(98);
    expect(gs.currentBet).toBe(2);
  });

  it("6-max: SB is left of dealer, BB is left of SB", () => {
    const gs = new GameState({
      tableSize: 6,
      bb: 2,
      stacks: [100, 100, 100, 100, 100, 100],
      positions: ["UTG", "MP", "CO", "BTN", "SB", "BB"],
      heroSeat: 0,
      heroCards: [makeCard(12, 0), makeCard(11, 0)],
      dealerSeat: 3,
    });
    // SB = seat 4, BB = seat 5
    expect(gs.invested[4]).toBe(1);
    expect(gs.invested[5]).toBe(2);
    expect(gs.pot).toBe(3);
  });
});

describe("action order", () => {
  it("HU preflop: BTN acts first", () => {
    const gs = huState();
    expect(gs.nextToAct()).toBe(0); // BTN
  });

  it("HU postflop: BB acts first", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 }); // BTN calls
    gs.applyAction({ seat: 1, type: "check", amount: 0 }); // BB checks
    expect(gs.roundComplete()).toBe(true);
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    expect(gs.nextToAct()).toBe(1); // BB
  });
});

describe("fold / check / call / bet / raise", () => {
  it("fold removes player", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "fold", amount: 0 });
    expect(gs.folded[0]).toBe(true);
    expect(gs.activeSeatCount).toBe(1);
    expect(gs.isComplete()).toBe(true);
  });

  it("call matches current bet", () => {
    const gs = huState();
    // BTN needs to call 1 more (posted 1 SB, current bet 2)
    expect(gs.toCall(0)).toBe(1);
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    expect(gs.streetInvested[0]).toBe(2);
    expect(gs.pot).toBe(4);
  });

  it("raise increases current bet and resets action", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 }); // raise to 6
    expect(gs.currentBet).toBe(6);
    expect(gs.pot).toBe(8); // 1 SB + 2 BB + 5 more from BTN
    // BB needs to act again
    expect(gs.nextToAct()).toBe(1);
  });

  it("bet when no current bet", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    expect(gs.currentBet).toBe(0);
    gs.applyAction({ seat: 1, type: "bet", amount: 3 });
    expect(gs.currentBet).toBe(3);
    expect(gs.pot).toBe(7); // 4 preflop + 3
  });
});

describe("pot odds", () => {
  it("returns 0 when nothing to call", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    expect(gs.potOdds(1)).toBe(0);
  });

  it("correct when facing a bet", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    gs.applyAction({ seat: 1, type: "bet", amount: 4 }); // bet 4 into 4
    // BTN to call 4 into pot of 8, odds = 4/12 = 0.333
    // Wait: pot is now 8 (4 preflop + 4 bet), toCall = 4, potAfterCall = 12
    expect(gs.potOdds(0)).toBeCloseTo(4 / 12, 3);
  });
});

describe("street transitions", () => {
  it("advanceStreet resets betting state", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    expect(gs.roundComplete()).toBe(true);
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    expect(gs.street).toBe("flop");
    expect(gs.board.length).toBe(3);
    expect(gs.currentBet).toBe(0);
    expect(gs.streetInvested[0]).toBe(0);
    expect(gs.streetInvested[1]).toBe(0);
  });

  it("full hand through all streets", () => {
    const gs = huState();
    // Preflop: call/check
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    // Flop: check/check
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(3, 3)]);
    expect(gs.street).toBe("turn");
    // Turn: check/check
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(4, 0)]);
    expect(gs.street).toBe("river");
    // River: check/check
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    expect(gs.isComplete()).toBe(true);
    expect(gs.board.length).toBe(5);
  });
});

describe("legal actions", () => {
  it("facing bet: fold, call, raise", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    const legal = gs.legalActionsFor(1);
    expect(legal).toContain("fold");
    expect(legal).toContain("call");
    expect(legal).toContain("raise");
  });

  it("no bet: check, bet", () => {
    const gs = huState();
    gs.applyAction({ seat: 0, type: "call", amount: 0 });
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.advanceStreet([makeCard(0, 0), makeCard(1, 1), makeCard(2, 2)]);
    const legal = gs.legalActionsFor(1);
    expect(legal).toContain("check");
    expect(legal).toContain("bet");
    expect(legal).not.toContain("fold");
  });
});

describe("clone", () => {
  it("produces independent copy", () => {
    const gs = huState();
    const clone = gs.clone();
    gs.applyAction({ seat: 0, type: "fold", amount: 0 });
    expect(gs.folded[0]).toBe(true);
    expect(clone.folded[0]).toBe(false);
    expect(clone.actions.length).toBe(0);
  });
});

describe("effective stack and SPR", () => {
  it("effective stack is the shorter stack", () => {
    const gs = new GameState({
      tableSize: 2,
      bb: 2,
      stacks: [50, 100],
      positions: ["BTN", "BB"],
      heroSeat: 0,
      heroCards: [makeCard(12, 0), makeCard(11, 0)],
      dealerSeat: 0,
    });
    // After blinds: stacks are [49, 98], invested [1, 2]
    // Effective = min(49+1, 98+2) = 50
    expect(gs.effectiveStack()).toBe(50);
  });

  it("SPR = effective stack / pot", () => {
    const gs = huState();
    // pot=3, effective=min(99+1,98+2)=100
    expect(gs.spr()).toBeCloseTo(100 / 3, 1);
  });
});
