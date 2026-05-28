import { describe, it, expect } from "vitest";
import {
  parseCard, parseHand, cardToString, handToString,
  rankOf, suitOf, makeCard, newDeck, NUM_CARDS,
} from "../cards.js";

describe("cards", () => {
  it("parses and round-trips canonical cards", () => {
    const samples = ["As", "Kh", "Qd", "Jc", "Ts", "2c", "9h"];
    for (const s of samples) {
      const c = parseCard(s);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(NUM_CARDS);
      expect(cardToString(c)).toBe(s);
    }
  });

  it("rejects malformed cards", () => {
    expect(() => parseCard("Zx")).toThrow();
    expect(() => parseCard("A")).toThrow();
    expect(() => parseCard("Asd")).toThrow();
  });

  it("parses multi-card hand strings", () => {
    const h = parseHand("AsKsQsJsTs");
    expect(h).toHaveLength(5);
    expect(handToString(h)).toBe("AsKsQsJsTs");
  });

  it("encodes ranks and suits consistently", () => {
    for (let r = 0; r < 13; r++) {
      for (let s = 0; s < 4; s++) {
        const c = makeCard(r, s);
        expect(rankOf(c)).toBe(r);
        expect(suitOf(c)).toBe(s);
      }
    }
  });

  it("newDeck() yields 52 unique cards", () => {
    const d = newDeck();
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });
});
