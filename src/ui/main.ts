import { type Card, rankOf, suitOf, makeCard, NUM_CARDS } from "../engine/cards.js";
import { type Combo } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { getPositions } from "../engine/charts/index.js";
import { recommend, type Recommendation } from "../engine/decision.js";
import { TAG, LAG, STATION, NIT, type OpponentProfile } from "../engine/opponent.js";
import { openRaiseSize, minRaise } from "../engine/sizing.js";

const RANKS = "23456789TJQKA";
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_RED = [false, true, true, false];
const PROFILES: Record<string, OpponentProfile> = { TAG, LAG, Station: STATION, Nit: NIT };

interface AppState {
  screen: "setup" | "game";
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
  rec: Recommendation | null;
  handOver: boolean;
  raiseAmount: number;
  message: string;
}

const S: AppState = {
  screen: "setup",
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
function chips(bb: number): string {
  const v = bb * S.bbValue;
  if (v === 0) return "$0";
  return v % 1 === 0 ? `$${v}` : `$${v.toFixed(2)}`;
}

function render(): void {
  if (S.screen === "setup") renderSetup();
  else renderGame();
  if (S.pickerOpen) renderPicker();
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
  $("#start").addEventListener("click", startHand);
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
  S.raiseAmount = 0;
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
  startHand();
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
    S.rec = recommend(S.gs, PROFILES[S.archetype], mulberry32(0xface));
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
        actText = `${lastAct.type} ${chips(lastAct.amount)}`;
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

  // ── Recommendation ──
  const recHtml = S.rec ? `
    <div class="rec-panel">
      <div class="rec-action">${S.rec.action}${S.rec.amount > 0 ? ` ${chips(S.rec.amount)}` : ""}</div>
      <div class="rec-details">
        <span>Equity: <strong>${(S.rec.equity * 100).toFixed(0)}%</strong></span>
        ${S.rec.potOdds > 0 ? `<span>Odds: <strong>${(S.rec.potOdds * 100).toFixed(0)}%</strong></span>` : ""}
      </div>
      <div class="rec-reason">${S.rec.reasoning}</div>
    </div>` : "";

  // ── Actions ──
  const legal = gs && next !== null ? gs.legalActionsFor(next) : [];
  const showActions = gs && !S.handOver && next !== null && !needsBoard;
  const maxR = gs && next !== null ? gs.stacks[next]! + gs.streetInvested[next]! : 0;
  const minR = gs ? Math.max(
    gs.currentBet > 0 ? minRaise(gs.currentBet, gs.bb) : openRaiseSize(gs.bb),
    (gs.toCall(next ?? 0) || 0) + 1,
  ) : 2;

  const actionsHtml = showActions ? `
    ${legal.includes("raise") || legal.includes("bet") ? `
    <div class="raise-row">
      <input type="range" id="raise-slider" min="${minR}" max="${maxR}" step="0.5" value="${S.raiseAmount}" />
      <span class="raise-val" id="raise-val">${chips(S.raiseAmount)}</span>
    </div>` : ""}
    <div class="action-bar">
      ${legal.includes("fold") ? `<button class="action-btn fold" data-act="fold">Fold</button>` : ""}
      ${legal.includes("check") ? `<button class="action-btn check" data-act="check">Check</button>` : ""}
      ${legal.includes("call") ? `<button class="action-btn call" data-act="call">Call ${chips(gs!.toCall(next!))}</button>` : ""}
      ${legal.includes("bet") ? `<button class="action-btn bet" data-act="bet">Bet</button>` : ""}
      ${legal.includes("raise") ? `<button class="action-btn raise" data-act="raise">Raise</button>` : ""}
    </div>` : "";

  app.innerHTML = `
    <div class="game">
      <div class="game-header">
        <span class="pot">Pot: ${gs ? chips(gs.pot) : "$0"}</span>
        <span class="street-badge">${gs?.street ?? "setup"}</span>
        <button class="hdr-btn" id="new-hand">New Hand</button>
      </div>

      <div class="poker-table" id="poker-table">
        <div class="felt"></div>
        ${seats}
        <div class="board-center" id="board-area">${boardHtml}</div>
      </div>

      <div class="hero-area">
        <div class="hero-cards">${heroHtml}</div>
        ${recHtml}
      </div>

      ${S.handOver ? `
      <div class="action-bar">
        <button class="action-btn raise" id="next-hand" style="font-size:16px;padding:16px">NEXT HAND</button>
      </div>` : actionsHtml}

      <div class="status-bar">
        Hand #${S.handNumber} &middot; Dealer: ${positions[S.dealerSeat]}
        ${isHeroTurn && !S.handOver ? " — <strong>YOUR TURN</strong>" : ""}
        ${S.handOver ? " — <strong>Hand complete</strong>" : ""}
      </div>
    </div>`;

  // ── Events ──
  $("#new-hand")?.addEventListener("click", () => { S.screen = "setup"; S.dealerSeat = -1; S.handNumber = 0; render(); });
  document.getElementById("next-hand")?.addEventListener("click", nextHand);

  app.querySelectorAll("[data-act]").forEach(btn =>
    btn.addEventListener("click", () => doAction(next!, (btn as HTMLElement).dataset.act as ActionType)),
  );

  const slider = document.getElementById("raise-slider") as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener("input", () => {
      S.raiseAmount = +slider.value;
      const el = document.getElementById("raise-val");
      if (el) el.textContent = chips(S.raiseAmount);
    });
  }

  if (needsBoard) {
    document.getElementById("board-area")?.addEventListener("click", openBoardPicker);
  }
}

function doAction(seat: number, type: ActionType): void {
  if (!S.gs) return;
  const amount = type === "bet" || type === "raise" ? S.raiseAmount : 0;
  S.gs.applyAction({ seat, type, amount });

  if (S.gs.activeSeatCount <= 1) {
    S.handOver = true; S.rec = null; updateMessage(); render(); return;
  }
  if (S.gs.roundComplete() && S.gs.street === "river") {
    S.handOver = true; S.rec = null;
  }
  updateRec(); updateMessage(); render();

  // Auto-open card picker when a street's action is done
  if (S.gs && S.gs.roundComplete() && !S.gs.isComplete() && !S.handOver) {
    openBoardPicker();
  }
}

function openBoardPicker(): void {
  if (!S.gs) return;
  const nm: Record<string, "flop" | "turn" | "river"> = { preflop: "flop", flop: "turn", turn: "river" };
  S.pickerTarget = nm[S.gs.street] ?? "flop";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

/* ═══════════════════ CARD PICKER ═══════════════════ */

function renderPicker(): void {
  const needed = S.pickerTarget === "hero" ? 2 : S.pickerTarget === "flop" ? 3 : 1;
  const title = S.pickerTarget === "hero" ? "Pick your 2 hole cards"
    : S.pickerTarget === "flop" ? "Deal the flop (3 cards)"
    : S.pickerTarget === "turn" ? "Deal the turn" : "Deal the river";

  const grid = [0, 1, 2, 3].map(suit =>
    Array.from({ length: 13 }, (_, rank) => {
      const card = makeCard(rank, suit);
      const used = S.allDealt.has(card);
      const picked = S.pickerPicked.includes(card);
      const cls = used ? "used" : picked ? "picked" : "";
      const red = SUIT_RED[suit] ? "red" : "";
      return `<div class="card-cell ${cls} ${red}" data-card="${card}">${RANKS[rank]}${SUITS[suit]}</div>`;
    }).join(""),
  ).join("");

  const canConfirm = S.pickerPicked.length === needed;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "picker-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${title} (${S.pickerPicked.length}/${needed})</h3>
      <div class="card-grid">${grid}</div>
      <div class="modal-actions">
        <button class="cancel-btn" id="picker-cancel">Cancel</button>
        <button class="confirm-btn" id="picker-confirm" ${canConfirm ? "" : "disabled"}>Confirm</button>
      </div>
    </div>`;

  app.appendChild(overlay);

  overlay.querySelectorAll(".card-cell:not(.used)").forEach(cell =>
    cell.addEventListener("click", () => {
      const card = +(cell as HTMLElement).dataset.card!;
      const idx = S.pickerPicked.indexOf(card);
      if (idx >= 0) S.pickerPicked.splice(idx, 1);
      else if (S.pickerPicked.length < needed) S.pickerPicked.push(card);
      document.getElementById("picker-modal")?.remove();
      renderPicker();
    }),
  );

  document.getElementById("picker-cancel")?.addEventListener("click", () => {
    S.pickerOpen = false; S.pickerPicked = [];
    document.getElementById("picker-modal")?.remove();
    if (!S.heroCards) { S.screen = "setup"; render(); }
  });

  document.getElementById("picker-confirm")?.addEventListener("click", () => {
    if (S.pickerTarget === "hero") {
      const [a, b] = S.pickerPicked;
      S.heroCards = a! <= b! ? [a!, b!] : [b!, a!];
      S.allDealt.add(a!); S.allDealt.add(b!);
      initGameState();
    } else {
      for (const c of S.pickerPicked) { S.boardCards.push(c); S.allDealt.add(c); }
      if (S.gs) { S.gs.advanceStreet(S.pickerPicked); updateRec(); updateMessage(); }
    }
    S.pickerOpen = false; S.pickerPicked = [];
    document.getElementById("picker-modal")?.remove();
    render();
  });
}

/* ═══════════════════ INIT ═══════════════════ */

render();
