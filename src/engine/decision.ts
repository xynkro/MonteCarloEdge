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
import { threeBetSize } from "./sizing.js";
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
  if (state.street === "preflop") return preflopRecommend(state, villainProfile ?? TAG, profiles);
  return postflopRecommend(
    state,
    villainProfile ?? TAG,
    rng ?? mulberry32(0xdec1de),
    profiles,
  );
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

function preflopRecommend(
  state: GameState,
  villainProfile: OpponentProfile = TAG,
  profiles?: ProfileMap,
): Recommendation {
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
        const amt = openSizeFor(state, villainProfile, profiles);
        const bbN = (amt / state.bb);
        const note = bbN >= 4 ? " (sized up vs loose field)" : "";
        return {
          action: "raise",
          amount: amt,
          equity: 0.55,
          potOdds: 0,
          ev: { fold: 0, call: 0.5, raise: 1 },
          reasoning: `Open raise to ${bbN.toFixed(1)}bb — ${label} in ${pos} RFI range${note}`,
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
    if (dq > odds + callCushion) {
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

  // Value-betting tiers (decision equity, texture- and opponent-adjusted sizing).
  // valueMult sizes up vs callers (extract more) and down vs folders.
  if (dq > 0.80) {
    // Monsters can overbet a sticky caller.
    const frac = Math.min(sticky > 0.6 ? 1.5 : 1.0, (0.80 + (dq - 0.80)) * valueTexAdj * valueMult);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, big value on ${texNote}`,
    });
  }
  if (dq > 0.60) {
    const frac = Math.min(1.1, (0.55 + (dq - 0.60)) * valueTexAdj * valueMult);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 1 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
    });
  }
  if (dq > VALUE_BET) {
    const frac = Math.min(0.7, 0.40 * valueTexAdj * valueMult);
    const size = Math.min(pot * frac, heroStack);
    return fin({
      action: "bet", amount: size, equity: eq, potOdds: 0,
      ev: { fold: 0, call: 0, raise: 0.5 },
      reasoning: `Bet ${pct(frac)} pot — ${handLabel}, ${pct(eq)} equity, thin value on ${texNote}`,
    });
  }
  if (dq > THIN_VALUE) {
    const size = Math.min(pot * 0.25 * valueMult, heroStack);
    if (size > 0) {
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0,
        ev: { fold: 0, call: 0, raise: 0.3 },
        reasoning: `Small bet — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
      });
    }
  }

  // ── Represent / bluff ──
  // With a hand that has no showdown value, checking just gives up. If the
  // opponent folds often enough, BETTING to represent a strong hand prints
  // money (fold equity). Only heads-up (multiway someone calls too often), only
  // with true air (no showdown value, no draw — draws are the semi-bluff above),
  // and only when the estimated fold% clears the bet's break-even with margin.
  // Never vs a calling station (low foldy) — that's where bluffs go to die.
  const bluffOK = villainSeats.length === 1 && eq < 0.34 && dq < THIN_VALUE
    && !conn.hasFlushDraw && !conn.hasStraightDraw;
  if (bluffOK) {
    const frac = tex.dry ? 0.5 : tex.wet ? 0.75 : 0.6; // size to credibly represent
    const breakeven = frac / (1 + frac);               // fold% needed to break even
    if (foldy > breakeven + 0.06 && heroStack > pot * frac) {
      const size = Math.min(pot * frac, heroStack);
      return fin({
        action: "bet", amount: size, equity: eq, potOdds: 0,
        ev: { fold: foldy * pot, call: 0, raise: foldy * pot - (1 - foldy) * size },
        reasoning: `Bluff — represent strength on ${texNote}, opp folds ~${pct(foldy)} (${posTag})`,
      });
    }
  }

  return fin({
    action: "check", amount: 0, equity: eq, potOdds: 0,
    ev: { fold: 0, call: 0, raise: -0.5 },
    reasoning: `Check — ${handLabel}, ${pct(eq)} equity on ${texNote}`,
  });
}
