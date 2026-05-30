import { cardToString } from "./cards.js";
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
import {
  openRaiseSize,
  threeBetSize,
  recommendSize,
} from "./sizing.js";
import {
  type OpponentProfile,
  TAG,
  estimateVillainRange,
  comboPercentile,
} from "./opponent.js";

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
}

// Per-seat opponent profiles (optional). Falls back to `defaultProfile`.
export type ProfileMap = Map<number, OpponentProfile>;

export function recommend(
  state: GameState,
  villainProfile?: OpponentProfile,
  rng?: Rng,
  profiles?: ProfileMap,
): Recommendation {
  if (state.street === "preflop") return preflopRecommend(state);
  return postflopRecommend(
    state,
    villainProfile ?? TAG,
    rng ?? mulberry32(0xdec1de),
    profiles,
  );
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

function preflopRecommend(state: GameState): Recommendation {
  const hero = state.heroCards;
  const seat = state.heroSeat;
  const pos = state.positions[seat]!;
  const label = `${cardToString(hero[0])}${cardToString(hero[1])}`;

  const facingRaise = state.actions.some(
    (a) =>
      a.seat !== seat &&
      (a.type === "raise" || a.type === "bet") &&
      a.street === "preflop",
  );

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
    try {
      const rfi = getRfiRange(state.tableSize, pos);
      if (rfi.has([hero[0], hero[1]])) {
        const amt = Math.min(
          openRaiseSize(state.bb),
          state.stacks[seat]! + state.streetInvested[seat]!,
        );
        return {
          action: "raise",
          amount: amt,
          equity: 0.55,
          potOdds: 0,
          ev: { fold: 0, call: 0.5, raise: 1 },
          reasoning: `Open raise — ${label} in ${pos} RFI range`,
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
      reasoning: `Fold — ${label} not in ${pos} RFI range`,
    };
  }

  if (pos === "BB") {
    const opener = state.actions.find(
      (a) =>
        a.seat !== seat &&
        (a.type === "raise" || a.type === "bet") &&
        a.street === "preflop",
    );
    if (opener) {
      const openerPos = state.positions[opener.seat]!;
      try {
        const defRange = getBbDefenseRange(state.tableSize, openerPos);
        if (defRange.has([hero[0], hero[1]])) {
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
      reasoning: `Fold — ${label} not in BB defense range`,
    };
  }

  // Scale 3-bet and calling thresholds by table size
  // HU: much wider ranges → 3-bet more, call more
  const threeBetCut = state.tableSize <= 2 ? 0.12 : state.tableSize <= 4 ? 0.08 : 0.06;
  const callCut = state.tableSize <= 2 ? 0.45 : state.tableSize <= 4 ? 0.30 : 0.25;

  const pct = comboPercentile([hero[0], hero[1]]);
  if (pct < threeBetCut) {
    const amt = Math.min(
      threeBetSize(state.currentBet, true),
      state.stacks[seat]! + state.streetInvested[seat]!,
    );
    return {
      action: "raise",
      amount: amt,
      equity: 0.6,
      potOdds: state.potOdds(seat),
      ev: { fold: 0, call: 0.5, raise: 2 },
      reasoning: `3-bet — ${label} premium hand`,
    };
  }
  if (pct < callCut) {
    return {
      action: "call",
      amount: 0,
      equity: 0.45,
      potOdds: state.potOdds(seat),
      ev: { fold: 0, call: 0.3, raise: 0 },
      reasoning: `Call — ${label} playable vs raise`,
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

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  // Finalize: attach shared context fields to every recommendation.
  const fin = (r: Recommendation): Recommendation => ({
    ...r, equity: eq, realizedEquity: dq, handLabel, inPosition: inPos,
  });

  const tc = state.toCall(seat);
  const odds = state.potOdds(seat);

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
    if (dq > odds) {
      return fin({
        action: "call", amount: 0, equity: eq, potOdds: odds,
        ev: { fold: 0, call: evCall, raise: 0 },
        reasoning: `Call — ${handLabel} (${posTag}), ${pct(eq)} equity > ${pct(odds)} pot odds${wayTag}`,
      });
    }
    return fin({
      action: "fold", amount: 0, equity: eq, potOdds: odds,
      ev: { fold: 0, call: evCall, raise: -tc },
      reasoning: `Fold — ${handLabel} (${posTag}), ${pct(eq)} equity < ${pct(odds)} pot odds${wayTag}`,
    });
  }

  const heroStack = state.stacks[seat]!;
  const pot = state.pot;
  const tex = analyzeBoard(state.board);
  const conn = heroConnection(hero, state.board);
  const texAdj = tex.dry ? 1.15 : tex.wet ? 0.85 : 1.0;
  const texNote = tex.desc;

  // Shove if short-stacked
  if (heroStack <= pot * 0.4 && dq > 0.5) {
    return fin({
      action: "bet", amount: heroStack, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: eq * (pot + heroStack * 2) - heroStack },
      reasoning: `All-in — ${handLabel}, ${pct(eq)} equity, short stack`,
    });
  }

  // Semi-bluff with draws even at lower equity (stronger in position)
  const drawBetThresh = inPos ? 0.28 : 0.34;
  if ((conn.hasFlushDraw || conn.hasStraightDraw) && dq > drawBetThresh && eqResult && eq < 0.62) {
    const frac = Math.min(0.65, 0.50 * texAdj);
    const size = Math.min(pot * frac, heroStack);
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
      const size = Math.min(pot * 0.25, heroStack);
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

  // Value-betting tiers (decision equity, texture-adjusted sizing)
  if (dq > 0.80) {
    const frac = Math.min(1.0, (0.80 + (dq - 0.80)) * texAdj);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, big value on ${texNote}`,
    });
  }
  if (dq > 0.60) {
    const frac = Math.min(0.85, (0.55 + (dq - 0.60)) * texAdj);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
    });
  }
  if (dq > VALUE_BET) {
    const frac = Math.min(0.55, 0.40 * texAdj);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0.5 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, thin value on ${texNote}`,
    });
  }
  if (dq > THIN_VALUE) {
    const size = Math.min(pot * 0.25, heroStack);
    if (size > 0) {
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0.3 },
        reasoning: `Small bet — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
      });
    }
  }

  return fin({
    action: "check", amount: 0, equity: eq, potOdds: 0,
    ev: { fold: 0, call: 0, raise: -0.5 },
    reasoning: `Check — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
  });
}
