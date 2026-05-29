import { describe, it, expect } from "vitest";
import {
  geometricSize,
  recommendSize,
  openRaiseSize,
  threeBetSize,
  fourBetSize,
  minRaise,
} from "../sizing.js";

describe("geometricSize", () => {
  it("reasonable bet on flop with 100bb stack, 6bb pot", () => {
    const bet = geometricSize(6, 97, 2); // 2 streets left
    // Should be between ⅓ pot and pot
    expect(bet).toBeGreaterThanOrEqual(2);
    expect(bet).toBeLessThanOrEqual(6);
  });

  it("returns 0 with 0 streets left", () => {
    expect(geometricSize(10, 50, 0)).toBe(0);
  });

  it("returns 0 with 0 stack", () => {
    expect(geometricSize(10, 0, 2)).toBe(0);
  });

  it("clamps to at least ⅓ pot", () => {
    // Very deep: stack >> pot, geometric wants small bet
    const bet = geometricSize(100, 10, 3);
    expect(bet).toBeGreaterThanOrEqual(100 / 3);
  });
});

describe("recommendSize", () => {
  it("shoves when SPR < 1", () => {
    expect(recommendSize(20, 15, "flop")).toBe(15);
  });

  it("river bet is ~67% pot", () => {
    const bet = recommendSize(10, 50, "river");
    expect(bet).toBeCloseTo(6.7, 0);
  });
});

describe("openRaiseSize", () => {
  it("2.5bb with no limpers", () => {
    expect(openRaiseSize(2)).toBe(5);
    expect(openRaiseSize(1)).toBe(2.5);
  });

  it("adds 1bb per limper", () => {
    expect(openRaiseSize(2, 1)).toBe(7); // 2 * (2.5 + 1)
    expect(openRaiseSize(2, 2)).toBe(9); // 2 * (2.5 + 2)
  });
});

describe("threeBetSize", () => {
  it("3x in position", () => {
    expect(threeBetSize(6, true)).toBe(18);
  });

  it("3.5x out of position", () => {
    expect(threeBetSize(6, false)).toBe(21);
  });
});

describe("fourBetSize", () => {
  it("2.25x the 3-bet", () => {
    expect(fourBetSize(18)).toBeCloseTo(40.5);
  });
});

describe("minRaise", () => {
  it("at least 2x the current bet", () => {
    expect(minRaise(6, 2)).toBe(12);
  });

  it("at least 2bb", () => {
    expect(minRaise(1, 2)).toBe(4);
  });
});
