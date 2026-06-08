import { cardToString, rankOf, suitOf } from "./cards.js";
import { type Rng, mulberry32 } from "./rng.js";
import { monteCarloEquityVsRange, monteCarloEquityMultiway } from "./equity.js";
import { getRfiRange, getBbDefenseRange } from "./charts/index.js";
import { comboScore, sortedCombos } from "./hand-strength.js";
import { analyzeBoard, heroConnection } from "./board-texture.js";
import { describeHand } from "./made-hand.js";
import {
  type ActionType,
  type GameState,
} from "./game-state.js";
import { threeBetSize, fourBetSize, recommendSize } from "./sizing.js";
import { bubbleFactor } from "./icm.js";
import { handClassKey } from "./gto/pushfold.js";
import { classJams } from "./gto/pushfold-chart.js";
import {
  type OpponentProfile,
  TAG,
  estimateVillainRange,
  comboPercentile,
  credibleRep,
  repIsPolar,
  scoreRunout,
  sizeClass,
  repsCapped,
} from "./opponent.js";

// ── Short-stack push/fold (jam-or-fold) ──
// Below ~16bb, min-raising bleeds the stack; the GTO play is jam-or-fold. The
// jam range comes from a precomputed Nash push/fold chart (classJams) — the CFR
// solver is far too slow to run per decision — tightened by position for
// multiway pots via jamPosCap below.
function heroJams(hero: readonly [number, number], stackBB: number): boolean {
  return classJams(handClassKey(hero[0], hero[1]), stackBB);
}

// Max fraction of hands to open-jam from a position in a multiway pot. HU has no
// such cap (rely purely on Nash). Later position = wider; UTG only premiums.
function jamPosCap(pos: string, tableSize: number): number {
  if (tableSize <= 2) return 1; // HU: Nash frequency alone governs
  switch (pos) {
    case "SB": return 0.55;
    case "BTN": return 0.50;
    case "CO": return 0.40;
    case "HJ": case "LJ": case "MP": return 0.28;
    default: return 0.18; // UTG / early
  }
}

// Effective big blinds = hero's total chips this hand, in BB. Drives the
// push/fold mode switch.
function heroStackBB(state: GameState): number {
  const seat = state.heroSeat;
  return (state.stacks[seat]! + state.streetInvested[seat]!) / state.bb;
}

export interface Recommendation {
  action: ActionType;
  amount: number;
  equity: number; // raw all-in equity vs estimated range(s)
  realizedEquity?: number; // position-adjusted equity used for the decision
  potOdds: number;
  handLabel?: string; // "Top Pair Top Kicker", "Flush draw", etc.
  inPosition?: boolean;
  ev: { fold: number; call: number; raise: number };
  reasoning: string;
  // Provenance of this recommendation, so the UI can be honest about whether the
  // advice is solver-grounded or a heuristic:
  //   "solver" = CFR subgame solve · "nash" = push/fold Nash chart
  //   "chart"  = hand-authored preflop range · "heuristic" = MC-equity + rules
  source?: "solver" | "nash" | "chart" | "heuristic";
  // Mixed strategy (per-action frequencies) when known — populated by the solver.
  mix?: { action: ActionType; amount: number; freq: number }[];
}

// Per-seat opponent profiles (optional). Falls back to `defaultProfile`.
export type ProfileMap = Map<number, OpponentProfile>;

// Tournament config: payout structure (fractions of the prize pool, top-down)
// for ICM. Present ⇒ tournament mode (bubble-factor risk premium); absent ⇒ cash.
export interface IcmConfig { payouts: number[] }

// Hero PLAY STYLE — lets the user dial their own strategy instead of one-size-
// fits-all. `aggression` scales bluff/barrel frequency, value-bet thinness and
// 3-bet width; `looseness` scales open/call/defense width. 1.0 = GTO baseline.
export interface HeroStyle { aggression: number; looseness: number }
export const STYLE_GTO: HeroStyle = { aggression: 1.0, looseness: 1.0 };

export function recommend(
  state: GameState,
  villainProfile?: OpponentProfile,
  rng?: Rng,
  profiles?: ProfileMap,
  icm?: IcmConfig,
  style: HeroStyle = STYLE_GTO,
): Recommendation {
  const r = state.street === "preflop"
    ? preflopRecommend(state, villainProfile ?? TAG, profiles, icm, style)
    : postflopRecommend(state, villainProfile ?? TAG, rng ?? mulberry32(0xdec1de), profiles, style);
  // Tag provenance: preflop is the Nash push/fold chart when short (its reasoning
  // says "jam"/"all-in") else a hand-authored chart; postflop is MC-equity
  // heuristics (the live CFR solver is layered on in the UI for solvable spots).
  if (!r.source) {
    r.source = state.street === "preflop"
      ? (/jam|all-in/i.test(r.reasoning) ? "nash" : "chart")
      : "heuristic";
  }
  return r;
}

// Open-raise size (in chips) adapted to the table. Standard ~2.5-3bb, but vs a
// loose/sticky field (calling stations) size up to charge them and thin the
// field, plus extra per limper. A premium still wants callers, so this caps at
// a sane iso size rather than "buy everyone out".
function openSizeFor(
  state: GameState,
  villainProfile: OpponentProfile,
  profiles?: ProfileMap,
): number {
  const seat = state.heroSeat;
  // Count limpers: seats that just called the big blind ahead of the hero.
  let limpers = 0;
  for (const a of state.actions) {
    if (a.street === "preflop" && a.seat !== seat && a.type === "call") limpers++;
  }
  // Field stickiness = how much the live opponents call down.
  let sticky = 0, k = 0;
  for (let i = 0; i < state.folded.length; i++) {
    if (i === seat || state.folded[i]) continue;
    const p = profiles?.get(i) ?? villainProfile;
    sticky += p.calldownPct; k++;
  }
  if (k > 0) sticky /= k; else sticky = villainProfile.calldownPct;

  // Base 3bb (live default) scaling toward ~5bb vs a station-heavy field.
  const baseBB = 3 + Math.max(0, Math.min(0.4, sticky - 0.45)) * 5;
  // Each limper adds 1bb (more vs a loose field that will call the iso).
  const perLimper = sticky > 0.55 ? 1.5 : 1.0;
  const openBB = baseBB + limpers * perLimper;
  return Math.min(openBB * state.bb, state.stacks[seat]! + state.streetInvested[seat]!);
}

// Equity realization: raw all-in equity overstates what marginal hands win
// out of position and understates strong draws in position. This factor nudges
// the decision thresholds without changing the displayed raw equity.
function realizationFactor(
  inPosition: boolean,
  strong: boolean,
  hasDraw: boolean,
  madePair: boolean,
): number {
  let f = inPosition ? 1.06 : 0.94;
  if (hasDraw && inPosition) f += 0.04; // draws realize well with position
  if (madePair && !strong && !inPosition) f -= 0.03; // marginal made hand OOP
  return Math.max(0.85, Math.min(1.12, f));
}

// A2s–A5s: the canonical suited-ace BLOCKER bluff hands for 4-betting (they
// block AA/AK and play OK if called). Used to add bluffs to the 4-bet range.
function isWheelAceSuited(hero: readonly [number, number]): boolean {
  const suited = suitOf(hero[0]) === suitOf(hero[1]);
  const hi = Math.max(rankOf(hero[0]), rankOf(hero[1]));
  const lo = Math.min(rankOf(hero[0]), rankOf(hero[1]));
  return suited && hi === 12 && lo <= 3; // A + {2,3,4,5}
}

// Should hero CONTINUE a speculative hand for implied odds even when its raw
// percentile is below the calling cut? Small pairs set-mine, suited connectors /
// suited aces draw to the nuts — all need deep effective stacks to pay off (the
// 15x / 5-10 rules). `minR` lets callers demand a bigger ratio facing a 3-bet.
function speculativeContinue(
  hero: readonly [number, number],
  state: GameState,
  seat: number,
  looseness: number,
  minR = 1,
): boolean {
  const callAmt = state.toCall(seat);
  if (callAmt <= 0) return false;
  const heroTotal = state.stacks[seat]! + state.streetInvested[seat]!;
  // Effective stack = min(hero, deepest still-in opponent) — can't win more.
  let villTotal = 0;
  for (let i = 0; i < state.folded.length; i++) {
    if (i === seat || state.folded[i]) continue;
    villTotal = Math.max(villTotal, state.stacks[i]! + state.streetInvested[i]!);
  }
  const eff = Math.min(heroTotal, villTotal || heroTotal);
  const R = eff / callAmt; // implied-odds ratio (effective stack : price)
  const pctOfStack = callAmt / eff;
  const r0 = rankOf(hero[0]), r1 = rankOf(hero[1]);
  const suited = suitOf(hero[0]) === suitOf(hero[1]);
  const hi = Math.max(r0, r1), lo = Math.min(r0, r1), gap = hi - lo;
  const L = looseness; // a looser style needs a less generous price
  if (r0 === r1) return R >= 15 / L && pctOfStack <= 0.12 * L;   // set-mine any pair
  if (suited && hi === 12) return R >= (22 / L) * minR;          // suited ace (nut-flush + ace-high)
  if (suited && gap <= 1 && lo >= 3) return R >= (25 / L) * minR; // suited connectors 54s+
  if (suited && gap <= 2) return R >= (32 / L) * minR;           // suited gappers
  return false;
}

// Facing a 3-bet (raiseCount 2) or a 4-bet+ (raiseCount >= 3) at a playable
// depth. Percentile cutoffs approximate the 6-max consensus polar ranges:
//   5-bet jam ≈ KK+/AKs (~1.3%) · 4-bet value ≈ QQ+/AK (~2.6%) + Axs blockers
//   flat-3bet ≈ JJ-99/AQ/suited broadways (IP wider than OOP).
function reRaiseDecision(
  state: GameState,
  hero: readonly [number, number],
  seat: number,
  raiseCount: number,
  heroRaisedPre: boolean,
  heroTotal: number,
  label: string,
  bf = 1, // ICM bubble factor — tightens value/jam/flat cutoffs near a pay jump
  style: HeroStyle = STYLE_GTO,
): Recommendation {
  const p = comboPercentile([hero[0], hero[1]]);
  const ip = state.isInPosition(seat);
  const odds = state.potOdds(seat);
  const aggr = style.aggression, loose = style.looseness;

  if (raiseCount >= 3) {
    // Facing a 4-bet: 5-bet jam premiums; flat QQ/AKo only when deep; else fold.
    if (p < (0.013 / bf) * aggr) {
      return { action: "raise", amount: heroTotal, equity: 0.6, potOdds: odds,
        ev: { fold: 0, call: 0.5, raise: 2 }, reasoning: `5-bet jam — ${label}, premium vs 4-bet` };
    }
    if (p < 0.022 / bf && heroTotal / state.bb > 40) {
      return { action: "call", amount: 0, equity: 0.45, potOdds: odds,
        ev: { fold: 0, call: 0.2, raise: 0 }, reasoning: `Call the 4-bet — ${label} (deep)` };
    }
    return { action: "fold", amount: 0, equity: 0, potOdds: odds,
      ev: { fold: 0, call: -1, raise: -1 }, reasoning: `Fold — ${label} vs 4-bet` };
  }

  // Facing a 3-bet. (Blocker 4-bet bluffs are dropped near a bubble — bf>1.)
  const fourBetCut = (0.026 / bf) * aggr;
  const blockerBluff = isWheelAceSuited(hero) && heroRaisedPre && ip && bf <= 1.03;
  if (p < fourBetCut || blockerBluff) {
    const amt = Math.min(fourBetSize(state.currentBet), heroTotal);
    const kind = p < fourBetCut ? "value" : "blocker bluff";
    return { action: "raise", amount: amt, equity: 0.58, potOdds: odds,
      ev: { fold: 0, call: 0.5, raise: 1.8 }, reasoning: `4-bet — ${label} (${kind})` };
  }
  const flatCut = (ip ? 0.075 : 0.045) * loose / bf; // JJ-99/AQ/suited broadways IP, tighter OOP
  // Deep IP, also set-mine / draw to the nuts vs a 3-bet (implied odds).
  const deepSpec = ip && heroTotal / state.bb > 40 && speculativeContinue(hero, state, seat, loose, 1.6);
  if (p < flatCut || deepSpec) {
    return { action: "call", amount: 0, equity: 0.45, potOdds: odds,
      ev: { fold: 0, call: 0.3, raise: 0 }, reasoning: `Call the 3-bet — ${label}${deepSpec && p >= flatCut ? " (implied odds)" : ""}` };
  }
  return { action: "fold", amount: 0, equity: 0, potOdds: odds,
    ev: { fold: 0, call: -0.4, raise: -1 }, reasoning: `Fold — ${label} vs 3-bet` };
}

// Short-handed games play looser than the full-ring positional twin (blinds come
// round faster, more heads-up pots). The hand-authored charts are 6-max/9-max, so
// 3/4/5-max get an explicit widen on top of the chart. 1.0 = no change (6-max+).
function shortHandedMult(tableSize: number): number {
  return tableSize === 3 || tableSize === 4 ? 1.28 : tableSize === 5 ? 1.13 : 1.0;
}

function preflopRecommend(
  state: GameState,
  villainProfile: OpponentProfile = TAG,
  profiles?: ProfileMap,
  icm?: IcmConfig,
  style: HeroStyle = STYLE_GTO,
): Recommendation {
  const hero = state.heroCards;
  const seat = state.heroSeat;
  const pos = state.positions[seat]!;
  const label = `${cardToString(hero[0])}${cardToString(hero[1])}`;

  // ICM risk premium (tournament mode). A bubble factor > 1 means busting costs
  // more $ than the chips are worth, so we must JAM/CALL TIGHTER than chip-EV.
  // We compute one representative bubble factor for hero (an even-stacked all-in)
  // from the table's chip stacks + payouts, and divide the jam/call cutoffs by it.
  let bf = 1;
  if (icm && icm.payouts.length > 0) {
    const chips = state.stacks.map((s, i) => s + (state.invested[i] ?? 0));
    const risk = Math.max(1, chips[seat]!);
    bf = bubbleFactor(chips, icm.payouts, seat, risk, risk);
    bf = Math.max(1, Math.min(2.5, bf));
  }
  const icmNote = bf > 1.03 ? ` · ICM ${bf.toFixed(2)}×` : "";

  // Raise DEPTH this preflop: 0 = unopened, 1 = a single open, 2 = a 3-bet is
  // out, 3+ = a 4-bet+ is out. Drives the open / 3-bet / 4-bet / 5-bet tree.
  const preRaises = state.actions.filter(
    (a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet"),
  );
  const raiseCount = preRaises.length;
  const heroRaisedPre = preRaises.some((a) => a.seat === seat);
  const callersBeforeHero = state.actions.filter(
    (a) => a.street === "preflop" && a.type === "call" && a.seat !== seat,
  ).length;
  const facingRaise = preRaises.some((a) => a.seat !== seat);

  const heroTotal = state.stacks[seat]! + state.streetInvested[seat]!;
  const heroBB = heroStackBB(state);

  if (!facingRaise) {
    if (pos === "BB") {
      return {
        action: "check",
        amount: 0,
        equity: 0.5,
        potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0 },
        reasoning: `Check — BB with no raise`,
      };
    }
    // Short-stack open: jam-or-fold instead of min-raising the stack away.
    if (heroBB <= 16) {
      const within = comboPercentile([hero[0], hero[1]]) <= jamPosCap(pos, state.tableSize) / bf;
      if (heroJams(hero, heroBB) && within) {
        return {
          action: "raise", amount: heroTotal, equity: 0.5, potOdds: 0,
          ev: { fold: 0, call: 0.5, raise: 1 },
          reasoning: `All-in ${heroBB.toFixed(0)}bb — ${label}, short-stack jam range (${pos})${icmNote}`,
        };
      }
      return {
        action: "fold", amount: 0, equity: 0, potOdds: 0,
        ev: { fold: 0, call: -1, raise: -1 },
        reasoning: `Fold — ${label}, short-stack jam-or-fold, not a jam (${pos})`,
      };
    }
    try {
      const rfi = getRfiRange(state.tableSize, pos);
      // Opens scale with shorthandedness AND the hero's looseness. The chart is
      // the GTO baseline (keyed to players-behind via position); on top of it we
      // only ever WIDEN, never tighten below it:
      //  • short-handed games open wider than the full-ring positional twin
      //    (blinds come round faster, more heads-up pots) — the chart is 6-max,
      //    so 3/4/5-max get an explicit bump;
      //  • a looser play style (LAG/Maniac) opens wider, a tighter one (Nit) just
      //    sticks to the chart.
      const shMult = shortHandedMult(state.tableSize);
      const widen = style.looseness * shMult;
      const inChart = rfi.has([hero[0], hero[1]]);
      const openCap = Math.min(0.9, (rfi.percentage / 100) * widen);
      const widened = !inChart && widen > 1.0 && comboPercentile([hero[0], hero[1]]) <= openCap;
      if (inChart || widened) {
        const amt = openSizeFor(state, villainProfile, profiles);
        const bbN = (amt / state.bb);
        const note = widened
          ? (shMult > 1.0 ? " (short-handed open)" : " (loose-style open)")
          : bbN >= 4 ? " (sized up vs loose field)" : "";
        return {
          action: "raise",
          amount: amt,
          equity: 0.55,
          potOdds: 0,
          ev: { fold: 0, call: 0.5, raise: 1 },
          reasoning: `Open raise to ${bbN.toFixed(1)}bb — ${label} in ${pos} open range${note}`,
        };
      }
    } catch {
      // position not in charts
    }
    return {
      action: "fold",
      amount: 0,
      equity: 0,
      potOdds: 0,
      ev: { fold: 0, call: -1, raise: -1 },
      reasoning: `Fold — ${label} below the ${pos} open range (${state.tableSize}-max)`,
    };
  }

  if (pos === "BB") {
    const opener = state.actions.find(
      (a) =>
        a.seat !== seat &&
        (a.type === "raise" || a.type === "bet") &&
        a.street === "preflop",
    );
    // Short-stack BB: jam the strong part of the defense range rather than
    // calling/min-3betting; otherwise fall through to a priced call or fold.
    if (heroBB <= 14) {
      if (heroJams(hero, heroBB) && comboPercentile([hero[0], hero[1]]) <= 0.30 / bf) {
        return {
          action: "raise", amount: heroTotal, equity: 0.52, potOdds: state.potOdds(seat),
          ev: { fold: 0, call: 0.4, raise: 1.4 },
          reasoning: `3-bet jam ${heroBB.toFixed(0)}bb — ${label} from BB${icmNote}`,
        };
      }
    }
    // BB facing a 3-bet+ (cold): the defense charts are vs a single opener, not a
    // 3-bet, so route to the polar re-raise tree (tight: 4-bet KK+/AKs, flat QQ/AK).
    if (raiseCount >= 2) {
      return reRaiseDecision(state, hero, seat, raiseCount, heroRaisedPre, heroTotal, label, bf, style);
    }
    if (opener) {
      const openerPos = state.positions[opener.seat]!;
      try {
        const defRange = getBbDefenseRange(state.tableSize, openerPos);
        const inDef = defRange.has([hero[0], hero[1]]);
        // Short-handed / loose styles defend wider than the 6-max chart; the
        // widened hands flat (the 3-bet branch stays reserved for top-of-chart).
        const widen = style.looseness * shortHandedMult(state.tableSize);
        const defWidened = !inDef && widen > 1.0
          && comboPercentile([hero[0], hero[1]]) <= Math.min(0.92, (defRange.percentage / 100) * widen);
        if (inDef) {
          const sorted = sortedCombos(defRange);
          const idx = sorted.findIndex(
            (c) =>
              (c[0] === hero[0] && c[1] === hero[1]) ||
              (c[0] === hero[1] && c[1] === hero[0]),
          );
          if (idx >= 0 && idx < sorted.length * 0.2) {
            const amt = Math.min(
              threeBetSize(state.currentBet, false),
              state.stacks[seat]! + state.streetInvested[seat]!,
            );
            return {
              action: "raise",
              amount: amt,
              equity: 0.58,
              potOdds: state.potOdds(seat),
              ev: { fold: 0, call: 0.5, raise: 1.5 },
              reasoning: `3-bet — ${label} top of BB defense vs ${openerPos}`,
            };
          }
          return {
            action: "call",
            amount: 0,
            equity: 0.45,
            potOdds: state.potOdds(seat),
            ev: { fold: 0, call: 0.3, raise: 0 },
            reasoning: `Call — ${label} in BB defense vs ${openerPos}`,
          };
        }
        if (defWidened) {
          return {
            action: "call",
            amount: 0,
            equity: 0.42,
            potOdds: state.potOdds(seat),
            ev: { fold: 0, call: 0.2, raise: 0 },
            reasoning: `Call — ${label}, short-handed BB defense vs ${openerPos}`,
          };
        }
      } catch {
        // fallthrough
      }
    }
    return {
      action: "fold",
      amount: 0,
      equity: 0,
      potOdds: state.potOdds(seat),
      ev: { fold: 0, call: -0.5, raise: -1 },
      reasoning: `Fold — ${label} below BB defense range (${state.tableSize}-max)`,
    };
  }

  // Short-stack facing a raise: re-jam or fold (flatting OOP short bleeds). The
  // re-jam range is tighter than an open-jam — you're calling off vs a range that
  // chose to raise.
  if (heroBB <= 14) {
    const reCap = jamPosCap(pos, state.tableSize) * 0.7 / bf;
    if (heroJams(hero, heroBB) && comboPercentile([hero[0], hero[1]]) <= reCap) {
      return {
        action: "raise", amount: heroTotal, equity: 0.5, potOdds: state.potOdds(seat),
        ev: { fold: 0, call: 0.5, raise: 1.5 },
        reasoning: `3-bet jam ${heroBB.toFixed(0)}bb — ${label} vs raise${icmNote}`,
      };
    }
    return {
      action: "fold", amount: 0, equity: 0, potOdds: state.potOdds(seat),
      ev: { fold: 0, call: -0.5, raise: -1 },
      reasoning: `Fold — ${label}, short stack vs raise (jam-or-fold)`,
    };
  }

  // Facing a 3-bet (we opened) or a 4-bet+ → the polar re-raise tree.
  if (raiseCount >= 2) {
    return reRaiseDecision(state, hero, seat, raiseCount, heroRaisedPre, heroTotal, label, bf, style);
  }

  // Facing a single open with caller(s) in between → SQUEEZE (tighter value, a
  // larger size to charge the dead money), rather than flatting multiway OOP.
  if (raiseCount === 1 && callersBeforeHero > 0) {
    const p = comboPercentile([hero[0], hero[1]]);
    const ip = state.isInPosition(seat);
    if (p < 0.05 * style.aggression * style.looseness) {
      const amt = Math.min(
        threeBetSize(state.currentBet, ip) + callersBeforeHero * state.currentBet,
        heroTotal,
      );
      return {
        action: "raise", amount: amt, equity: 0.58, potOdds: state.potOdds(seat),
        ev: { fold: 0, call: 0.5, raise: 1.8 },
        reasoning: `Squeeze — ${label} vs open + ${callersBeforeHero} caller${callersBeforeHero > 1 ? "s" : ""}`,
      };
    }
    // Overcall IP with the playable range OR a speculative hand with implied odds
    // (multiway sweetens set-mining / suited draws — great pot odds when you hit).
    const specOC = ip && speculativeContinue(hero, state, seat, style.looseness);
    if ((p < 0.09 * style.looseness && ip) || specOC) {
      return {
        action: "call", amount: 0, equity: 0.45, potOdds: state.potOdds(seat),
        ev: { fold: 0, call: 0.2, raise: 0 }, reasoning: `Overcall — ${label} in position${specOC && p >= 0.09 * style.looseness ? " (implied odds)" : ""}` };
    }
    return {
      action: "fold", amount: 0, equity: 0, potOdds: state.potOdds(seat),
      ev: { fold: 0, call: -0.3, raise: -1 }, reasoning: `Fold — ${label} multiway` };
  }

  // Scale 3-bet and calling thresholds by table size
  // HU: much wider ranges → 3-bet more, call more
  const baseThreeBetCut = state.tableSize <= 2 ? 0.12 : state.tableSize <= 4 ? 0.08 : 0.06;
  // EXPLOIT: if the opener over-folds to 3-bets, add light/bluff 3-bets (widen the
  // cutoff); if they rarely fold, tighten to value. Read their adapted profile.
  const opener = preRaises.find((a) => a.seat !== seat);
  const openerProfile = (opener && profiles?.get(opener.seat)) || villainProfile;
  const f3b = openerProfile.foldTo3Bet;
  const exploitMult = 1 + Math.max(-0.4, Math.min(1.2, (f3b - 0.5) * 2.2)); // foldy → wider
  // Cap light 3-bets at ~18% of hands, tighten by the ICM bubble factor, and
  // widen/tighten by the hero's chosen aggression & looseness.
  const threeBetCut = Math.min(0.22, baseThreeBetCut * exploitMult * style.aggression * style.looseness) / bf;
  // Calling a raise risks chips with no fold equity, so the ICM bubble factor
  // tightens it (busting near a pay jump is extra costly); looseness widens it.
  const callCut = (state.tableSize <= 2 ? 0.45 : state.tableSize <= 4 ? 0.30 : 0.25) * style.looseness / bf;

  const pct = comboPercentile([hero[0], hero[1]]);
  if (pct < threeBetCut) {
    const amt = Math.min(
      threeBetSize(state.currentBet, true),
      state.stacks[seat]! + state.streetInvested[seat]!,
    );
    const light = pct >= baseThreeBetCut;
    return {
      action: "raise",
      amount: amt,
      equity: 0.6,
      potOdds: state.potOdds(seat),
      ev: { fold: 0, call: 0.5, raise: 2 },
      reasoning: light
        ? `3-bet — ${label} light (opener folds ${(f3b * 100).toFixed(0)}% to 3-bets)`
        : `3-bet — ${label} premium hand`,
    };
  }
  // Call the raw playable range OR a speculative hand getting implied odds — a
  // small pair set-mines, a suited connector/ace draws to the nuts. This is the
  // fix for "pocket 2s asked to fold": the percentile sort buries set-miners.
  const spec = speculativeContinue(hero, state, seat, style.looseness);
  if (pct < callCut || spec) {
    return {
      action: "call",
      amount: 0,
      equity: 0.45,
      potOdds: state.potOdds(seat),
      ev: { fold: 0, call: 0.3, raise: 0 },
      reasoning: spec && pct >= callCut
        ? `Call — ${label}, implied odds (set-mine / draw to the nuts)`
        : `Call — ${label} playable vs raise`,
    };
  }
  return {
    action: "fold",
    amount: 0,
    equity: 0,
    potOdds: state.potOdds(seat),
    ev: { fold: 0, call: -0.3, raise: -1 },
    reasoning: `Fold — ${label} too weak vs raise`,
  };
}

function postflopRecommend(
  state: GameState,
  villainProfile: OpponentProfile,
  rng: Rng,
  profiles?: ProfileMap,
  style: HeroStyle = STYLE_GTO,
): Recommendation {
  const hero = state.heroCards;
  const seat = state.heroSeat;

  // Scale thresholds by table size — HU ranges are much wider so
  // weaker absolute hands (like Ace-high) are relatively strong
  const hu = state.tableSize <= 2;
  const small = state.tableSize <= 4;
  const VALUE_BET = hu ? 0.48 : small ? 0.53 : 0.60;
  const THIN_VALUE = hu ? 0.33 : small ? 0.36 : 0.40;
  const RAISE_EDGE = hu ? 0.07 : 0.10;

  // Collect ALL active villains for multiway equity.
  const villainSeats: number[] = [];
  for (let i = 0; i < state.folded.length; i++) {
    if (i !== seat && !state.folded[i]) villainSeats.push(i);
  }
  if (villainSeats.length === 0) {
    return {
      action: "check", amount: 0, equity: 1, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0 }, reasoning: "No villain remaining",
    };
  }

  const ranges = villainSeats
    .map((vs) => estimateVillainRange(state, vs, profiles?.get(vs) ?? villainProfile))
    .filter((r) => r.size > 0);

  if (ranges.length === 0) {
    return {
      action: "check", amount: 0, equity: 1, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0 }, reasoning: "No valid villain range",
    };
  }

  const eqResult = ranges.length === 1
    ? monteCarloEquityVsRange({ hero, villainRange: ranges[0]!, board: state.board, iterations: 6000, rng })
    : monteCarloEquityMultiway({ hero, villainRanges: ranges, board: state.board, iterations: 8000, rng });
  const eq = eqResult.equity; // raw all-in equity (displayed)

  // Hand context.
  const inPos = state.isInPosition(seat);
  const desc = describeHand(hero, state.board);
  const madePair = desc.category === 2;
  const hasDraw = desc.draws.length > 0;
  const factor = realizationFactor(inPos, desc.strong, hasDraw, madePair);
  const dq = Math.max(0, Math.min(1, eq * factor)); // decision (realized) equity

  const handLabel = desc.label + (desc.draws.length ? ` + ${desc.draws.join(" + ")}` : "");
  const posTag = inPos ? "IP" : "OOP";
  const wayTag = villainSeats.length > 1 ? ` ${villainSeats.length + 1}-way` : "";

  // ── Opponent-aware exploitation ──
  // Aggregate the active villains' tendencies: how sticky (calls down), how
  // foldy (folds to bets), how aggressive (bets/bluffs). Used to size value
  // bets, decide whether bluffing is profitable, and tighten/loosen calls.
  let sticky = 0, foldy = 0, aggro = 0, vk = 0;
  for (const vs of villainSeats) {
    const p = profiles?.get(vs) ?? villainProfile;
    sticky += p.calldownPct; foldy += p.foldToCbet; aggro += p.betWhenCheckedTo; vk++;
  }
  if (vk > 0) { sticky /= vk; foldy /= vk; aggro /= vk; }
  // Bet bigger ONLY vs genuinely sticky callers (stations). Sizing up vs a
  // partial-folder loses value (they fold more to bigger bets), so anchor at
  // 0.5 — LAG/TAG/Nit stay at standard sizing, true stations get sized up.
  const valueMult = Math.max(1.0, Math.min(1.5, 1 + (sticky - 0.5) * 1.2));
  // Semi-bluffs win two ways (fold equity + the draw) — fine vs anyone except a
  // pure station who never folds.
  const semiBluffOK = foldy > 0.28;
  // Vs a sticky, value-heavy station (calls everything, never bluffs), fold a
  // touch more to their bets — their betting range is almost all value.
  const callCushion = sticky > 0.6 ? 0.05 : 0;
  // Thin value vs sticky callers: a station calls with so many worse hands that
  // a bet is +value at lower equity than the default tiers assume. Drop the
  // value thresholds as stickiness rises (toward ~0.50 equity vs a pure station,
  // i.e. "called by worse more than half the time").
  const stickyDiscount = sticky > 0.5 ? Math.min(0.10, (sticky - 0.5) * 0.4) : 0;
  // Aggression thins value bets (bet weaker hands for value) — capped so it can't
  // go silly. aggr 1.4 ≈ −6 equity points on the value tiers.
  const aggrThin = Math.max(-0.04, Math.min(0.10, (style.aggression - 1) * 0.15));
  const valueBetT = VALUE_BET - stickyDiscount - aggrThin;
  const thinValueT = THIN_VALUE - stickyDiscount - aggrThin;

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  // Finalize: attach shared context fields to every recommendation.
  const fin = (r: Recommendation): Recommendation => ({
    ...r, equity: eq, realizedEquity: dq, handLabel, inPosition: inPos,
  });

  const tc = state.toCall(seat);
  const odds = state.potOdds(seat);

  // ── Bluff-catch read ───────────────────────────────────────────────────────
  // Facing a bet, how likely is it a bluff? Read the board RUNOUT vs the credible
  // rep + the bettor's TYPE. A BRICK barreled by a bluffy/incoherent type → polar,
  // lots of air → call LIGHTER. A SCARE that completed the rep, barreled by a
  // coherent type → credible value → fold MORE. A bounded (±0.08) correction on
  // top of the range-equity, plus a teachable note. (eq already reflects his range;
  // this nudges for type-specific bluffing the generic range estimate misses.)
  const clamp01 = (lo: number, hi: number, x: number) => Math.max(lo, Math.min(hi, x));
  let bluffCatchAdj = 0;        // +need more to call (fold more) · −call lighter
  let bluffCatchNote = "";
  // Carrier so the counter-bluff branch reuses this context (no recompute).
  let cb: { ap: OpponentProfile; cls: ReturnType<typeof sizeClass>; phase: "scare" | "brick" | "kill"; repLabel: string; baseBluff: number } | null = null;
  if (tc > 0 && state.board.length >= 3) {
    let aggrSeat = -1, aggrBet = 0;
    for (const a of state.actions) {
      if (a.seat !== seat && a.street !== "preflop" && (a.type === "bet" || a.type === "raise")) {
        aggrSeat = a.seat; if (a.amount > 0) aggrBet = Math.max(aggrBet, a.amount);
      }
    }
    if (aggrSeat >= 0) {
      const ap = profiles?.get(aggrSeat) ?? villainProfile;
      const rep = credibleRep(state.board);
      const phase = scoreRunout({ ...rep, coherence: 1, openedStreet: state.street }, state.board);
      const cls = sizeClass(aggrBet / Math.max(1, state.pot)); // bet-sizing tell
      const streetsBet = new Set(state.actions
        .filter((a) => a.seat === aggrSeat && a.street !== "preflop" && (a.type === "bet" || a.type === "raise"))
        .map((a) => a.street)).size;
      const baseBluff = streetsBet >= 2 ? ap.barrelFreq : ap.bluffFreq;
      const valueType = ap.coherence >= 0.6; // honest / under-bluffed (TAG, Nit)
      cb = { ap, cls, phase, repLabel: rep.label, baseBluff };
      // The SIZE shapes the read (one nudge, never two summed):
      if (cls === "small" || cls === "min") {
        // CAPPED — rarely the nuts; never hero-FOLD a made hand to a cheap bet.
        bluffCatchAdj = -0.04;
        bluffCatchNote = ` — his ${cls} bet is capped, don't fold a made hand`;
      } else if (cls === "merged") {
        // Half-pot merged = the least exploitable size; no nudge.
      } else if (cls === "overbet") {
        // Max-polar: nuts or air. Type decides which.
        if (phase === "scare") {
          bluffCatchAdj = Math.min(0.12, ap.coherence * 0.16);
          bluffCatchNote = ` — overbet & ${rep.label} got there, value-heavy — fold`;
        } else if (phase === "brick" && valueType) {
          bluffCatchAdj = Math.min(0.12, ap.coherence * 0.14);
          bluffCatchNote = ` — overbet from a value-heavy type, that's the nuts — fold`;
        } else {
          const bluffPct = clamp01(0.05, 0.9, baseBluff * (1.25 - ap.coherence));
          bluffCatchAdj = -Math.min(0.12, Math.max(0, bluffPct - 0.30) * 0.40);
          if (bluffCatchAdj <= -0.01) bluffCatchNote = ` — overbet on a brick (~${pct(bluffPct)} air), call wider`;
        }
      } else if (phase === "brick") { // pot-size, existing ±0.08
        const bluffPct = clamp01(0.05, 0.9, baseBluff * (1.25 - ap.coherence)); // incoherent types barrel bricks with air
        bluffCatchAdj = -Math.min(0.08, Math.max(0, bluffPct - 0.30) * 0.28);
        if (bluffCatchAdj <= -0.01) bluffCatchNote = ` — he barrels this brick (~${pct(bluffPct)} bluffs), call lighter`;
      } else if (phase === "scare") {
        const bluffPct = clamp01(0.03, 0.6, baseBluff * (1 - ap.coherence) * 0.6);
        bluffCatchAdj = Math.min(0.08, ap.coherence * 0.12);
        if (bluffCatchAdj >= 0.01) bluffCatchNote = ` — ${rep.label} got there (~${pct(bluffPct)} bluffs), respect it`;
      }
    }
  }
  const callBar = odds + callCushion + bluffCatchAdj;

  if (tc > 0) {
    const evCall = eq * state.potAfterCall(seat) - tc;
    const canRaise = state.stacks[seat]! > tc;

    if (dq > odds + RAISE_EDGE && canRaise) {
      const raiseMult = dq > 0.75 ? 3.5 : dq > 0.60 ? 3.0 : 2.5;
      const amt = Math.min(
        Math.max(state.currentBet * raiseMult, state.pot + tc),
        state.stacks[seat]! + state.streetInvested[seat]!,
      );
      return fin({
        action: "raise", amount: amt, equity: eq, potOdds: odds,
        ev: { fold: 0, call: evCall, raise: evCall * 1.3 },
        reasoning: `Raise — ${handLabel} (${posTag}), ${pct(eq)} equity vs ${pct(odds)} pot odds${wayTag}`,
      });
    }

    // ── COUNTER-BLUFF (re-bluff) ────────────────────────────────────────────
    // Punish a CAPPED bet (small/min — he can't have the nuts) by raising to rep
    // the polar hand he doesn't have. Tightly gated so it's a +EV semi-bluff vs
    // a FOLDER, never spew: heads-up only, vs a coherent/foldy type (NOT a
    // station/maniac/lag), with a blocker or a live draw, a complete (non-lever)
    // raise, and a hard pFold>need + ev>0 check. This is the "mind game".
    if (cb && canRaise && repsCapped(cb.cls)) {
      const post = state.actions.filter((a) => a.seat !== seat && a.street !== "preflop");
      const villainLeadBet = post.some((a) => a.type === "bet") && !post.some((a) => a.type === "raise");
      const heroConn = heroConnection(hero, state.board);
      const hiCard = Math.max(rankOf(hero[0]), rankOf(hero[1]));
      const hasBackup = hiCard >= 12 || heroConn.hasFlushDraw || heroConn.hasStraightDraw;
      const nv = villainSeats.length;
      if (
        villainLeadBet &&
        nv === 1 &&                                   // heads-up
        cb.ap.foldToRaise >= 0.5 && cb.ap.calldownPct < 0.6 && cb.ap.coherence >= 0.6 && // foldy + reliable tell (excludes Station/LAG/Maniac)
        dq < callBar && dq > 0.12 &&                  // not a value hand, not pure air
        hasBackup &&                                  // semi-bluff, never bare air
        state.spr() <= 6                              // a complete bet, not a lever
      ) {
        const heroTotal = state.stacks[seat]! + state.streetInvested[seat]!;
        const amt = Math.min(Math.max(state.currentBet * 2.8, state.pot + tc), heroTotal);
        const riskAdded = amt - tc;
        const be = riskAdded / (riskAdded + state.pot);
        const blockerCredit = hiCard >= 12 ? 0.05 : 0;
        const backupEquityCredit = Math.min(0.08, dq * 0.25);
        const need = be + 0.06 * (nv - 1) - blockerCredit - backupEquityCredit;
        const pFold = clamp01(0.1, 0.92, cb.ap.foldToRaise * (cb.cls === "min" ? 1.15 : 1.0) * (cb.phase === "brick" ? 1.1 : 0.9));
        const evRaise = pFold * state.pot - (1 - pFold) * riskAdded;
        if (pFold > need && evRaise > 0 && amt > state.currentBet) {
          const f = clamp01(0.20, 0.45, 0.20 + (pFold - need) * 1.2 + (style.aggression - 1) * 0.2);
          const alt: ActionType = dq > callBar ? "call" : "fold";
          return fin({
            action: "raise", amount: amt, equity: eq, potOdds: odds,
            mix: [{ action: "raise", amount: amt, freq: f }, { action: alt, amount: 0, freq: 1 - f }],
            ev: { fold: 0, call: evCall, raise: evRaise },
            reasoning: `Re-bluff — his ${cb.cls} bet is capped, can't have ${cb.repLabel}; you block it, folds ~${pct(pFold)} (mix ${pct(f)}) (${posTag})${wayTag}`,
          });
        }
      }
    }

    if (dq > callBar) {
      return fin({
        action: "call", amount: 0, equity: eq, potOdds: odds,
        ev: { fold: 0, call: evCall, raise: 0 },
        reasoning: `Call — ${handLabel} (${posTag}), ${pct(eq)} equity vs ${pct(odds)} pot odds${bluffCatchNote}${wayTag}`,
      });
    }
    // IMPLIED-ODDS PEEL: a draw that fails DIRECT pot odds can still be a +EV call
    // if the effective stack behind pays off when it hits (vs a payable field).
    // This is the fix for "I folded my draw and would've hit the nuts on the river".
    const drawConn = heroConnection(hero, state.board);
    if ((drawConn.hasFlushDraw || drawConn.hasStraightDraw) && state.stacks[seat]! > tc) {
      const toCome = 5 - state.board.length; // 2 on flop, 1 on turn
      const hitProb = drawConn.hasFlushDraw
        ? (toCome >= 2 ? 0.35 : 0.196)   // ~9 outs
        : (toCome >= 2 ? 0.31 : 0.17);   // OESD ~8 outs
      let maxRem = 0;
      for (const vs of villainSeats) maxRem = Math.max(maxRem, state.stacks[vs]!);
      const behind = Math.min(state.stacks[seat]! - tc, maxRem); // chips still winnable
      const potAfter = state.potAfterCall(seat);
      const impliedNeeded = tc / hitProb - potAfter; // extra $ to collect on a hit
      // Sticky/loose fields pay off draws; nits don't — collect fraction of `behind`.
      const expectedPayoff = behind * (0.30 + sticky * 0.55);
      if (hitProb >= 0.14 && expectedPayoff >= impliedNeeded) {
        return fin({
          action: "call", amount: 0, equity: eq, potOdds: odds,
          ev: { fold: 0, call: evCall, raise: 0 },
          reasoning: `Call — ${drawConn.hasFlushDraw ? "flush" : "straight"} draw, implied odds (${posTag})${wayTag}`,
        });
      }
    }
    return fin({
      action: "fold", amount: 0, equity: eq, potOdds: odds,
      ev: { fold: 0, call: evCall, raise: -tc },
      reasoning: `Fold — ${handLabel} (${posTag}), ${pct(eq)} equity < ${pct(odds)} pot odds${bluffCatchNote}${wayTag}`,
    });
  }

  const heroStack = state.stacks[seat]!;
  // Effective stack for sizing: you can't get called for more than the deepest
  // still-in opponent has behind, so never recommend betting past that (dead
  // money). Shoves still use the full stack; only non-all-in bets cap here.
  let maxVilRem = 0;
  for (const vs of villainSeats) maxVilRem = Math.max(maxVilRem, state.stacks[vs]!);
  const betCap = Math.max(0, Math.min(heroStack, maxVilRem));
  const pot = state.pot;
  const tex = analyzeBoard(state.board);
  const conn = heroConnection(hero, state.board);
  // For polarized BETS (bluffs/semi-bluffs), a dry board lets you size up. For
  // made-VALUE bets it's the opposite: size up on WET/dynamic boards to charge
  // draws, smaller on dry/static boards where villain has fewer calling hands.
  const texAdj = tex.dry ? 1.15 : tex.wet ? 0.85 : 1.0;
  const valueTexAdj = tex.wet ? 1.2 : tex.dry ? 0.9 : 1.0;
  const texNote = tex.desc;

  // Shove if short-stacked
  if (heroStack <= pot * 0.4 && dq > 0.5) {
    return fin({
      action: "bet", amount: heroStack, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: eq * (pot + heroStack * 2) - heroStack },
      reasoning: `All-in — ${handLabel}, ${pct(eq)} equity, short stack`,
    });
  }

  // Semi-bluff with draws — only when villains actually fold (fold equity).
  // Vs a calling station there is no fold equity, so a draw should take the
  // free card instead of bloating the pot as the worse hand.
  const drawBetThresh = inPos ? 0.28 : 0.34;
  if (semiBluffOK && (conn.hasFlushDraw || conn.hasStraightDraw) && dq > drawBetThresh && eq < 0.62) {
    const frac = Math.min(0.65, 0.50 * texAdj);
    const size = Math.min(pot * frac, betCap);
    const drawType = conn.hasFlushDraw ? "flush draw" : "straight draw";
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0.8 },
      reasoning: `Semi-bluff — ${drawType} (${posTag}), ${pct(eq)} equity on ${texNote}`,
    });
  }

  // Monotone board without flush → cautious
  if (tex.monotone && !conn.hasFlushDraw && eq < 0.70) {
    if (dq > THIN_VALUE) {
      const size = Math.min(pot * 0.25, betCap);
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0.2 },
        reasoning: `Small bet — ${handLabel}, cautious on ${texNote} board`,
      });
    }
    return fin({
      action: "check", amount: 0, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: -0.5 },
      reasoning: `Check — ${handLabel}, wary of flush on ${texNote} board`,
    });
  }

  // Value-betting tiers (decision equity, texture- and opponent-adjusted sizing).
  // valueMult sizes up vs callers (extract more) and down vs folders.
  if (dq > 0.80) {
    // Big value plays for STACKS: size geometrically so the bet/turn/river chain
    // gets all-in by the river given the SPR (and naturally overbets when deep),
    // rather than a one-off pot-fraction. Nudge up a touch vs a sticky station.
    const geo = recommendSize(pot, betCap, state.street);
    const size = Math.min(betCap, Math.max(geo, pot * 0.5) * (sticky > 0.6 ? 1.1 : 1.0));
    const frac = pot > 0 ? size / pot : 1;
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, big value on ${texNote}`,
    });
  }
  if (dq > 0.60) {
    const frac = Math.min(1.1, (0.55 + (dq - 0.60)) * valueTexAdj * valueMult);
    const size = Math.min(pot * frac, betCap);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
    });
  }
  if (dq > valueBetT) {
    const frac = Math.min(0.7, 0.40 * valueTexAdj * valueMult);
    const size = Math.min(pot * frac, betCap);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0.5 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, thin value on ${texNote}`,
    });
  }
  if (dq > thinValueT) {
    const size = Math.min(pot * 0.25 * valueMult, betCap);
    if (size > 0) {
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0.3 },
        reasoning: `Small bet — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
      });
    }
  }

  // ── Represent / bluff (incl. barrels & river bluffs) ──
  // With no showdown value, checking just gives up. Bet to represent strength
  // when fold equity clears the break-even. Now allowed MULTIWAY (with a steeper
  // fold-equity bar per extra caller), credits a BARREL (we were the aggressor —
  // the story is consistent) and BLOCKERS (an A/K blocks villain value), and on
  // the river a missed draw becomes a pure bluff here. Still folds to print vs a
  // calling station (low foldy).
  const isAir = eq < 0.34 && dq < THIN_VALUE && !conn.hasFlushDraw && !conn.hasStraightDraw;
  const nVil = villainSeats.length;
  // Bluffing is allowed MULTIWAY now (no hard heads-up gate) — the per-caller
  // `need` term below makes it collapse to ~0 with extra players instead of a
  // cliff, so 3+ way it almost never fires but there's no artificial wall.
  if (isAir) {
    const wasAggressor = state.actions.some(
      (a) => a.seat === seat && a.street !== "preflop" && (a.type === "bet" || a.type === "raise"),
    );
    // SIZE THE BLUFF LIKE THE HAND IT REPS. A small stab can't credibly rep a
    // monster: on polar boards (flush/straight/paired → rep the nuts) bet big/
    // overbet so the story is believable; on a dry board (rep top pair/overpair)
    // a medium bet is consistent. This keeps the bet and the read in sync.
    const rep = credibleRep(state.board);
    const polar = repIsPolar(rep.rep);
    const frac = polar
      ? (state.board.length >= 5 ? 1.05 : state.board.length >= 4 ? 0.9 : 0.8) // pot-ish → overbet by the river
      : (tex.wet ? 0.66 : 0.55);
    const breakeven = frac / (1 + frac); // fold% needed to break even
    const hiCard = Math.max(rankOf(hero[0]), rankOf(hero[1]));
    const blockerCredit = hiCard >= 12 ? 0.05 : hiCard >= 10 ? 0.02 : 0; // A/K… blocks value
    const barrelCredit = wasAggressor ? 0.05 : 0;
    // Each extra caller steeply raises the bar (someone always has it multiway);
    // hero aggression lowers it (bluff more often).
    const need = breakeven + 0.05 + 0.14 * (nVil - 1) - blockerCredit - barrelCredit
      - (style.aggression - 1) * 0.12;
    if (foldy > need && heroStack > pot * frac) {
      const size = Math.min(pot * frac, betCap);
      const kind = wasAggressor ? "Barrel" : "Bluff";
      // BALANCE: don't bluff EVERY time — bluffing is a mixed-frequency play so
      // you're not transparent. f scales with fold-equity surplus, blockers, and
      // your aggression (Nit checks more, LAG bluffs more). Showing the split (and
      // grading both actions as fine) teaches "bluff some of your air, not all".
      const f = Math.max(0.2, Math.min(0.85,
        0.5 + (foldy - need) * 1.6 + blockerCredit + barrelCredit + (style.aggression - 1) * 0.25));
      const mix = [
        { action: "bet" as ActionType, amount: size, freq: f },
        { action: "check" as ActionType, amount: 0, freq: 1 - f },
      ];
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0, mix,
        ev: { fold: foldy * pot, call: 0, raise: foldy * pot - (1 - foldy) * size },
        reasoning: `${kind} ${pct(frac)} pot — represent ${rep.label}; mix ~${pct(f)} bluff / ${pct(1 - f)} check (balance) on ${texNote}, opp folds ~${pct(foldy)} (${posTag})${wayTag}`,
      });
    }
  }

  return fin({
    action: "check", amount: 0, equity: eq, potOdds: 0,
    ev: { fold: 0, call: 0, raise: -0.5 },
    reasoning: `Check — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
  });
}
