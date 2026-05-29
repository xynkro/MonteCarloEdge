import { type Card, rankOf, suitOf, makeCard, NUM_CARDS, cardToString } from "../engine/cards.js";
import { type Combo } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType, type ActionInput } from "../engine/game-state.js";
import { getPositions } from "../engine/charts/index.js";
import { recommend, type Recommendation } from "../engine/decision.js";
import { TAG, LAG, STATION, NIT, type OpponentProfile } from "../engine/opponent.js";
import { openRaiseSize, threeBetSize, minRaise } from "../engine/sizing.js";

const RANKS = "23456789TJQKA";
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_RED = [false, true, true, false];
const PROFILES: Record<string, OpponentProfile> = { TAG, LAG, Station: STATION, Nit: NIT };

interface AppState {
  screen: "setup" | "game";
  tableSize: number;
  stackBB: number;
  heroSeat: number;
  archetype: string;
  gs: GameState | null;
  heroCards: [Card, Card] | null;
  boardCards: Card[];
  allDealt: Set<number>;
  pickerOpen: boolean;
  pickerTarget: "hero" | "flop" | "turn" | "river";
  pickerPicked: Card[];
  rec: Recommendation | null;
  handOver: boolean;
  raiseAmount: number;
  message: string;
}

const S: AppState = {
  screen: "setup",
  tableSize: 6,
  stackBB: 100,
  heroSeat: 3,
  archetype: "TAG",
  gs: null,
  heroCards: null,
  boardCards: [],
  allDealt: new Set(),
  pickerOpen: false,
  pickerTarget: "hero",
  pickerPicked: [],
  rec: null,
  handOver: false,
  raiseAmount: 0,
  message: "",
};

const $ = (s: string) => document.querySelector(s)!;
const app = document.getElementById("app")!;

function cardDisplay(c: Card): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}

function isRed(c: Card): boolean {
  return SUIT_RED[suitOf(c)]!;
}

function render(): void {
  if (S.screen === "setup") renderSetup();
  else renderGame();
  if (S.pickerOpen) renderPicker();
}

/* ═══════════════════ SETUP ═══════════════════ */

function renderSetup(): void {
  const positions = getPositions(S.tableSize);
  app.innerHTML = `
    <div class="setup">
      <h1>MonteCarloEdge<small>Poker Decision Assistant</small></h1>

      <div class="field">
        <label>Table Size</label>
        <select id="tsize">
          ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
            `<option value="${n}" ${n === S.tableSize ? "selected" : ""}>${n === 2 ? "Heads-Up" : n + "-max"}</option>`
          ).join("")}
        </select>
      </div>

      <div class="field">
        <label>Stack Depth (bb)</label>
        <input type="number" id="stack" value="${S.stackBB}" min="10" max="500" />
      </div>

      <div class="field">
        <label>Your Seat (tap to select)</label>
        <div class="seat-ring">
          ${positions.map((p, i) =>
            `<button class="seat-btn ${i === S.heroSeat ? "selected" : ""}" data-seat="${i}">${p}</button>`
          ).join("")}
        </div>
      </div>

      <div class="field">
        <label>Opponent Type</label>
        <select id="arch">
          ${Object.keys(PROFILES).map(k =>
            `<option value="${k}" ${k === S.archetype ? "selected" : ""}>${k}</option>`
          ).join("")}
        </select>
      </div>

      <button class="start-btn" id="start">DEAL HAND</button>
    </div>`;

  $("#tsize").addEventListener("change", (e) => {
    S.tableSize = +(e.target as HTMLSelectElement).value;
    const maxSeat = getPositions(S.tableSize).length - 1;
    if (S.heroSeat > maxSeat) S.heroSeat = maxSeat;
    render();
  });
  $("#stack").addEventListener("change", (e) => {
    S.stackBB = Math.max(10, +(e.target as HTMLInputElement).value);
  });
  $("#arch").addEventListener("change", (e) => {
    S.archetype = (e.target as HTMLSelectElement).value;
  });

  app.querySelectorAll(".seat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      S.heroSeat = +(btn as HTMLElement).dataset.seat!;
      render();
    });
  });

  $("#start").addEventListener("click", startHand);
}

function startHand(): void {
  S.heroCards = null;
  S.boardCards = [];
  S.allDealt = new Set();
  S.gs = null;
  S.rec = null;
  S.handOver = false;
  S.raiseAmount = 0;
  S.message = "Tap your cards to pick them";
  S.screen = "game";
  S.pickerTarget = "hero";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

/* ═══════════════════ GAME ═══════════════════ */

function initGameState(): void {
  if (!S.heroCards) return;
  const positions = getPositions(S.tableSize);
  const stacks = positions.map(() => S.stackBB);
  S.gs = new GameState({
    tableSize: S.tableSize,
    bb: 1,
    stacks,
    positions: [...positions],
    heroSeat: S.heroSeat,
    heroCards: S.heroCards,
    dealerSeat: S.tableSize === 2 ? 0 : positions.length - 3,
  });
  updateRec();
  updateMessage();
}

function updateRec(): void {
  if (!S.gs || S.handOver) { S.rec = null; return; }
  const next = S.gs.nextToAct();
  if (next === S.heroSeat) {
    S.rec = recommend(S.gs, PROFILES[S.archetype], mulberry32(0xface));
    S.raiseAmount = Math.max(
      S.gs.currentBet > 0 ? minRaise(S.gs.currentBet, S.gs.bb) : openRaiseSize(S.gs.bb),
      S.gs.toCall(S.heroSeat) + 1
    );
  } else {
    S.rec = null;
  }
}

function updateMessage(): void {
  if (!S.gs) return;
  if (S.handOver) {
    S.message = "Hand complete — tap New Hand";
    return;
  }
  if (S.gs.roundComplete() && !S.gs.isComplete()) {
    const streetNames: Record<string, string> = { preflop: "flop (3 cards)", flop: "turn card", turn: "river card" };
    S.message = `Tap board to deal ${streetNames[S.gs.street] ?? "next street"}`;
    return;
  }
  const next = S.gs.nextToAct();
  if (next === null) { S.message = ""; return; }
  const pos = S.gs.positions[next];
  if (next === S.heroSeat) {
    S.message = `Your turn (${pos})`;
  } else {
    S.message = `${pos} to act — tap their action`;
  }
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

  const opps = positions.map((pos, i) => {
    if (i === S.heroSeat) return "";
    const folded = gs?.folded[i] ?? false;
    const isActive = next === i;
    const acted = gs ? gs.actions.some(a => a.seat === i && a.street === gs.street) : false;
    const lastAct = gs?.actions.filter(a => a.seat === i && a.street === gs.street).at(-1);
    const stack = gs ? (gs.stacks[i]! + gs.streetInvested[i]!).toFixed(1) : S.stackBB.toString();
    const cls = folded ? "folded" : isActive ? "active" : acted ? "acted" : "";
    const actLabel = lastAct
      ? lastAct.type === "raise" || lastAct.type === "bet"
        ? `${lastAct.type} ${lastAct.amount.toFixed(1)}`
        : lastAct.type
      : "";

    return `<div class="opp-seat ${cls}" data-seat="${i}">
      <div class="pos">${pos}</div>
      <div class="stack">${stack}bb</div>
      ${actLabel ? `<div class="action-label">${actLabel}</div>` : ""}
    </div>`;
  }).join("");

  const boardSlots = [0, 1, 2, 3, 4].map(i => {
    if (i < S.boardCards.length) {
      const c = S.boardCards[i]!;
      return `<div class="board-slot dealt ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</div>`;
    }
    const clickable = needsBoard ? "" : "";
    return `<div class="board-slot" id="board-tap">${i < 3 ? "+" : "+"}</div>`;
  }).join("");

  const heroCardHtml = S.heroCards
    ? S.heroCards.map(c =>
        `<div class="hero-card dealt ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</div>`
      ).join("")
    : `<div class="hero-card empty" id="pick-hero">?</div><div class="hero-card empty" id="pick-hero2">?</div>`;

  const recHtml = S.rec ? `
    <div class="rec-panel">
      <div class="rec-action">${S.rec.action}${S.rec.amount > 0 ? ` ${S.rec.amount.toFixed(1)}bb` : ""}</div>
      <div class="rec-details">
        <span>Equity: <strong>${(S.rec.equity * 100).toFixed(0)}%</strong></span>
        ${S.rec.potOdds > 0 ? `<span>Odds: <strong>${(S.rec.potOdds * 100).toFixed(0)}%</strong></span>` : ""}
      </div>
      <div class="rec-reason">${S.rec.reasoning}</div>
    </div>` : "";

  const legal = gs && next !== null ? gs.legalActionsFor(next) : [];
  const isHeroTurn = next === S.heroSeat;
  const showActions = gs && !S.handOver && next !== null && !needsBoard;

  const maxRaise = gs ? gs.stacks[next ?? 0]! + gs.streetInvested[next ?? 0]! : 0;
  const minR = gs ? Math.max(
    gs.currentBet > 0 ? minRaise(gs.currentBet, gs.bb) : openRaiseSize(gs.bb),
    (gs.toCall(next ?? 0) || 0) + 1
  ) : 2;

  const actionHtml = showActions ? `
    ${legal.includes("raise") || legal.includes("bet") ? `
      <div class="raise-row">
        <input type="range" id="raise-slider" min="${minR}" max="${maxRaise}" step="0.5" value="${S.raiseAmount}" />
        <span class="raise-val" id="raise-val">${S.raiseAmount.toFixed(1)}</span>
      </div>` : ""}
    <div class="action-bar">
      ${legal.includes("fold") ? `<button class="action-btn fold" data-act="fold">Fold</button>` : ""}
      ${legal.includes("check") ? `<button class="action-btn check" data-act="check">Check</button>` : ""}
      ${legal.includes("call") ? `<button class="action-btn call" data-act="call">Call${gs ? " " + gs.toCall(next!).toFixed(1) : ""}</button>` : ""}
      ${legal.includes("bet") ? `<button class="action-btn bet" data-act="bet">Bet</button>` : ""}
      ${legal.includes("raise") ? `<button class="action-btn raise" data-act="raise">Raise</button>` : ""}
    </div>` : "";

  app.innerHTML = `
    <div class="game">
      <div class="game-header">
        <span class="pot">Pot: ${gs ? gs.pot.toFixed(1) : "0"}bb</span>
        <span class="street-badge">${gs?.street ?? "setup"}</span>
        <button class="new-hand-btn" style="padding:6px 12px;margin:0;width:auto;font-size:12px" id="new-hand">New Hand</button>
      </div>

      <div class="table-area">
        <div class="opponents">${opps}</div>
        <div class="board-area" id="board-area">${boardSlots}</div>
      </div>

      <div class="hero-area">
        <div class="hero-cards">${heroCardHtml}</div>
        ${recHtml}
      </div>

      ${actionHtml}

      <div class="status-bar">${S.message}${isHeroTurn ? " — <strong>YOUR TURN</strong>" : ""}</div>
    </div>`;

  // Event listeners
  $("#new-hand")?.addEventListener("click", () => { S.screen = "setup"; render(); });

  app.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const act = (btn as HTMLElement).dataset.act as ActionType;
      doAction(next!, act);
    });
  });

  const slider = document.getElementById("raise-slider") as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener("input", () => {
      S.raiseAmount = +slider.value;
      const valEl = document.getElementById("raise-val");
      if (valEl) valEl.textContent = S.raiseAmount.toFixed(1);
    });
  }

  if (needsBoard) {
    document.getElementById("board-area")?.addEventListener("click", () => {
      openBoardPicker();
    });
  }

  app.querySelectorAll(".opp-seat").forEach(el => {
    el.addEventListener("click", () => {
      const seat = +(el as HTMLElement).dataset.seat!;
      if (seat === next && !isHeroTurn) {
        // tapping active opponent — could show quick action menu
      }
    });
  });
}

function doAction(seat: number, type: ActionType): void {
  if (!S.gs) return;
  let amount = 0;
  if (type === "bet" || type === "raise") {
    amount = S.raiseAmount;
  }
  S.gs.applyAction({ seat, type, amount });

  if (S.gs.activeSeatCount <= 1) {
    S.handOver = true;
    S.rec = null;
    updateMessage();
    render();
    return;
  }

  if (S.gs.roundComplete()) {
    if (S.gs.street === "river") {
      S.handOver = true;
      S.rec = null;
    }
  }

  updateRec();
  updateMessage();
  render();
}

function openBoardPicker(): void {
  if (!S.gs) return;
  const street = S.gs.street;
  const nextStreet: Record<string, "flop" | "turn" | "river"> = {
    preflop: "flop", flop: "turn", turn: "river",
  };
  S.pickerTarget = nextStreet[street] ?? "flop";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

/* ═══════════════════ CARD PICKER ═══════════════════ */

function renderPicker(): void {
  const needed = S.pickerTarget === "hero" ? 2 : S.pickerTarget === "flop" ? 3 : 1;
  const title = S.pickerTarget === "hero"
    ? "Pick your 2 hole cards"
    : S.pickerTarget === "flop"
      ? "Deal the flop (3 cards)"
      : S.pickerTarget === "turn"
        ? "Deal the turn"
        : "Deal the river";

  const grid = [0, 1, 2, 3].map(suit => {
    return Array.from({ length: 13 }, (_, rank) => {
      const card = makeCard(rank, suit);
      const used = S.allDealt.has(card);
      const picked = S.pickerPicked.includes(card);
      const cls = used ? "used" : picked ? "picked" : "";
      const red = SUIT_RED[suit] ? "red" : "";
      return `<div class="card-cell ${cls} ${red}" data-card="${card}">${RANKS[rank]}${SUITS[suit]}</div>`;
    }).join("");
  }).join("");

  const pickedCount = S.pickerPicked.length;
  const canConfirm = pickedCount === needed;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "picker-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${title} (${pickedCount}/${needed})</h3>
      <div class="card-grid">${grid}</div>
      <div class="modal-actions">
        <button class="cancel-btn" id="picker-cancel">Cancel</button>
        <button class="confirm-btn" id="picker-confirm" ${canConfirm ? "" : "disabled"}>Confirm</button>
      </div>
    </div>`;

  app.appendChild(overlay);

  overlay.querySelectorAll(".card-cell:not(.used)").forEach(cell => {
    cell.addEventListener("click", () => {
      const card = +(cell as HTMLElement).dataset.card!;
      const idx = S.pickerPicked.indexOf(card);
      if (idx >= 0) {
        S.pickerPicked.splice(idx, 1);
      } else if (S.pickerPicked.length < needed) {
        S.pickerPicked.push(card);
      }
      // Re-render picker
      document.getElementById("picker-modal")?.remove();
      renderPicker();
    });
  });

  document.getElementById("picker-cancel")?.addEventListener("click", () => {
    S.pickerOpen = false;
    S.pickerPicked = [];
    document.getElementById("picker-modal")?.remove();
    if (!S.heroCards) { S.screen = "setup"; render(); }
  });

  document.getElementById("picker-confirm")?.addEventListener("click", () => {
    if (S.pickerTarget === "hero") {
      const [a, b] = S.pickerPicked;
      S.heroCards = a! <= b! ? [a!, b!] : [b!, a!];
      S.allDealt.add(a!);
      S.allDealt.add(b!);
      initGameState();
    } else {
      for (const c of S.pickerPicked) {
        S.boardCards.push(c);
        S.allDealt.add(c);
      }
      if (S.gs) {
        S.gs.advanceStreet(S.pickerPicked);
        updateRec();
        updateMessage();
      }
    }
    S.pickerOpen = false;
    S.pickerPicked = [];
    document.getElementById("picker-modal")?.remove();
    render();
  });
}

/* ═══════════════════ INIT ═══════════════════ */

render();
