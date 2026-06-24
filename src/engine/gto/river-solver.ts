import { type Card, NUM_CARDS, rankOf, suitOf } from "../cards.js";
import { type Combo, Range } from "../range.js";
import { evaluate } from "../evaluator.js";
import { type Rng, mulberry32 } from "../rng.js";
import { InfoSets } from "./regret.js";

// Street-aware subgame solver. Solves from the flop (3), turn (4), or river (5)
// via chance-sampled CFR: each iteration samples the two hole hands and, at each
// street transition, one runout card. The averaged strategy converges to the
// Nash equilibrium of the full subgame (it accounts for all runouts in
// expectation). Hero = player 0 and acts first.

export interface RiverSpot {
  heroRange: Range;
  villainRange: Range;
  board: readonly Card[]; // 3, 4, or 5 cards
  pot: number;
  stack: number;
  betSizes?: number[];
  maxRaises?: number;
  iterations?: number;
  rng?: Rng;
  // When > 0, hero is FACING a bet of this many chips at the root (villain has already
  // bet), so hero's root menu is fold / call / raise instead of check / bet. `pot` must be
  // the pot BEFORE this bet. 0 / undefined = hero leads (the original behaviour).
  facingBet?: number;
  // Force equity-leaf mode (single betting street, then award by all-in equity
  // over the runout). Default: flop only. Set true to make turn solves fast
  // enough for live use (approximates a check-down after this street).
  equityLeaf?: boolean;
}

export interface ActionFreq {
  action: "check" | "bet" | "fold" | "call" | "raise";
  amount: number;
  freq: number;
}

export interface RiverResult {
  strategy: ActionFreq[];
  heroEv: number;
  iterations: number;
}

interface Ctx {
  pot: number;
  stack: number;
  betSizes: number[];
  maxRaises: number;
  rng: Rng;
  info: InfoSets;
  initialLen: number; // board length the solve started from (3/4/5)
  // Equity-leaf mode: when betting closes before the river, award the pot by
  // all-in equity over the runout instead of recursing further streets. Keeps
  // flop solves fast (single betting street) — it assumes a check-down after.
  equityLeaf: boolean;
  eqCache: Map<string, { pWin: number; pTie: number }>;
  leafSamples: number;
}

// Bucket a runout card by what it DOES relative to the prior board, so later-
// street info sets don't fragment per exact card (card abstraction). The
// showdown always uses the real card; only info-set keys are bucketed.
function cardBucket(card: Card, prevBoard: Card[]): string {
  const r = rankOf(card), s = suitOf(card);
  let paired = false, suitCount = 0;
  for (const b of prevBoard) {
    if (rankOf(b) === r) paired = true;
    if (suitOf(b) === s) suitCount++;
  }
  const tier = r >= 8 ? "H" : r >= 5 ? "M" : "L";
  return tier + (paired ? "p" : "") + (suitCount >= 2 ? "f" : "");
}

interface St {
  toAct: 0 | 1;
  inv: [number, number]; // cumulative chips contributed (all streets)
  raises: number; // raises this street
  checks: number;
  done: "showdown" | "fold" | null;
  folder: 0 | 1 | -1;
  hist: string;
  board: Card[];
  hero: Combo;
  vill: Combo;
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
function curPot(ctx: Ctx, s: St): number { return ctx.pot + s.inv[0] + s.inv[1]; }
// Order-independent combo id. Range.combos yields canonical [lo,hi] but callers
// pass heroHand in arbitrary order; without normalizing, the root info-set key
// built from the passed hand misses the key accumulated during traversal and
// average() falls back to a uniform strategy (the solver appears not to solve).
function comboId(c: Combo): number {
  return c[0] <= c[1] ? c[0] * 52 + c[1] : c[1] * 52 + c[0];
}
function conflict(a: Combo, b: Combo): boolean {
  return a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1];
}

function actions(ctx: Ctx, s: St): string[] {
  const me = s.toAct;
  const other = (1 - me) as 0 | 1;
  const toCall = s.inv[other]! - s.inv[me]!;
  const facing = toCall > 0.0001;
  const stackLeft = ctx.stack - s.inv[me]!;
  if (stackLeft <= 0.0001) return facing ? ["c"] : ["x"];

  if (!facing) {
    const acts = ["x"];
    const targets = new Set<number>();
    if (s.raises < ctx.maxRaises) {
      for (const frac of ctx.betSizes) {
        const t = Math.min(ctx.stack, round1(s.inv[me]! + frac * curPot(ctx, s)));
        if (t > s.inv[me]! + 0.0001) targets.add(t);
      }
      targets.add(ctx.stack);
    }
    for (const t of [...targets].sort((a, b) => a - b)) acts.push(`b${t}`);
    return acts;
  }

  const acts = ["f", "c"];
  if (s.raises < ctx.maxRaises) {
    const potAfterCall = curPot(ctx, s) + toCall;
    const potRaise = Math.min(ctx.stack, round1(s.inv[other]! + potAfterCall));
    if (potRaise > s.inv[other]! + 0.0001 && potRaise < ctx.stack) acts.push(`r${potRaise}`);
    acts.push(`r${ctx.stack}`);
  }
  return acts;
}

function next(s: St, action: string): St {
  const me = s.toAct;
  const other = (1 - me) as 0 | 1;
  const ns: St = { ...s, inv: [s.inv[0], s.inv[1]], hist: s.hist + action, toAct: other };
  if (action === "x") {
    ns.checks = s.checks + 1;
    if (ns.checks >= 2) ns.done = "showdown";
    return ns;
  }
  ns.checks = 0;
  if (action === "f") { ns.done = "fold"; ns.folder = me; return ns; }
  if (action === "c") { ns.inv[me] = s.inv[other]!; ns.done = "showdown"; return ns; }
  ns.inv[me] = parseFloat(action.slice(1));
  ns.raises = s.raises + 1;
  return ns;
}

function terminalUtil(ctx: Ctx, s: St): number {
  if (s.done === "fold") {
    return s.folder === 1 ? ctx.pot + s.inv[1]! : -s.inv[0]!;
  }
  const hr = evaluate([s.hero[0], s.hero[1], ...s.board]);
  const vr = evaluate([s.vill[0], s.vill[1], ...s.board]);
  if (hr > vr) return ctx.pot + s.inv[1]!;
  if (hr < vr) return -s.inv[0]!;
  return (ctx.pot + s.inv[1]! - s.inv[0]!) / 2;
}

function transition(s: St, card: Card): St {
  return {
    ...s,
    inv: [s.inv[0], s.inv[1]],
    raises: 0, checks: 0, done: null, toAct: 0,
    hist: s.hist + "/",
    board: [...s.board, card],
  };
}

function availableCards(s: St): Card[] {
  const used = new Uint8Array(NUM_CARDS);
  for (const c of s.board) used[c] = 1;
  used[s.hero[0]] = 1; used[s.hero[1]] = 1;
  used[s.vill[0]] = 1; used[s.vill[1]] = 1;
  const out: Card[] = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!used[c]) out.push(c);
  return out;
}

// All-in equity for the current pair over the runout, cached per matchup.
function leafEquity(ctx: Ctx, s: St): { pWin: number; pTie: number } {
  const key = `${comboId(s.hero)}_${comboId(s.vill)}`;
  const hit = ctx.eqCache.get(key);
  if (hit) return hit;
  const cards = availableCards(s);
  const need = 5 - s.board.length;
  let win = 0, tie = 0, n = 0;
  const N = ctx.leafSamples;
  const full = s.board.slice();
  for (let it = 0; it < N; it++) {
    // partial Fisher–Yates draw of `need` cards
    for (let j = 0; j < need; j++) {
      const idx = j + Math.floor(ctx.rng() * (cards.length - j));
      const t = cards[j]!; cards[j] = cards[idx]!; cards[idx] = t;
    }
    full.length = s.board.length;
    for (let j = 0; j < need; j++) full.push(cards[j]!);
    const hr = evaluate([s.hero[0], s.hero[1], ...full]);
    const vr = evaluate([s.vill[0], s.vill[1], ...full]);
    if (hr > vr) win++; else if (hr === vr) tie++;
    n++;
  }
  const res = { pWin: n ? win / n : 0.5, pTie: n ? tie / n : 0 };
  ctx.eqCache.set(key, res);
  return res;
}

function leafUtil(ctx: Ctx, s: St): number {
  const { pWin, pTie } = leafEquity(ctx, s);
  const pLose = 1 - pWin - pTie;
  const win = ctx.pot + s.inv[1]!;
  const lose = -s.inv[0]!;
  return pWin * win + pLose * lose + pTie * (win + lose) / 2;
}

function infoKey(ctx: Ctx, s: St): string {
  const combo = s.toAct === 0 ? s.hero : s.vill;
  const init = ctx.initialLen;
  let key = `${comboId(combo)}|${s.board.slice(0, init).join(",")}`;
  for (let i = init; i < s.board.length; i++) {
    key += `|${cardBucket(s.board[i]!, s.board.slice(0, i))}`;
  }
  return `${key}|${s.hist}`;
}

// CFR traversal with chance sampling at street transitions.
function traverse(ctx: Ctx, s: St, pi0: number, pi1: number): number {
  if (s.done === "fold") return terminalUtil(ctx, s);
  if (s.done === "showdown") {
    if (s.board.length >= 5) return terminalUtil(ctx, s);
    if (ctx.equityLeaf) return leafUtil(ctx, s);
    const cards = availableCards(s);
    const card = cards[Math.floor(ctx.rng() * cards.length)]!;
    return traverse(ctx, transition(s, card), pi0, pi1);
  }

  const pl = s.toAct;
  const key = infoKey(ctx, s);
  const acts = actions(ctx, s);
  const n = acts.length;
  const strat = ctx.info.getStrategy(key, n);
  const childUtil = new Float64Array(n);
  let nodeU0 = 0;
  for (let i = 0; i < n; i++) {
    const u = pl === 0
      ? traverse(ctx, next(s, acts[i]!), pi0 * strat[i]!, pi1)
      : traverse(ctx, next(s, acts[i]!), pi0, pi1 * strat[i]!);
    childUtil[i] = u;
    nodeU0 += strat[i]! * u;
  }
  const cfReach = pl === 0 ? pi1 : pi0;
  const ownReach = pl === 0 ? pi0 : pi1;
  const node = pl === 0 ? nodeU0 : -nodeU0;
  for (let i = 0; i < n; i++) {
    const val = pl === 0 ? childUtil[i]! : -childUtil[i]!;
    ctx.info.addRegret(key, i, cfReach * (val - node));
  }
  ctx.info.addStrategy(key, strat, ownReach);
  return nodeU0;
}

// EV under averaged strategies; chance is enumerated (turn→river) or sampled (deeper).
function evalNode(ctx: Ctx, s: St): number {
  if (s.done === "fold") return terminalUtil(ctx, s);
  if (s.done === "showdown") {
    if (s.board.length >= 5) return terminalUtil(ctx, s);
    if (ctx.equityLeaf) return leafUtil(ctx, s);
    const cards = availableCards(s);
    // One layer to the river → enumerate; deeper (flop) → sample to bound cost.
    const layersLeft = 5 - s.board.length;
    const chosen = layersLeft === 1 ? cards : sampleK(cards, 12, ctx.rng);
    let sum = 0;
    for (const c of chosen) sum += evalNode(ctx, transition(s, c));
    return sum / chosen.length;
  }
  const key = infoKey(ctx, s);
  const acts = actions(ctx, s);
  const avg = ctx.info.average(key) ?? acts.map(() => 1 / acts.length);
  let v = 0;
  for (let i = 0; i < acts.length; i++) v += avg[i]! * evalNode(ctx, next(s, acts[i]!));
  return v;
}

function sampleK(arr: Card[], k: number, rng: Rng): Card[] {
  if (arr.length <= k) return arr;
  const out: Card[] = [];
  const seen = new Set<number>();
  while (out.length < k) {
    const idx = Math.floor(rng() * arr.length);
    if (!seen.has(idx)) { seen.add(idx); out.push(arr[idx]!); }
  }
  return out;
}

export function solveSubgame(spot: RiverSpot, heroHand: Combo): RiverResult {
  if (spot.board.length < 3 || spot.board.length > 5) {
    throw new Error("subgame solver needs a 3-, 4-, or 5-card board");
  }
  const flop = spot.board.length === 3;
  const ctx: Ctx = {
    pot: spot.pot,
    stack: Math.max(spot.stack, spot.pot * 0.5),
    betSizes: spot.betSizes ?? [0.66, 1],
    maxRaises: spot.maxRaises ?? 2,
    rng: spot.rng ?? mulberry32(0x5001),
    info: new InfoSets(),
    initialLen: spot.board.length,
    equityLeaf: spot.equityLeaf ?? flop, // flop default; opt-in for fast turn solves
    eqCache: new Map(),
    leafSamples: 160,
  };
  const iterations = spot.iterations ??
    (spot.board.length === 5 ? 12000 : spot.board.length === 4 ? 24000 : 18000);

  const dead = [...spot.board];
  const heroCombos = spot.heroRange.filter(dead).combos;
  const villCombos = spot.villainRange.filter(dead).combos;
  if (heroCombos.length === 0 || villCombos.length === 0) {
    return { strategy: [], heroEv: 0, iterations: 0 };
  }

  // Facing a bet: seed villain's bet into the pot so hero's root menu is fold/call/raise.
  // The bet counts as the first raise (so maxRaises caps re-raises consistently). The root
  // info-set key is combo|board|hist("") regardless, so it still matches `rootKey` below.
  const facing = spot.facingBet && spot.facingBet > 0.0001 ? round1(spot.facingBet) : 0;
  const root = (hero: Combo, vill: Combo): St => ({
    toAct: 0, inv: [0, facing], raises: facing ? 1 : 0, checks: 0, done: null, folder: -1,
    hist: "", board: [...spot.board], hero, vill,
  });

  for (let it = 0; it < iterations; it++) {
    const hero = heroCombos[Math.floor(ctx.rng() * heroCombos.length)]!;
    let vill: Combo | null = null;
    for (let t = 0; t < 12; t++) {
      const cand = villCombos[Math.floor(ctx.rng() * villCombos.length)]!;
      if (!conflict(hero, cand)) { vill = cand; break; }
    }
    if (!vill) continue;
    traverse(ctx, root(hero, vill), 1, 1);
  }

  const rootKey = `${comboId(heroHand)}|${spot.board.join(",")}|`;
  const acts = actions(ctx, root(heroHand, villCombos[0]!));
  const avg = ctx.info.average(rootKey) ?? acts.map(() => 1 / acts.length);
  const strategy: ActionFreq[] = acts.map((a, i) => {
    const freq = avg[i]!;
    if (a === "x") return { action: "check" as const, amount: 0, freq };
    if (a === "f") return { action: "fold" as const, amount: 0, freq };
    if (a === "c") return { action: "call" as const, amount: 0, freq };
    if (a[0] === "r") return { action: "raise" as const, amount: parseFloat(a.slice(1)), freq };
    return { action: "bet" as const, amount: parseFloat(a.slice(1)), freq };
  });

  let sum = 0, n = 0;
  for (const v of villCombos) {
    if (conflict(heroHand, v)) continue;
    sum += evalNode(ctx, root(heroHand, v));
    n++;
  }
  return { strategy, heroEv: n > 0 ? sum / n : 0, iterations };
}

// River-only convenience wrapper (board must be 5 cards).
export function solveRiver(spot: RiverSpot, heroHand: Combo): RiverResult {
  if (spot.board.length !== 5) throw new Error("river solver needs a 5-card board");
  return solveSubgame(spot, heroHand);
}
