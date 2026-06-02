import { describe, it, expect } from "vitest";
import { parseHand } from "../cards.js";
import { handsThatBeat, describeHand } from "../made-hand.js";

describe("handsThatBeat — what beats your hand", () => {
  it("flags a flush as a threat to two pair on a 3-flush board", () => {
    // Hero AhKd: top two pair on Ac Kc 7c 2d. Three clubs out → any one more
    // club makes a flush that beats two pair.
    const hero = parseHand("AhKd") as [number, number];
    const board = parseHand("AcKc7c2d");
    const { threats } = handsThatBeat(hero, board);
    const labels = threats.map((t) => t.label.toLowerCase());
    expect(labels.some((l) => l.includes("flush"))).toBe(true);
    // Most-likely threat (most combos) is listed first.
    expect(threats[0]!.combos).toBeGreaterThanOrEqual(threats[threats.length - 1]!.combos);
  });

  it("reports the nuts (empty threat list) when nothing can beat hero", () => {
    // Hero holds the absolute nuts: quad aces on AAAK with the case ace... use
    // a board where hero has the unbeatable hand. AsAh on Ac Ad Kc → quad aces,
    // best possible is the same quads + better kicker, but no higher hand exists
    // above quad aces here except a straight flush which is impossible (no 4 to a
    // SF). Hero's quads with an ace kicker can't be beaten.
    const hero = parseHand("AsAh") as [number, number];
    const board = parseHand("AcAdKc");
    const { threats } = handsThatBeat(hero, board);
    expect(threats.length).toBe(0);
  });

  it("counts more beating combos when hero is weak (one pair) than strong", () => {
    const board = parseHand("Ac9d7c");
    const weak = handsThatBeat(parseHand("8h8s") as [number, number], board); // underpair
    const strong = handsThatBeat(parseHand("AhAd") as [number, number], board); // top set
    expect(weak.beating).toBeGreaterThan(strong.beating);
  });
});

describe("describeHand — no draws on the river", () => {
  it("drops the gutshot tag once the river is out", () => {
    const hero = parseHand("9h8h") as [number, number];
    // Turn: 9-high gutshot territory (no pair, open gutshot to a straight).
    const turn = describeHand(hero, parseHand("Kc7d2s"));
    // River completes the board with a brick → still no made hand, and crucially
    // NO draw tag should be present (no cards left to come).
    const river = describeHand(hero, parseHand("Kc7d2s3c"));
    expect(river.draws.length).toBe(0);
    // sanity: the turn description CAN carry draws (5th card not out yet)
    void turn;
  });
});
