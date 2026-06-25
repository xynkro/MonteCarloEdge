import { type Action, type GameState } from "./game-state.js";
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
  foldTo3BetActs: number; foldTo3BetOpps: number; // opened, faced a 3-bet, folded
  betWhenCheckedToActs: number; betWhenCheckedToOpps: number; // checked to, bet
  calldownActs: number; calldownOpps: number; // faced a postflop bet, called
  // Barrel — led a postflop street, then (checked to again next street) fired a
  // 2nd/3rd barrel vs gave up. Observable from the action log alone (no cards),
  // and it un-freezes OpponentProfile.barrelFreq, which the multi-street
  // bluff-catch read in decision.ts keys on.
  barrelActs: number; barrelOpps: number;
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
    foldTo3BetActs: 0, foldTo3BetOpps: 0,
    betWhenCheckedToActs: 0, betWhenCheckedToOpps: 0,
    calldownActs: 0, calldownOpps: 0,
    barrelActs: 0, barrelOpps: 0,
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

  // Fold to 3-bet — player OPENED (first preflop raiser), faced a re-raise, and
  // we record whether they folded to it. Drives light-3-bet exploitation.
  let firstRaiser = -1;
  for (const a of preflop) { if (a.type === "raise" || a.type === "bet") { firstRaiser = a.seat; break; } }
  if (firstRaiser === seat) {
    let opened = false, threeBet = false;
    for (const a of preflop) {
      if (!opened) { if ((a.type === "raise" || a.type === "bet") && a.seat === seat) opened = true; continue; }
      if (!threeBet) { if ((a.type === "raise" || a.type === "bet") && a.seat !== seat) threeBet = true; continue; }
      if (a.seat === seat) { // player's response to the 3-bet
        s.foldTo3BetOpps++;
        if (a.type === "fold") s.foldTo3BetActs++;
        break;
      }
    }
  }

  // Bet-when-checked-to & call-down, per postflop street.
  for (const st of ["flop", "turn", "river"] as const) {
    const sa = gs.actions.filter((a) => a.street === st);
    let betBefore = false, checkBefore = false, recorded = false;
    for (const a of sa) {
      if (a.seat === seat && !recorded) {
        if (!betBefore && checkBefore) { // it was checked to them
          s.betWhenCheckedToOpps++;
          if (a.type === "bet") s.betWhenCheckedToActs++;
        }
        recorded = true;
      }
      if (a.type === "bet" || a.type === "raise") betBefore = true;
      if (a.type === "check") checkBefore = true;
    }
  }

  // Call-down — faced a postflop bet/raise and called (vs folded).
  let postBetPending = false;
  for (const a of gs.actions) {
    if (a.street === "preflop") continue;
    if (a.seat === seat) {
      if (postBetPending) {
        if (a.type === "call" || a.type === "fold") {
          s.calldownOpps++;
          if (a.type === "call") s.calldownActs++;
        }
        postBetPending = false;
      }
    } else if (a.type === "bet" || a.type === "raise") {
      postBetPending = true;
    }
  }

  // Barrel — multi-street continuation aggression. `ledPrev` = "I led (bet first-in)
  // last postflop street"; if it's checked to me again the next street, that's a
  // barrel opportunity, and betting it is a barrel act. Conditioning on having led
  // the previous street is what distinguishes a barrel from a fresh stab and is
  // exactly the signal the streetsBet>=2 bluff-catch branch reads off barrelFreq.
  {
    let ledPrev = false;
    for (const st of ["flop", "turn", "river"] as const) {
      const sa = gs.actions.filter((a) => a.street === st);
      let betInFront = false;
      let myAct: Action | undefined;
      for (const a of sa) {
        if (a.seat === seat) { myAct = a; break; }
        if (a.type === "bet" || a.type === "raise") betInFront = true;
      }
      const checkedToMe = !!myAct && !betInFront; // I was first to act with no bet in front
      if (ledPrev && checkedToMe) {
        s.barrelOpps++;
        if (myAct!.type === "bet") s.barrelActs++;
      }
      ledPrev = checkedToMe && myAct!.type === "bet";
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
    foldTo3Bet: blend(prior.foldTo3Bet, stats.foldTo3BetActs, stats.foldTo3BetOpps),
    betWhenCheckedTo: blend(prior.betWhenCheckedTo, stats.betWhenCheckedToActs, stats.betWhenCheckedToOpps),
    calldownPct: blend(prior.calldownPct, stats.calldownActs, stats.calldownOpps),
    // Un-frozen: barrelFreq now learns from observed multi-street barreling instead
    // of staying pinned at the archetype prior. Shrinkage (PRIOR_WEIGHT) keeps small
    // samples anchored, so the bluff-catch read can't swing on a handful of hands.
    barrelFreq: blend(prior.barrelFreq, stats.barrelActs, stats.barrelOpps),
  };
}

// Session-P&L "break-even" tilt (prospect theory; Eil & Lien 2014; Smith, Levere &
// Kurtzman 2009 — see docs/research/poker-psychology-and-betting.md). A villain STUCK
// below their session reference (negative P&L) is in the loss domain and turns risk-
// SEEKING: looser, stickier, chases draws, spews more. A villain AHEAD locks up
// (tighter, folds more to protect the win). The asymmetry is real and well-evidenced —
// the break-even effect is STRONG, the house-money effect WEAK — so the stuck shifts
// are larger than the ahead shifts. We don't add new decision logic: we just shift the
// profile, and the existing sticky-caller exploits (value thinner + bigger, suppress
// bluffs/semi-bluffs vs a chaser) fire automatically. `pnlBb` = session P&L in big
// blinds (current stack − buy-in); `refBb` scales how much P&L registers as fully tilted.
export function applySessionTilt(prior: OpponentProfile, pnlBb: number, refBb = 100): OpponentProfile {
  if (!Number.isFinite(pnlBb) || pnlBb === 0) return prior;
  const ref = Math.max(40, refBb); // a buy-in-ish reference so small swings barely register
  const c01 = (x: number) => Math.max(0, Math.min(1, x));
  const stuck = c01(-pnlBb / (ref * 0.8)); // down ~0.8 buy-ins → fully stuck
  const ahead = c01(pnlBb / (ref * 1.2));   // up ~1.2 buy-ins → fully locked up (weaker)
  if (stuck === 0 && ahead === 0) return prior;
  const adj = (v: number, dStuck: number, dAhead: number) => c01(v + dStuck * stuck + dAhead * ahead);
  const tag = stuck > 0.25 ? " (stuck)" : ahead > 0.3 ? " (ahead)" : "";
  return {
    ...prior,
    name: `${prior.name}${tag}`,
    vpip: adj(prior.vpip, +0.10, -0.06),
    calldownPct: adj(prior.calldownPct, +0.18, -0.10),
    foldToCbet: adj(prior.foldToCbet, -0.12, +0.08),
    foldToRaise: adj(prior.foldToRaise, -0.10, +0.06),
    bluffFreq: adj(prior.bluffFreq, +0.10, -0.05),
    stickiness: adj(prior.stickiness, +0.15, -0.08),
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

// Compact tag for a seat chip during play, shown once a small sample exists.
// Returns null until there's enough signal.
export function playerTag(stats: PlayerStats): string | null {
  if (stats.hands < 5) return null;
  const vpip = stats.vpipOpps > 0 ? stats.vpipActs / stats.vpipOpps : 0;
  const pfr = stats.pfrOpps > 0 ? stats.pfrActs / stats.pfrOpps : 0;
  const gap = vpip - pfr;
  if (vpip > 0.4 && gap > 0.18) return "STATION";
  if (vpip > 0.32 && pfr > 0.22) return "LAG";
  if (vpip < 0.18) return "NIT";
  if (gap < 0.1 && pfr > 0.14) return "TAG";
  return "REG";
}
