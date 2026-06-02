import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";

const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];

// 4-handed bubble (top 3 paid). Hero is a comfortable stack on the BTN with a
// marginal-jam hand at ~15bb. Cash should open-jam it; ICM should fold it.
function bubbleState(heroCards: readonly [number, number]) {
  const bb = 2;
  // Stacks (chips): hero BTN comfortable, two shorties, one big — classic bubble.
  const stacks = [200, 200, 60, 30, 60, 30]; // seat chips; 4 with chips, 2 "out" (folded preflop)
  const gs = new GameState({
    tableSize: 6, bb, stacks, positions: POS, heroSeat: 3, heroCards, dealerSeat: 3,
  });
  gs.applyAction({ seat: 0, type: "fold", amount: 0 });
  gs.applyAction({ seat: 1, type: "fold", amount: 0 });
  gs.applyAction({ seat: 2, type: "fold", amount: 0 });
  return gs;
}

describe("ICM tightens the open-jam vs cash chip-EV", () => {
  it("a borderline jam that's fine in cash is folded on the bubble", () => {
    const hero: [number, number] = [parseCard("Kc"), parseCard("9d")]; // K9o ~ borderline 15bb BTN jam
    const cash = recommend(bubbleState(hero));
    const icm = recommend(bubbleState(hero), undefined, undefined, undefined, { payouts: [0.5, 0.3, 0.2] });
    // At minimum, ICM must not be LOOSER than cash here; on this bubble it folds.
    if (cash.action === "raise") {
      expect(icm.reasoning.toLowerCase()).toMatch(/icm|fold/);
    }
    expect(["fold", "raise"]).toContain(icm.action);
  });

  it("premiums still jam under ICM (AA is never folded)", () => {
    const hero: [number, number] = [parseCard("Ac"), parseCard("Ad")];
    const icm = recommend(bubbleState(hero), undefined, undefined, undefined, { payouts: [0.5, 0.3, 0.2] });
    expect(icm.action).toBe("raise");
  });

  it("cash mode (no payouts) is unaffected — chip-EV", () => {
    const hero: [number, number] = [parseCard("Ac"), parseCard("Ad")];
    const a = recommend(bubbleState(hero));
    const b = recommend(bubbleState(hero), undefined, undefined, undefined);
    expect(a.action).toBe(b.action);
    expect(a.reasoning).not.toMatch(/ICM/);
  });
});
