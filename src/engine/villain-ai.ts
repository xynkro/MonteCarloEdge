import { type GameState, type ActionInput, type ActionType } from "./game-state.js";
import { type Combo } from "./range.js";
import { type Rng } from "./rng.js";
import { recommend } from "./decision.js";
import { type OpponentProfile, TAG, comboPercentile } from "./opponent.js";
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
  // The villain assumes its opponents are solid (TAG) when reading their range.
  const rec = recommend(ps, TAG, rng);

  let type: ActionType = rec.action;
  let amount = rec.amount;
  const tc = state.toCall(seat);
  const facing = tc > 0;
  const canRaise = state.stacks[seat]! > tc;
  const eq = rec.realizedEquity ?? rec.equity ?? 0.5;
  const roll = rng();
  const n = profile.name.replace("*", "");
  const preflop = state.street === "preflop";

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
      else if (type === "raise" && eq < 0.78) { type = facing ? "call" : "check"; amount = 0; }
    } else if (n === "LAG") {
      // Heavy aggression: barrels when checked to, bluff-raises, floats.
      if (!facing && type === "check" && roll < profile.betWhenCheckedTo && canRaise) {
        type = "bet"; amount = clampBetTarget(0.7, state, seat);
      } else if (facing && type === "call" && roll < 0.22 && canRaise) {
        type = "raise"; amount = clampRaiseTo(2.6, state, seat);
      } else if (facing && type === "fold" && roll < 0.12) {
        type = "call"; amount = 0; // float to bluff later
      }
    } else {
      // TAG: honest aggression — c-bets with initiative, occasional check-raise.
      if (!facing && type === "check" && roll < profile.cbetPct * 0.55 &&
          lastAggressor(state) === seat && canRaise) {
        type = "bet"; amount = clampBetTarget(0.55, state, seat);
      } else if (facing && type === "call" && roll < 0.09 && eq > 0.45 && canRaise) {
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
