import { describe, it, expect } from "vitest";
import { parseCard, parseHand, type Card } from "../cards.js";
import { monteCarloEquity } from "../equity.js";
import { mulberry32 } from "../rng.js";

function hand(s: string): [Card, Card] {
  const cs = parseHand(s);
  if (cs.length !== 2) throw new Error(`expected 2 cards, got ${cs.length}`);
  return [cs[0]!, cs[1]!];
}

// Canonical preflop equities (heads-up, hot/cold). Reference values are
// widely published; tolerance covers Monte Carlo noise.
const ITERATIONS = 80_000;
const TOL = 0.01; // ±1 percentage point

describe("equity — canonical heads-up preflop", () => {
  it("AA vs KK ≈ 81-82%", () => {
    // Pick suits to give KK a flush-blocker (the slightly harder case for AA).
    const r = monteCarloEquity({
      hero: hand("AsAh"),
      opponents: [hand("KsKh")],
      iterations: ITERATIONS,
      rng: mulberry32(1),
    });
    expect(r.equity).toBeGreaterThan(0.80);
    expect(r.equity).toBeLessThan(0.83);
  });

  it("AKs vs 22 ≈ 50% (classic coin flip)", () => {
    const r = monteCarloEquity({
      hero: hand("AsKs"),
      opponents: [hand("2c2d")],
      iterations: ITERATIONS,
      rng: mulberry32(2),
    });
    expect(Math.abs(r.equity - 0.50)).toBeLessThan(TOL);
  });

  it("AKo vs JJ ≈ 43%", () => {
    const r = monteCarloEquity({
      hero: hand("AsKh"),
      opponents: [hand("JdJc")],
      iterations: ITERATIONS,
      rng: mulberry32(3),
    });
    expect(r.equity).toBeGreaterThan(0.42);
    expect(r.equity).toBeLessThan(0.45);
  });

  it("identical pocket pairs in different suits tie at 50%", () => {
    const r = monteCarloEquity({
      hero: hand("AsAh"),
      opponents: [hand("AdAc")],
      iterations: 20_000,
      rng: mulberry32(4),
    });
    expect(Math.abs(r.equity - 0.50)).toBeLessThan(0.005);
  });

  it("dominated: AK vs AQ ≈ 73-74%", () => {
    const r = monteCarloEquity({
      hero: hand("AsKh"),
      opponents: [hand("AdQc")],
      iterations: ITERATIONS,
      rng: mulberry32(5),
    });
    expect(r.equity).toBeGreaterThan(0.72);
    expect(r.equity).toBeLessThan(0.76);
  });

  it("dominated: KK vs KQ ≈ 90%+", () => {
    const r = monteCarloEquity({
      hero: hand("KsKh"),
      opponents: [hand("KdQc")],
      iterations: ITERATIONS,
      rng: mulberry32(6),
    });
    expect(r.equity).toBeGreaterThan(0.88);
    expect(r.equity).toBeLessThan(0.93);
  });
});

describe("equity — postflop sanity", () => {
  it("flopped set is overwhelmingly ahead of top pair", () => {
    // Hero: 8s8h. Board: 8d Kc 2h. Villain: KsQh (top pair).
    const r = monteCarloEquity({
      hero: hand("8s8h"),
      opponents: [hand("KsQh")],
      board: parseHand("8dKc2h"),
      iterations: 20_000,
      rng: mulberry32(7),
    });
    expect(r.equity).toBeGreaterThan(0.93);
  });

  it("turned nut flush is locked when board cannot pair into boats", () => {
    // Hero: AsKs nut flush on 5s 7s Js 2c. Villain 9hTd has no outs:
    // no pair on board (5,7,J,2), no straight draw, no flush draw.
    const r = monteCarloEquity({
      hero: hand("AsKs"),
      opponents: [hand("9hTd")],
      board: parseHand("5s7sJs2c"),
      iterations: 10_000,
      rng: mulberry32(8),
    });
    expect(r.equity).toBe(1);
  });

  it("known runout: hero with no outs loses 100%", () => {
    // Hero 2c 3c. Board 7s 7h 7d 7c Ah. Villain has anything else → boats win or board plays.
    // Actually with 4 sevens on board, hero plays board's quad-sevens with A kicker (board), tying.
    // Use a cleaner spot: full board where hero is drawing dead.
    // Board: As Ah Ad Ac 2h. Hero: 7c 8c. Villain: KsQs. Both play board's quads + ace kicker; tie.
    // Instead: hero already lost — board: 2s 3s 4s 5s, hero 9c 9h, villain 6s7s.
    const r = monteCarloEquity({
      hero: hand("9c9h"),
      opponents: [hand("6s7s")],
      board: parseHand("2s3s4s5s8d"),
      iterations: 2_000,
      rng: mulberry32(9),
    });
    expect(r.equity).toBeLessThan(0.01);
  });
});

describe("equity — multi-way", () => {
  it("equity drops as opponents increase (AA stays ahead but shrinks)", () => {
    const heads = monteCarloEquity({
      hero: hand("AsAh"),
      opponents: [hand("KsKh")],
      iterations: 20_000,
      rng: mulberry32(10),
    });
    const threeWay = monteCarloEquity({
      hero: hand("AsAh"),
      opponents: [hand("KsKh"), hand("QdQc")],
      iterations: 20_000,
      rng: mulberry32(11),
    });
    expect(threeWay.equity).toBeLessThan(heads.equity);
    expect(threeWay.equity).toBeGreaterThan(0.6);
  });
});

describe("equity — reporting", () => {
  it("returns finite confidence bound", () => {
    const r = monteCarloEquity({
      hero: hand("AsKs"),
      opponents: [hand("2c2d")],
      iterations: 5_000,
      rng: mulberry32(42),
    });
    expect(Number.isFinite(r.stderr95)).toBe(true);
    expect(r.stderr95).toBeGreaterThan(0);
    expect(r.stderr95).toBeLessThan(0.05);
    expect(r.wins + r.ties + r.losses).toBe(5_000);
  });
});

describe("equity — input validation", () => {
  it("rejects duplicate cards", () => {
    expect(() =>
      monteCarloEquity({
        hero: [parseCard("As"), parseCard("Ks")],
        opponents: [[parseCard("As"), parseCard("Qs")]],
        iterations: 100,
      }),
    ).toThrow();
  });

  it("rejects malformed board sizes", () => {
    expect(() =>
      monteCarloEquity({
        hero: hand("AsKs"),
        opponents: [hand("2c2d")],
        board: parseHand("3s4s"),
        iterations: 100,
      }),
    ).toThrow();
  });
});
