import { type Card, rankOf, suitOf } from "./cards.js";
import { type Combo, Range } from "./range.js";
import { type Rng } from "./rng.js";
import { evaluate, categoryOf, CATEGORY } from "./evaluator.js";
import { describeHand } from "./made-hand.js";
import { getRfiRange, getBbDefenseRange } from "./charts/index.js";
import {
  allCombos,
  sortedCombos,
  comboScore,
  topSlice,
  middleSlice,
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
  // ── Realism knobs (Stage 8, research-grounded) ──
  bluffFreq: number; // how often it fires PURE air as a bluff
  semiBluffFreq: number; // how often it bets/raises DRAWS (semi-bluff)
  barrelFreq: number; // how often it continues a bluff on the next street
  stickiness: number; // sunk-cost / curiosity: continues beyond pot-odds
}

export const TAG: OpponentProfile = {
  name: "TAG",
  vpip: 0.22, pfr: 0.18, threeBetPct: 0.08, foldTo3Bet: 0.65,
  cbetPct: 0.7, foldToCbet: 0.55, betWhenCheckedTo: 0.45, foldToRaise: 0.6, calldownPct: 0.3,
  bluffFreq: 0.45, semiBluffFreq: 0.55, barrelFreq: 0.50, stickiness: 0.30,
};

export const LAG: OpponentProfile = {
  name: "LAG",
  vpip: 0.30, pfr: 0.26, threeBetPct: 0.12, foldTo3Bet: 0.45,
  cbetPct: 0.8, foldToCbet: 0.35, betWhenCheckedTo: 0.6, foldToRaise: 0.4, calldownPct: 0.5,
  bluffFreq: 0.70, semiBluffFreq: 0.75, barrelFreq: 0.65, stickiness: 0.50,
};

export const STATION: OpponentProfile = {
  name: "Station",
  vpip: 0.42, pfr: 0.08, threeBetPct: 0.03, foldTo3Bet: 0.3,
  cbetPct: 0.35, foldToCbet: 0.2, betWhenCheckedTo: 0.2, foldToRaise: 0.15, calldownPct: 0.8,
  bluffFreq: 0.10, semiBluffFreq: 0.30, barrelFreq: 0.20, stickiness: 0.85,
};

export const NIT: OpponentProfile = {
  name: "Nit",
  vpip: 0.12, pfr: 0.10, threeBetPct: 0.06, foldTo3Bet: 0.75,
  cbetPct: 0.75, foldToCbet: 0.6, betWhenCheckedTo: 0.35, foldToRaise: 0.7, calldownPct: 0.2,
  bluffFreq: 0.30, semiBluffFreq: 0.45, barrelFreq: 0.25, stickiness: 0.15,
};

// A loose-aggressive overbluffer — bets/raises nearly everything. Hero counter:
// tighten, let them barrel into your value, don't bluff back.
export const MANIAC: OpponentProfile = {
  name: "Maniac",
  vpip: 0.50, pfr: 0.40, threeBetPct: 0.16, foldTo3Bet: 0.30,
  cbetPct: 0.9, foldToCbet: 0.30, betWhenCheckedTo: 0.8, foldToRaise: 0.3, calldownPct: 0.55,
  bluffFreq: 0.85, semiBluffFreq: 0.90, barrelFreq: 0.80, stickiness: 0.50,
};

// Neutral "average player" prior for when the opponent type is unknown. The
// adaptive model blends this toward each seat's observed tendencies as hands
// are logged, so the strategy starts solid/unexploitative and self-corrects.
export const AUTO: OpponentProfile = {
  name: "Auto",
  vpip: 0.25, pfr: 0.18, threeBetPct: 0.06, foldTo3Bet: 0.55,
  cbetPct: 0.6, foldToCbet: 0.45, betWhenCheckedTo: 0.4, foldToRaise: 0.5, calldownPct: 0.45,
  bluffFreq: 0.40, semiBluffFreq: 0.55, barrelFreq: 0.45, stickiness: 0.35,
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

// Bucket a holding on the board for villain decisions. Crucially a flush/straight
// draw is now its OWN bucket ("draw") instead of being lumped with air — a villain
// must be able to semi-bluff its draws and peel them, not treat them as 7-2.
export function handConnection(
  cards: Combo,
  board: Card[],
): "strong" | "medium" | "draw" | "air" {
  if (board.length < 3) return "air";
  const d = describeHand([cards[0], cards[1]], board);
  if (d.category >= CATEGORY.TWO_PAIR) return "strong"; // two pair, set, straight, flush+
  const hasDraw =
    d.draws.includes("Flush draw") ||
    d.draws.includes("Open-ended straight draw") ||
    d.draws.includes("Gutshot");
  if (d.category === CATEGORY.PAIR) {
    if (/Overpair/i.test(d.label)) return "strong"; // overpair plays like a strong made hand
    return hasDraw ? "strong" : "medium"; // pair + draw = strong combo
  }
  return hasDraw ? "draw" : "air";
}

// A combo's strength on the current board: its made-hand rank, with a bump for
// strong draws (flush draw / OESD) so semi-bluffs rank alongside weak made hands
// rather than getting dumped into the fold tail of a betting range.
function boardStrength(c: Combo, board: readonly Card[]): number {
  let r = evaluate([c[0], c[1], ...board]);
  if (board.length < 5 && categoryOf(r) <= CATEGORY.PAIR) {
    const d = describeHand([c[0], c[1]], board);
    if (d.draws.includes("Flush draw") || d.draws.includes("Open-ended straight draw")) {
      r = Math.max(r, CATEGORY.PAIR << 20); // ~ a weak pair: survives a value slice
    }
  }
  return r;
}

// THE FROZEN-RANGE FIX. The preflop continuing range is the same whether the
// villain then check-folds or fires three barrels — which makes hero's equity
// (and all the postflop advice) systematically too optimistic against aggression.
// Here we condition the range on the villain's POSTFLOP line and bet sizing:
//   raised      → strong, polar (top of range)
//   bet big     → polarized: nutty value + a thin bluff tail, middle removed
//   bet small   → merged: the top/continuing portion
//   called      → condensed: a medium band (too weak to raise, too strong to fold)
//   only checked → capped: the strong value that would bet is removed
// This is a tractable stand-in for true range-vs-range (GTO Wizard range
// morphology), and the precondition for the later solver work.
function narrowPostflop(
  state: GameState,
  villainSeat: number,
  range: Range,
  profile: OpponentProfile,
): Range {
  const board = state.board;
  if (board.length < 3 || range.size === 0) return range;

  const post = state.actions.filter(
    (a) => a.seat === villainSeat && a.street !== "preflop",
  );
  if (post.length === 0) return range; // villain hasn't acted postflop yet

  const raised = post.some((a) => a.type === "raise");
  const aggressed = raised || post.some((a) => a.type === "bet");
  const called = post.some((a) => a.type === "call");
  const onlyChecked = post.every((a) => a.type === "check");

  // Largest villain bet/raise as a fraction of the pot → polarization degree.
  let betFrac = 0;
  for (const a of post) {
    if ((a.type === "bet" || a.type === "raise") && a.amount > 0) {
      betFrac = Math.max(betFrac, a.amount / Math.max(1, state.pot));
    }
  }

  const scored = range.combos
    .map((c) => [c, boardStrength(c, board)] as [Combo, number])
    .sort((x, y) => y[1] - x[1]);
  const n = scored.length;
  const slice = (lo: number, hi: number): Combo[] =>
    scored.slice(Math.floor(lo * n), Math.max(Math.floor(lo * n) + 1, Math.ceil(hi * n))).map((s) => s[0]);

  let combos: Combo[];
  if (raised) {
    combos = slice(0, 0.30); // raises are strong
  } else if (aggressed && betFrac >= 0.66) {
    // Polarized big bet: top value + a thin bluff tail, drop the middle.
    combos = [...slice(0, 0.26), ...scored.slice(Math.floor(0.88 * n)).map((s) => s[0])];
  } else if (aggressed) {
    // Merged bet: top/continuing portion (foldy fields bet a touch wider).
    combos = slice(0, profile.betWhenCheckedTo > 0.5 ? 0.62 : 0.5);
  } else if (called) {
    combos = slice(0.10, 0.65); // condensed medium band
  } else if (onlyChecked) {
    // Capped: a passive station checks everything, so cap less.
    combos = slice(profile.betWhenCheckedTo > 0.45 ? 0.08 : 0.22, 1);
  } else {
    return range;
  }

  const narrowed = Range.fromCombos(combos);
  return narrowed.size > 0 ? narrowed : range;
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
  const raisedPreflop = state.actions.some(
    (a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet"),
  );

  // A LIMP/CHECK range: wide AND capped. Crucially it EXCLUDES the top ~pfr% of
  // hands (the premiums a player would have RAISED) and keeps the next band down
  // to ~vpip+0.5. Using the *top* slice here (as before) front-loads aces/pairs
  // and massively overstates how often a passive limper holds a board-pairing
  // card — which understated hero's equity in multiway limped pots and made the
  // engine check the near-nuts.
  const limpBand = (): Range => {
    const top = Math.min(0.04, profile.pfr * 0.25); // a few premiums slow-play / trap
    const bottom = Math.min(0.92, Math.max(profile.vpip + 0.5, 0.55));
    return middleSlice(allCombos(), top, bottom);
  };

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
      // BB checked its option in an unraised pot → essentially any two cards.
      range = topSlice(allCombos(), 0.97);
    }
  } else if (villainCalled && raisedPreflop) {
    // Called a preflop RAISE → a genuine (tighter) continuing range.
    range = topSlice(allCombos(), profile.vpip);
  } else {
    // Limped (called the BB) or checked in an UNRAISED pot — both are passive
    // limp/check ranges. (Real limpers reach here via villainCalled, which is
    // why the previous fix on the bare `else` was dead code.)
    range = limpBand();
  }

  // Postflop: condition the continuing range on the villain's line + sizing so
  // hero's equity reflects who's actually represented (no more frozen range).
  return narrowPostflop(state, villainSeat, range.filter(dead), profile);
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
    // Blind defense SCALED TO THE OPEN SIZE (pot odds), not a flat tight cut. A
    // small raise gets defended very wide (you're already invested and getting a
    // price — "another $3 to see a flop"); a big open gets defended tighter.
    const raiseBB = state.bb > 0 ? state.currentBet / state.bb : 2.5;
    const sizeF = Math.max(0.45, Math.min(1.15, 1.6 - 0.3 * raiseBB)); // 2x→1.0, 2.5x→0.85, 3x→0.70, 4x→0.40
    const anchor = pos === "BB" ? 0.62 : pos === "SB" ? 0.36 : profile.vpip + 0.04;
    const loose = Math.max(0.7, Math.min(1.5, 0.55 + profile.vpip * 1.6)); // station wide, nit tight
    const defend = Math.min(0.88, anchor * sizeF * loose);
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
  const pot = state.pot;

  // Did THIS villain already bet/raise on a prior postflop street? Used to barrel
  // (continue a bluff) coherently instead of re-rolling to ~0 each street.
  const wasAggressor = state.actions.some(
    (a) => a.seat === seat && a.street !== "preflop" && (a.type === "bet" || a.type === "raise"),
  );
  // Already invested chips this hand → sunk-cost stickiness kicks in harder.
  const invested = state.invested[seat]! > state.bb;

  if (tc > 0) {
    const betFrac = pot > 0 ? state.currentBet / pot : 0.5;
    // MDF-ish price sensitivity: small bets get called much wider, overbets get
    // folded more. Stickiness (station/sunk-cost) inflates calls beyond the price.
    const priceAdj = betFrac <= 0.4 ? 1.22 : betFrac >= 1.2 ? 0.72 : 1 - (betFrac - 0.4) * 0.35;
    const stick = 1 + profile.stickiness * (invested ? 0.5 : 0.35);

    let callProb: number;
    let raiseProb = 0;
    if (strength === "strong") { callProb = 0.97; raiseProb = profile.semiBluffFreq * 0.3 + 0.12; }
    else if (strength === "draw") { callProb = 0.80 * priceAdj; raiseProb = profile.semiBluffFreq * 0.22; } // peel / semi-bluff raise
    else if (strength === "medium") { callProb = (1 - profile.foldToCbet) * priceAdj * stick; }
    else { callProb = profile.calldownPct * 0.45 * priceAdj * stick; } // air: float/curiosity
    callProb = Math.min(0.98, callProb);

    if (raiseProb > 0 && rng() < raiseProb && state.stacks[seat]! > tc) {
      const amt = Math.min(Math.max(state.currentBet * 2.5, pot + tc), maxBet);
      if (amt > state.currentBet) return { seat, type: "raise", amount: amt };
    }
    if (rng() < callProb) return { seat, type: "call", amount: 0 };
    return { seat, type: "fold", amount: 0 };
  }

  // No bet to call — decide whether to bet (value / semi-bluff / bluff) or check.
  // Polarized: strong bets for value; draws semi-bluff; air bluffs (sometimes a
  // barrel); medium mostly checks back (merge-bet only a fraction).
  let betProb: number;
  if (strength === "strong") betProb = Math.min(0.95, profile.cbetPct * 1.25);
  else if (strength === "draw") betProb = wasAggressor ? profile.barrelFreq : profile.semiBluffFreq;
  else if (strength === "medium") betProb = profile.betWhenCheckedTo * 0.5; // mostly check back
  else betProb = wasAggressor ? profile.barrelFreq * 0.7 : profile.bluffFreq; // air bluff / barrel

  if (rng() < betProb) {
    // Texture-aware sizing: smaller with merged (medium/value) hands, bigger when
    // polar (a draw or air on a later street wants fold equity).
    const polar = strength === "draw" || strength === "air";
    const frac = polar ? (state.board.length >= 4 ? 0.75 : 0.6) : 0.4 + (strength === "strong" ? 0.2 : 0);
    const size = Math.min(pot * frac, state.stacks[seat]!);
    if (size > 0) return { seat, type: "bet", amount: size };
  }
  return { seat, type: "check", amount: 0 };
}
