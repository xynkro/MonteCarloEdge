import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { villainAct, handConnection, LAG, NIT, TAG, STATION } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const board = (s: string) => s.match(/.{2}/g)!.map(parseCard);

describe("handConnection surfaces a draw bucket", () => {
  it("classifies a flush draw as 'draw', not 'air'", () => {
    // Ah2h on Kh 7h 2c — nut flush draw (+ bottom pair would be 'medium', so use no pair)
    const c = handConnection([parseCard("Ah"), parseCard("3h")], board("Kh7h2c"));
    expect(c).toBe("draw");
  });
  it("pure air is still air", () => {
    const c = handConnection([parseCard("Ac"), parseCard("Qd")], board("Kh7s2c"));
    expect(c).toBe("air");
  });
});

describe("villain bluffs (no longer 'bets its worst hands least')", () => {
  function flopOpenSpot() {
    const gs = new GameState({
      tableSize: 2, bb: 2, stacks: [200, 200], positions: ["BTN", "BB"],
      heroSeat: 0, heroCards: [parseCard("Qs"), parseCard("Jd")], dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: 6 });
    gs.applyAction({ seat: 1, type: "call", amount: 0 });
    gs.advanceStreet(board("Kh7s2c")); // dry, villain (BB) first to act with air
    return gs;
  }
  it("a LAG fires air as a bluff a meaningful fraction of the time", () => {
    let bets = 0;
    const villAir = [parseCard("9c"), parseCard("8d")] as [number, number]; // total air on K72
    for (let i = 0; i < 200; i++) {
      const act = villainAct(flopOpenSpot(), 1, villAir, LAG, mulberry32(i + 1));
      if (act.type === "bet") bets++;
    }
    expect(bets / 200).toBeGreaterThan(0.4); // LAG bluffFreq ~0.70 → bets air often
  });
  it("a NIT bluffs air far less than a LAG", () => {
    const villAir = [parseCard("9c"), parseCard("8d")] as [number, number];
    const count = (p: typeof LAG) => {
      let b = 0;
      for (let i = 0; i < 200; i++) if (villainAct(flopOpenSpot(), 1, villAir, p, mulberry32(i + 1)).type === "bet") b++;
      return b;
    };
    expect(count(NIT)).toBeLessThan(count(LAG));
  });
});

describe("blind defense scales with open size (the '$3 over-fold' fix)", () => {
  // A spread of BB holdings from strong to trashy.
  const HANDS: [number, number][] = [
    [parseCard("Ah"), parseCard("Qh")], [parseCard("Kc"), parseCard("Jc")],
    [parseCard("Qd"), parseCard("Td")], [parseCard("Jc"), parseCard("9c")],
    [parseCard("Ts"), parseCard("8s")], [parseCard("Kd"), parseCard("9d")],
    [parseCard("Qc"), parseCard("9d")], [parseCard("Jh"), parseCard("8c")],
    [parseCard("9s"), parseCard("7d")], [parseCard("8h"), parseCard("6c")],
    [parseCard("Td"), parseCard("9h")], [parseCard("Ac"), parseCard("5c")],
  ];
  function defenseWidth(raiseToBB: number, vill: typeof TAG) {
    const gs = new GameState({
      tableSize: 2, bb: 2, stacks: [200, 200], positions: ["BTN", "BB"],
      heroSeat: 0, heroCards: [parseCard("As"), parseCard("Ks")], dealerSeat: 0,
    });
    gs.applyAction({ seat: 0, type: "raise", amount: raiseToBB * 2 });
    let defend = 0;
    for (const h of HANDS) if (villainAct(gs, 1, h, vill, mulberry32(1)).type !== "fold") defend++;
    return defend / HANDS.length;
  }
  it("BB defends a min-raise MUCH wider than a 4x open", () => {
    const vsMin = defenseWidth(2, TAG);
    const vs4x = defenseWidth(4, TAG);
    expect(vsMin).toBeGreaterThan(vs4x);
    expect(vsMin).toBeGreaterThan(0.5); // doesn't fold most of these for "another $3"
  });
  it("a station defends the blind wider than a TAG", () => {
    expect(defenseWidth(2.5, STATION)).toBeGreaterThanOrEqual(defenseWidth(2.5, TAG));
  });
});
