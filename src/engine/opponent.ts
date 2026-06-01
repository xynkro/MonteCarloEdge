import { type Card, rankOf } from "./cards.js";
import { type Combo, Range } from "./range.js";
import { type Rng } from "./rng.js";
import { getRfiRange, getBbDefenseRange } from "./charts/index.js";
import {
  allCombos,
  sortedCombos,
  comboScore,
  topSlice,
} from "./hand-strength.js";
import {
  type ActionInput,
  type GameState,
} from "./game-state.js";
import { openRaiseSize, threeBetSize } from "./sizing.js";

export interface OpponentProfile {
  name: string;
  vpip: number;
  pfr: number;
  threeBetPct: number;
  foldTo3Bet: number;
  cbetPct: number;
  foldToCbet: number;
  betWhenCheckedTo: number;
  foldToRaise: number;
  calldownPct: number;
}

export const TAG: OpponentProfile = {
  name: "TAG",
  vpip: 0.22,
  pfr: 0.18,
  threeBetPct: 0.08,
  foldTo3Bet: 0.65,
  cbetPct: 0.7,
  foldToCbet: 0.55,
  betWhenCheckedTo: 0.45,
  foldToRaise: 0.6,
  calldownPct: 0.3,
};

export const LAG: OpponentProfile = {
  name: "LAG",
  vpip: 0.35,
  pfr: 0.28,
  threeBetPct: 0.12,
  foldTo3Bet: 0.45,
  cbetPct: 0.8,
  foldToCbet: 0.35,
  betWhenCheckedTo: 0.6,
  foldToRaise: 0.4,
  calldownPct: 0.5,
};

export const STATION: OpponentProfile = {
  name: "Station",
  vpip: 0.5,
  pfr: 0.1,
  threeBetPct: 0.03,
  foldTo3Bet: 0.3,
  cbetPct: 0.35,
  foldToCbet: 0.2,
  betWhenCheckedTo: 0.2,
  foldToRaise: 0.15,
  calldownPct: 0.8,
};

export const NIT: OpponentProfile = {
  name: "Nit",
  vpip: 0.12,
  pfr: 0.1,
  threeBetPct: 0.06,
  foldTo3Bet: 0.75,
  cbetPct: 0.75,
  foldToCbet: 0.6,
  betWhenCheckedTo: 0.35,
  foldToRaise: 0.7,
  calldownPct: 0.2,
};

// Neutral "average player" prior for when the opponent type is unknown. The
// adaptive model blends this toward each seat's observed tendencies as hands
// are logged, so the strategy starts solid/unexploitative and self-corrects.
export const AUTO: OpponentProfile = {
  name: "Auto",
  vpip: 0.25,
  pfr: 0.18,
  threeBetPct: 0.06,
  foldTo3Bet: 0.55,
  cbetPct: 0.6,
  foldToCbet: 0.45,
  betWhenCheckedTo: 0.4,
  foldToRaise: 0.5,
  calldownPct: 0.45,
};

let _pctMap: Map<number, number> | null = null;
function percentileMap(): Map<number, number> {
  if (!_pctMap) {
    const sorted = sortedCombos(allCombos());
    _pctMap = new Map();
    for (let i = 0; i < sorted.length; i++) {
      _pctMap.set(sorted[i]![0] * 52 + sorted[i]![1], i / sorted.length);
    }
  }
  return _pctMap;
}

export function comboPercentile(c: Combo): number {
  const lo = Math.min(c[0], c[1]);
  const hi = Math.max(c[0], c[1]);
  return percentileMap().get(lo * 52 + hi) ?? 1;
}

export function handConnection(
  cards: Combo,
  board: Card[],
): "strong" | "medium" | "air" {
  const r0 = rankOf(cards[0]);
  const r1 = rankOf(cards[1]);
  const boardRanks = board.map(rankOf);
  const maxBoard = boardRanks.length > 0 ? Math.max(...boardRanks) : -1;

  let matches = 0;
  for (const br of boardRanks) {
    if (br === r0) matches++;
    if (br === r1) matches++;
  }

  const isPair = r0 === r1;
  const isOverpair = isPair && r0 > maxBoard;

  if (matches >= 2 || isOverpair) return "strong";
  if (matches >= 1 || isPair) return "medium";
  return "air";
}

export function estimateVillainRange(
  state: GameState,
  villainSeat: number,
  profile: OpponentProfile,
): Range {
  const pos = state.positions[villainSeat]!;
  const dead: Card[] = [state.heroCards[0], state.heroCards[1], ...state.board];

  const villainRaised = state.actions.some(
    (a) => a.seat === villainSeat && (a.type === "raise" || a.type === "bet"),
  );
  const villainCalled = state.actions.some(
    (a) => a.seat === villainSeat && a.type === "call",
  );

  let range: Range;

  if (villainRaised && pos !== "BB") {
    try {
      range = getRfiRange(state.tableSize, pos);
    } catch {
      range = topSlice(allCombos(), profile.pfr);
    }
  } else if (pos === "BB") {
    const opener = state.actions.find(
      (a) =>
        a.seat !== villainSeat &&
        (a.type === "raise" || a.type === "bet") &&
        a.street === "preflop",
    );
    if (opener) {
      const openerPos = state.positions[opener.seat]!;
      try {
        range = getBbDefenseRange(state.tableSize, openerPos);
      } catch {
        range = topSlice(allCombos(), profile.vpip);
      }
    } else {
      // BB checked its option in an unraised pot → literally any two cards.
      range = topSlice(allCombos(), 0.95);
    }
  } else if (villainCalled) {
    range = topSlice(allCombos(), profile.vpip);
  } else {
    // Never raised, bet, or called — i.e. limped / checked along in an unraised
    // pot. That is a WIDE, weak, capped range. The top-vpip% slice (pair- and
    // ace-heavy) badly overstates how often they hold board-pairing cards and so
    // wildly understates hero's equity in multiway limped pots. Widen it.
    range = topSlice(allCombos(), Math.min(0.9, profile.vpip + 0.5));
  }

  return range.filter(dead);
}

export function villainAct(
  state: GameState,
  villainSeat: number,
  villainCards: Combo,
  profile: OpponentProfile,
  rng: Rng,
): ActionInput {
  if (state.street === "preflop") {
    return villainPreflopAct(state, villainSeat, villainCards, profile, rng);
  }
  return villainPostflopAct(state, villainSeat, villainCards, profile, rng);
}

function villainPreflopAct(
  state: GameState,
  seat: number,
  cards: Combo,
  profile: OpponentProfile,
  rng: Rng,
): ActionInput {
  const pct = comboPercentile(cards); // 0 = best hand, ~1 = worst
  const pos = state.positions[seat]!;
  const facingRaise = state.currentBet > state.bb;
  const toCall = state.toCall(seat);
  const maxBet = state.stacks[seat]! + state.streetInvested[seat]!;

  if (facingRaise) {
    // 3-bet the very top, otherwise defend (flat-call) up to the VPIP range.
    if (pct < profile.threeBetPct) {
      const amt = Math.min(threeBetSize(state.currentBet, pos === "BTN" || pos === "CO"), maxBet);
      if (amt > state.currentBet) return { seat, type: "raise", amount: amt };
    }
    // Loose players defend wide; tight players need a real hand. BB defends a
    // touch wider since it's already partly invested and getting a price.
    const defend = (pos === "BB" ? profile.vpip + 0.08 : profile.vpip) * 0.9;
    if (pct < defend) return { seat, type: "call", amount: 0 };
    return { seat, type: "fold", amount: 0 };
  }

  // Unraised pot.
  if (pos === "BB" && toCall === 0) {
    // BB can check for free or raise its opening range.
    if (pct < profile.pfr) {
      const amt = Math.min(openRaiseSize(state.bb), maxBet);
      return { seat, type: "raise", amount: amt };
    }
    return { seat, type: "check", amount: 0 };
  }

  // First in / limped pot: open-raise the PFR range, limp/complete the rest of
  // the VPIP range, fold the bottom. This keeps multiple players in the pot.
  if (pct < profile.pfr) {
    const amt = Math.min(openRaiseSize(state.bb), maxBet);
    return { seat, type: "raise", amount: amt };
  }
  if (pct < profile.vpip) {
    // Mostly limp, occasionally raise marginal hands for variety.
    if (rng() < 0.12) {
      const amt = Math.min(openRaiseSize(state.bb), maxBet);
      return { seat, type: "raise", amount: amt };
    }
    return { seat, type: "call", amount: 0 };
  }
  return { seat, type: "fold", amount: 0 };
}

function villainPostflopAct(
  state: GameState,
  seat: number,
  cards: Combo,
  profile: OpponentProfile,
  rng: Rng,
): ActionInput {
  const strength = handConnection(cards, state.board);
  const tc = state.toCall(seat);
  const maxBet = state.stacks[seat]! + state.streetInvested[seat]!;

  if (tc > 0) {
    const callProb =
      strength === "strong"
        ? 0.95
        : strength === "medium"
          ? 1 - profile.foldToCbet
          : profile.calldownPct * 0.3;

    if (rng() < callProb) {
      if (strength === "strong" && rng() < 0.2 && state.stacks[seat]! > tc) {
        const amt = Math.min(state.currentBet * 2.5, maxBet);
        return { seat, type: "raise", amount: amt };
      }
      return { seat, type: "call", amount: 0 };
    }
    return { seat, type: "fold", amount: 0 };
  }

  const betProb =
    strength === "strong"
      ? Math.min(1, profile.cbetPct * 1.3)
      : strength === "medium"
        ? profile.betWhenCheckedTo
        : profile.betWhenCheckedTo * 0.3;

  if (rng() < betProb) {
    const size = Math.min(state.pot * 0.6, state.stacks[seat]!);
    if (size > 0) return { seat, type: "bet", amount: size };
  }
  return { seat, type: "check", amount: 0 };
}
