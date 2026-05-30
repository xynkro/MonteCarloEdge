import { type Card, rankOf, suitOf, makeCard, NUM_CARDS } from "../engine/cards.js";
import { type Combo } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { getPositions } from "../engine/charts/index.js";
import { recommend, type Recommendation, type ProfileMap } from "../engine/decision.js";
import { TAG, LAG, STATION, NIT, type OpponentProfile, villainAct } from "../engine/opponent.js";
import { evaluate } from "../engine/evaluator.js";
import { describeHand } from "../engine/made-hand.js";
import { openRaiseSize, minRaise } from "../engine/sizing.js";
import { saveHand, getSessionHands, clearHistory, computeStats, type HandRecord, type SessionStats } from "../engine/hand-history.js";
import { emptyStats, observeHand, blendProfile, playerRead, type PlayerStats } from "../engine/player-model.js";
import { playSound, setSoundEnabled, isSoundEnabled } from "./sound.js";

const RANKS = "23456789TJQKA";
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_RED = [false, true, true, false];
const PROFILES: Record<string, OpponentProfile> = { TAG, LAG, Station: STATION, Nit: NIT };

interface AppState {
  screen: "setup" | "game" | "stats";
  mode: "live" | "training";
  sessionStart: number;
  tableSize: number;
  stackBB: number;
  bbValue: number;
  sbValue: number;
  heroSeat: number;
  dealerSeat: number;
  handNumber: number;
  archetype: string;
  gs: GameState | null;
  heroCards: [Card, Card] | null;
  boardCards: Card[];
  allDealt: Set<number>;
  pickerOpen: boolean;
  pickerTarget: "hero" | "flop" | "turn" | "river";
  pickerPicked: Card[];
  pickerRank: number | null;
  rec: Recommendation | null;
  handOver: boolean;
  handResult: string;
  raiseAmount: number;
  betPadOpen: boolean;
  betPadAction: "bet" | "raise";
  betPadSeat: number;
  // Training mode
  villainCards: [Card, Card] | null;
  trainingDeck: Card[];
  trainingBoardCards: Card[];
  // Per-seat opponent types + adaptive modeling
  seatTypes: Map<number, string>;
  playerStats: Map<number, PlayerStats>;
  // Post-hand review: hero's decision points this hand
  decisionLog: { street: string; chosen: ActionType; chosenAmt: number; rec: Recommendation }[];
  reviewOpen: boolean;
  message: string;
}

const S: AppState = {
  screen: "setup",
  mode: "live",
  sessionStart: Date.now(),
  tableSize: 6,
  stackBB: 100,
  bbValue: 1,
  sbValue: 0.5,
  heroSeat: 3,
  dealerSeat: -1,
  handNumber: 0,
  archetype: "Station",
  gs: null,
  heroCards: null,
  boardCards: [],
  allDealt: new Set(),
  pickerOpen: false,
  pickerTarget: "hero",
  pickerPicked: [],
  pickerRank: null,
  rec: null,
  handOver: false,
  handResult: "",
  raiseAmount: 0,
  betPadOpen: false,
  betPadAction: "bet",
  betPadSeat: 0,
  villainCards: null,
  trainingDeck: [],
  trainingBoardCards: [],
  seatTypes: new Map(),
  playerStats: new Map(),
  decisionLog: [],
  reviewOpen: false,
  message: "",
};

// ── Adaptive modeling: persist per-seat stats in localStorage ──
const STATS_KEY = "mce-player-stats";

function loadPlayerStats(): void {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, PlayerStats>;
      S.playerStats = new Map(Object.entries(obj).map(([k, v]) => [+k, v]));
    }
  } catch { /* ignore */ }
}

function savePlayerStats(): void {
  try {
    const obj: Record<string, PlayerStats> = {};
    for (const [k, v] of S.playerStats) obj[k] = v;
    localStorage.setItem(STATS_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

// Build per-seat blended profiles from the chosen archetype + observed stats.
function buildProfiles(): ProfileMap {
  const map: ProfileMap = new Map();
  const n = getPositions(S.tableSize).length;
  for (let i = 0; i < n; i++) {
    if (i === S.heroSeat) continue;
    const archName = S.seatTypes.get(i) ?? S.archetype;
    const prior = PROFILES[archName] ?? STATION;
    const stats = S.playerStats.get(i);
    map.set(i, stats ? blendProfile(prior, stats) : prior);
  }
  return map;
}

const $ = (s: string) => document.querySelector(s)!;
const app = document.getElementById("app")!;

function cardDisplay(c: Card): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}
function isRed(c: Card): boolean {
  return SUIT_RED[suitOf(c)]!;
}
function roundBet(bb: number): number {
  const unit = S.sbValue / S.bbValue;
  return Math.round(bb / unit) * unit;
}

function chips(bb: number): string {
  const v = bb * S.bbValue;
  if (v === 0) return "$0";
  return v % 1 === 0 ? `$${v}` : `$${v.toFixed(2)}`;
}

function chipsBet(bb: number): string {
  return chips(roundBet(bb));
}

function render(): void {
  if (S.screen === "setup") renderSetup();
  else if (S.screen === "stats") renderStats();
  else renderGame();
  if (S.pickerOpen) renderPicker();
  if (S.betPadOpen) renderBetPad();
}

/* ═══════════════════ SETUP ═══════════════════ */

function positionTip(pos: string): string {
  const t: Record<string, string> = {
    BTN: "Dealer — best position, acts last after the flop",
    SB: "Small Blind — forced half-bet, left of dealer",
    BB: "Big Blind — forced full bet, left of SB",
    UTG: "Under the Gun — first to act preflop",
    UTG1: "Early position — second to act",
    UTG2: "Early position — third to act",
    MP: "Middle Position", MP1: "Middle Position",
    HJ: "Hijack — two before dealer",
    CO: "Cutoff — one before dealer",
  };
  return t[pos] ?? pos;
}

const ARCH_DESC: Record<string, string> = {
  TAG: "Tight-Aggressive — plays few hands but bets hard. Toughest opponent.",
  LAG: "Loose-Aggressive — plays many hands aggressively. Lots of bluffs.",
  Station: "Calling Station — calls everything, rarely folds. Bet big for value.",
  Nit: "Nit — only plays premium hands (AA, KK, AK). Easy to steal from.",
};

function renderSetup(): void {
  const positions = getPositions(S.tableSize);
  app.innerHTML = `
    <div class="setup">
      <h1>MonteCarloEdge<small>Poker Decision Assistant</small></h1>

      <div class="help-banner" id="help-toggle">
        <span class="help-icon">?</span> How does this work?
      </div>
      <div class="help-body hidden" id="help-body">
        <p>This app tells you <strong>what to do</strong> at the poker table in real time.</p>
        <ol>
          <li>Set up your table below</li>
          <li>Pick your two hole cards when dealt</li>
          <li>Tap each opponent's action as it happens (fold / call / raise)</li>
          <li>When it's <strong>your turn</strong>, the app shows the recommended play with the math behind it</li>
          <li>After each betting round, tap the board to enter community cards</li>
        </ol>
      </div>

      <div class="field">
        <label>How many players?</label>
        <select id="tsize">
          ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
            `<option value="${n}" ${n === S.tableSize ? "selected" : ""}>${n === 2 ? "2 (Heads-Up)" : n + " players"}</option>`
          ).join("")}
        </select>
      </div>

      <div class="field">
        <label>Blinds</label>
        <span class="hint">Enter your table's small blind / big blind. All amounts will show in dollars.</span>
        <div class="blinds-row">
          <div class="blind-input-row">
            <span class="currency-sign">$</span>
            <input type="number" id="sb-input" value="${S.sbValue}" min="0.01" step="0.25" />
          </div>
          <span class="blind-slash">/</span>
          <div class="blind-input-row">
            <span class="currency-sign">$</span>
            <input type="number" id="bb-input" value="${S.bbValue}" min="0.01" step="0.25" />
          </div>
        </div>
        <span class="hint">${S.sbValue === S.bbValue ? "$" + S.sbValue + " / $" + S.bbValue + " (equal blinds)" : "$" + S.sbValue + " / $" + S.bbValue}</span>
      </div>

      <div class="field">
        <label>Starting chips per player</label>
        <span class="hint">In big blinds. If BB is $1 and everyone buys in for $100, enter 100.</span>
        <input type="number" id="stack" value="${S.stackBB}" min="10" max="500" />
        <span class="hint">= $${(S.stackBB * S.bbValue) % 1 === 0 ? S.stackBB * S.bbValue : (S.stackBB * S.bbValue).toFixed(2)} buy-in</span>
      </div>

      <div class="field">
        <label>Where are you sitting?</label>
        <span class="hint">Tap your seat. BTN (Dealer) is the best — you act last after the flop.</span>
        <div class="seat-ring">
          ${positions.map((p, i) =>
            `<button class="seat-btn ${i === S.heroSeat ? "selected" : ""}" data-seat="${i}" title="${positionTip(p)}">${p}</button>`
          ).join("")}
        </div>
        <span class="hint seat-tip">${positionTip(positions[S.heroSeat]!)}</span>
      </div>

      <div class="field">
        <label>What type of opponents?</label>
        <span class="hint">Pick the style that best matches the players at your table.</span>
        <select id="arch">
          ${Object.keys(PROFILES).map(k =>
            `<option value="${k}" ${k === S.archetype ? "selected" : ""}>${k}</option>`
          ).join("")}
        </select>
        <span class="hint arch-desc">${ARCH_DESC[S.archetype]}</span>
      </div>

      <button class="start-btn" id="start">DEAL HAND</button>
      <button class="start-btn" id="start-training" style="background:var(--blue);margin-top:8px">TRAINING MODE</button>
      <span class="hint" style="text-align:center">Training: practice against the AI. It deals cards, makes villain decisions, reveals hands at showdown.</span>
      <button class="hdr-btn" id="view-stats" style="width:100%;padding:12px;margin-top:4px;font-size:14px">Session Stats</button>
    </div>`;

  $("#help-toggle").addEventListener("click", () => {
    document.getElementById("help-body")?.classList.toggle("hidden");
  });
  $("#tsize").addEventListener("change", (e) => {
    S.tableSize = +(e.target as HTMLSelectElement).value;
    const max = getPositions(S.tableSize).length - 1;
    if (S.heroSeat > max) S.heroSeat = max;
    render();
  });
  $("#sb-input").addEventListener("change", (e) => {
    const v = +(e.target as HTMLInputElement).value;
    if (v > 0) { S.sbValue = v; render(); }
  });
  $("#bb-input").addEventListener("change", (e) => {
    const v = +(e.target as HTMLInputElement).value;
    if (v > 0) { S.bbValue = v; render(); }
  });
  $("#stack").addEventListener("change", (e) => {
    S.stackBB = Math.max(10, +(e.target as HTMLInputElement).value);
    render();
  });
  $("#arch").addEventListener("change", (e) => {
    S.archetype = (e.target as HTMLSelectElement).value;
    const d = document.querySelector(".arch-desc");
    if (d) d.textContent = ARCH_DESC[S.archetype] ?? "";
  });
  app.querySelectorAll(".seat-btn").forEach(btn =>
    btn.addEventListener("click", () => { S.heroSeat = +(btn as HTMLElement).dataset.seat!; render(); }),
  );
  $("#start").addEventListener("click", () => { S.mode = "live"; startHand(); });
  document.getElementById("start-training")?.addEventListener("click", () => { S.mode = "training"; startTrainingHand(); });
  document.getElementById("view-stats")?.addEventListener("click", () => {
    S.screen = "stats"; render();
  });
}

function startHand(): void {
  const n = getPositions(S.tableSize).length;
  if (S.dealerSeat < 0) {
    // First hand — set dealer based on table size
    S.dealerSeat = S.tableSize === 2 ? 0 : n - 3;
  }
  S.handNumber++;
  S.heroCards = null;
  S.boardCards = [];
  S.allDealt = new Set();
  S.gs = null;
  S.rec = null;
  S.handOver = false;
  S.handResult = "";
  S.raiseAmount = 0;
  S.decisionLog = [];
  S.reviewOpen = false;
  S.message = "Tap your cards to pick them";
  S.screen = "game";
  S.pickerTarget = "hero";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

function nextHand(): void {
  const n = getPositions(S.tableSize).length;
  S.dealerSeat = (S.dealerSeat + 1) % n;
  if (S.mode === "training") startTrainingHand();
  else startHand();
}

function shuffleDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < NUM_CARDS; i++) deck.push(i);
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i]!; deck[i] = deck[j]!; deck[j] = tmp;
  }
  return deck;
}

function startTrainingHand(): void {
  const n = getPositions(S.tableSize).length;
  if (S.dealerSeat < 0) {
    S.dealerSeat = S.tableSize === 2 ? 0 : n - 3;
  }
  S.handNumber++;

  // Shuffle and deal
  const deck = shuffleDeck();
  const heroCards: [Card, Card] = deck[0]! <= deck[1]! ? [deck[0]!, deck[1]!] : [deck[1]!, deck[0]!];
  const villCards: [Card, Card] = deck[2]! <= deck[3]! ? [deck[2]!, deck[3]!] : [deck[3]!, deck[2]!];
  const boardCards = [deck[4]!, deck[5]!, deck[6]!, deck[7]!, deck[8]!];

  S.heroCards = heroCards;
  S.villainCards = villCards;
  S.trainingBoardCards = boardCards;
  S.boardCards = [];
  S.allDealt = new Set([heroCards[0], heroCards[1], villCards[0], villCards[1], ...boardCards]);
  S.handOver = false;
  S.handResult = "";
  S.raiseAmount = 0;
  S.rec = null;
  S.decisionLog = [];
  S.reviewOpen = false;

  // Create game state
  const positions = getPositions(S.tableSize);
  S.gs = new GameState({
    tableSize: S.tableSize,
    bb: 1,
    sb: S.sbValue / S.bbValue,
    stacks: positions.map(() => S.stackBB),
    positions: [...positions],
    heroSeat: S.heroSeat,
    heroCards: heroCards,
    dealerSeat: S.dealerSeat,
  });

  S.screen = "game";
  S.pickerOpen = false;
  playSound("deal");
  updateRec();
  updateMessage();
  render();

  // If villain acts first, auto-play them
  autoPlayVillain();
}

/* ═══════════════════ GAME ═══════════════════ */

function initGameState(): void {
  if (!S.heroCards) return;
  const positions = getPositions(S.tableSize);
  S.gs = new GameState({
    tableSize: S.tableSize,
    bb: 1,
    sb: S.sbValue / S.bbValue,
    stacks: positions.map(() => S.stackBB),
    positions: [...positions],
    heroSeat: S.heroSeat,
    heroCards: S.heroCards,
    dealerSeat: S.dealerSeat,
  });
  updateRec();
  updateMessage();
}

function updateRec(): void {
  if (!S.gs || S.handOver) { S.rec = null; return; }
  if (S.gs.nextToAct() === S.heroSeat) {
    const prior = PROFILES[S.archetype] ?? STATION;
    S.rec = recommend(S.gs, prior, mulberry32(0xface), buildProfiles());
    if (S.rec.amount > 0) S.rec.amount = roundBet(S.rec.amount);
    S.raiseAmount = Math.max(
      S.gs.currentBet > 0 ? minRaise(S.gs.currentBet, S.gs.bb) : openRaiseSize(S.gs.bb),
      S.gs.toCall(S.heroSeat) + 1,
    );
  } else {
    S.rec = null;
  }
}

function updateMessage(): void {
  if (!S.gs) return;
  if (S.handOver) { S.message = "Hand complete — tap Next Hand"; return; }
  if (S.gs.roundComplete() && !S.gs.isComplete()) {
    const nm: Record<string, string> = { preflop: "flop (3 cards)", flop: "turn card", turn: "river card" };
    S.message = `Tap the board to deal the ${nm[S.gs.street] ?? "next"}`;
    return;
  }
  const n = S.gs.nextToAct();
  if (n === null) { S.message = ""; return; }
  const pos = S.gs.positions[n];
  S.message = n === S.heroSeat ? `Your turn (${pos})` : `${pos} to act — tap their action below`;
}

function seatCoord(seatIdx: number): { left: number; top: number } {
  const n = getPositions(S.tableSize).length;
  const vis = (seatIdx - S.heroSeat + n) % n;
  const a = (vis * 2 * Math.PI) / n;
  return { left: 50 - 40 * Math.sin(a), top: 50 + 35 * Math.cos(a) };
}

function renderGame(): void {
  if (!S.gs && !S.heroCards) {
    app.innerHTML = `<div class="game"><div class="status-bar">Picking cards...</div></div>`;
    return;
  }
  const gs = S.gs;
  const positions = getPositions(S.tableSize);
  const next = gs?.nextToAct() ?? null;
  const needsBoard = gs && gs.roundComplete() && !gs.isComplete() && !S.handOver;
  const isHeroTurn = next === S.heroSeat;

  // ── Table seats ──
  const seats = positions.map((pos, i) => {
    const { left, top } = seatCoord(i);
    const isHero = i === S.heroSeat;
    const isDealer = i === S.dealerSeat;
    const folded = gs?.folded[i] ?? false;
    const active = next === i;
    const lastAct = gs?.actions.filter(a => a.seat === i && a.street === gs.street).at(-1);
    const stack = gs ? gs.stacks[i]! + gs.streetInvested[i]! : S.stackBB;
    const cls = [
      "table-seat",
      isHero ? "hero-seat" : "",
      folded ? "folded" : "",
      active ? "active" : "",
    ].filter(Boolean).join(" ");

    let actText = "";
    if (lastAct) {
      if (lastAct.type === "raise" || lastAct.type === "bet")
        actText = `${lastAct.type} ${chipsBet(lastAct.amount)}`;
      else actText = lastAct.type;
    }

    return `<div class="${cls}" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%">
      ${isDealer ? '<div class="dealer-btn">D</div>' : ""}
      <div class="seat-chip">
        <div class="seat-pos">${isHero ? "YOU" : pos}</div>
        <div class="seat-stack">${chips(stack)}</div>
        ${actText ? `<div class="seat-act">${actText}</div>` : ""}
      </div>
    </div>`;
  }).join("");

  // ── Board ──
  const boardHtml = [0, 1, 2, 3, 4].map(i => {
    if (i < S.boardCards.length) {
      const c = S.boardCards[i]!;
      return `<div class="board-card dealt ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</div>`;
    }
    return `<div class="board-card empty"></div>`;
  }).join("");

  // ── Hero cards ──
  const heroHtml = S.heroCards
    ? S.heroCards.map(c =>
        `<div class="hero-card dealt ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</div>`
      ).join("")
    : `<div class="hero-card empty">?</div><div class="hero-card empty">?</div>`;

  // ── Hand strength label ──
  let handLabelHtml = "";
  if (S.heroCards && gs) {
    const d = describeHand(S.heroCards, gs.board);
    const draws = d.draws.length ? ` + ${d.draws.join(" + ")}` : "";
    handLabelHtml = `<div class="hand-label ${d.strong ? "strong" : ""}">${d.label}${draws}</div>`;
  }

  // ── Recommendation ──
  const recHtml = S.rec ? `
    <div class="rec-panel">
      <div class="rec-action">${S.rec.action}${S.rec.amount > 0 ? ` ${chipsBet(S.rec.amount)}` : ""}</div>
      <div class="rec-details">
        <span>Equity: <strong>${(S.rec.equity * 100).toFixed(0)}%</strong></span>
        ${S.rec.potOdds > 0 ? `<span>Odds: <strong>${(S.rec.potOdds * 100).toFixed(0)}%</strong></span>` : ""}
      </div>
      <div class="rec-reason">${S.rec.reasoning}</div>
    </div>` : "";

  // ── Actions ──
  const legal = gs && next !== null ? gs.legalActionsFor(next) : [];
  const showActions = gs && !S.handOver && next !== null && !needsBoard;

  // If there's a rec with amount, show it on the bet/raise button for one-tap action
  const recAmt = S.rec && S.rec.amount > 0 ? roundBet(S.rec.amount) : 0;
  const betLabel = recAmt > 0 && S.rec?.action === "bet" ? `Bet ${chipsBet(recAmt)}` : "Bet";
  const raiseLabel = recAmt > 0 && S.rec?.action === "raise" ? `Raise ${chipsBet(recAmt)}` : "Raise";

  const actionsHtml = showActions ? `
    <div class="action-bar">
      ${legal.includes("fold") ? `<button class="action-btn fold" data-act="fold">Fold</button>` : ""}
      ${legal.includes("check") ? `<button class="action-btn check" data-act="check">Check</button>` : ""}
      ${legal.includes("call") ? `<button class="action-btn call" data-act="call">Call ${chips(gs!.toCall(next!))}</button>` : ""}
      ${legal.includes("bet") ? `<button class="action-btn bet" data-open-bet="bet">${betLabel}</button>` : ""}
      ${legal.includes("raise") ? `<button class="action-btn raise" data-open-bet="raise">${raiseLabel}</button>` : ""}
    </div>` : "";

  app.innerHTML = `
    <div class="game">
      <div class="game-topbar">
        <span>Hand #${S.handNumber}${S.mode === "training" ? " · <strong style=\"color:var(--blue)\">TRAINING</strong>" : ""}</span>
        <button class="hdr-btn" id="new-hand">New Hand</button>
      </div>

      <div class="poker-table" id="poker-table">
        <div class="felt"></div>
        ${seats}
        <div class="table-info">
          <div class="table-pot">${gs ? chips(gs.pot) : "$0"}</div>
          <div class="table-street">${gs?.street ?? ""}</div>
        </div>
        <div class="board-center" id="board-area">${boardHtml}</div>
      </div>

      <div class="hero-area">
        <div class="hero-cards">${heroHtml}</div>
        ${handLabelHtml}
        ${recHtml}
      </div>

      ${S.handOver ? renderHandResult(positions) : actionsHtml}

      ${isHeroTurn && !S.handOver ? `<div class="status-bar"><strong>YOUR TURN</strong></div>` : ""}
    </div>`;

  // ── Events ──
  $("#new-hand")?.addEventListener("click", () => { S.screen = "setup"; S.dealerSeat = -1; S.handNumber = 0; render(); });
  document.getElementById("next-hand")?.addEventListener("click", nextHand);

  // Showdown winner buttons
  app.querySelectorAll("[data-winner]").forEach(btn =>
    btn.addEventListener("click", () => {
      const val = (btn as HTMLElement).dataset.winner!;
      let heroPnl: number;
      const invested = S.gs!.invested[S.heroSeat]!;
      if (val === "split") {
        S.handResult = `Split pot — ${chips(S.gs!.pot / 2)} each`;
        heroPnl = S.gs!.pot / 2 - invested;
      } else {
        const w = +val;
        const who = w === S.heroSeat ? "You" : S.gs!.positions[w]!;
        S.handResult = `${who} won ${chips(S.gs!.pot)}`;
        heroPnl = w === S.heroSeat ? S.gs!.pot - invested : -invested;
      }
      saveHandRecord(heroPnl);
      render();
    }),
  );

  app.querySelectorAll("[data-act]").forEach(btn =>
    btn.addEventListener("click", () => doAction(next!, (btn as HTMLElement).dataset.act as ActionType)),
  );
  app.querySelectorAll("[data-open-bet]").forEach(btn =>
    btn.addEventListener("click", () => {
      S.betPadAction = (btn as HTMLElement).dataset.openBet as "bet" | "raise";
      S.betPadSeat = next!;
      // Auto-fill with recommendation amount if available
      if (S.rec && S.rec.amount > 0 && (S.rec.action === "bet" || S.rec.action === "raise")) {
        S.raiseAmount = roundBet(S.rec.amount);
      } else {
        S.raiseAmount = roundBet(gs!.currentBet > 0
          ? minRaise(gs!.currentBet, gs!.bb)
          : openRaiseSize(gs!.bb));
      }
      S.betPadOpen = true;
      renderBetPad();
    }),
  );

  if (needsBoard) {
    document.getElementById("board-area")?.addEventListener("click", openBoardPicker);
  }
}

function doAction(seat: number, type: ActionType): void {
  if (!S.gs) return;
  const amount = type === "bet" || type === "raise" ? S.raiseAmount : 0;

  // Log hero's decision against the recommendation for post-hand review.
  if (seat === S.heroSeat && S.rec) {
    S.decisionLog.push({ street: S.gs.street, chosen: type, chosenAmt: amount, rec: S.rec });
  }

  playSound(type === "fold" ? "fold" : type === "check" ? "check"
    : type === "call" ? "bet" : "bet");

  S.gs.applyAction({ seat, type, amount });

  if (S.gs.activeSeatCount <= 1) {
    const winnerSeat = S.gs.folded.findIndex(f => !f);
    const winnerPos = winnerSeat === S.heroSeat ? "You" : S.gs.positions[winnerSeat]!;
    const folderPos = seat === S.heroSeat ? "You" : S.gs.positions[seat]!;
    S.handResult = `${folderPos} folded — ${winnerPos} won ${chips(S.gs.pot)}`;
    const heroPnl = winnerSeat === S.heroSeat
      ? S.gs.pot - S.gs.invested[S.heroSeat]!
      : -S.gs.invested[S.heroSeat]!;
    saveHandRecord(heroPnl);
    S.handOver = true; S.rec = null;
    updateMessage(); render();
    return;
  }

  // Training mode: let villain AI take over after hero acts
  if (S.mode === "training") {
    if (S.gs.isComplete() || (S.gs.roundComplete() && S.gs.street === "river")) {
      trainingShowdown(); return;
    }
    updateRec(); updateMessage(); render();
    autoPlayVillain();
    return;
  }

  // Live mode: check if hand is complete
  if (S.gs.isComplete() || (S.gs.roundComplete() && S.gs.street === "river")) {
    S.handResult = "showdown";
    S.handOver = true; S.rec = null; updateMessage(); render(); return;
  }

  // Check if all remaining players are all-in
  const anyCanAct = S.gs.stacks.some((s, i) => !S.gs!.folded[i] && s > 0);
  if (S.gs.roundComplete() && !anyCanAct) {
    S.pickerTarget = S.gs.street === "preflop" ? "flop" : S.gs.street === "flop" ? "turn" : "river";
    S.pickerPicked = [];
    S.pickerOpen = true;
    updateRec(); updateMessage(); render();
    return;
  }

  // Final catch-all: if hand is complete, go to showdown
  if (S.gs.isComplete() || (S.gs.roundComplete() && S.gs.street === "river")) {
    S.handResult = "showdown";
    S.handOver = true; S.rec = null; updateMessage(); render(); return;
  }

  updateRec(); updateMessage(); render();

  // Auto-open card picker when a street's action is done
  if (S.gs && S.gs.roundComplete() && !S.gs.isComplete() && !S.handOver) {
    openBoardPicker();
  }
}

function renderHandResult(positions: readonly string[]): string {
  if (!S.gs) return "";
  const pot = S.gs.pot;

  if (S.handResult === "showdown" && S.mode === "live") {
    // Live mode: ask who won
    const remaining = S.gs.folded
      .map((f, i) => f ? null : i)
      .filter((i): i is number => i !== null);

    return `
      <div class="result-panel">
        <div class="result-title">Showdown — ${chips(pot)} pot</div>
        <div class="result-question">Who won?</div>
        <div class="result-buttons">
          ${remaining.map(i =>
            `<button class="result-btn ${i === S.heroSeat ? "hero" : ""}" data-winner="${i}">
              ${i === S.heroSeat ? "You won" : positions[i] + " won"}
            </button>`
          ).join("")}
          <button class="result-btn split" data-winner="split">Split pot</button>
        </div>
      </div>`;
  }

  // Training showdown or fold — show villain cards + result
  const villainReveal = S.mode === "training" && S.villainCards && S.handOver
    ? `<div class="villain-reveal">
        <span class="hint">Opponent's hand:</span>
        <div class="hero-cards" style="margin-top:4px">
          <div class="hero-card dealt ${isRed(S.villainCards[0]) ? "red" : ""}" style="width:44px;height:60px;font-size:17px">${cardDisplay(S.villainCards[0])}</div>
          <div class="hero-card dealt ${isRed(S.villainCards[1]) ? "red" : ""}" style="width:44px;height:60px;font-size:17px">${cardDisplay(S.villainCards[1])}</div>
        </div>
      </div>`
    : "";

  return `
    <div class="result-panel">
      ${villainReveal}
      <div class="result-text">${S.handResult}</div>
      <div class="action-bar" style="margin-top:10px">
        <button class="action-btn raise" id="next-hand" style="font-size:16px;padding:16px">NEXT HAND</button>
      </div>
    </div>`;
}

function autoPlayVillain(): void {
  if (!S.gs || S.handOver || S.mode !== "training" || !S.villainCards) return;

  // Keep playing villain turns until it's hero's turn or hand is over
  const profile = PROFILES[S.archetype]!;
  const rng = () => Math.random();
  let safety = 20;

  while (safety-- > 0) {
    if (S.gs.activeSeatCount <= 1 || S.gs.isComplete()) break;

    // If round is complete, deal next street automatically
    if (S.gs.roundComplete() && !S.gs.isComplete()) {
      if (S.gs.street === "river") {
        // Go to showdown
        trainingShowdown();
        return;
      }
      // Check if anyone can act next street
      const anyCanAct = S.gs.stacks.some((s, i) => !S.gs!.folded[i] && s > 0);
      if (!anyCanAct) {
        // All-in — deal remaining board and showdown
        while (S.gs.street !== "river") {
          const cards = getNextBoardCards();
          S.boardCards.push(...cards);
          S.gs.advanceStreet(cards);
        }
        trainingShowdown();
        return;
      }
      const cards = getNextBoardCards();
      S.boardCards.push(...cards);
      S.gs.advanceStreet(cards);
    }

    const next = S.gs.nextToAct();
    if (next === null) break;
    if (next === S.heroSeat) break; // Hero's turn — stop and wait for input

    // Villain acts
    const vAct = villainAct(S.gs, next, S.villainCards, profile, rng);
    let action = vAct.type;
    let amount = vAct.amount;
    const legal = S.gs.legalActionsFor(next);

    if (action === "raise" && !legal.includes("raise")) {
      action = legal.includes("call") ? "call" : "check"; amount = 0;
    }
    if (action === "bet" && !legal.includes("bet")) { action = "check"; amount = 0; }
    if (action === "fold" && !legal.includes("fold")) { action = "check"; amount = 0; }

    S.gs.applyAction({ seat: next, type: action, amount });

    if (S.gs.activeSeatCount <= 1) {
      // Villain folded
      const winnerSeat = S.gs.folded.findIndex(f => !f);
      const winnerPos = winnerSeat === S.heroSeat ? "You" : S.gs.positions[winnerSeat]!;
      const folderPos = S.gs.positions[next]!;
      S.handResult = `${folderPos} folded — ${winnerPos} won ${chips(S.gs.pot)}`;
      const heroPnl = winnerSeat === S.heroSeat
        ? S.gs.pot - S.gs.invested[S.heroSeat]! : -S.gs.invested[S.heroSeat]!;
      saveHandRecord(heroPnl);
      S.handOver = true; S.rec = null;
      updateMessage(); render();
      return;
    }
  }

  // After loop: check if hand ended while villain was acting
  if (S.gs && (S.gs.isComplete() || (S.gs.roundComplete() && S.gs.street === "river"))) {
    trainingShowdown();
    return;
  }

  updateRec(); updateMessage(); render();
  if (S.gs && S.gs.nextToAct() === S.heroSeat && !S.handOver) playSound("turn");
}

function getNextBoardCards(): Card[] {
  if (!S.gs) return [];
  const street = S.gs.street;
  if (street === "preflop") return [S.trainingBoardCards[0]!, S.trainingBoardCards[1]!, S.trainingBoardCards[2]!];
  if (street === "flop") return [S.trainingBoardCards[3]!];
  if (street === "turn") return [S.trainingBoardCards[4]!];
  return [];
}

function trainingShowdown(): void {
  if (!S.gs || !S.heroCards || !S.villainCards) return;
  // Make sure full board is dealt
  while (S.boardCards.length < 5) {
    const cards = getNextBoardCards();
    if (cards.length === 0) break;
    S.boardCards.push(...cards);
    if (S.gs.street !== "river") S.gs.advanceStreet(cards);
  }

  const board5 = S.boardCards.slice(0, 5);
  const heroRank = evaluate([S.heroCards[0], S.heroCards[1], ...board5]);
  const villRank = evaluate([S.villainCards[0], S.villainCards[1], ...board5]);

  const invested = S.gs.invested[S.heroSeat]!;
  let heroPnl: number;
  const villPos = S.gs.positions.find((_, i) => i !== S.heroSeat && !S.gs!.folded[i]) ?? "Villain";

  if (heroRank > villRank) {
    S.handResult = `You won ${chips(S.gs.pot)} at showdown`;
    heroPnl = S.gs.pot - invested;
  } else if (heroRank === villRank) {
    S.handResult = `Split pot — ${chips(S.gs.pot / 2)} each`;
    heroPnl = S.gs.pot / 2 - invested;
  } else {
    S.handResult = `${villPos} won ${chips(S.gs.pot)} at showdown`;
    heroPnl = -invested;
  }

  saveHandRecord(heroPnl);
  S.handOver = true; S.rec = null;
  updateMessage(); render();
}

function saveHandRecord(heroPnl: number): void {
  if (!S.gs || !S.heroCards) return;

  // Adaptive modeling: fold villain actions from this hand into their stats.
  const n = getPositions(S.tableSize).length;
  for (let i = 0; i < n; i++) {
    if (i === S.heroSeat) continue;
    // Only observe seats that were actually dealt in (acted or posted).
    const dealtIn = S.gs.actions.some(a => a.seat === i) || !S.gs.folded[i] || S.gs.invested[i]! > 0;
    if (!dealtIn) continue;
    const prev = S.playerStats.get(i) ?? emptyStats();
    S.playerStats.set(i, observeHand(prev, S.gs, i));
  }
  savePlayerStats();

  // Win/lose sound.
  playSound(heroPnl > 0 ? "win" : heroPnl < 0 ? "lose" : "check");

  saveHand({
    timestamp: Date.now(),
    tableSize: S.tableSize,
    heroSeat: S.heroSeat,
    heroCards: S.heroCards,
    boardCards: [...S.boardCards],
    actions: [...S.gs.actions],
    pot: S.gs.pot * S.bbValue,
    result: S.handResult,
    heroPnl: heroPnl * S.bbValue,
    bbValue: S.bbValue,
    sbValue: S.sbValue,
    dealerSeat: S.dealerSeat,
  }).catch(() => {});
}

function openBoardPicker(): void {
  if (!S.gs) return;
  const nm: Record<string, "flop" | "turn" | "river"> = { preflop: "flop", flop: "turn", turn: "river" };
  S.pickerTarget = nm[S.gs.street] ?? "flop";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

/* ═══════════════════ CARD PICKER (rank → suit) ═══════════════════ */

function renderPicker(): void {
  document.getElementById("picker-modal")?.remove();

  const needed = S.pickerTarget === "hero" ? 2 : S.pickerTarget === "flop" ? 3 : 1;
  const title = S.pickerTarget === "hero" ? "Pick your hole cards"
    : S.pickerTarget === "flop" ? "Deal the flop"
    : S.pickerTarget === "turn" ? "Deal the turn" : "Deal the river";

  const pickedDisp = S.pickerPicked.map(c =>
    `<span class="picked-tag ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</span>`
  ).join("");

  let body: string;

  if (S.pickerRank === null) {
    // Step 1: pick a rank
    body = `
      <div class="pick-label">Select rank</div>
      <div class="rank-grid">
        ${Array.from({ length: 13 }, (_, r) => {
          const allUsed = [0,1,2,3].every(s => S.allDealt.has(makeCard(r, s)));
          return `<button class="rank-btn ${allUsed ? "used" : ""}" data-rank="${r}">${RANKS[r]}</button>`;
        }).join("")}
      </div>`;
  } else {
    // Step 2: pick a suit
    const r = S.pickerRank;
    body = `
      <div class="pick-label">Pick suit for ${RANKS[r]}</div>
      <div class="suit-grid">
        ${[0,1,2,3].map(s => {
          const card = makeCard(r, s);
          const used = S.allDealt.has(card) || S.pickerPicked.includes(card);
          const red = SUIT_RED[s] ? "red" : "";
          return `<button class="suit-btn ${red} ${used ? "used" : ""}" data-suit="${s}">${SUITS[s]}</button>`;
        }).join("")}
      </div>
      <button class="back-btn" id="pick-back">Back to ranks</button>`;
  }

  const canConfirm = S.pickerPicked.length === needed;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "picker-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${title} (${S.pickerPicked.length}/${needed})</h3>
      ${pickedDisp ? `<div class="picked-row">${pickedDisp}</div>` : ""}
      ${body}
      <div class="modal-actions">
        <button class="cancel-btn" id="picker-cancel">Cancel</button>
        <button class="confirm-btn" id="picker-confirm" ${canConfirm ? "" : "disabled"}>Confirm</button>
      </div>
    </div>`;

  app.appendChild(overlay);

  // Rank buttons
  overlay.querySelectorAll(".rank-btn:not(.used)").forEach(btn =>
    btn.addEventListener("click", () => {
      S.pickerRank = +(btn as HTMLElement).dataset.rank!;
      document.getElementById("picker-modal")?.remove();
      renderPicker();
    }),
  );

  // Suit buttons
  overlay.querySelectorAll(".suit-btn:not(.used)").forEach(btn =>
    btn.addEventListener("click", () => {
      const card = makeCard(S.pickerRank!, +(btn as HTMLElement).dataset.suit!);
      S.pickerPicked.push(card);
      S.pickerRank = null;
      // Auto-confirm if we have enough cards
      if (S.pickerPicked.length === needed) {
        confirmPicker();
        return;
      }
      document.getElementById("picker-modal")?.remove();
      renderPicker();
    }),
  );

  document.getElementById("pick-back")?.addEventListener("click", () => {
    S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    renderPicker();
  });

  document.getElementById("picker-cancel")?.addEventListener("click", () => {
    S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    if (!S.heroCards) { S.screen = "setup"; render(); }
  });

  document.getElementById("picker-confirm")?.addEventListener("click", confirmPicker);
}

function confirmPicker(): void {
  const needed = S.pickerTarget === "hero" ? 2 : S.pickerTarget === "flop" ? 3 : 1;
  if (S.pickerPicked.length !== needed) return;

  if (S.pickerTarget === "hero") {
    const [a, b] = S.pickerPicked;
    S.heroCards = a! <= b! ? [a!, b!] : [b!, a!];
    S.allDealt.add(a!); S.allDealt.add(b!);
    playSound("deal");
    initGameState();
  } else {
    for (const c of S.pickerPicked) { S.boardCards.push(c); S.allDealt.add(c); }
    if (S.gs) { S.gs.advanceStreet(S.pickerPicked); updateRec(); updateMessage(); }
    playSound("card");
  }
  S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
  document.getElementById("picker-modal")?.remove();
  render();
}

/* ═══════════════════ BET PAD ═══════════════════ */

function renderBetPad(): void {
  document.getElementById("betpad-modal")?.remove();

  const gs = S.gs!;
  const seat = S.betPadSeat;
  const maxBB = roundBet(gs.stacks[seat]! + gs.streetInvested[seat]!);
  const minBB = roundBet(Math.max(
    gs.currentBet > 0 ? minRaise(gs.currentBet, gs.bb) : openRaiseSize(gs.bb),
    (gs.toCall(seat) || 0) + 1,
  ));
  const potBB = gs.pot;

  const display = S.raiseAmount > 0 ? chipsBet(S.raiseAmount) : "$0";
  const label = S.betPadAction === "raise" ? "Raise to" : "Bet";
  const needsDecimals = S.sbValue % 1 !== 0;

  const presets = [
    { label: "Min", bb: minBB },
    { label: "½ Pot", bb: roundBet(Math.max(minBB, potBB * 0.5)) },
    { label: "Pot", bb: roundBet(Math.max(minBB, potBB)) },
    { label: "All-in", bb: maxBB },
  ];

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "betpad-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${label}</h3>
      <div class="betpad-display" id="bp-display">${display}</div>
      <div class="betpad-presets">
        ${presets.map(p => `<button class="preset-btn" data-bb="${p.bb}">${p.label}<br><span>${chipsBet(p.bb)}</span></button>`).join("")}
      </div>
      <div class="betpad-grid">
        ${["1","2","3","4","5","6","7","8","9", needsDecimals ? "." : "","0","⌫"].map(k =>
          k ? `<button class="numpad-btn" data-key="${k}">${k}</button>` : `<div></div>`
        ).join("")}
      </div>
      <div class="modal-actions">
        <button class="cancel-btn" id="bp-cancel">Cancel</button>
        <button class="confirm-btn" id="bp-confirm">Confirm</button>
      </div>
    </div>`;

  app.appendChild(overlay);

  let raw = S.raiseAmount > 0 ? String(roundBet(S.raiseAmount) * S.bbValue) : "";

  function updateDisplay() {
    const dollars = parseFloat(raw) || 0;
    S.raiseAmount = roundBet(dollars / S.bbValue);
    const el = document.getElementById("bp-display");
    if (el) el.textContent = raw ? `$${raw}` : "$0";
  }

  overlay.querySelectorAll(".numpad-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const k = (btn as HTMLElement).dataset.key!;
      if (k === "⌫") { raw = raw.slice(0, -1); }
      else if (k === ".") { if (!raw.includes(".")) raw += "."; }
      else { raw += k; }
      updateDisplay();
    }),
  );

  overlay.querySelectorAll(".preset-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const bb = roundBet(+(btn as HTMLElement).dataset.bb!);
      S.raiseAmount = bb;
      const dollars = bb * S.bbValue;
      raw = dollars % 1 === 0 ? String(dollars) : dollars.toFixed(2);
      updateDisplay();
    }),
  );

  document.getElementById("bp-cancel")?.addEventListener("click", () => {
    S.betPadOpen = false;
    document.getElementById("betpad-modal")?.remove();
  });

  document.getElementById("bp-confirm")?.addEventListener("click", () => {
    let bb = roundBet(S.raiseAmount);
    if (bb < minBB) bb = minBB;
    if (bb > maxBB) bb = maxBB;
    S.raiseAmount = bb;
    S.betPadOpen = false;
    document.getElementById("betpad-modal")?.remove();
    doAction(seat, S.betPadAction);
  });
}

/* ═══════════════════ STATS SCREEN ═══════════════════ */

async function renderStats(): Promise<void> {
  const hands = await getSessionHands(S.sessionStart);
  const allHands = await getSessionHands();
  const stats = computeStats(hands);
  const allStats = computeStats(allHands);

  const fmt = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
  const pnlColor = (v: number) => v >= 0 ? "var(--green)" : "var(--red)";

  // Mini P&L chart using simple bars
  const history = stats.pnlHistory;
  const maxAbs = Math.max(1, ...history.map(Math.abs));
  const chartBars = history.map((v, i) =>
    `<div class="chart-bar" style="height:${Math.abs(v) / maxAbs * 40}px;background:${v >= 0 ? "var(--green)" : "var(--red)"}"></div>`
  ).join("");

  app.innerHTML = `
    <div class="setup">
      <h1>Session Stats</h1>

      <div class="stats-card">
        <div class="stat-big" style="color:${pnlColor(stats.totalPnl)}">
          ${fmt(stats.totalPnl)}
        </div>
        <div class="stat-label">This Session P&L</div>
      </div>

      <div class="stats-row">
        <div class="stats-card small">
          <div class="stat-num">${stats.hands}</div>
          <div class="stat-label">Hands</div>
        </div>
        <div class="stats-card small">
          <div class="stat-num">${stats.wins}</div>
          <div class="stat-label">Wins</div>
        </div>
        <div class="stats-card small">
          <div class="stat-num">${stats.losses}</div>
          <div class="stat-label">Losses</div>
        </div>
      </div>

      ${stats.hands > 0 ? `
      <div class="stats-row">
        <div class="stats-card small">
          <div class="stat-num" style="color:var(--green)">${fmt(stats.biggestWin)}</div>
          <div class="stat-label">Biggest Win</div>
        </div>
        <div class="stats-card small">
          <div class="stat-num" style="color:var(--red)">${fmt(stats.biggestLoss)}</div>
          <div class="stat-label">Biggest Loss</div>
        </div>
      </div>

      <div class="stats-card">
        <div class="stat-label" style="margin-bottom:8px">P&L Over Hands</div>
        <div class="chart-row">${chartBars}</div>
      </div>` : ""}

      ${allHands.length > hands.length ? `
      <div class="stats-card">
        <div class="stat-label">All Time: ${allStats.hands} hands, ${fmt(allStats.totalPnl)}</div>
      </div>` : ""}

      <button class="start-btn" id="back-setup">Back to Table</button>
      ${allHands.length > 0 ? `<button class="hdr-btn" id="clear-hist" style="width:100%;padding:12px;margin-top:4px;font-size:13px;color:var(--red)">Clear All History</button>` : ""}
    </div>`;

  document.getElementById("back-setup")?.addEventListener("click", () => {
    S.screen = "setup"; render();
  });
  document.getElementById("clear-hist")?.addEventListener("click", () => {
    if (confirm("Clear all hand history?")) {
      clearHistory().then(() => { S.sessionStart = Date.now(); render(); });
    }
  });
}

/* ═══════════════════ INIT ═══════════════════ */

loadPlayerStats();
render();
