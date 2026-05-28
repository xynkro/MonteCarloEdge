import { describe, it, expect } from "vitest";
import { parseHand } from "../cards.js";
import { evaluate, categoryOf, CATEGORY } from "../evaluator.js";

function rankFor(s: string): number {
  return evaluate(parseHand(s));
}

describe("evaluator — category detection", () => {
  it("recognizes a royal flush as a straight flush", () => {
    const r = rankFor("AsKsQsJsTs");
    expect(categoryOf(r)).toBe(CATEGORY.STRAIGHT_FLUSH);
  });

  it("recognizes a king-high straight flush", () => {
    expect(categoryOf(rankFor("KsQsJsTs9s"))).toBe(CATEGORY.STRAIGHT_FLUSH);
  });

  it("recognizes the wheel straight flush (5-high)", () => {
    expect(categoryOf(rankFor("As2s3s4s5s"))).toBe(CATEGORY.STRAIGHT_FLUSH);
  });

  it("recognizes quads", () => {
    expect(categoryOf(rankFor("AsAhAdAcKs"))).toBe(CATEGORY.QUADS);
  });

  it("recognizes a full house", () => {
    expect(categoryOf(rankFor("AsAhAdKsKh"))).toBe(CATEGORY.FULL_HOUSE);
  });

  it("recognizes a flush (non-straight)", () => {
    expect(categoryOf(rankFor("As9s7s4s2s"))).toBe(CATEGORY.FLUSH);
  });

  it("recognizes the wheel straight (A-2-3-4-5, mixed suits)", () => {
    expect(categoryOf(rankFor("As2h3d4c5s"))).toBe(CATEGORY.STRAIGHT);
  });

  it("recognizes a broadway straight (T-J-Q-K-A, mixed suits)", () => {
    expect(categoryOf(rankFor("AsKhQdJcTs"))).toBe(CATEGORY.STRAIGHT);
  });

  it("recognizes trips", () => {
    expect(categoryOf(rankFor("AsAhAdKsQh"))).toBe(CATEGORY.TRIPS);
  });

  it("recognizes two pair", () => {
    expect(categoryOf(rankFor("AsAhKsKhQc"))).toBe(CATEGORY.TWO_PAIR);
  });

  it("recognizes one pair", () => {
    expect(categoryOf(rankFor("AsAhKsQhJc"))).toBe(CATEGORY.PAIR);
  });

  it("recognizes high card", () => {
    expect(categoryOf(rankFor("AsKhQdJc9s"))).toBe(CATEGORY.HIGH_CARD);
  });
});

describe("evaluator — 7-card best-hand selection", () => {
  it("picks the flush out of 7 cards when 5+ of a suit are present", () => {
    const r = evaluate(parseHand("As9s7s4s2s 8h 8d".replace(/\s/g, "")));
    expect(categoryOf(r)).toBe(CATEGORY.FLUSH);
  });

  it("picks the straight when both straight and trips are possible", () => {
    // 9-high straight (5-6-7-8-9) beats trips 8s
    const r = evaluate(parseHand("8s8h8d9s7c6h5d".replace(/\s/g, "")));
    expect(categoryOf(r)).toBe(CATEGORY.STRAIGHT);
  });

  it("picks the full house when both pair and trips are present", () => {
    const r = evaluate(parseHand("AsAhAdKsKh2c3d".replace(/\s/g, "")));
    expect(categoryOf(r)).toBe(CATEGORY.FULL_HOUSE);
  });

  it("picks straight flush over flush when both exist", () => {
    const r = evaluate(parseHand("9s8s7s6s5sKsQh".replace(/\s/g, "")));
    expect(categoryOf(r)).toBe(CATEGORY.STRAIGHT_FLUSH);
  });

  it("picks quads over full house when both exist", () => {
    const r = evaluate(parseHand("AsAhAdAcKsKh3d".replace(/\s/g, "")));
    expect(categoryOf(r)).toBe(CATEGORY.QUADS);
  });
});

describe("evaluator — relative ordering", () => {
  it("orders categories correctly", () => {
    const order = [
      "AsKhQdJc9s",          // high card
      "AsAhKsQhJc",          // pair
      "AsAhKsKhQc",          // two pair
      "AsAhAdKsQh",          // trips
      "AsKhQdJcTs",          // straight
      "As9s7s4s2s",          // flush
      "AsAhAdKsKh",          // full house
      "AsAhAdAcKs",          // quads
      "KsQsJsTs9s",          // straight flush
      "AsKsQsJsTs",          // royal flush
    ];
    const ranks = order.map(rankFor);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it("breaks ties on kickers", () => {
    // Pair of aces, K vs Q kicker
    const a = rankFor("AsAhKsQhJc");
    const b = rankFor("AsAhQsJhTc");
    expect(a).toBeGreaterThan(b);
  });

  it("pair of aces beats pair of kings", () => {
    expect(rankFor("AsAhKs2h3c")).toBeGreaterThan(rankFor("KsKh2h3c4s"));
  });

  it("ace-high beats king-high", () => {
    expect(rankFor("AsKhQd5c3s")).toBeGreaterThan(rankFor("KsQhJd5c3s"));
  });

  it("wheel straight (5-high) loses to 6-high straight", () => {
    expect(rankFor("As2h3d4c5s")).toBeLessThan(rankFor("2h3d4c5s6h"));
  });
});
