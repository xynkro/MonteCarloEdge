import { describe, it, expect } from "vitest";
import { settlePots, strengthFromWinners } from "../settle.js";

describe("settlePots", () => {
  it("heads-up equal all-in, winner takes it", () => {
    const won = settlePots([100, 100], [true, true], [1, 0]);
    expect(won).toEqual([200, 0]);
  });

  it("returns the uncalled portion of an over-bet", () => {
    // Hero bets 100, villain calls all-in for 60, villain wins.
    const won = settlePots([100, 60], [true, true], [0, 1]);
    expect(won[1]).toBe(120); // villain wins the matched 120
    expect(won[0]).toBe(40); // hero's uncalled 40 comes back
    expect(won[0]! - 100).toBe(-60); // hero net -60
  });

  it("layers a side pot correctly (short stack can't win the side)", () => {
    // A=100, B=50 all-in (best hand), C=100. B wins main, A wins side.
    const won = settlePots([100, 50, 100], [true, true, true], [2, 3, 1]);
    expect(won[1]).toBe(150); // B (best) wins only the 150 main pot
    expect(won[0]).toBe(100); // A (2nd) wins the 100 side pot
    expect(won[2]).toBe(0);
  });

  it("conserves chips", () => {
    const contrib = [40, 100, 25, 100];
    const won = settlePots(contrib, [true, true, false, true], [1, 2, 0, 3]);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(won)).toBeCloseTo(sum(contrib), 6);
  });

  it("fold: lone remaining player wins the pot, keeps own uncalled chips", () => {
    // SB 0.5, BB 1, BTN raised to 3, blinds fold. BTN (seat0) the only one in.
    const contrib = [3, 0.5, 1];
    const won = settlePots(contrib, [true, false, false], strengthFromWinners(3, [0]));
    expect(won[0]).toBeCloseTo(4.5, 6); // wins the whole 4.5
    expect(won[0]! - 3).toBeCloseTo(1.5, 6); // net +1.5 (the blinds)
  });

  it("split pot divides evenly", () => {
    const won = settlePots([50, 50], [true, true], [1, 1]);
    expect(won).toEqual([50, 50]);
  });

  it("manual-winner strength is exact for a short all-in vs one caller", () => {
    // Hero all-in 60, villain calls 60, plus villain over-bet... symmetric here.
    const won = settlePots([60, 60], [true, true], strengthFromWinners(2, [0]));
    expect(won[0]).toBe(120);
  });
});
