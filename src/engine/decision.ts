import { cardToString } from "./cards.js";
import { type Rng, mulberry32 } from "./rng.js";
import { monteCarloEquityVsRange } from "./equity.js";
import { getRfiRange, getBbDefenseRange } from "./charts/index.js";
import { comboScore, sortedCombos } from "./hand-strength.js";
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
  equity: number;
  potOdds: number;
  ev: { fold: number; call: number; raise: number };
  reasoning: string;
}

export function recommend(
  state: GameState,
  villainProfile?: OpponentProfile,
  rng?: Rng,
): Recommendation {
  if (state.street === "preflop") return preflopRecommend(state);
  return postflopRecommend(state, villainProfile ?? TAG, rng ?? mulberry32(0xdec1de));
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

  let villainSeat = -1;
  for (let i = 0; i < state.folded.length; i++) {
    if (i !== seat && !state.folded[i]) {
      villainSeat = i;
      break;
    }
  }
  if (villainSeat < 0) {
    return {
      action: "check",
      amount: 0,
      equity: 1,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0 },
      reasoning: "No villain remaining",
    };
  }

  const villainRange = estimateVillainRange(state, villainSeat, villainProfile);
  if (villainRange.size === 0) {
    return {
      action: "check",
      amount: 0,
      equity: 1,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0 },
      reasoning: "Empty villain range after filtering",
    };
  }

  const { equity } = monteCarloEquityVsRange({
    hero,
    villainRange,
    board: state.board,
    iterations: 5000,
    rng,
  });

  const tc = state.toCall(seat);
  const odds = state.potOdds(seat);
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

  if (tc > 0) {
    const evCall = equity * state.potAfterCall(seat) - tc;
    const canRaise = state.stacks[seat]! > tc;

    if (equity > odds + RAISE_EDGE && canRaise) {
      // Raise size: 2.5-3x the bet with strong hands, pot-size with monsters
      const raiseMult = equity > 0.75 ? 3.5 : equity > 0.60 ? 3.0 : 2.5;
      const amt = Math.min(
        Math.max(state.currentBet * raiseMult, state.pot + tc),
        state.stacks[seat]! + state.streetInvested[seat]!,
      );
      return {
        action: "raise",
        amount: amt,
        equity,
        potOdds: odds,
        ev: { fold: 0, call: evCall, raise: evCall * 1.3 },
        reasoning: `Raise — ${pct(equity)} equity >> ${pct(odds)} pot odds`,
      };
    }
    if (equity > odds) {
      return {
        action: "call",
        amount: 0,
        equity,
        potOdds: odds,
        ev: { fold: 0, call: evCall, raise: 0 },
        reasoning: `Call — ${pct(equity)} equity > ${pct(odds)} pot odds`,
      };
    }
    return {
      action: "fold",
      amount: 0,
      equity,
      potOdds: odds,
      ev: { fold: 0, call: evCall, raise: -tc },
      reasoning: `Fold — ${pct(equity)} equity < ${pct(odds)} pot odds`,
    };
  }

  // Bet sizing: scale pot fraction by hand strength
  // Monster (>80%): bet 80-100% pot — extract max value
  // Strong  (>60%): bet 60-75% pot — solid value bet
  // Good    (>VB):  bet 40-55% pot — protect / thin value
  // Thin    (>TV):  bet 25-33% pot — cheap showdown / block
  // Weak:           check
  const heroStack = state.stacks[seat]!;
  const pot = state.pot;

  // Shove if we can't make a meaningful bet (short stack)
  if (heroStack <= pot * 0.4 && equity > 0.5) {
    return {
      action: "bet",
      amount: heroStack,
      equity,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: equity * (pot + heroStack * 2) - heroStack },
      reasoning: `All-in — ${pct(equity)} equity, short stack`,
    };
  }

  if (equity > 0.80) {
    const frac = 0.80 + (equity - 0.80) * 1.0; // 80-100% pot
    const size = Math.min(pot * frac, heroStack);
    return {
      action: "bet",
      amount: size,
      equity,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${pct(equity)} equity, big value`,
    };
  }

  if (equity > 0.60) {
    const frac = 0.55 + (equity - 0.60) * 1.0; // 55-75% pot
    const size = Math.min(pot * frac, heroStack);
    return {
      action: "bet",
      amount: size,
      equity,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${pct(equity)} equity, value`,
    };
  }

  if (equity > VALUE_BET) {
    const frac = 0.40;
    const size = Math.min(pot * frac, heroStack);
    return {
      action: "bet",
      amount: size,
      equity,
      potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0.5 },
      reasoning: `Bet ${pct(frac)} pot — ${pct(equity)} equity, thin value`,
    };
  }

  if (equity > THIN_VALUE) {
    const size = Math.min(pot * 0.25, heroStack);
    if (size > 0) {
      return {
        action: "bet",
        amount: size,
        equity,
        potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0.3 },
        reasoning: `Small bet — ${pct(equity)} equity, block/protect`,
      };
    }
  }

  return {
    action: "check",
    amount: 0,
    equity,
    potOdds: 0,
    ev: { fold: 0, call: 0, raise: -0.5 },
    reasoning: `Check — ${pct(equity)} equity`,
  };
}
