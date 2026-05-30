import { type GameState } from "./game-state.js";
import { type OpponentProfile } from "./opponent.js";

// Observed action counters for one player across a session.
// Each stat tracks "acts" (times they did X) over "opps" (times they could).
export interface PlayerStats {
  hands: number;
  vpipActs: number; vpipOpps: number;
  pfrActs: number; pfrOpps: number;
  threeBetActs: number; threeBetOpps: number;
  cbetActs: number; cbetOpps: number;
  foldToCbetActs: number; foldToCbetOpps: number;
  foldToRaiseActs: number; foldToRaiseOpps: number;
}

export function emptyStats(): PlayerStats {
  return {
    hands: 0,
    vpipActs: 0, vpipOpps: 0,
    pfrActs: 0, pfrOpps: 0,
    threeBetActs: 0, threeBetOpps: 0,
    cbetActs: 0, cbetOpps: 0,
    foldToCbetActs: 0, foldToCbetOpps: 0,
    foldToRaiseActs: 0, foldToRaiseOpps: 0,
  };
}

// Update a player's stats from a completed hand's action log.
export function observeHand(stats: PlayerStats, gs: GameState, seat: number): PlayerStats {
  const s = { ...stats };
  s.hands++;

  const acts = gs.actions.filter((a) => a.seat === seat);
  const preflop = gs.actions.filter((a) => a.street === "preflop");
  const myPreflop = preflop.filter((a) => a.seat === seat);

  // VPIP — voluntarily put money in preflop (call/bet/raise; blinds are implicit, not in the log).
  s.vpipOpps++;
  if (myPreflop.some((a) => a.type === "call" || a.type === "bet" || a.type === "raise")) {
    s.vpipActs++;
  }

  // PFR — raised preflop.
  s.pfrOpps++;
  if (myPreflop.some((a) => a.type === "raise" || a.type === "bet")) s.pfrActs++;

  // 3-bet — raised after facing a preflop raise.
  let raiseSeenBefore = false;
  let faced3BetSpot = false;
  let did3Bet = false;
  for (const a of preflop) {
    if (a.seat === seat) {
      if (raiseSeenBefore) {
        faced3BetSpot = true;
        if (a.type === "raise") did3Bet = true;
      }
    }
    if (a.type === "raise" || a.type === "bet") raiseSeenBefore = true;
  }
  if (faced3BetSpot) { s.threeBetOpps++; if (did3Bet) s.threeBetActs++; }

  // Identify the preflop aggressor (last preflop raiser).
  let aggressor = -1;
  for (const a of preflop) if (a.type === "raise" || a.type === "bet") aggressor = a.seat;

  // C-bet — preflop aggressor bets the flop.
  const flop = gs.actions.filter((a) => a.street === "flop");
  if (seat === aggressor && (gs.board.length >= 3)) {
    // Opportunity exists if they saw a flop (didn't fold preflop).
    if (!gs.folded[seat] || flop.some((a) => a.seat === seat)) {
      s.cbetOpps++;
      if (flop.some((a) => a.seat === seat && a.type === "bet")) s.cbetActs++;
    }
  }

  // Fold to c-bet — faced a flop bet and folded that street.
  const flopBetBy = flop.find((a) => a.type === "bet");
  if (flopBetBy && flopBetBy.seat !== seat) {
    const myFlop = flop.filter((a) => a.seat === seat);
    if (myFlop.length > 0) {
      s.foldToCbetOpps++;
      if (myFlop.some((a) => a.type === "fold")) s.foldToCbetActs++;
    }
  }

  // Fold to raise (any street) — faced a raise and folded.
  let raisePending = false;
  for (const a of gs.actions) {
    if (a.seat === seat) {
      if (raisePending) {
        s.foldToRaiseOpps++;
        if (a.type === "fold") s.foldToRaiseActs++;
        raisePending = false;
      }
    } else if (a.type === "raise") {
      raisePending = true;
    }
  }

  return s;
}

// Blend the prior archetype toward observed frequencies using shrinkage.
// With few hands the prior dominates; as the sample grows, observation wins.
const PRIOR_WEIGHT = 12;

export function blendProfile(prior: OpponentProfile, stats: PlayerStats): OpponentProfile {
  const K = PRIOR_WEIGHT;
  const blend = (p: number, acts: number, opps: number) =>
    opps > 0 ? (p * K + acts) / (K + opps) : p;

  return {
    ...prior,
    name: stats.hands >= 8 ? `${prior.name}*` : prior.name, // * = adapted
    vpip: blend(prior.vpip, stats.vpipActs, stats.vpipOpps),
    pfr: blend(prior.pfr, stats.pfrActs, stats.pfrOpps),
    threeBetPct: blend(prior.threeBetPct, stats.threeBetActs, stats.threeBetOpps),
    cbetPct: blend(prior.cbetPct, stats.cbetActs, stats.cbetOpps),
    foldToCbet: blend(prior.foldToCbet, stats.foldToCbetActs, stats.foldToCbetOpps),
    foldToRaise: blend(prior.foldToRaise, stats.foldToRaiseActs, stats.foldToRaiseOpps),
  };
}

// Human-readable read on a player once enough hands are in.
export function playerRead(stats: PlayerStats): string | null {
  if (stats.hands < 8) return null;
  const vpip = stats.vpipOpps > 0 ? stats.vpipActs / stats.vpipOpps : 0;
  const pfr = stats.pfrOpps > 0 ? stats.pfrActs / stats.pfrOpps : 0;
  const gap = vpip - pfr;
  if (vpip > 0.4 && gap > 0.18) return "loose-passive (calls a lot)";
  if (vpip > 0.32 && pfr > 0.22) return "loose-aggressive";
  if (vpip < 0.18) return "very tight";
  if (gap < 0.08 && pfr > 0.15) return "tight-aggressive";
  return "balanced";
}
