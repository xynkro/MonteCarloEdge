import { describe, it, expect } from "vitest";
import { Range } from "../range.js";
import { getPositions, getRfiRange, getBbDefenseRange } from "../charts/index.js";
import { RFI as SIX_RFI } from "../charts/preflop-6max.js";
import { RFI as NINE_RFI } from "../charts/preflop-9max.js";
import { RFI as HU_RFI } from "../charts/preflop-hu.js";

describe("Chart position lists", () => {
  it("2-max has BTN and BB", () => {
    expect(getPositions(2)).toEqual(["BTN", "BB"]);
  });

  it("6-max has 6 positions", () => {
    expect(getPositions(6)).toHaveLength(6);
    expect(getPositions(6)).toContain("UTG");
    expect(getPositions(6)).toContain("BTN");
    expect(getPositions(6)).toContain("BB");
  });

  it("9-max has 9 positions", () => {
    expect(getPositions(9)).toHaveLength(9);
  });

  it("throws for unsupported table size", () => {
    expect(() => getPositions(1)).toThrow();
    expect(() => getPositions(13)).toThrow(); // 2–12 supported (12-max tables); 13 is out of range
  });
});

describe("6-max RFI ranges — tightness ordering", () => {
  const positions = ["UTG", "MP", "CO", "BTN"] as const;
  const sizes = positions.map((p) => getRfiRange(6, p).size);

  it("UTG < MP < CO < BTN (progressively wider)", () => {
    for (let i = 0; i < sizes.length - 1; i++) {
      expect(sizes[i]!).toBeLessThan(sizes[i + 1]!);
    }
  });

  it("UTG is ~12-18% of hands", () => {
    const pct = getRfiRange(6, "UTG").percentage;
    expect(pct).toBeGreaterThan(10);
    expect(pct).toBeLessThan(20);
  });

  it("BTN is ~35-50% of hands", () => {
    const pct = getRfiRange(6, "BTN").percentage;
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(55);
  });
});

describe("9-max RFI ranges — tightness ordering", () => {
  const positions = ["UTG", "UTG1", "UTG2", "MP", "HJ", "CO", "BTN"] as const;
  const sizes = positions.map((p) => getRfiRange(9, p).size);

  it("strictly wider from UTG to BTN", () => {
    for (let i = 0; i < sizes.length - 1; i++) {
      expect(sizes[i]!).toBeLessThan(sizes[i + 1]!);
    }
  });

  it("9-max UTG is tighter than 6-max UTG", () => {
    const nineUtg = getRfiRange(9, "UTG").percentage;
    const sixUtg = getRfiRange(6, "UTG").percentage;
    expect(nineUtg).toBeLessThan(sixUtg);
  });
});

describe("HU ranges", () => {
  it("BTN open is very wide (>50%)", () => {
    const pct = getRfiRange(2, "BTN").percentage;
    expect(pct).toBeGreaterThan(50);
  });

  it("BB defense vs BTN is wide (>40%)", () => {
    const pct = getBbDefenseRange(2, "BTN").percentage;
    expect(pct).toBeGreaterThan(40);
  });
});

describe("BB defense ranges", () => {
  it("BB defends wider vs BTN than vs UTG (6-max)", () => {
    const vsBTN = getBbDefenseRange(6, "BTN").percentage;
    const vsUTG = getBbDefenseRange(6, "UTG").percentage;
    expect(vsBTN).toBeGreaterThan(vsUTG);
  });

  it("BB defends wider vs SB than vs CO (6-max)", () => {
    const vsSB = getBbDefenseRange(6, "SB").percentage;
    const vsCO = getBbDefenseRange(6, "CO").percentage;
    expect(vsSB).toBeGreaterThan(vsCO);
  });
});

describe("All chart range strings parse without error", () => {
  for (const [pos, str] of Object.entries(SIX_RFI)) {
    it(`6-max RFI ${pos} parses`, () => {
      const r = Range.parse(str);
      expect(r.size).toBeGreaterThan(0);
    });
  }

  for (const [pos, str] of Object.entries(NINE_RFI)) {
    it(`9-max RFI ${pos} parses`, () => {
      const r = Range.parse(str);
      expect(r.size).toBeGreaterThan(0);
    });
  }

  for (const [pos, str] of Object.entries(HU_RFI)) {
    it(`HU RFI ${pos} parses`, () => {
      const r = Range.parse(str);
      expect(r.size).toBeGreaterThan(0);
    });
  }
});

describe("Table size interpolation", () => {
  it("4-max CO uses 6-max CO range", () => {
    const four = getRfiRange(4, "CO");
    const six = getRfiRange(6, "CO");
    expect(four.size).toBe(six.size);
  });

  it("7-max UTG uses 9-max UTG range", () => {
    const seven = getRfiRange(7, "UTG");
    const nine = getRfiRange(9, "UTG");
    expect(seven.size).toBe(nine.size);
  });

  it("5-max has MP, CO, BTN, SB, BB", () => {
    const pos = getPositions(5);
    expect(pos).toContain("MP");
    expect(pos).toContain("CO");
    expect(pos).toContain("BTN");
  });
});
