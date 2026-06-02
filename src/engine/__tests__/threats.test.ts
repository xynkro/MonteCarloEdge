import { describe, it, expect } from "vitest";
import { parseHand } from "../cards.js";
import { readThreats, describeHand } from "../made-hand.js";
import { allCombos } from "../hand-strength.js";

const UNIVERSE = allCombos().combos;

describe("readThreats — what beats you / what's drawing", () => {
  it("flags a flush as a made threat to two pair on a 3-flush board", () => {
    // Hero AhKd: top two pair on Ac Kc 7c 2d. Three clubs out → any one more
    // club makes a flush that beats two pair.
    const hero = parseHand("AhKd") as [number, number];
    const board = parseHand("AcKc7c2d");
    const { made } = readThreats(hero, board, UNIVERSE);
    expect(made.some((t) => t.label.toLowerCase().includes("flush"))).toBe(true);
    // Most-likely threat (most combos) is listed first.
    expect(made[0]!.combos).toBeGreaterThanOrEqual(made[made.length - 1]!.combos);
  });

  it("reports no made threats when hero holds the current nuts", () => {
    // AsAh on Ac Ad Kc → quad aces; nothing beats it on this board.
    const hero = parseHand("AsAh") as [number, number];
    const board = parseHand("AcAdKc");
    const { made } = readThreats(hero, board, UNIVERSE);
    expect(made.length).toBe(0);
  });

  it("shows a flush DRAW (not a made flush) on a two-tone flop", () => {
    // Hero has top set (AA on Ad 8c 3c) — far ahead. Two clubs on board, so a
    // club-club holding is only DRAWING to a flush, not made. It must appear
    // under draws, never under made.
    const hero = parseHand("AhAs") as [number, number];
    const board = parseHand("Ad8c3c");
    const { made, draws } = readThreats(hero, board, UNIVERSE);
    expect(draws.some((d) => d.label === "Flush draw")).toBe(true);
    expect(made.some((m) => m.label.toLowerCase().includes("flush"))).toBe(false);
  });

  it("has no draws on the river (no cards left to come)", () => {
    const hero = parseHand("AhAs") as [number, number];
    const board = parseHand("Ad8c3c2h7d"); // complete board
    const { draws } = readThreats(hero, board, UNIVERSE);
    expect(draws.length).toBe(0);
  });

  it("ignores junk holdings outside the given range", () => {
    // Board 2c 5h Ad 9s. The ONLY made hand that beats pocket sevens here is the
    // wheel via 3-4. If 3-4 combos aren't in the supplied range, there should be
    // no 'Straight' made threat — the read is range-aware.
    const hero = parseHand("7h7d") as [number, number];
    const board = parseHand("2c5hAd9s");
    const range = [parseHand("AhKh"), parseHand("AcQd"), parseHand("KsQs")] as [number, number][];
    const { made } = readThreats(hero, board, range);
    expect(made.some((m) => m.label.toLowerCase().includes("straight"))).toBe(false);
  });
});

describe("describeHand — no draws on the river", () => {
  it("drops the gutshot tag once the river is out", () => {
    const hero = parseHand("9h8h") as [number, number];
    const river = describeHand(hero, parseHand("Kc7d2s3c"));
    expect(river.draws.length).toBe(0);
  });
});
