// ── Independent Chip Model (ICM) ──
// Converts chip stacks into $-equity given a payout structure. In tournaments,
// chips are NOT linear money — busting is disproportionately costly near a pay
// jump, so correct play tightens (the "bubble factor"). This module is for a
// SINGLE TABLE (SNG / final table): the table's stacks + payouts = the whole
// ICM problem. Multi-table chip-chop is out of scope.
//
// Model: Malmuth–Harville. P(player i finishes 1st) = stack_i / total; then the
// remaining places are filled recursively on the remaining stacks. Exact (and
// fast) for the handful of players left at a final table; a Monte-Carlo
// finish-order sampler covers larger fields.

// Exact recursive ICM. Returns each player's $-equity (same order as `stacks`).
export function icmEquityExact(stacks: readonly number[], payouts: readonly number[]): number[] {
  const n = stacks.length;
  const eq = new Array<number>(n).fill(0);
  if (n === 0 || payouts.length === 0) return eq;

  // Award busted (zero-stack) players the worst remaining places, split equally.
  const busted = stacks.map((s, i) => s <= 0 ? i : -1).filter((i) => i >= 0);
  if (busted.length > 0) {
    const live = stacks.filter((s) => s > 0);
    if (live.length === 0) {
      const share = payouts.reduce((a, b) => a + b, 0) / n;
      return eq.map(() => share);
    }
    const livePayouts = payouts.slice(0, live.length);
    const bottomPayouts = payouts.slice(live.length, live.length + busted.length);
    const bottomShare = bottomPayouts.length > 0 ? bottomPayouts.reduce((a, b) => a + b, 0) / busted.length : 0;
    for (const b of busted) eq[b] = bottomShare;
    const liveEq = icmEquityExact(live, livePayouts);
    let k = 0;
    for (let i = 0; i < n; i++) if (stacks[i]! > 0) eq[i] = liveEq[k++]!;
    return eq;
  }

  const total = stacks.reduce((s, x) => s + x, 0);
  if (total <= 0) return eq;

  const place1 = payouts[0]!;
  const restPayouts = payouts.slice(1);
  for (let i = 0; i < n; i++) {
    if (stacks[i]! <= 0) continue;
    const pFirst = stacks[i]! / total;
    eq[i]! += pFirst * place1;
    if (restPayouts.length > 0 && n > 1) {
      const rest: number[] = [];
      for (let j = 0; j < n; j++) if (j !== i) rest.push(stacks[j]!);
      const subEq = icmEquityExact(rest, restPayouts);
      let k = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        eq[j]! += pFirst * subEq[k++]!;
      }
    }
  }
  return eq;
}

// Monte-Carlo ICM for larger fields: repeatedly sample a finish order where the
// next-highest place is awarded ∝ remaining stack, and average payouts by place.
export function icmEquityMonteCarlo(
  stacks: readonly number[],
  payouts: readonly number[],
  iterations: number,
  rng: () => number,
): number[] {
  const n = stacks.length;
  const eq = new Array<number>(n).fill(0);
  if (n === 0 || payouts.length === 0) return eq;
  const places = Math.min(payouts.length, n);
  for (let it = 0; it < iterations; it++) {
    const remaining = stacks.map((s, i) => ({ i, s }));
    let pool = remaining.reduce((a, b) => a + b.s, 0);
    for (let place = 0; place < places; place++) {
      let r = rng() * pool;
      let pick = 0;
      for (let j = 0; j < remaining.length; j++) {
        r -= remaining[j]!.s;
        if (r <= 0) { pick = j; break; }
      }
      const chosen = remaining[pick]!;
      eq[chosen.i]! += payouts[place]!;
      pool -= chosen.s;
      remaining.splice(pick, 1);
    }
  }
  return eq.map((e) => e / iterations);
}

// Pick exact for small fields (cheap and precise), MC otherwise. The exact cost
// grows with the number of PAID places (recursion depth), so gate on both.
export function icmEquity(
  stacks: readonly number[],
  payouts: readonly number[],
  rng?: () => number,
): number[] {
  const paid = Math.min(payouts.length, stacks.length);
  if (stacks.length <= 10 && paid <= 6) return icmEquityExact(stacks, payouts);
  // Deterministic default RNG (callers can pass their own seeded one).
  let s = 0x2f6e2b1;
  const r = rng ?? (() => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; });
  return icmEquityMonteCarlo(stacks, payouts, 20000, r);
}

// The ICM-required win probability for hero to profitably call an all-in:
// risking `risk` chips to win `gain` chips. p* = (E0 - E_lose) / (E_win - E_lose).
// Compare to the chip-EV pot-odds requirement risk/(risk+gain): the ratio is the
// classic "bubble factor" (>1 ⇒ you must be tighter than chip-EV says).
export function requiredCallEquityICM(
  stacks: readonly number[],
  payouts: readonly number[],
  heroIdx: number,
  risk: number,
  gain: number,
): number {
  const e0 = icmEquity(stacks, payouts)[heroIdx]!;
  const win = stacks.slice();
  win[heroIdx] = win[heroIdx]! + gain;
  // The chips hero wins come from the at-risk opponent pool; model as removing
  // `gain` from the rest proportionally (single-villain all-in: from that villain,
  // but proportional keeps it table-agnostic and conservative).
  const winTotalOthers = win.reduce((a, b, i) => a + (i === heroIdx ? 0 : b), 0);
  if (winTotalOthers > 0) {
    for (let i = 0; i < win.length; i++) {
      if (i === heroIdx) continue;
      win[i] = Math.max(0, win[i]! - gain * (stacks[i]! / (winTotalOthers || 1)));
    }
  }
  const lose = stacks.slice();
  lose[heroIdx] = Math.max(0, lose[heroIdx]! - risk);

  const eWin = icmEquity(win, payouts)[heroIdx]!;
  const eLose = icmEquity(lose, payouts)[heroIdx]!;
  const denom = eWin - eLose;
  if (denom <= 1e-9) return 1; // no upside ⇒ never call
  return Math.max(0, Math.min(1, (e0 - eLose) / denom));
}

// Bubble factor = ICM-required equity / chip-EV-required equity for the same
// all-in. 1.0 = chips are money (no bubble); >1 = busting is extra costly.
export function bubbleFactor(
  stacks: readonly number[],
  payouts: readonly number[],
  heroIdx: number,
  risk: number,
  gain: number,
): number {
  const chipEv = risk / (risk + gain);
  if (chipEv <= 1e-9) return 1;
  const icm = requiredCallEquityICM(stacks, payouts, heroIdx, risk, gain);
  return icm / chipEv;
}

// Standard single-table payout presets (fractions of the prize pool).
export const PAYOUT_PRESETS: Record<string, number[]> = {
  wta: [1],
  top2: [0.65, 0.35],
  top3: [0.5, 0.3, 0.2],
  top4: [0.4, 0.27, 0.2, 0.13],
};
