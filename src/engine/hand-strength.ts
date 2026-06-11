import { rankOf, suitOf, NUM_CARDS } from "./cards.js";
import { type Combo, Range } from "./range.js";

const CHEN = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10] as const;
const GAP = [0, -1, -2, -4, -5] as const;

export function comboScore(c: Combo): number {
  const r0 = rankOf(c[0]);
  const r1 = rankOf(c[1]);
  const hi = Math.max(r0, r1);
  const lo = Math.min(r0, r1);

  if (hi === lo) return Math.max(5, Math.ceil(CHEN[hi]! * 2));

  let s = CHEN[hi]!;
  if (suitOf(c[0]) === suitOf(c[1])) s += 2;
  const gap = hi - lo - 1;
  s += GAP[Math.min(gap, 4)]!;
  if (gap <= 1 && hi <= 9) s += 1;
  return Math.ceil(s);
}

let _all: Range | null = null;
export function allCombos(): Range {
  if (!_all) {
    const cs: Combo[] = [];
    for (let a = 0; a < NUM_CARDS; a++)
      for (let b = a + 1; b < NUM_CARDS; b++) cs.push([a, b] as Combo);
    _all = Range.fromCombos(cs);
  }
  return _all;
}

export function sortedCombos(range: Range): Combo[] {
  return range.combos.slice().sort((a, b) => {
    const d = comboScore(b) - comboScore(a);
    return d !== 0 ? d : b[0] * 52 + b[1] - (a[0] * 52 + a[1]);
  });
}

export function topSlice(range: Range, pct: number): Range {
  if (pct <= 0) return Range.empty();
  if (pct >= 1) return range;
  const sorted = sortedCombos(range);
  return Range.fromCombos(
    sorted.slice(0, Math.max(1, Math.round(sorted.length * pct))),
  );
}

export function middleSlice(
  range: Range,
  fromPct: number,
  toPct: number,
): Range {
  if (fromPct >= toPct) return Range.empty();
  const sorted = sortedCombos(range);
  return Range.fromCombos(
    sorted.slice(
      Math.round(sorted.length * fromPct),
      Math.round(sorted.length * toPct),
    ),
  );
}
