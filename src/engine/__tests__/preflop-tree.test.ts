import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";

const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];
function sixMax(heroCards: readonly [number, number], heroSeat: number, bbStack = 100) {
  return new GameState({
    tableSize: 6, bb: 2, stacks: Array(6).fill(bbStack * 2),
    positions: POS, heroSeat, heroCards, dealerSeat: 3,
  });
}

describe("preflop tree — 4-bet / 5-bet / squeeze", () => {
  it("4-bets AA when our open gets 3-bet", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 2); // CO opens, BTN 3-bets
    gs.applyAction({ seat: 2, type: "raise", amount: 5 }); // hero (CO) opens
    gs.applyAction({ seat: 3, type: "raise", amount: 16 }); // BTN 3-bets
    gs.applyAction({ seat: 4, type: "fold", amount: 0 });
    gs.applyAction({ seat: 5, type: "fold", amount: 0 });
    // action back on hero (CO) facing a 3-bet
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.reasoning.toLowerCase()).toContain("4-bet");
  });

  it("folds a weak hand facing a 3-bet (no flat, no 4-bet)", () => {
    const gs = sixMax([parseCard("9c"), parseCard("7d")], 2); // CO opened 97o
    gs.applyAction({ seat: 2, type: "raise", amount: 5 });
    gs.applyAction({ seat: 3, type: "raise", amount: 16 });
    gs.applyAction({ seat: 4, type: "fold", amount: 0 });
    gs.applyAction({ seat: 5, type: "fold", amount: 0 });
    const rec = recommend(gs);
    expect(rec.action).toBe("fold");
  });

  it("5-bet JAMS KK when our open is 3-bet then we 4-bet and get 4-bet... i.e. facing a 4-bet", () => {
    const gs = sixMax([parseCard("Kc"), parseCard("Kd")], 3); // BTN
    gs.applyAction({ seat: 2, type: "raise", amount: 5 });  // CO opens
    gs.applyAction({ seat: 3, type: "raise", amount: 16 }); // hero (BTN) 3-bets
    gs.applyAction({ seat: 4, type: "fold", amount: 0 });
    gs.applyAction({ seat: 5, type: "fold", amount: 0 });
    gs.applyAction({ seat: 2, type: "raise", amount: 40 }); // CO 4-bets → hero faces a 4-bet
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.amount).toBe(gs.stacks[3]! + gs.streetInvested[3]!); // all-in jam
    expect(rec.reasoning.toLowerCase()).toContain("5-bet");
  });

  it("SQUEEZES a strong hand facing an open + a caller", () => {
    const gs = sixMax([parseCard("Ah"), parseCard("Kh")], 4); // SB
    gs.applyAction({ seat: 2, type: "raise", amount: 5 }); // CO opens
    gs.applyAction({ seat: 3, type: "call", amount: 0 });  // BTN calls
    // action to SB (hero) — open + 1 caller → squeeze spot
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.reasoning.toLowerCase()).toContain("squeeze");
  });

  it("opener facing a non-BB 3-bet is the percentile heuristic (not solver, not mislabeled chart)", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 2); // hero CO opens
    gs.applyAction({ seat: 2, type: "raise", amount: 5 });
    gs.applyAction({ seat: 3, type: "raise", amount: 16 }); // BTN (not BB) 3-bets → off-chart
    const rec = recommend(gs);
    expect(rec.source).toBe("heuristic");
  });

  it("BB 3-bets a premium vs an open, sourced from the chart", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 5); // hero is BB
    gs.applyAction({ seat: 2, type: "raise", amount: 5 }); // CO opens
    gs.applyAction({ seat: 3, type: "fold", amount: 0 }); // BTN folds
    gs.applyAction({ seat: 4, type: "fold", amount: 0 }); // SB folds
    const rec = recommend(gs); // action to BB (hero)
    expect(rec.action).toBe("raise");
    expect(rec.source).toBe("chart");
    expect(rec.reasoning.toLowerCase()).toContain("3-bet");
  });

  it("opener facing a BB 3-bet 4-bets a premium, sourced from the chart", () => {
    const gs = sixMax([parseCard("Ac"), parseCard("Ad")], 2); // hero CO opens
    gs.applyAction({ seat: 2, type: "raise", amount: 5 });
    gs.applyAction({ seat: 3, type: "fold", amount: 0 });
    gs.applyAction({ seat: 4, type: "fold", amount: 0 });
    gs.applyAction({ seat: 5, type: "raise", amount: 16 }); // BB 3-bets → hero faces a BB 3-bet
    const rec = recommend(gs);
    expect(rec.action).toBe("raise");
    expect(rec.source).toBe("chart");
    expect(rec.reasoning.toLowerCase()).toContain("4-bet");
  });
});
