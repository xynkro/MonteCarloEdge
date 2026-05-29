import { describe, it, expect } from "vitest";
import { Range, TOTAL_COMBOS, pairCombos, suitedCombos, offsuitCombos } from "../range.js";
import { parseCard, parseHand } from "../cards.js";
import { mulberry32 } from "../rng.js";
import { monteCarloEquity, monteCarloEquityVsRange } from "../equity.js";

describe("Range parsing — hand classes", () => {
  it("AA → 6 combos (C(4,2) suit combinations)", () => {
    const r = Range.parse("AA");
    expect(r.size).toBe(6);
  });

  it("AKs → 4 combos (one per suit)", () => {
    const r = Range.parse("AKs");
    expect(r.size).toBe(4);
  });

  it("AKo → 12 combos (4×3 cross-suit)", () => {
    const r = Range.parse("AKo");
    expect(r.size).toBe(12);
  });

  it("AK → 16 combos (suited + offsuit)", () => {
    const r = Range.parse("AK");
    expect(r.size).toBe(16);
  });

  it("specific combo AhKh → 1 combo", () => {
    const r = Range.parse("AhKh");
    expect(r.size).toBe(1);
    const c = r.combos[0]!;
    const ah = parseCard("Ah");
    const kh = parseCard("Kh");
    expect(c[0]).toBe(Math.min(ah, kh));
    expect(c[1]).toBe(Math.max(ah, kh));
  });
});

describe("Range parsing — plus notation", () => {
  it("JJ+ → JJ,QQ,KK,AA = 24 combos", () => {
    const r = Range.parse("JJ+");
    expect(r.size).toBe(4 * 6); // 4 pair ranks × 6 combos each
  });

  it("TT+ → TT,JJ,QQ,KK,AA = 30 combos", () => {
    const r = Range.parse("TT+");
    expect(r.size).toBe(5 * 6);
  });

  it("ATs+ → ATs,AJs,AQs,AKs = 16 suited combos", () => {
    const r = Range.parse("ATs+");
    expect(r.size).toBe(4 * 4);
  });

  it("KTo+ → KTo,KJo,KQo = 36 offsuit combos", () => {
    const r = Range.parse("KTo+");
    expect(r.size).toBe(3 * 12);
  });

  it("AT+ → suited + offsuit, ATs+ and ATo+ combined", () => {
    const r = Range.parse("AT+");
    const rs = Range.parse("ATs+");
    const ro = Range.parse("ATo+");
    expect(r.size).toBe(rs.size + ro.size);
  });
});

describe("Range parsing — dash notation", () => {
  it("22-66 → 5 pairs = 30 combos", () => {
    const r = Range.parse("22-66");
    expect(r.size).toBe(5 * 6);
  });

  it("TT-AA → same as TT+", () => {
    const a = Range.parse("TT-AA");
    const b = Range.parse("TT+");
    expect(a.size).toBe(b.size);
  });

  it("66-22 → same as 22-66 (order doesn't matter)", () => {
    const a = Range.parse("66-22");
    const b = Range.parse("22-66");
    expect(a.size).toBe(b.size);
  });
});

describe("Range parsing — comma-separated", () => {
  it("AA,KK,AKs → 6+6+4 = 16 combos", () => {
    const r = Range.parse("AA,KK,AKs");
    expect(r.size).toBe(16);
  });

  it("deduplicates overlapping tokens", () => {
    const r = Range.parse("AA,AA,AA");
    expect(r.size).toBe(6);
  });

  it("22+,AKs → all pairs + AKs = 78+4 = 82", () => {
    const r = Range.parse("22+,AKs");
    expect(r.size).toBe(82);
  });
});

describe("Range combo counts", () => {
  it("all 1326 combos from 22+,A2+", () => {
    // 22+ = all 13 pairs = 78 combos
    // A2+ = all non-pair hands with Ace high = A2 through AK = 12 × 16 = 192
    // But we need ALL combos. Let's build it properly.
    // All pairs: 13 × 6 = 78
    // All non-pairs: 78 × 16 = 1248
    // Total: 78 + 1248 = 1326
    // Range string for all hands: every pair + every non-pair
    const tokens: string[] = [];
    tokens.push("22+"); // all pairs
    const ranks = "23456789TJQKA";
    for (let hi = 1; hi < 13; hi++) {
      for (let lo = 0; lo < hi; lo++) {
        tokens.push(ranks[hi]! + ranks[lo]!);
      }
    }
    const r = Range.parse(tokens.join(","));
    expect(r.size).toBe(TOTAL_COMBOS);
  });

  it("TOTAL_COMBOS is 1326", () => {
    expect(TOTAL_COMBOS).toBe(1326);
  });
});

describe("Range.filter — dead card removal", () => {
  it("removes combos containing dead cards", () => {
    const r = Range.parse("AA");
    expect(r.size).toBe(6);
    const ah = parseCard("Ah");
    const filtered = r.filter([ah]);
    // 6 AA combos: AcAd, AcAh, AcAs, AdAh, AdAs, AhAs
    // Removing Ah eliminates: AcAh, AdAh, AhAs = 3 combos removed
    expect(filtered.size).toBe(3);
  });

  it("filter with hero cards reduces range", () => {
    const r = Range.parse("AKs");
    expect(r.size).toBe(4);
    const as = parseCard("As");
    const ks = parseCard("Ks");
    const filtered = r.filter([as, ks]);
    // AsKs is the only combo using As or Ks that's suited
    // AhKh, AdKd, AcKc survive. AsKs is removed.
    expect(filtered.size).toBe(3);
  });
});

describe("Range.sample", () => {
  it("returns a combo from the range", () => {
    const r = Range.parse("AA");
    const rng = mulberry32(42);
    const c = r.sample(rng);
    expect(c).not.toBeNull();
    expect(r.has(c!)).toBe(true);
  });

  it("returns null for empty range", () => {
    const r = Range.empty();
    const rng = mulberry32(42);
    expect(r.sample(rng)).toBeNull();
  });

  it("samples uniformly (chi-squared-ish check)", () => {
    const r = Range.parse("AA"); // 6 combos
    const rng = mulberry32(123);
    const counts = new Map<string, number>();
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const c = r.sample(rng)!;
      const key = `${c[0]},${c[1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    // Each combo should appear ~1000 times. Allow ±300 (30%).
    for (const [, count] of counts) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });
});

describe("Range.encode — round-trip", () => {
  const cases = [
    "AA",
    "AKs",
    "AKo",
    "AK",
    "AA,KK,QQ",
    "AKs,AQs,AJs",
    "22+",
    "ATs+",
    "22-66",
  ];

  for (const input of cases) {
    it(`round-trips: ${input}`, () => {
      const r1 = Range.parse(input);
      const encoded = r1.encode();
      const r2 = Range.parse(encoded);
      expect(r2.size).toBe(r1.size);
      // Every combo in r1 must be in r2 and vice versa
      for (const c of r1.combos) expect(r2.has(c)).toBe(true);
      for (const c of r2.combos) expect(r1.has(c)).toBe(true);
    });
  }
});

describe("Range set operations", () => {
  it("union combines two ranges", () => {
    const a = Range.parse("AA");
    const b = Range.parse("KK");
    const u = a.union(b);
    expect(u.size).toBe(12);
  });

  it("intersect finds common combos", () => {
    const a = Range.parse("AA,KK");
    const b = Range.parse("KK,QQ");
    const i = a.intersect(b);
    expect(i.size).toBe(6); // just KK
  });

  it("intersect of disjoint ranges is empty", () => {
    const a = Range.parse("AA");
    const b = Range.parse("KK");
    expect(a.intersect(b).size).toBe(0);
  });
});

describe("Range.percentage", () => {
  it("AA is ~0.45%", () => {
    const r = Range.parse("AA");
    expect(r.percentage).toBeCloseTo(0.452, 1);
  });

  it("22+ is ~5.9%", () => {
    const r = Range.parse("22+");
    expect(r.percentage).toBeCloseTo(5.88, 1);
  });
});

describe("Combo generator helpers", () => {
  it("pairCombos returns 6", () => {
    expect(pairCombos(12).length).toBe(6); // AA
  });

  it("suitedCombos returns 4", () => {
    expect(suitedCombos(12, 11).length).toBe(4); // AKs
  });

  it("offsuitCombos returns 12", () => {
    expect(offsuitCombos(12, 11).length).toBe(12); // AKo
  });
});

describe("monteCarloEquityVsRange — single-hand range matches HU equity", () => {
  it("hero AsKs vs range={2c2d} matches direct HU MC", () => {
    const hero: readonly [number, number] = [
      parseCard("As"),
      parseCard("Ks"),
    ];
    const villain: readonly [number, number] = [
      parseCard("2c"),
      parseCard("2d"),
    ];
    const singleHandRange = Range.fromCombos([villain]);

    const directResult = monteCarloEquity({
      hero,
      opponents: [villain],
      iterations: 100_000,
      rng: mulberry32(0xBEEF),
    });

    const rangeResult = monteCarloEquityVsRange({
      hero,
      villainRange: singleHandRange,
      iterations: 100_000,
      rng: mulberry32(0xBEEF),
    });

    // Both should be very close (same seed, same single opponent)
    expect(Math.abs(directResult.equity - rangeResult.equity)).toBeLessThan(
      0.005,
    );
  });
});
