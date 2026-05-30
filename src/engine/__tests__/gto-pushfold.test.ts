import { describe, it, expect } from "vitest";
import { solvePushFold, jamFraction, callFraction } from "../gto/pushfold.js";
import { mulberry32 } from "../rng.js";

// Push/fold Nash has well-known qualitative properties; we validate those.
describe("push/fold Nash solver", () => {
  const short = solvePushFold(2, 150000, mulberry32(1)); // 2bb effective
  const mid = solvePushFold(10, 150000, mulberry32(2)); // 10bb
  const deep = solvePushFold(20, 150000, mulberry32(3)); // 20bb

  it("jams an extremely wide range at 2bb", () => {
    expect(jamFraction(short)).toBeGreaterThan(0.85);
  });

  it("jamming range tightens as the stack deepens", () => {
    expect(jamFraction(short)).toBeGreaterThan(jamFraction(mid));
    expect(jamFraction(mid)).toBeGreaterThan(jamFraction(deep));
  });

  it("BB calls tighter than SB jams (need a stronger hand to call off)", () => {
    expect(callFraction(mid)).toBeLessThan(jamFraction(mid));
    expect(callFraction(deep)).toBeLessThan(jamFraction(deep));
  });

  it("aces always jam and always call", () => {
    expect(mid.jam.get("AA")!).toBeGreaterThan(0.95);
    expect(mid.call.get("AA")!).toBeGreaterThan(0.95);
    expect(deep.call.get("AA")!).toBeGreaterThan(0.95);
  });

  it("trash is jammed more at 2bb than at 20bb and never a deep call-off", () => {
    expect(short.jam.get("72o")!).toBeGreaterThanOrEqual(deep.jam.get("72o")!);
    expect(deep.call.get("72o")!).toBeLessThan(0.1);
  });

  it("BB calling range at 10bb is a sane fraction (~15-45%)", () => {
    const f = callFraction(mid);
    expect(f).toBeGreaterThan(0.12);
    expect(f).toBeLessThan(0.5);
  });

  it("strong aces are jammed across all stack depths", () => {
    for (const r of [short, mid, deep]) {
      expect(r.jam.get("AKs")!).toBeGreaterThan(0.9);
      expect(r.jam.get("AKo")!).toBeGreaterThan(0.9);
    }
  });
});
