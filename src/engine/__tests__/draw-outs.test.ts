import { describe, it, expect } from "vitest";
import { makeCard } from "../cards.js";
import { drawOuts, drawHitProb } from "../board-texture.js";

// rank: 0=2 … 8=T, 9=J, 10=Q, 11=K, 12=A. suit: 0=c 1=d 2=h 3=s.
const C = (rank: number, suit: number) => makeCard(rank, suit);

describe("drawOuts — exact out counting", () => {
  it("flush draw = 9 outs", () => {
    // Ah Kh on 7h 2h 9s → 4 hearts, no straight
    const outs = drawOuts([C(12, 2), C(11, 2)], [C(5, 2), C(0, 2), C(7, 3)]);
    expect(outs).toBe(9);
  });

  it("open-ended straight draw = 8 outs", () => {
    // 9c 8d on 7h 6s 2c → 9-8-7-6, no flush
    const outs = drawOuts([C(7, 0), C(6, 1)], [C(5, 2), C(4, 3), C(0, 0)]);
    expect(outs).toBe(8);
  });

  it("gutshot = 4 outs (the old code wrongly treated this as 8)", () => {
    // 9c 8d on 7h 5s 2c → needs a 6 only
    const outs = drawOuts([C(7, 0), C(6, 1)], [C(5, 2), C(3, 3), C(0, 0)]);
    expect(outs).toBe(4);
  });

  it("combo flush + OESD = 15 outs", () => {
    // 9h 8h on 7h 6s 2h → flush draw (9) + OESD (8) − 2 overlap (5h, Th)
    const outs = drawOuts([C(7, 2), C(6, 2)], [C(5, 2), C(4, 3), C(0, 2)]);
    expect(outs).toBe(15);
  });

  it("no draw = 0 outs", () => {
    // Ac Kd on 7h 2s 9c → nothing
    const outs = drawOuts([C(12, 0), C(11, 1)], [C(5, 2), C(0, 3), C(7, 0)]);
    expect(outs).toBe(0);
  });

  it("already-made flush is not counted as a draw", () => {
    // Ah Kh on 7h 2h 9h → made flush
    const outs = drawOuts([C(12, 2), C(11, 2)], [C(5, 2), C(0, 2), C(7, 2)]);
    expect(outs).toBe(0);
  });
});

describe("drawHitProb — exact probability (not the 2/4 rule)", () => {
  it("9 outs on the flop ≈ 35%", () => { expect(drawHitProb(9, 3)).toBeCloseTo(0.350, 2); });
  it("9 outs on the turn ≈ 19.6%", () => { expect(drawHitProb(9, 4)).toBeCloseTo(0.196, 2); });
  it("4-out gutshot on the flop ≈ 16.5% (was overstated at 31%)", () => { expect(drawHitProb(4, 3)).toBeCloseTo(0.165, 2); });
  it("15-out combo on the flop ≈ 54%", () => { expect(drawHitProb(15, 3)).toBeCloseTo(0.541, 2); });
});
