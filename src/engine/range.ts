import {
  type Card,
  makeCard,
  RANK_CHARS,
  rankOf,
  cardToString,
  parseCard,
} from "./cards.js";
import { type Rng } from "./rng.js";

export type Combo = readonly [Card, Card];

export const TOTAL_COMBOS = 1326;

const RI: Record<string, number> = {};
for (let i = 0; i < RANK_CHARS.length; i++) RI[RANK_CHARS[i]!] = i;

const SUITS = new Set(["c", "d", "h", "s"]);

function ri(ch: string): number {
  const v = RI[ch.toUpperCase()];
  if (v === undefined) throw new Error(`Invalid rank: ${ch}`);
  return v;
}

function ord(a: Card, b: Card): Combo {
  return a <= b ? [a, b] : [b, a];
}

function ck(c: Combo): number {
  return c[0] * 52 + c[1];
}

function unck(k: number): Combo {
  return [Math.floor(k / 52), k % 52] as Combo;
}

export function pairCombos(rank: number): Combo[] {
  const out: Combo[] = [];
  for (let s1 = 0; s1 < 4; s1++)
    for (let s2 = s1 + 1; s2 < 4; s2++)
      out.push(ord(makeCard(rank, s1), makeCard(rank, s2)));
  return out;
}

export function suitedCombos(hi: number, lo: number): Combo[] {
  const out: Combo[] = [];
  for (let s = 0; s < 4; s++)
    out.push(ord(makeCard(hi, s), makeCard(lo, s)));
  return out;
}

export function offsuitCombos(hi: number, lo: number): Combo[] {
  const out: Combo[] = [];
  for (let s1 = 0; s1 < 4; s1++)
    for (let s2 = 0; s2 < 4; s2++) {
      if (s1 === s2) continue;
      out.push(ord(makeCard(hi, s1), makeCard(lo, s2)));
    }
  return out;
}

function expandToken(raw: string): Combo[] {
  const t = raw.trim();
  if (!t) return [];

  // Specific combo: "AhKs" — 4 chars with suits at [1] and [3]
  if (
    t.length === 4 &&
    SUITS.has(t[1]!.toLowerCase()) &&
    SUITS.has(t[3]!.toLowerCase())
  ) {
    const c1 = parseCard(t.slice(0, 2));
    const c2 = parseCard(t.slice(2, 4));
    if (c1 === c2) throw new Error(`Duplicate card: ${t}`);
    return [ord(c1, c2)];
  }

  const plus = t.endsWith("+");
  const base = plus ? t.slice(0, -1) : t;

  // Pair range with dash: "22-66"
  const dash = base.indexOf("-");
  if (dash > 0) {
    if (base.length !== 5 || dash !== 2)
      throw new Error(`Bad range: ${t}`);
    const r1 = ri(base[0]!);
    const r1b = ri(base[1]!);
    const r2 = ri(base[3]!);
    const r2b = ri(base[4]!);
    if (r1 !== r1b || r2 !== r2b)
      throw new Error(`Dash ranges for pairs only: ${t}`);
    const lo = Math.min(r1, r2);
    const hi = Math.max(r1, r2);
    const out: Combo[] = [];
    for (let r = lo; r <= hi; r++) out.push(...pairCombos(r));
    return out;
  }

  if (base.length === 2) {
    const r1 = ri(base[0]!);
    const r2 = ri(base[1]!);

    if (r1 === r2) {
      if (plus) {
        const out: Combo[] = [];
        for (let r = r1; r <= 12; r++) out.push(...pairCombos(r));
        return out;
      }
      return pairCombos(r1);
    }

    // Non-pair, no suit → suited + offsuit. High card fixed, kicker slides.
    const hi = Math.max(r1, r2);
    const lo = Math.min(r1, r2);
    if (plus) {
      const out: Combo[] = [];
      for (let k = lo; k < hi; k++) {
        out.push(...suitedCombos(hi, k));
        out.push(...offsuitCombos(hi, k));
      }
      return out;
    }
    return [...suitedCombos(hi, lo), ...offsuitCombos(hi, lo)];
  }

  if (base.length === 3) {
    const r1 = ri(base[0]!);
    const r2 = ri(base[1]!);
    const sfx = base[2]!.toLowerCase();
    if (sfx !== "s" && sfx !== "o")
      throw new Error(`Bad suffix in: ${t}`);
    const hi = Math.max(r1, r2);
    const lo = Math.min(r1, r2);
    if (hi === lo) throw new Error(`Pairs can't be suited/offsuit: ${t}`);
    const fn = sfx === "s" ? suitedCombos : offsuitCombos;
    if (plus) {
      const out: Combo[] = [];
      for (let k = lo; k < hi; k++) out.push(...fn(hi, k));
      return out;
    }
    return fn(hi, lo);
  }

  throw new Error(`Unrecognized token: ${t}`);
}

export class Range {
  private readonly _keys: Set<number>;
  private _arr: Combo[] | null = null;

  private constructor(keys: Set<number>) {
    this._keys = keys;
  }

  static parse(s: string): Range {
    const keys = new Set<number>();
    for (const tok of s.split(",")) {
      for (const c of expandToken(tok)) keys.add(ck(c));
    }
    return new Range(keys);
  }

  static fromCombos(combos: Iterable<Combo>): Range {
    const keys = new Set<number>();
    for (const c of combos) keys.add(ck(ord(c[0], c[1])));
    return new Range(keys);
  }

  static empty(): Range {
    return new Range(new Set());
  }

  get combos(): Combo[] {
    if (!this._arr) {
      this._arr = Array.from(this._keys, unck);
    }
    return this._arr;
  }

  get size(): number {
    return this._keys.size;
  }

  get percentage(): number {
    return (this.size / TOTAL_COMBOS) * 100;
  }

  has(c: Combo): boolean {
    return this._keys.has(ck(ord(c[0], c[1])));
  }

  filter(dead: readonly Card[]): Range {
    const ds = new Set(dead);
    const keys = new Set<number>();
    for (const k of this._keys) {
      const [a, b] = unck(k);
      if (!ds.has(a) && !ds.has(b)) keys.add(k);
    }
    return new Range(keys);
  }

  sample(rng: Rng): Combo | null {
    const arr = this.combos;
    if (arr.length === 0) return null;
    return arr[Math.floor(rng() * arr.length)]!;
  }

  union(other: Range): Range {
    const keys = new Set(this._keys);
    for (const k of other._keys) keys.add(k);
    return new Range(keys);
  }

  intersect(other: Range): Range {
    const keys = new Set<number>();
    for (const k of this._keys) if (other._keys.has(k)) keys.add(k);
    return new Range(keys);
  }

  encode(): string {
    const tokens: string[] = [];
    const used = new Set<number>();

    for (let r = 12; r >= 0; r--) {
      const all = pairCombos(r);
      if (all.every((c) => this._keys.has(ck(c)))) {
        tokens.push(RANK_CHARS[r]! + RANK_CHARS[r]!);
        for (const c of all) used.add(ck(c));
      }
    }

    for (let hi = 12; hi >= 1; hi--) {
      for (let lo = hi - 1; lo >= 0; lo--) {
        const sc = suitedCombos(hi, lo);
        const oc = offsuitCombos(hi, lo);
        const hasSuited = sc.every((c) => this._keys.has(ck(c)));
        const hasOffsuit = oc.every((c) => this._keys.has(ck(c)));

        if (hasSuited && hasOffsuit) {
          tokens.push(RANK_CHARS[hi]! + RANK_CHARS[lo]!);
          for (const c of sc) used.add(ck(c));
          for (const c of oc) used.add(ck(c));
        } else {
          if (hasSuited) {
            tokens.push(RANK_CHARS[hi]! + RANK_CHARS[lo]! + "s");
            for (const c of sc) used.add(ck(c));
          }
          if (hasOffsuit) {
            tokens.push(RANK_CHARS[hi]! + RANK_CHARS[lo]! + "o");
            for (const c of oc) used.add(ck(c));
          }
        }
      }
    }

    const remaining = [...this._keys]
      .filter((k) => !used.has(k))
      .sort((a, b) => a - b);
    for (const k of remaining) {
      const [a, b] = unck(k);
      tokens.push(cardToString(a) + cardToString(b));
    }

    return tokens.join(",");
  }
}
