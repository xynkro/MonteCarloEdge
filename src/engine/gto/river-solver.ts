import { type Card, NUM_CARDS } from "../cards.js";
import { type Combo, Range } from "../range.js";
import { evaluate } from "../evaluator.js";
import { type Rng, mulberry32 } from "../rng.js";
import { InfoSets } from "./regret.js";
import { cfr, type CfrGame } from "./cfr.js";

export interface RiverSpot {
  heroRange: Range;
  villainRange: Range;
  board: readonly Card[]; // exactly 5 cards
  pot: number; // chips in the pot at the start of the river
  stack: number; // effective remaining stack per player
  betSizes?: number[]; // bet sizes as fractions of the pot (default [0.66, 1])
  maxRaises?: number; // total bets+raises allowed (default 2)
  iterations?: number; // CFR iterations (default 30000)
  rng?: Rng;
}

export interface ActionFreq {
  action: "check" | "bet" | "fold" | "call" | "raise";
  amount: number; // chips put in (0 for check/fold)
  freq: number;
}

export interface RiverResult {
  strategy: ActionFreq[]; // hero's GTO strategy for `heroHand` at the first decision
  heroEv: number; // hero EV in chips (hero acts first)
  iterations: number;
}

// Betting-tree node. Hero = player 0, villain = player 1. Hero acts first.
interface RState {
  toAct: 0 | 1;
  c: [number, number]; // chips contributed this street
  raises: number;
  checks: number; // consecutive checks (2 => showdown)
  done: "showdown" | "fold" | null;
  folder: 0 | 1 | -1;
  hist: string;
  hero: Combo;
  vill: Combo;
  pot: number; // starting pot
  stack: number;
  betSizes: number[];
  maxRaises: number;
  board: readonly Card[];
}

function curPot(s: RState): number {
  return s.pot + s.c[0] + s.c[1];
}

function makeGame(): CfrGame<RState> {
  return {
    isTerminal(s) {
      return s.done !== null;
    },

    utilityP0(s) {
      // Hero (player 0) chip EV, with the starting pot as contested dead money.
      if (s.done === "fold") {
        // The folder loses what they put in; the other wins the pot.
        if (s.folder === 1) return s.pot + s.c[1]; // villain folded -> hero wins
        return -s.c[0]; // hero folded
      }
      // Showdown
      const hr = evaluate([s.hero[0], s.hero[1], ...s.board]);
      const vr = evaluate([s.vill[0], s.vill[1], ...s.board]);
      if (hr > vr) return s.pot + s.c[1];
      if (hr < vr) return -s.c[0];
      return (s.pot + s.c[1] - s.c[0]) / 2; // tie
    },

    player(s) {
      return s.toAct;
    },

    infoKey(s) {
      const combo = s.toAct === 0 ? s.hero : s.vill;
      return `${combo[0] * 52 + combo[1]}|${s.hist}`;
    },

    actions(s) {
      const me = s.toAct;
      const other = (1 - me) as 0 | 1;
      const toCall = s.c[other]! - s.c[me]!;
      const facing = toCall > 0.0001;
      const myInvested = s.c[me]!;
      const stackLeft = s.stack - myInvested;
      if (stackLeft <= 0.0001) return facing ? ["c"] : ["x"];

      if (!facing) {
        const acts = ["x"];
        const targets = new Set<number>();
        if (s.raises < s.maxRaises) {
          for (const frac of s.betSizes) {
            const t = Math.min(s.stack, round1(myInvested + frac * curPot(s)));
            if (t > myInvested + 0.0001) targets.add(t);
          }
          targets.add(s.stack); // all-in
        }
        for (const t of [...targets].sort((a, b) => a - b)) acts.push(`b${t}`);
        return acts;
      }

      const acts = ["f", "c"];
      if (s.raises < s.maxRaises) {
        const potAfterCall = curPot(s) + toCall;
        const potRaise = Math.min(s.stack, round1(s.c[other]! + potAfterCall));
        if (potRaise > s.c[other]! + 0.0001 && potRaise < s.stack) acts.push(`r${potRaise}`);
        acts.push(`r${s.stack}`); // all-in raise
      }
      return acts;
    },

    next(s, action) {
      const me = s.toAct;
      const other = (1 - me) as 0 | 1;
      const ns: RState = {
        ...s,
        c: [s.c[0], s.c[1]],
        hist: s.hist + action,
        toAct: other,
      };
      if (action === "x") {
        ns.checks = s.checks + 1;
        if (ns.checks >= 2) { ns.done = "showdown"; }
        return ns;
      }
      ns.checks = 0;
      if (action === "f") {
        ns.done = "fold";
        ns.folder = me;
        return ns;
      }
      if (action === "c") {
        ns.c[me] = s.c[other]!;
        ns.done = "showdown";
        return ns;
      }
      // bet / raise: action is `b<target>` or `r<target>`
      const target = parseFloat(action.slice(1));
      ns.c[me] = target;
      ns.raises = s.raises + 1;
      return ns;
    },
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function comboConflict(a: Combo, b: Combo): boolean {
  return a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1];
}

export function solveRiver(spot: RiverSpot, heroHand: Combo): RiverResult {
  if (spot.board.length !== 5) throw new Error("river solver needs a 5-card board");
  const betSizes = spot.betSizes ?? [0.66, 1];
  const maxRaises = spot.maxRaises ?? 2;
  const iterations = spot.iterations ?? 30000;
  const rng = spot.rng ?? mulberry32(0x5001);

  const dead = [...spot.board];
  const heroCombos = spot.heroRange.filter(dead).combos;
  const villCombos = spot.villainRange.filter(dead).combos;
  if (heroCombos.length === 0 || villCombos.length === 0) {
    return { strategy: [], heroEv: 0, iterations: 0 };
  }

  const game = makeGame();
  const info = new InfoSets();

  const root = (hero: Combo, vill: Combo): RState => ({
    toAct: 0, c: [0, 0], raises: 0, checks: 0, done: null, folder: -1,
    hist: "", hero, vill, pot: spot.pot, stack: spot.stack,
    betSizes, maxRaises, board: spot.board,
  });

  // Chance-sampled CFR: each iteration samples one non-conflicting pair.
  for (let it = 0; it < iterations; it++) {
    const hero = heroCombos[Math.floor(rng() * heroCombos.length)]!;
    let vill: Combo | null = null;
    for (let tries = 0; tries < 12; tries++) {
      const cand = villCombos[Math.floor(rng() * villCombos.length)]!;
      if (!comboConflict(hero, cand)) { vill = cand; break; }
    }
    if (!vill) continue;
    cfr(game, info, root(hero, vill), 1, 1);
  }

  // Read hero's averaged strategy at the root for the actual hand.
  const rootKey = `${heroHand[0] * 52 + heroHand[1]}|`;
  const acts = game.actions(root(heroHand, villCombos[0]!));
  const avg = info.average(rootKey) ?? acts.map(() => 1 / acts.length);

  const strategy: ActionFreq[] = acts.map((a, i) => {
    const freq = avg[i]!;
    if (a === "x") return { action: "check" as const, amount: 0, freq };
    const target = parseFloat(a.slice(1));
    return { action: "bet" as const, amount: target, freq };
  });

  // Hero EV at the root for the actual hand, averaged over villain's range.
  const heroEv = rootEv(game, info, root, heroHand, villCombos);

  return { strategy, heroEv, iterations };
}

// Expected value to hero at the root for a fixed hero hand, under average strategies.
function rootEv(
  game: CfrGame<RState>,
  info: InfoSets,
  root: (h: Combo, v: Combo) => RState,
  heroHand: Combo,
  villCombos: Combo[],
): number {
  let sum = 0;
  let n = 0;
  for (const v of villCombos) {
    if (comboConflict(heroHand, v)) continue;
    sum += evalNode(game, info, root(heroHand, v));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function evalNode(game: CfrGame<RState>, info: InfoSets, s: RState): number {
  if (game.isTerminal(s)) return game.utilityP0(s);
  const key = game.infoKey(s);
  const acts = game.actions(s);
  const avg = info.average(key) ?? acts.map(() => 1 / acts.length);
  let v = 0;
  for (let i = 0; i < acts.length; i++) {
    v += avg[i]! * evalNode(game, info, game.next(s, acts[i]!));
  }
  return v;
}
