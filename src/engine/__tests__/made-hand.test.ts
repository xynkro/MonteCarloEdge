import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { describeHand } from "../made-hand.js";
import { CATEGORY } from "../evaluator.js";

const h = (s: string): [number, number] => [parseCard(s.slice(0, 2)), parseCard(s.slice(2, 4))];
const b = (s: string): number[] => s.match(/.{2}/g)!.map(parseCard);

describe("describeHand — made hands", () => {
  it("top pair top kicker", () => {
    const d = describeHand(h("AhKd"), b("Kc7d2s"));
    expect(d.category).toBe(CATEGORY.PAIR);
    expect(d.label).toContain("Top Pair");
    expect(d.label).toContain("Top Kicker");
  });

  it("overpair", () => {
    const d = describeHand(h("QhQs"), b("Jc7d2s"));
    expect(d.label).toBe("Overpair");
  });

  it("set (pocket pair hits board)", () => {
    const d = describeHand(h("7h7s"), b("Kc7d2s"));
    expect(d.category).toBe(CATEGORY.TRIPS);
    expect(d.label).toBe("Set");
  });

  it("trips (one hole card + paired board)", () => {
    const d = describeHand(h("Kh9s"), b("KcKd2s"));
    expect(d.category).toBe(CATEGORY.TRIPS);
    expect(d.label).toBe("Trips");
  });

  it("two pair", () => {
    const d = describeHand(h("KhQd"), b("KcQs2h"));
    expect(d.category).toBe(CATEGORY.TWO_PAIR);
    expect(d.label).toBe("Two Pair");
  });

  it("second pair", () => {
    const d = describeHand(h("9h8d"), b("Kc9d2s"));
    expect(d.label).toBe("Second Pair");
  });

  it("flush", () => {
    const d = describeHand(h("AhKh"), b("7h2h9hQs"));
    expect(d.category).toBe(CATEGORY.FLUSH);
    expect(d.label).toBe("Flush");
  });

  it("straight", () => {
    const d = describeHand(h("9h8d"), b("7c6d5sKh"));
    expect(d.category).toBe(CATEGORY.STRAIGHT);
    expect(d.label).toBe("Straight");
  });

  it("ace high", () => {
    const d = describeHand(h("AhKd"), b("9c7d2s"));
    expect(d.label).toBe("Ace High");
    expect(d.category).toBe(CATEGORY.HIGH_CARD);
  });
});

describe("describeHand — draws", () => {
  it("flush draw detected", () => {
    const d = describeHand(h("AhKh"), b("7h2h9s"));
    expect(d.draws).toContain("Flush draw");
    expect(d.strong).toBe(true);
  });

  it("open-ended straight draw", () => {
    const d = describeHand(h("9h8d"), b("7c6d2s"));
    expect(d.draws).toContain("Open-ended straight draw");
  });

  it("gutshot", () => {
    const d = describeHand(h("9h8d"), b("7c5d2s"));
    expect(d.draws).toContain("Gutshot");
  });

  it("no draw on dry disconnected board", () => {
    const d = describeHand(h("AhKd"), b("9c7d2s"));
    expect(d.draws.length).toBe(0);
  });

  it("top pair plus flush draw is strong", () => {
    const d = describeHand(h("AhKh"), b("Kh7h2s"));
    expect(d.label).toContain("Top Pair");
    expect(d.draws).toContain("Flush draw");
    expect(d.strong).toBe(true);
  });

  it("made flush does not also report flush draw", () => {
    const d = describeHand(h("AhKh"), b("7h2h9hQs"));
    expect(d.draws).not.toContain("Flush draw");
  });
});

describe("describeHand — preflop", () => {
  it("pocket pair", () => {
    const d = describeHand(h("AhAs"), []);
    expect(d.label).toBe("Pocket Aces");
  });

  it("suited notation", () => {
    const d = describeHand(h("AhKh"), []);
    expect(d.label).toBe("AKs");
  });

  it("offsuit notation", () => {
    const d = describeHand(h("AhKd"), []);
    expect(d.label).toBe("AKo");
  });
});
