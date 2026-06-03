import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";
import { STATION, NIT } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const POS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];

describe("hero no longer folds live draws (implied odds / continue)", () => {
  it("continues a flush draw facing a turn bet vs a payable opponent (call or raise, not fold)", () => {
    const gs = new GameState({
      tableSize: 2, bb: 2, stacks: [400, 400], positions: ["BTN", "BB"],
      heroSeat: 0, heroCards: [parseCard("Ah"), parseCard("3h")], dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    gs.advanceStreet([parseCard("Kh"), parseCard("7h"), parseCard("2c")]); // flop
    gs.applyAction({ seat: 1, type: "check", amount: 0 });
    gs.applyAction({ seat: 0, type: "check", amount: 0 });
    gs.advanceStreet([parseCard("9s")]); // turn — bare nut flush draw, ~19%
    gs.applyAction({ seat: 1, type: "bet", amount: 5 });
    const rec = recommend(gs, STATION, mulberry32(1), new Map([[1, STATION]]));
    expect(rec.action).not.toBe("fold"); // the draw is not abandoned
  });

  it("folds a bare gutshot with no implied odds when shallow vs a nit", () => {
    const gs = new GameState({
      tableSize: 2, bb: 2, stacks: [40, 40], positions: ["BTN", "BB"], // shallow
      heroSeat: 0, heroCards: [parseCard("Js"), parseCard("Td")], dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    gs.advanceStreet([parseCard("8c"), parseCard("4d"), parseCard("2h")]); // J-high, gutshot-ish, low equity
    gs.applyAction({ seat: 1, type: "bet", amount: 10 }); // big bet, shallow → no implied odds
    const rec = recommend(gs, NIT, mulberry32(1), new Map([[1, NIT]]));
    expect(rec.action).toBe("fold");
  });
});

describe("hero bluffs air — heads-up AND multiway (board representation)", () => {
  function airBarrel(villains: number[], profileSeats: Map<number, typeof NIT>) {
    const gs = new GameState({
      tableSize: 6, bb: 2, stacks: Array(6).fill(200), positions: POS,
      heroSeat: 3, heroCards: [parseCard("7s"), parseCard("6s")], dealerSeat: 3,
    });
    // fold everyone not a designated villain or hero
    for (let s = 0; s < 6; s++) {
      if (s === 3 || villains.includes(s)) continue;
      gs.applyAction({ seat: s, type: "fold", amount: 0 });
    }
    gs.applyAction({ seat: 3, type: "raise", amount: 6 }); // hero opens
    for (const v of villains) gs.applyAction({ seat: v, type: "call", amount: 0 });
    gs.advanceStreet([parseCard("Kd"), parseCard("Qc"), parseCard("2h")]); // hero 76s = pure air
    for (const v of villains) gs.applyAction({ seat: v, type: "check", amount: 0 });
    return recommend(gs, NIT, mulberry32(2), profileSeats);
  }
  it("bluffs air heads-up vs a foldy nit", () => {
    const rec = airBarrel([5], new Map([[5, NIT]]));
    expect(rec.action).toBe("bet");
    expect(rec.reasoning.toLowerCase()).toMatch(/bluff|barrel/);
  });
  it("can still bluff multiway (2 foldy villains)", () => {
    const rec = airBarrel([4, 5], new Map([[4, NIT], [5, NIT]]));
    expect(rec.action).toBe("bet");
  });
});
