import { type GameState, type ActionInput, type ActionType } from "./game-state.js";
import { type Combo } from "./range.js";
import { type Rng } from "./rng.js";
import { recommend } from "./decision.js";
import { type OpponentProfile, TAG, comboPercentile, commitStory, scoreRunout } from "./opponent.js";
import { openRaiseSize } from "./sizing.js";

// A tough, realistic, NON-CHEATING villain. It decides by running the same
// equity engine the hero's recommendations use, but from its own seat — it
// estimates the hero's RANGE from position/action (never the actual cards) and
// computes its hand's equity against that. An archetype layer then distorts the
// honest baseline into a recognizable style (aggression, calling, tightness).

// Clone the state with `seat` as the acting "hero" holding `cards`. recommend()
// then evaluates this seat's spot, estimating every other seat's range — it
// never reads the real hero's hole cards, so there is no tacit knowledge.
function flipPerspective(state: GameState, seat: number, cards: Combo): GameState {
  const c = state.clone() as unknown as { heroSeat: number; heroCards: Combo };
  c.heroSeat = seat;
  c.heroCards = cards;
  return c as unknown as GameState;
}

function lastAggressor(state: GameState): number {
  let s = -1;
  for (const a of state.actions) if (a.type === "bet" || a.type === "raise") s = a.seat;
  return s;
}

function clampBetTarget(potFrac: number, state: GameState, seat: number): number {
  const max = state.stacks[seat]! + state.streetInvested[seat]!;
  const target = Math.min(max, Math.round((state.pot * potFrac) * 2) / 2);
  return Math.max(state.bb, Math.min(target, max));
}

function clampRaiseTo(mult: number, state: GameState, seat: number): number {
  const max = state.stacks[seat]! + state.streetInvested[seat]!;
  const target = Math.max(state.currentBet * mult, state.currentBet + state.pot * 0.6);
  return Math.min(Math.round(target * 2) / 2, max);
}

export function villainDecision(
  state: GameState,
  seat: number,
  cards: Combo,
  profile: OpponentProfile,
  rng: Rng,
): ActionInput {
  const ps = flipPerspective(state, seat, cards);
  // The villain assumes its opponents are solid (TAG) when reading their range. Bots run on
  // the server every action tick, so use a LOW Monte-Carlo iteration count (vs the trainer's
  // 6000/8000) — the archetype layer dominates anyway, and this keeps the online tick fast.
  const rec = recommend(ps, TAG, rng, undefined, undefined, undefined, 1500);

  let type: ActionType = rec.action;
  let amount = rec.amount;
  const tc = state.toCall(seat);
  const facing = tc > 0;
  const canRaise = state.stacks[seat]! > tc;
  const eq = rec.realizedEquity ?? rec.equity ?? 0.5;
  const roll = rng();
  const n = profile.name.replace("*", "");
  const preflop = state.street === "preflop";

  // Anti-exploit defense floor: a player who folds too often to bets gets
  // bluffed relentlessly. The engine assumes an honest (TAG) bettor, so it
  // over-folds against a human who over-bluffs. If we'd fold but our equity is
  // within a bluff-catch cushion of the price, call instead. Nit still folds.
  if (!preflop && facing && type === "fold") {
    const odds = state.potOdds(seat); // equity needed to call
    const cushion = n === "Station" ? 0.22 : n === "Nit" ? 0.0 : n === "LAG" ? 0.14 : 0.12;
    if (eq + cushion >= odds && state.stacks[seat]! > 0) { type = "call"; amount = 0; }
  }

  if (!preflop) {
    if (n === "Station") {
      // Calls down light, rarely folds, plays passively (flats instead of raising).
      if (type === "fold" && facing && (eq > 0.16 || roll < profile.calldownPct)) {
        type = "call"; amount = 0;
      } else if (type === "raise") {
        type = facing ? "call" : "check"; amount = 0;
      } else if (type === "bet" && roll < 0.45) {
        type = "check"; amount = 0; // checks back made hands, only bets some
      }
    } else if (n === "Nit") {
      // Continues only with strong hands; value-bets, almost never bluffs.
      if (type === "call" && facing && eq < 0.58) { type = "fold"; amount = 0; }
      else if (type === "bet" && eq < 0.62) { type = "check"; amount = 0; }
      else if (type === "raise" && eq < 0.74) { type = facing ? "call" : "check"; amount = 0; }
    } else if (n === "LAG") {
      // Heavy aggression: barrels when checked to, bluff-raises, floats.
      if (!facing && type === "check" && roll < profile.betWhenCheckedTo && canRaise) {
        type = "bet"; amount = clampBetTarget(0.7, state, seat);
      } else if (facing && type === "call" && roll < 0.30 && canRaise) {
        type = "raise"; amount = clampRaiseTo(2.6, state, seat);
      } else if (facing && type === "fold" && roll < 0.12) {
        type = "call"; amount = 0; // float to bluff later
      }
    } else {
      // TAG: honest aggression — c-bets with initiative, occasional check-raise.
      if (!facing && type === "check" && roll < profile.cbetPct * 0.55 &&
          lastAggressor(state) === seat && canRaise) {
        type = "bet"; amount = clampBetTarget(0.55, state, seat);
      } else if (facing && type === "call" && roll < 0.18 && eq > 0.45 && canRaise) {
        type = "raise"; amount = clampRaiseTo(2.5, state, seat);
      }
    }
  } else {
    // Preflop archetype tweaks on top of the chart-based baseline.
    const pct = comboPercentile(cards);
    const maxBet = state.stacks[seat]! + state.streetInvested[seat]!;
    if (n === "Station" && type === "fold" && roll < 0.5) {
      type = "call"; amount = 0; // limps / calls light
    } else if (n === "Nit" && pct > 0.1 && (type === "call" || type === "raise")) {
      if (roll < 0.45) { type = "fold"; amount = 0; } // only premiums
    } else if (n === "LAG" && roll < 0.3 && canRaise) {
      if (type === "call") { type = "raise"; amount = Math.min(facing ? clampRaiseTo(3, state, seat) : openRaiseSize(state.bb) * 1.2, maxBet); }
    }
  }

  // ── Story coherence ──────────────────────────────────────────────────────
  // Make BLUFFS represent ONE board-credible hand across streets instead of
  // re-rolling each street. Commit a story on the first bluff bet; on later
  // streets keep barrelling the cards that complete the rep (scare) but ABANDON
  // bricked/killed bluffs (scaled by the type's coherence) — and fire a barrel on
  // a scare card even if we'd otherwise check. This is what makes the villain
  // tell a believable story instead of betting random air.
  if (!preflop && canRaise) {
    const board = state.board;
    if (type === "bet" && eq < 0.5) {
      // a bluff bet (value bets have eq ≥ 0.5 → left alone)
      const story = state.villainStories.get(seat);
      if (!story) {
        state.villainStories.set(seat, commitStory(state, profile)); // open the story
      } else {
        const phase = scoreRunout(story, board);
        if (phase !== "scare") {
          // Abandon fewer RIVER brick bluffs than turn bricks — the river was ~11pts under the
          // GTO bluff-to-value cap (value-heavy, exploitable by over-folding); the turn was fine.
          const onRiver = board.length >= 5;
          const giveUp = phase === "kill"
            ? 0.55 + story.coherence * 0.45
            : story.coherence * (onRiver ? 0.45 : 0.7);
          if (rng() < giveUp) { type = "check"; amount = 0; } // abandon a bricked/killed bluff
        }
      }
    } else if (type === "check" && !facing && eq < 0.55) {
      // checked this street, but a committed story just got there → barrel it
      const story = state.villainStories.get(seat);
      if (story && scoreRunout(story, board) === "scare"
          && rng() < profile.barrelFreq * (0.5 + story.coherence * 0.5)) {
        type = "bet"; amount = clampBetTarget(0.85, state, seat);
      }
    }
  }

  // Legality: a raise must exceed the current bet and be affordable.
  if ((type === "raise" || type === "bet")) {
    const max = state.stacks[seat]! + state.streetInvested[seat]!;
    if (!canRaise || amount <= state.currentBet || amount > max) {
      if (type === "raise") { type = facing ? "call" : "check"; amount = 0; }
      else if (amount > max || amount <= 0) { type = facing ? "call" : "check"; amount = 0; }
    }
  }

  return { seat, type, amount };
}
