import { type Card, NUM_CARDS } from "./cards.js";
import { type Combo } from "./range.js";
import { type Rng } from "./rng.js";
import { evaluate } from "./evaluator.js";
import { GameState } from "./game-state.js";
import { recommend } from "./decision.js";
import { type OpponentProfile, TAG, villainAct } from "./opponent.js";

export interface SimConfig {
  villainProfile: OpponentProfile;
  hands: number;
  startingStack: number;
  bb: number;
  rng: Rng;
}

export interface SimResult {
  handsPlayed: number;
  totalPnl: number;
  bbPer100: number;
  stddev: number;
  ci95: [number, number];
}

export function simulate(config: SimConfig): SimResult {
  const {
    villainProfile,
    hands,
    startingStack,
    bb,
    rng,
  } = config;

  let totalPnl = 0;
  let pnlSqSum = 0;
  let played = 0;

  for (let h = 0; h < hands; h++) {
    const heroSeat = h % 2;
    const villainSeat = 1 - heroSeat;

    const deck = shuffleDeck(rng);
    const heroCards: Combo = ordered(deck[0]!, deck[1]!);
    const villainCards: Combo = ordered(deck[2]!, deck[3]!);
    const boardCards = [deck[4]!, deck[5]!, deck[6]!, deck[7]!, deck[8]!];

    const pnl = playHand({
      heroSeat,
      villainSeat,
      heroCards,
      villainCards,
      boardCards,
      startingStack,
      bb,
      villainProfile,
      rng,
    });

    totalPnl += pnl;
    pnlSqSum += pnl * pnl;
    played++;
  }

  const mean = totalPnl / played;
  const bbPer100 = (mean / bb) * 100;
  const variance = Math.max(0, pnlSqSum / played - mean * mean);
  const stddev = Math.sqrt(variance);
  const stderr = stddev / Math.sqrt(played);
  const ci95: [number, number] = [
    ((mean - 1.96 * stderr) / bb) * 100,
    ((mean + 1.96 * stderr) / bb) * 100,
  ];

  return { handsPlayed: played, totalPnl, bbPer100, stddev, ci95 };
}

function ordered(a: Card, b: Card): Combo {
  return a <= b ? [a, b] : [b, a];
}

function shuffleDeck(rng: Rng): Card[] {
  const deck: Card[] = new Array(NUM_CARDS);
  for (let i = 0; i < NUM_CARDS; i++) deck[i] = i;
  for (let i = 0; i < 9; i++) {
    const j = i + Math.floor(rng() * (NUM_CARDS - i));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

interface HandConfig {
  heroSeat: number;
  villainSeat: number;
  heroCards: Combo;
  villainCards: Combo;
  boardCards: Card[];
  startingStack: number;
  bb: number;
  villainProfile: OpponentProfile;
  rng: Rng;
}

function playHand(cfg: HandConfig): number {
  const state = new GameState({
    tableSize: 2,
    bb: cfg.bb,
    stacks: [cfg.startingStack, cfg.startingStack],
    positions: ["BTN", "BB"],
    heroSeat: cfg.heroSeat,
    heroCards: cfg.heroCards,
    dealerSeat: 0,
  });

  // PnL = money_won − money_invested (including blinds)

  const maxActions = 30;
  let actionCount = 0;

  while (!state.isComplete() && actionCount < maxActions) {
    if (state.roundComplete()) {
      if (state.street === "river") break;

      const bothAllIn =
        state.stacks[0]! <= 0 || state.stacks[1]! <= 0;
      if (bothAllIn) break;

      const nextCards = dealNextStreet(state, cfg.boardCards);
      state.advanceStreet(nextCards);
    }

    const seat = state.nextToAct();
    if (seat === null) break;

    if (seat === cfg.heroSeat) {
      const rec = recommend(state, cfg.villainProfile, cfg.rng);
      let action = rec.action;
      let amount = rec.amount;

      if (
        action === "raise" &&
        !state.legalActionsFor(seat).includes("raise")
      ) {
        action = state.legalActionsFor(seat).includes("call") ? "call" : "check";
        amount = 0;
      }
      if (action === "bet" && !state.legalActionsFor(seat).includes("bet")) {
        action = "check";
        amount = 0;
      }

      state.applyAction({ seat, type: action, amount });
    } else {
      const vAct = villainAct(
        state,
        seat,
        cfg.villainCards,
        cfg.villainProfile,
        cfg.rng,
      );

      let action = vAct.type;
      let amount = vAct.amount;
      const legal = state.legalActionsFor(seat);

      if (action === "raise" && !legal.includes("raise")) {
        action = legal.includes("call") ? "call" : "check";
        amount = 0;
      }
      if (action === "bet" && !legal.includes("bet")) {
        action = "check";
        amount = 0;
      }
      if (action === "fold" && !legal.includes("fold")) {
        action = "check";
        amount = 0;
      }

      state.applyAction({ seat, type: action, amount });
    }

    actionCount++;
  }

  const heroInvested = state.invested[cfg.heroSeat]!;

  if (state.activeSeatCount <= 1) {
    if (state.folded[cfg.heroSeat]) return -heroInvested;
    return state.pot - heroInvested;
  }

  const fullBoard = ensureFullBoard(state, cfg.boardCards);
  const heroRank = evaluate([cfg.heroCards[0], cfg.heroCards[1], ...fullBoard]);
  const villRank = evaluate([
    cfg.villainCards[0],
    cfg.villainCards[1],
    ...fullBoard,
  ]);

  if (heroRank > villRank) {
    return state.pot - heroInvested;
  } else if (heroRank === villRank) {
    return state.pot / 2 - heroInvested;
  } else {
    return -heroInvested;
  }
}

function dealNextStreet(state: GameState, boardCards: Card[]): Card[] {
  switch (state.street) {
    case "preflop":
      return [boardCards[0]!, boardCards[1]!, boardCards[2]!];
    case "flop":
      return [boardCards[3]!];
    case "turn":
      return [boardCards[4]!];
    default:
      return [];
  }
}

function ensureFullBoard(state: GameState, boardCards: Card[]): Card[] {
  if (state.board.length >= 5) return state.board.slice(0, 5);
  return boardCards.slice(0, 5);
}
