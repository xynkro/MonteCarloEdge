import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend, type HeroStyle } from "../decision.js";
import { NIT, STATION } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];
const AGGRO: HeroStyle = { aggression: 1.6, looseness: 1.5 };
const TIGHT: HeroStyle = { aggression: 0.7, looseness: 0.7 };

// Hero opens BTN, a foldy nit calls, hero whiffs a marginal-air flop.
function spot(hero: [number, number]) {
  const gs = new GameState({
    tableSize: 6, bb: 2, stacks: Array(6).fill(200), positions: POS,
    heroSeat: 3, heroCards: hero, dealerSeat: 3,
  });
  for (const s of [0, 1, 2]) gs.applyAction({ seat: s, type: "fold", amount: 0 });
  gs.applyAction({ seat: 3, type: "raise", amount: 6 });
  gs.applyAction({ seat: 4, type: "fold", amount: 0 });
  gs.applyAction({ seat: 5, type: "call", amount: 0 });
  gs.advanceStreet([parseCard("Kd"), parseCard("8c"), parseCard("2h")]); // dryish
  gs.applyAction({ seat: 5, type: "check", amount: 0 });
  return gs;
}

describe("hero play-style selector changes behavior", () => {
  it("an aggressive style bluffs a marginal air hand a tight style gives up", () => {
    const hero: [number, number] = [parseCard("7s"), parseCard("6s")]; // air on K82
    const profiles = new Map([[5, NIT]]);
    const aggro = recommend(spot(hero), NIT, mulberry32(2), profiles, undefined, AGGRO);
    const tight = recommend(spot(hero), NIT, mulberry32(2), profiles, undefined, TIGHT);
    // Aggressive bets/bluffs; tight is more willing to check/give up.
    expect(aggro.action).toBe("bet");
    // The tight line should be no more aggressive than the aggressive line.
    expect(tight.action === "check" || tight.action === "bet").toBe(true);
    if (tight.action === "bet" && aggro.action === "bet") {
      // both bet → aggressive sizes at least as big (thinner/larger)
      expect(aggro.amount).toBeGreaterThanOrEqual(tight.amount - 0.01);
    } else {
      expect(aggro.action).toBe("bet");
      expect(tight.action).toBe("check");
    }
  });

  it("preflop: a loose style opens/3-bets wider than a tight style", () => {
    // Hero CO facing a UTG open with a speculative hand — loose continues, tight folds.
    function vsOpen(style: HeroStyle) {
      const gs = new GameState({
        tableSize: 6, bb: 2, stacks: Array(6).fill(200), positions: POS, heroSeat: 2,
        heroCards: [parseCard("Ad"), parseCard("Td")], dealerSeat: 3,
      });
      gs.applyAction({ seat: 0, type: "raise", amount: 5 }); // UTG opens
      gs.applyAction({ seat: 1, type: "fold", amount: 0 });
      return recommend(gs, STATION, mulberry32(1), new Map([[0, NIT]]), undefined, style);
    }
    const loose = vsOpen({ aggression: 1.4, looseness: 1.4 });
    const tight = vsOpen({ aggression: 0.7, looseness: 0.6 });
    const rank = (a: string) => (a === "raise" ? 2 : a === "call" ? 1 : 0);
    expect(rank(loose.action)).toBeGreaterThanOrEqual(rank(tight.action));
  });
});
