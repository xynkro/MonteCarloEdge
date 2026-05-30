import { describe, it, expect } from "vitest";
import { parseCard } from "../cards.js";
import { Range } from "../range.js";
import { monteCarloEquity, monteCarloEquityMultiway } from "../equity.js";
import { mulberry32 } from "../rng.js";

const h = (s: string): [number, number] => [parseCard(s.slice(0, 2)), parseCard(s.slice(2, 4))];

describe("monteCarloEquityMultiway", () => {
  it("single villain matches the heads-up calculator", () => {
    const hero = h("AsKs");
    const villain: [number, number] = [parseCard("2c"), parseCard("2d")];
    const range = Range.fromCombos([villain]);

    const direct = monteCarloEquity({
      hero, opponents: [villain], iterations: 100_000, rng: mulberry32(0xabc),
    });
    const multi = monteCarloEquityMultiway({
      hero, villainRanges: [range], iterations: 100_000, rng: mulberry32(0xabc),
    });

    expect(Math.abs(direct.equity - multi.equity)).toBeLessThan(0.02);
  });

  it("equity drops as more villains are added", () => {
    const hero = h("AsAd");
    const wide = Range.parse("22+,A2s+,K2s+,Q2s+,J2s+,T2s+,A2o+,K2o+");

    const vs1 = monteCarloEquityMultiway({
      hero, villainRanges: [wide], iterations: 30_000, rng: mulberry32(1),
    });
    const vs3 = monteCarloEquityMultiway({
      hero, villainRanges: [wide, wide, wide], iterations: 30_000, rng: mulberry32(1),
    });

    // AA is still favorite but wins less of the pot multiway.
    expect(vs1.equity).toBeGreaterThan(vs3.equity);
    expect(vs3.equity).toBeGreaterThan(0.4);
  });

  it("no villains => hero wins everything", () => {
    const r = monteCarloEquityMultiway({
      hero: h("7c2d"), villainRanges: [], iterations: 1000, rng: mulberry32(5),
    });
    expect(r.equity).toBe(1);
  });

  it("equity is between 0 and 1 with a board", () => {
    const r = monteCarloEquityMultiway({
      hero: h("AhKh"),
      villainRanges: [Range.parse("QQ+"), Range.parse("JJ+,AKs")],
      board: [parseCard("Kc"), parseCard("7d"), parseCard("2s")],
      iterations: 20_000,
      rng: mulberry32(7),
    });
    expect(r.equity).toBeGreaterThanOrEqual(0);
    expect(r.equity).toBeLessThanOrEqual(1);
    expect(r.iterations).toBeGreaterThan(0);
  });
});
