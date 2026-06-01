import { type Card, rankOf, suitOf, makeCard, NUM_CARDS } from "../engine/cards.js";
import { type Combo, Range } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { getPositions, positionsForButton, getRfiRange, getBbDefenseRange } from "../engine/charts/index.js";
import { estimateVillainRange } from "../engine/opponent.js";
import { solveSubgame, type RiverResult } from "../engine/gto/river-solver.js";
import { solvePushFold, handClassKey, type PushFoldResult } from "../engine/gto/pushfold.js";
import { allCombos, topSlice } from "../engine/hand-strength.js";
import { recommend, type Recommendation, type ProfileMap } from "../engine/decision.js";
import { AUTO, TAG, LAG, STATION, NIT, type OpponentProfile } from "../engine/opponent.js";
import { villainDecision } from "../engine/villain-ai.js";
import { evaluate } from "../engine/evaluator.js";
import { describeHand, nutHand, nutLabel } from "../engine/made-hand.js";
import { monteCarloEquityMultiway } from "../engine/equity.js";
import { settlePots, strengthFromWinners } from "../engine/settle.js";
import { openRaiseSize, minRaise } from "../engine/sizing.js";
import { saveHand, getSessionHands, clearHistory, computeStats, type HandRecord, type SessionStats } from "../engine/hand-history.js";
import { emptyStats, observeHand, blendProfile, playerRead, playerTag, type PlayerStats } from "../engine/player-model.js";
import { playSound, setSoundEnabled, isSoundEnabled } from "./sound.js";

const RANKS = "23456789TJQKA";
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_RED = [false, true, true, false];
const PROFILES: Record<string, OpponentProfile> = { Auto: AUTO, TAG, LAG, Station: STATION, Nit: NIT };

// A reversible snapshot of mid-hand state (live mode). Pushed before each
// user-initiated mutation so a mis-tap can be taken back. Cleared once the
// hand resolves (the result is persisted at that point and shouldn't be undone).
interface UndoSnapshot {
  label: string;
  gs: GameState | null;
  boardCards: Card[];
  allDealt: Set<number>;
  handOver: boolean;
  handResult: string;
  decisionLog: { street: string; chosen: ActionType; chosenAmt: number; rec: Recommendation }[];
  showdownCards: Map<number, [Card, Card]>;
  allInPrompt: boolean;
  message: string;
}

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
  // Live mode: running per-seat stacks (bb) carried across the session.
  seatStacks: number[];
  archetype: string;
  gs: GameState | null;
  heroCards: [Card, Card] | null;
  boardCards: Card[];
  allDealt: Set<number>;
  pickerOpen: boolean;
  pickerTarget: "hero" | "flop" | "turn" | "river" | "villain" | "run";
  pickerVillainSeat: number;
  // Run-it-twice (all-in): offer the choice, then deal & resolve two runouts.
  allInPrompt: boolean;
  rit: { run: number; baseLen: number; won: number[]; summary: string[]; awaitWinner: boolean } | null;
  pickerPicked: Card[];
  pickerRank: number | null;
  // Showdown: villain hole cards keyed by the user (seat -> cards)
  showdownCards: Map<number, [Card, Card]>;
  rec: Recommendation | null;
  handOver: boolean;
  handResult: string;
  raiseAmount: number;
  betPadOpen: boolean;
  betPadAction: "bet" | "raise";
  betPadSeat: number;
  // Training mode
  villainCards: [Card, Card] | null; // legacy single-villain (kept for compat)
  villainHands: Map<number, [Card, Card]>; // training: distinct hand per opponent seat
  trainingDeck: Card[];
  trainingBoardCards: Card[];
  // Per-seat opponent types + adaptive modeling
  seatTypes: Map<number, string>;
  playerStats: Map<number, PlayerStats>;
  // Post-hand review: hero's decision points this hand
  decisionLog: { street: string; chosen: ActionType; chosenAmt: number; rec: Recommendation }[];
  reviewOpen: boolean;
  // Generic numpad (blinds / stack)
  numpadTarget: NumpadTarget | null;
  numpadSeat: number;
  numpadRaw: string;
  // GTO river/turn solver
  gtoResult: RiverResult | null;
  gtoSolving: boolean;
  // GTO preflop push/fold readout
  gtoPreflop: { title: string; rows: { label: string; freq: number }[]; note: string } | null;
  // Board read: hero win% vs villain range(s) + the nuts on this board
  boardRead: { equity: number | null; nuts: string; nutsCards: [Card, Card] | null; second: string | null; secondCards: [Card, Card] | null; nutsPct: number | null } | null;
  boardReadKey: string;
  message: string;
  // Undo: reversible snapshots of mid-hand state (live mode only).
  undoStack: UndoSnapshot[];
  // Tap-a-seat: which seat's inline action menu is open (live mode).
  seatMenuSeat: number | null;
  // One-shot deal animation: animate only freshly-dealt cards on the next render.
  dealAnim: { kind: "hero" | "board"; from: number } | null;
  // One-shot: seat that just acted (for an action flash on the next render).
  flashSeat: number | null;
  // Training tournament: end state + the configured starting table size (so
  // "New Game" can rebuild the full table after players have busted out).
  trainingOver: "win" | "bust" | null;
  trainingStartSize: number;
}

const S: AppState = {
  screen: "setup",
  mode: "live",
  sessionStart: Date.now(),
  tableSize: 6,
  stackBB: 100,
  bbValue: 1,
  sbValue: 1,
  heroSeat: 3,
  dealerSeat: -1,
  handNumber: 0,
  seatStacks: [],
  archetype: "Auto",
  gs: null,
  heroCards: null,
  boardCards: [],
  allDealt: new Set(),
  pickerOpen: false,
  pickerTarget: "hero",
  pickerVillainSeat: -1,
  allInPrompt: false,
  rit: null,
  pickerPicked: [],
  pickerRank: null,
  showdownCards: new Map(),
  rec: null,
  handOver: false,
  handResult: "",
  raiseAmount: 0,
  betPadOpen: false,
  betPadAction: "bet",
  betPadSeat: 0,
  villainCards: null,
  villainHands: new Map(),
  trainingDeck: [],
  trainingBoardCards: [],
  seatTypes: new Map(),
  playerStats: new Map(),
  decisionLog: [],
  reviewOpen: false,
  numpadTarget: null,
  numpadSeat: -1,
  numpadRaw: "",
  gtoResult: null,
  gtoSolving: false,
  gtoPreflop: null,
  boardRead: null,
  boardReadKey: "",
  message: "",
  undoStack: [],
  seatMenuSeat: null,
  dealAnim: null,
  flashSeat: null,
  trainingOver: null,
  trainingStartSize: 6,
};

// Cache push/fold solutions by effective-stack depth (equity table is reused).
const pushFoldCache = new Map<number, PushFoldResult>();

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

function fmtMoney(v: number): string {
  return v % 1 === 0 ? String(v) : v.toFixed(2);
}

type NumpadTarget = "sb" | "bb" | "stack" | "seatstack";

function render(): void {
  if (S.screen === "setup") renderSetup();
  else if (S.screen === "stats") renderStats();
  else renderGame();
  if (S.pickerOpen) renderPicker();
  if (S.betPadOpen) renderBetPad();
  if (S.numpadTarget) renderNumpad();
  if (S.reviewOpen) renderReview();
}

/* ═══════════════════ GENERIC NUMPAD (blinds / stack) ═══════════════════ */

function openNumpad(target: NumpadTarget): void {
  S.numpadTarget = target;
  S.numpadRaw = "";
  renderNumpad();
}

function renderNumpad(): void {
  document.getElementById("numpad-modal")?.remove();
  const target = S.numpadTarget;
  if (!target) return;

  const seatPos = S.gs?.positions[S.numpadSeat] ?? "";
  const title = target === "sb" ? "Small Blind ($)" : target === "bb" ? "Big Blind ($)"
    : target === "stack" ? "Stack (big blinds)"
    : `${S.numpadSeat === S.heroSeat ? "Your" : seatPos} stack (bb)`;
  const current = target === "sb" ? S.sbValue : target === "bb" ? S.bbValue
    : target === "seatstack" ? (S.seatStacks[S.numpadSeat] ?? S.stackBB) : S.stackBB;
  const display = S.numpadRaw || String(current);
  const unit = target === "sb" || target === "bb" ? "$" : "";

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "numpad-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${title}</h3>
      <div class="betpad-display">${unit}${display}</div>
      <div class="betpad-grid">
        ${["1","2","3","4","5","6","7","8","9",".","0","⌫"].map(k =>
          `<button class="numpad-btn" data-key="${k}">${k}</button>`
        ).join("")}
      </div>
      ${target === "seatstack" && S.mode === "live" && S.numpadSeat !== S.heroSeat && getPositions(S.tableSize).length > 2
        ? `<button class="remove-player-btn" id="np-remove">🚪 Remove ${seatPos} (left table)</button>` : ""}
      <div class="modal-actions">
        <button class="cancel-btn" id="np-cancel">Cancel</button>
        <button class="confirm-btn" id="np-confirm">Set</button>
      </div>
    </div>`;
  app.appendChild(overlay);

  document.getElementById("np-remove")?.addEventListener("click", () => {
    const seat = S.numpadSeat;
    S.numpadTarget = null; S.numpadRaw = "";
    document.getElementById("numpad-modal")?.remove();
    removePlayer(seat);
  });

  overlay.querySelectorAll(".numpad-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const k = (btn as HTMLElement).dataset.key!;
      if (k === "⌫") S.numpadRaw = S.numpadRaw.slice(0, -1);
      else if (k === ".") { if (!S.numpadRaw.includes(".")) S.numpadRaw = (S.numpadRaw || "0") + "."; }
      else S.numpadRaw += k;
      const d = overlay.querySelector(".betpad-display");
      if (d) d.textContent = `${unit}${S.numpadRaw || "0"}`;
    }),
  );

  document.getElementById("np-cancel")?.addEventListener("click", () => {
    S.numpadTarget = null; S.numpadRaw = "";
    document.getElementById("numpad-modal")?.remove();
  });
  document.getElementById("np-confirm")?.addEventListener("click", () => {
    const v = parseFloat(S.numpadRaw);
    if (!isNaN(v) && v > 0) {
      if (target === "sb") S.sbValue = v;
      else if (target === "bb") S.bbValue = v;
      else if (target === "seatstack") {
        const seat = S.numpadSeat;
        S.seatStacks[seat] = v;
        // Apply to the live hand too (correction / rebuy mid-session).
        if (S.gs) S.gs.stacks[seat] = Math.max(0, v - S.gs.streetInvested[seat]!);
      } else S.stackBB = Math.max(2, Math.round(v));
    }
    S.numpadTarget = null; S.numpadRaw = "";
    document.getElementById("numpad-modal")?.remove();
    render();
  });
}

// Remove a player from the live table mid-session (they busted / left). Shrinks
// the table by one and re-indexes everything keyed by seat — running stacks,
// per-seat stats & types, hero seat, dealer seat — then deals the next hand.
function removePlayer(seat: number): void {
  if (S.mode !== "live") return;
  const n = getPositions(S.tableSize).length;
  if (n <= 2 || seat === S.heroSeat) return; // can't go below heads-up or remove yourself
  const newN = n - 1;
  const shift = (idx: number) => (idx > seat ? idx - 1 : idx); // for idx !== seat

  // Running stacks: drop the leaving seat, keep the rest in order.
  const newStacks: number[] = [];
  for (let i = 0; i < n; i++) if (i !== seat) newStacks.push(S.seatStacks[i] ?? S.stackBB);
  S.seatStacks = newStacks;

  // Per-seat maps: drop the seat, shift higher indices down.
  const remapMap = <T>(m: Map<number, T>): Map<number, T> => {
    const out = new Map<number, T>();
    for (const [k, v] of m) if (k !== seat) out.set(shift(k), v);
    return out;
  };
  S.playerStats = remapMap(S.playerStats);
  S.seatTypes = remapMap(S.seatTypes);

  if (S.heroSeat > seat) S.heroSeat -= 1;
  // If the button was the leaving seat, it passes to the next player (now at
  // index `seat`); otherwise shift it down if it was above the removed seat.
  S.dealerSeat = S.dealerSeat === seat ? seat % newN : (S.dealerSeat > seat ? S.dealerSeat - 1 : S.dealerSeat);
  S.tableSize = newN;

  // Start the next hand fresh on the smaller table.
  startHand();
}

/* ═══════════════════ GTO RIVER SOLVER ═══════════════════ */

// GTO solving is currently river, heads-up (one active villain).
function activeVillains(): number[] {
  if (!S.gs) return [];
  const out: number[] = [];
  for (let i = 0; i < S.gs.folded.length; i++) {
    if (i !== S.heroSeat && !S.gs.folded[i]) out.push(i);
  }
  return out;
}

function canSolveGto(): boolean {
  if (!S.gs || !S.heroCards || S.handOver) return false;
  if (S.gs.nextToAct() !== S.heroSeat) return false;
  if (activeVillains().length !== 1) return false;
  if (S.gs.street === "flop" || S.gs.street === "turn" || S.gs.street === "river") return true;
  // Preflop push/fold: short effective stack, heads-up.
  if (S.gs.street === "preflop") {
    const eff = Math.min(S.gs.stacks[S.heroSeat]! + S.gs.streetInvested[S.heroSeat]!,
      ...activeVillains().map(v => S.gs!.stacks[v]! + S.gs!.streetInvested[v]!));
    return eff <= 20.0001;
  }
  return false;
}

function heroRangeEstimate(): Range {
  const gs = S.gs!;
  const pos = gs.positions[S.heroSeat]!;
  const raisedPre = gs.actions.some(a =>
    a.seat === S.heroSeat && (a.type === "raise" || a.type === "bet") && a.street === "preflop");
  let r: Range;
  try {
    if (pos === "BB" && !raisedPre) {
      const opener = gs.actions.find(a =>
        a.seat !== S.heroSeat && (a.type === "raise" || a.type === "bet") && a.street === "preflop");
      r = opener ? getBbDefenseRange(gs.tableSize, gs.positions[opener.seat]!) : topSlice(allCombos(), 0.4);
    } else {
      r = getRfiRange(gs.tableSize, pos);
    }
  } catch {
    r = topSlice(allCombos(), 0.4);
  }
  r = r.filter([...gs.board]);
  // Guarantee hero's actual hand is in their own range.
  return r.union(Range.fromCombos([S.heroCards!]));
}

function startGtoSolve(): void {
  if (!canSolveGto()) return;
  S.gtoSolving = true;
  render();
  // Yield so the "Solving…" state paints before the (synchronous) CFR run.
  setTimeout(runGtoSolve, 30);
}

function runGtoSolve(): void {
  const gs = S.gs;
  if (!gs || !S.heroCards) { S.gtoSolving = false; render(); return; }

  // Preflop short-stack → push/fold Nash readout.
  if (gs.street === "preflop") {
    runPushFoldSolve();
    return;
  }

  const villainSeat = activeVillains()[0]!;
  const profile = buildProfiles().get(villainSeat);
  const heroRange = heroRangeEstimate();
  const villainRange = estimateVillainRange(gs, villainSeat, profile ?? PROFILES[S.archetype]!);
  const stack = Math.min(gs.stacks[S.heroSeat]!, gs.stacks[villainSeat]!);

  S.gtoPreflop = null;
  S.boardRead = null;
  S.boardReadKey = "";
  try {
    S.gtoResult = solveSubgame({
      heroRange,
      villainRange: villainRange.size > 0 ? villainRange : topSlice(allCombos(), 0.4).filter([...gs.board]),
      board: gs.board,
      pot: gs.pot,
      stack: Math.max(stack, gs.pot * 0.5),
      iterations: gs.street === "river" ? 12000 : gs.street === "turn" ? 22000 : 16000,
      rng: mulberry32(0x9e3a),
    }, S.heroCards);
  } catch {
    S.gtoResult = null;
  }
  S.gtoSolving = false;
  render();
  renderGtoModal();
}

function runPushFoldSolve(): void {
  const gs = S.gs!;
  const hero = S.heroCards!;
  const eff = Math.round(Math.min(
    gs.stacks[S.heroSeat]! + gs.streetInvested[S.heroSeat]!,
    ...activeVillains().map(v => gs.stacks[v]! + gs.streetInvested[v]!),
  ));
  const depth = Math.max(1, Math.min(25, eff));

  let res = pushFoldCache.get(depth);
  if (!res) {
    res = solvePushFold(depth, 50000, mulberry32(0x9111));
    pushFoldCache.set(depth, res);
  }

  const cls = handClassKey(hero[0], hero[1]);
  // Are we facing an all-in (deciding to call) or first-in (deciding to jam)?
  const facingAllIn = gs.toCall(S.heroSeat) >= gs.stacks[S.heroSeat]! - 0.01 && gs.toCall(S.heroSeat) > 0;

  if (facingAllIn) {
    const callFreq = res.call.get(cls) ?? 0;
    S.gtoPreflop = {
      title: `Push/Fold — facing all-in (${depth}bb)`,
      rows: [
        { label: "Call", freq: callFreq },
        { label: "Fold", freq: 1 - callFreq },
      ],
      note: `${cls} · Nash call-off range at ${depth}bb effective`,
    };
  } else {
    const jamFreq = res.jam.get(cls) ?? 0;
    S.gtoPreflop = {
      title: `Push/Fold — open jam (${depth}bb)`,
      rows: [
        { label: "Jam (all-in)", freq: jamFreq },
        { label: "Fold", freq: 1 - jamFreq },
      ],
      note: `${cls} · Nash open-shove range at ${depth}bb effective`,
    };
  }
  S.gtoResult = null;
  S.gtoSolving = false;
  render();
  renderGtoModal();
}

function renderGtoModal(): void {
  document.getElementById("gto-modal")?.remove();

  // Preflop push/fold readout
  if (S.gtoPreflop) {
    const pf = S.gtoPreflop;
    const rows = pf.rows.map(r => `<div class="gto-row">
        <span class="gto-act">${r.label}</span>
        <div class="gto-bar"><div class="gto-fill" style="width:${(r.freq * 100).toFixed(0)}%"></div></div>
        <span class="gto-pct">${(r.freq * 100).toFixed(0)}%</span>
      </div>`).join("");
    const overlay = document.createElement("div");
    overlay.className = "modal-backdrop";
    overlay.id = "gto-modal";
    overlay.innerHTML = `
      <div class="modal-content">
        <h3>🧠 ${pf.title}</h3>
        <div class="gto-sub">Solved with CFR (Nash equilibrium) · ${pf.note}</div>
        ${rows}
        <div class="modal-actions"><button class="confirm-btn" id="gto-close">Close</button></div>
      </div>`;
    app.appendChild(overlay);
    document.getElementById("gto-close")?.addEventListener("click", () => {
      document.getElementById("gto-modal")?.remove();
    });
    return;
  }

  if (!S.gtoResult) return;
  const res = S.gtoResult;

  const rows = res.strategy
    .filter(a => a.freq > 0.005)
    .sort((a, b) => b.freq - a.freq)
    .map(a => {
      const label = a.action === "check" ? "Check"
        : `Bet ${chipsBet(a.amount)}`;
      const pct = (a.freq * 100).toFixed(0);
      return `<div class="gto-row">
        <span class="gto-act">${label}</span>
        <div class="gto-bar"><div class="gto-fill" style="width:${(a.freq * 100).toFixed(0)}%"></div></div>
        <span class="gto-pct">${pct}%</span>
      </div>`;
    }).join("");

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "gto-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>🧠 GTO Solution (${S.gs?.street ?? "river"})</h3>
      <div class="gto-sub">Solved with CFR — ${res.iterations.toLocaleString()} iters${S.gs?.street === "turn" ? " · over all river runouts" : S.gs?.street === "flop" ? " · flop street (all-in equity beyond)" : ""} · assumes you act first</div>
      ${rows || `<div class="hint" style="text-align:center">No solution.</div>`}
      <div class="gto-ev">Hand EV: <strong>${chips(res.heroEv)}</strong></div>
      <div class="modal-actions">
        <button class="confirm-btn" id="gto-close">Close</button>
      </div>
    </div>`;
  app.appendChild(overlay);
  document.getElementById("gto-close")?.addEventListener("click", () => {
    document.getElementById("gto-modal")?.remove();
  });
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
  Auto: "Don't know the table? Start here. Plays solid, balanced poker and learns each player's real style as you log hands.",
  TAG: "Tight-Aggressive — plays few hands but bets hard. Toughest opponent.",
  LAG: "Loose-Aggressive — plays many hands aggressively. Lots of bluffs.",
  Station: "Calling Station — calls everything, rarely folds. Bet big for value.",
  Nit: "Nit — only plays premium hands (AA, KK, AK). Easy to steal from.",
};

function renderSetup(): void {
  cancelVillainTimer();
  // Returning to setup starts a fresh session: clear running stacks so they
  // re-initialise to the (possibly changed) buy-in on the next hand.
  S.seatStacks = [];
  const positions = getPositions(S.tableSize);
  app.innerHTML = `
    <div class="setup">
      <div class="brand">
        <img class="brand-logo" src="${import.meta.env.BASE_URL}logo.png" alt="" onerror="this.style.display='none'" />
        <h1>MonteCarloEdge<small>Poker Decision Assistant</small></h1>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Players</label>
          <select id="tsize">
            ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
              `<option value="${n}" ${n === S.tableSize ? "selected" : ""}>${n === 2 ? "2 (HU)" : n + " players"}</option>`
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label>Opponent type</label>
          <select id="arch">
            ${Object.keys(PROFILES).map(k =>
              `<option value="${k}" ${k === S.archetype ? "selected" : ""}>${k}</option>`
            ).join("")}
          </select>
        </div>
      </div>
      <span class="hint arch-desc">${ARCH_DESC[S.archetype]}</span>

      <div class="field-row">
        <div class="field">
          <label>Blinds</label>
          <div class="blinds-row">
            <button class="tap-input" data-numpad="sb">$${fmtMoney(S.sbValue)}</button>
            <span class="blind-slash">/</span>
            <button class="tap-input" data-numpad="bb">$${fmtMoney(S.bbValue)}</button>
          </div>
        </div>
        <div class="field">
          <label>Starting chips</label>
          <button class="tap-input" data-numpad="stack">${S.stackBB}bb · $${fmtMoney(S.stackBB * S.bbValue)}</button>
        </div>
      </div>

      <div class="field">
        <label>Where are you sitting?</label>
        <span class="hint">Tap your seat. BTN (Dealer) is best — you act last after the flop.</span>
        <div class="seat-ring">
          ${positions.map((p, i) =>
            `<button class="seat-btn ${i === S.heroSeat ? "selected" : ""}" data-seat="${i}" title="${positionTip(p)}">${p}</button>`
          ).join("")}
        </div>
        <span class="hint seat-tip">${positionTip(positions[S.heroSeat]!)}</span>
      </div>

      <div class="field">
        <div class="per-seat-head" id="per-seat-toggle">
          <label>Customize opponents per seat ▾</label>
        </div>
        <div class="per-seat-body hidden" id="per-seat-body">
          ${positions.map((p, i) => {
            if (i === S.heroSeat) return "";
            const read = S.playerStats.get(i) ? playerRead(S.playerStats.get(i)!) : null;
            return `<div class="per-seat-row">
              <span class="per-seat-pos">${p}</span>
              <select data-seat-type="${i}">
                ${Object.keys(PROFILES).map(k =>
                  `<option value="${k}" ${(S.seatTypes.get(i) ?? S.archetype) === k ? "selected" : ""}>${k}</option>`
                ).join("")}
              </select>
              ${read ? `<span class="per-seat-read">${read}</span>` : ""}
            </div>`;
          }).join("")}
        </div>
      </div>

      <button class="start-btn" id="start">DEAL HAND</button>
      <button class="start-btn" id="start-training" style="background:linear-gradient(135deg,var(--violet),var(--violet-2));color:#fff;box-shadow:0 8px 22px rgba(124,92,255,.3);margin-top:8px">TRAINING MODE</button>
      <span class="hint" style="text-align:center">Training: practice against the AI. It deals cards, makes villain decisions, reveals hands at showdown.</span>

      <div class="help-banner" id="help-toggle">
        <span class="help-icon">?</span> How does this work?
      </div>
      <div class="help-body hidden" id="help-body">
        <p>This app tells you <strong>what to do</strong> at the poker table in real time.</p>
        <ol>
          <li>Set up your table above</li>
          <li>Pick your two hole cards when dealt</li>
          <li>Tap each opponent's action as it happens (fold / call / raise)</li>
          <li>When it's <strong>your turn</strong>, the app shows the recommended play with the math behind it</li>
          <li>After each betting round, tap the board to enter community cards</li>
        </ol>
      </div>

      <div class="setup-footer">
        <button class="hdr-btn" id="view-stats">Session Stats</button>
        <button class="hdr-btn" id="sound-toggle">${isSoundEnabled() ? "🔊 Sound On" : "🔇 Sound Off"}</button>
      </div>
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
  app.querySelectorAll("[data-numpad]").forEach(btn =>
    btn.addEventListener("click", () => openNumpad((btn as HTMLElement).dataset.numpad as NumpadTarget)),
  );
  $("#arch").addEventListener("change", (e) => {
    S.archetype = (e.target as HTMLSelectElement).value;
    const d = document.querySelector(".arch-desc");
    if (d) d.textContent = ARCH_DESC[S.archetype] ?? "";
  });
  document.getElementById("per-seat-toggle")?.addEventListener("click", () => {
    document.getElementById("per-seat-body")?.classList.toggle("hidden");
  });
  app.querySelectorAll("[data-seat-type]").forEach(sel =>
    sel.addEventListener("change", (e) => {
      const seat = +(sel as HTMLElement).dataset.seatType!;
      S.seatTypes.set(seat, (e.target as HTMLSelectElement).value);
    }),
  );
  document.getElementById("sound-toggle")?.addEventListener("click", () => {
    setSoundEnabled(!isSoundEnabled());
    render();
  });
  app.querySelectorAll(".seat-btn").forEach(btn =>
    btn.addEventListener("click", () => { S.heroSeat = +(btn as HTMLElement).dataset.seat!; render(); }),
  );
  $("#start").addEventListener("click", () => { S.mode = "live"; startHand(); });
  document.getElementById("start-training")?.addEventListener("click", () => {
    S.mode = "training";
    S.trainingOver = null;
    S.trainingStartSize = S.tableSize;
    S.dealerSeat = -1;
    S.handNumber = 0;
    S.seatStacks = []; // fresh tournament stacks
    startTrainingHand();
  });
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
  // Running stacks: initialise on the first hand / table change, otherwise
  // carry across the session. Auto-rebuy any seat that busted back to buy-in.
  if (S.seatStacks.length !== n) {
    S.seatStacks = Array.from({ length: n }, () => S.stackBB);
  } else {
    for (let i = 0; i < n; i++) if (S.seatStacks[i]! < 1) S.seatStacks[i] = S.stackBB;
  }
  S.handNumber++;
  S.heroCards = null;
  S.boardCards = [];
  S.allDealt = new Set();
  S.gs = null;
  S.rec = null;
  S.handOver = false;
  S.handResult = "";
  S.showdownCards = new Map();
  S.allInPrompt = false;
  S.rit = null;
  S.raiseAmount = 0;
  S.decisionLog = [];
  S.reviewOpen = false;
  S.gtoResult = null;
  S.gtoSolving = false;
  S.gtoPreflop = null;
  S.boardRead = null;
  S.boardReadKey = "";
  S.undoStack = [];
  S.message = "Tap your cards to pick them";
  S.screen = "game";
  S.pickerTarget = "hero";
  S.pickerPicked = [];
  S.pickerOpen = true;
  render();
}

function nextHand(): void {
  if (S.mode === "training") { advanceTrainingHand(); return; }
  const n = getPositions(S.tableSize).length;
  S.dealerSeat = (S.dealerSeat + 1) % n;
  startHand();
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
  cancelVillainTimer();
  const n = getPositions(S.tableSize).length;
  if (S.dealerSeat < 0) {
    S.dealerSeat = S.tableSize === 2 ? 0 : n - 3;
  }
  // Tournament stacks persist across hands; initialise only for a new game.
  if (S.seatStacks.length !== n) S.seatStacks = Array.from({ length: n }, () => S.stackBB);
  S.handNumber++;

  // Shuffle and deal — each seat gets its OWN hand (true multiway).
  const deck = shuffleDeck();
  let d = 0;
  const draw2 = (): [Card, Card] => {
    const a = deck[d++]!, b = deck[d++]!;
    return a <= b ? [a, b] : [b, a];
  };
  const seatCount = getPositions(S.tableSize).length;
  const heroCards = draw2();
  const villainHands = new Map<number, [Card, Card]>();
  for (let i = 0; i < seatCount; i++) if (i !== S.heroSeat) villainHands.set(i, draw2());
  const boardCards = [deck[d++]!, deck[d++]!, deck[d++]!, deck[d++]!, deck[d++]!];

  S.heroCards = heroCards;
  S.villainHands = villainHands;
  S.villainCards = villainHands.values().next().value ?? null; // legacy/back-compat
  S.trainingBoardCards = boardCards;
  S.boardCards = [];
  const dealt: Card[] = [heroCards[0], heroCards[1], ...boardCards];
  for (const h of villainHands.values()) dealt.push(h[0], h[1]);
  S.allDealt = new Set(dealt);
  S.handOver = false;
  S.handResult = "";
  S.showdownCards = new Map();
  S.allInPrompt = false;
  S.rit = null;
  S.raiseAmount = 0;
  S.rec = null;
  S.decisionLog = [];
  S.reviewOpen = false;
  S.gtoResult = null;
  S.gtoSolving = false;
  S.gtoPreflop = null;
  S.boardRead = null;
  S.boardReadKey = "";

  // Create game state — labels rotate with the button.
  const positions = positionsForButton(S.tableSize, S.dealerSeat);
  S.gs = new GameState({
    tableSize: S.tableSize,
    bb: 1,
    sb: S.sbValue / S.bbValue,
    stacks: S.seatStacks.slice(), // persistent tournament stacks
    positions: [...positions],
    heroSeat: S.heroSeat,
    heroCards: heroCards,
    dealerSeat: S.dealerSeat,
  });

  S.screen = "game";
  S.pickerOpen = false;
  S.dealAnim = { kind: "hero", from: 0 };
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
  const positions = positionsForButton(S.tableSize, S.dealerSeat); // labels follow the button
  if (S.seatStacks.length !== positions.length) {
    S.seatStacks = positions.map(() => S.stackBB);
  }
  S.gs = new GameState({
    tableSize: S.tableSize,
    bb: 1,
    sb: S.sbValue / S.bbValue,
    stacks: S.seatStacks.slice(), // running stacks → correct depth for advice
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

// Hero's win% vs the active villain range(s) and the nuts on the current board.
// Cached per (street, board, villains) so it only recomputes when the board changes.
function updateBoardRead(): void {
  if (!S.gs || !S.heroCards || S.gs.board.length < 3) { S.boardRead = null; S.boardReadKey = ""; return; }
  const vils = activeVillains();
  const key = `${S.gs.board.join(",")}|${vils.join(",")}`;
  if (key === S.boardReadKey && S.boardRead) return;
  S.boardReadKey = key;

  const nut = nutHand(S.gs.board, [S.heroCards[0], S.heroCards[1]]);
  const nuts = nut?.label ?? "—";
  const second = nut?.second ?? null;
  const nutsCards = nut?.combos[0] ?? null;
  const secondCards = nut?.secondCombo ?? null;
  let equity: number | null = null;
  let nutsPct: number | null = null;
  if (vils.length > 0) {
    const prof = buildProfiles();
    const ranges = vils
      .map(v => estimateVillainRange(S.gs!, v, prof.get(v) ?? PROFILES[S.archetype]!))
      .filter(r => r.size > 0);
    if (ranges.length > 0) {
      equity = monteCarloEquityMultiway({
        hero: S.heroCards, villainRanges: ranges, board: S.gs.board,
        iterations: 4000, rng: mulberry32(0x1234),
      }).equity;
      // P(at least one villain holds a nut combo) = 1 - Π(1 - p_i).
      if (nut && nut.combos.length > 0) {
        let pNone = 1;
        for (const r of ranges) {
          let held = 0;
          for (const c of nut.combos) if (r.has(c)) held++;
          const p = r.size > 0 ? held / r.size : 0;
          pNone *= (1 - p);
        }
        nutsPct = 1 - pNone;
      }
    }
  }
  S.boardRead = { equity, nuts, nutsCards, second, secondCards, nutsPct };
}

// Common one-tap raise/bet sizes for the seat about to act. Facing a bet →
// multiples of it (the "× the raise" sizes live players eyeball); no bet yet →
// fractions of the pot. Each is clamped to the legal min-raise and the stack.
function sizeChips(gs: GameState, seat: number): { label: string; bb: number }[] {
  const minBB = roundBet(Math.max(
    gs.currentBet > 0 ? minRaise(gs.currentBet, gs.bb) : openRaiseSize(gs.bb),
    (gs.toCall(seat) || 0) + 1,
  ));
  const maxBB = roundBet(gs.stacks[seat]! + gs.streetInvested[seat]!);
  const clamp = (x: number) => roundBet(Math.min(maxBB, Math.max(minBB, x)));
  const raw = gs.currentBet > 0
    ? [
        { label: "2×", bb: clamp(gs.currentBet * 2) },
        { label: "2.5×", bb: clamp(gs.currentBet * 2.5) },
        { label: "3×", bb: clamp(gs.currentBet * 3) },
        { label: "Pot", bb: clamp(gs.pot + gs.currentBet) },
        { label: "All in", bb: maxBB },
      ]
    : [
        { label: "⅓", bb: clamp(gs.pot / 3) },
        { label: "½", bb: clamp(gs.pot / 2) },
        { label: "¾", bb: clamp(gs.pot * 0.75) },
        { label: "Pot", bb: clamp(gs.pot) },
        { label: "All in", bb: maxBB },
      ];
  // Any chip that committed the whole stack IS an all-in — relabel it so the
  // label never lies (e.g. a short stack where 2× the bet > the stack). Do this
  // before dedupe so the surviving chip at maxBB reads "All in", not "2×".
  for (const c of raw) if (c.bb >= maxBB) c.label = "All in";
  // Drop chips that collapsed onto the same amount (e.g. min-raise > 3×).
  const seen = new Set<number>();
  return raw.filter((c) => (seen.has(c.bb) ? false : (seen.add(c.bb), true)));
}

// Compact one-line recap of the current street's action, so table state is
// verifiable at a glance while logging a busy multiway pot.
function streetRecap(gs: GameState): string {
  const acts = gs.actions.filter((a) => a.street === gs.street);
  if (acts.length === 0) return "";
  return acts.map((a) => {
    const who = a.seat === S.heroSeat ? "You" : (gs.positions[a.seat] ?? "?");
    const v = a.type === "fold" ? "fold"
      : a.type === "check" ? "check"
      : a.type === "call" ? "call"
      : `${a.type} ${chipsBet(a.amount)}`;
    return `${who} ${v}`;
  }).join("  ·  ");
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
  if (n === S.heroSeat) { S.message = `Your turn (${pos})`; return; }
  // Training: the AI plays the villains, so just show who's thinking.
  S.message = S.mode === "training" ? `${pos} is deciding…` : `${pos} to act — tap their action below`;
}

function seatCoord(seatIdx: number): { left: number; top: number } {
  const n = getPositions(S.tableSize).length;
  const vis = (seatIdx - S.heroSeat + n) % n;
  const a = (vis * 2 * Math.PI) / n;
  // Push seats out toward the rim of the felt (wider horizontally; vertically
  // capped so the top seat clears the header).
  return { left: 50 - 47 * Math.sin(a), top: 50 + 38 * Math.cos(a) };
}

// A small head-and-shoulders silhouette avatar so opponents read as people, not
// just labels. Colour varies per seat for distinction; hero is emerald.
const AVATAR_COLORS = ["#5b8def", "#e0566a", "#f59e0b", "#a78bfa", "#3fd6c4",
  "#ec4899", "#f97316", "#22c55e", "#eab308", "#38bdf8"];
// Animate the current street's bet chips sliding into the pot. Spawns transient
// chip elements on document.body (so the imminent re-render doesn't kill them),
// reading live positions from the rendered .seat-bet tokens and the pot.
function animateChipsToPot(): void {
  // Chips converge to the middle of the felt (the board area).
  const target = document.querySelector(".board-center") ?? document.querySelector(".poker-table");
  const bets = [...document.querySelectorAll(".seat-bet")] as HTMLElement[];
  if (!target || bets.length === 0) return;
  const pr = target.getBoundingClientRect();
  const tx = pr.left + pr.width / 2, ty = pr.top + pr.height / 2;
  for (const b of bets) {
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const chip = document.createElement("div");
    chip.className = "fly-chip";
    chip.style.left = `${x}px`;
    chip.style.top = `${y}px`;
    document.body.appendChild(chip);
    setTimeout(() => { chip.style.transform = `translate(${tx - x}px, ${ty - y}px) scale(.45)`; chip.style.opacity = "0.15"; }, 16);
    setTimeout(() => chip.remove(), 460);
  }
  const potLine = document.querySelector(".pot-line");
  if (potLine) {
    potLine.classList.remove("pot-collect");
    void (potLine as HTMLElement).offsetWidth; // restart the animation
    potLine.classList.add("pot-collect");
  }
}

function avatarHtml(seat: number, isHero: boolean): string {
  const color = isHero ? "#00d68f" : AVATAR_COLORS[seat % AVATAR_COLORS.length]!;
  return `<div class="seat-avatar" style="color:${color}">
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <circle cx="12" cy="8.5" r="4.3" fill="currentColor"/>
      <path d="M3.5 21c0-4.6 3.8-7.5 8.5-7.5s8.5 2.9 8.5 7.5z" fill="currentColor"/>
    </svg>
  </div>`;
}

function renderGame(): void {
  if (!S.gs && !S.heroCards) {
    app.innerHTML = `<div class="game"><div class="status-bar">Picking cards...</div></div>`;
    return;
  }
  const gs = S.gs;
  updateBoardRead();
  // Labels follow the button. Use the live game state's positions when a hand is
  // running so the board matches exactly what the engine/recommendation use.
  const positions = gs ? gs.positions
    : positionsForButton(S.tableSize, S.dealerSeat < 0 ? S.tableSize - 3 : S.dealerSeat);
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
    // Mid-hand: show in-hand stack. After the hand resolves: show the awarded
    // running stack (so the winner's stack visibly grows).
    const stack = (S.handOver && S.seatStacks[i] != null) ? S.seatStacks[i]!
      : gs ? gs.stacks[i]! + gs.streetInvested[i]! : S.stackBB;
    const cls = [
      "table-seat",
      isHero ? "hero-seat" : "",
      folded ? "folded" : "",
      active ? "active" : "",
      S.flashSeat === i ? "flash" : "",
    ].filter(Boolean).join(" ");

    // Chips this player has wagered on the current street, shown on the felt
    // between the seat and the pot (WSOP-style).
    const streetBet = gs ? gs.streetInvested[i]! : 0;
    const betChip = streetBet > 0 && !folded
      ? `<div class="seat-bet ${top < 50 ? "below" : "above"}"><span class="chip-dot"></span>${chips(streetBet)}</div>`
      : "";

    let actText = "";
    if (lastAct) {
      if (lastAct.type === "raise" || lastAct.type === "bet")
        actText = `${lastAct.type} ${chipsBet(lastAct.amount)}`;
      else actText = lastAct.type;
    }

    const tag = !isHero && S.mode === "live" && S.playerStats.has(i)
      ? playerTag(S.playerStats.get(i)!) : null;

    // Tap-a-seat: when it's this opponent's turn (live), tapping the chip opens
    // an inline action menu right at the seat instead of the stack editor.
    const oppActor = active && !isHero && S.mode === "live" && !!gs && !S.handOver && !needsBoard;
    const chipAttr = oppActor ? `data-actmenu="${i}"` : `data-seatstack="${i}"`;
    let seatMenu = "";
    if (oppActor && S.seatMenuSeat === i && gs) {
      const lg = gs.legalActionsFor(i);
      const dir = top < 50 ? "below" : "above"; // open away from the table edge
      const hp = left < 30 ? "hleft" : left > 70 ? "hright" : "hcenter"; // keep in-bounds
      seatMenu = `<div class="seat-actions ${dir} ${hp}">
        ${lg.includes("fold") ? `<button class="sa-btn fold" data-seatact="fold" data-seat="${i}">Fold</button>` : ""}
        ${lg.includes("check") ? `<button class="sa-btn check" data-seatact="check" data-seat="${i}">Check</button>` : ""}
        ${lg.includes("call") ? `<button class="sa-btn call" data-seatact="call" data-seat="${i}">Call ${chips(gs.toCall(i))}</button>` : ""}
        ${(lg.includes("raise") || lg.includes("bet")) ? `<button class="sa-btn raise" data-seatact="betraise" data-seat="${i}">${gs.currentBet > 0 ? "Raise" : "Bet"}</button>` : ""}
      </div>`;
    }
    const avatar = S.mode === "training" ? avatarHtml(i, isHero) : "";
    return `<div class="${cls} ${oppActor ? "tappable" : ""}" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%">
      ${isDealer ? '<div class="dealer-btn">D</div>' : ""}
      ${tag ? `<div class="seat-tag tag-${tag.toLowerCase()}">${tag}</div>` : ""}
      ${avatar}
      <div class="seat-chip" ${chipAttr}>
        <div class="seat-pos">${isHero ? `YOU <span class="seat-subpos">${pos}</span>` : pos}</div>
        <div class="seat-stack">${chips(stack)}</div>
        ${actText ? `<div class="seat-act">${actText}</div>` : ""}
      </div>
      ${betChip}
      ${seatMenu}
    </div>`;
  }).join("");

  // Deal animation: only cards added on this render get the "deal-in" class,
  // with a stagger, so re-renders during play don't replay the animation.
  const animBoard = S.dealAnim?.kind === "board" ? S.dealAnim.from : -1;
  const animHero = S.dealAnim?.kind === "hero";

  // ── Board ──
  const boardHtml = [0, 1, 2, 3, 4].map(i => {
    if (i < S.boardCards.length) {
      const c = S.boardCards[i]!;
      const anim = animBoard >= 0 && i >= animBoard
        ? ` deal-in" style="animation-delay:${((i - animBoard) * 90)}ms`
        : "";
      return `<div class="board-card dealt ${isRed(c) ? "red" : ""}${anim}">${cardDisplay(c)}</div>`;
    }
    return `<div class="board-card empty"></div>`;
  }).join("");

  // ── Hero cards ──
  const heroHtml = S.heroCards
    ? S.heroCards.map((c, i) =>
        `<div class="hero-card dealt ${isRed(c) ? "red" : ""}${animHero ? ` deal-in" style="animation-delay:${i * 110}ms` : ""}">${cardDisplay(c)}</div>`
      ).join("")
    : `<div class="hero-card empty">?</div><div class="hero-card empty">?</div>`;

  // ── Hand strength label ──
  let handLabelHtml = "";
  if (S.heroCards && gs) {
    const d = describeHand(S.heroCards, gs.board);
    const draws = d.draws.length ? ` + ${d.draws.join(" + ")}` : "";
    handLabelHtml = `<div class="hand-label ${d.strong ? "strong" : ""}">${d.label}${draws}</div>`;
  }

  // ── Board read: win% + the nuts ──
  let boardReadHtml = "";
  if (S.boardRead) {
    const eq = S.boardRead.equity;
    const eqStr = eq === null ? "—" : `${(eq * 100).toFixed(0)}%`;
    const npct = S.boardRead.nutsPct;
    const heldItem = npct === null ? "" :
      `<div class="br-item"><span class="br-label">Nuts out</span><span class="br-val ${npct > 0.15 ? "warn" : ""}">${(npct * 100).toFixed(0)}%</span></div>`;
    // Show the actual two cards that make the nuts, with the hand name beneath.
    const cardsMini = (combo: [Card, Card] | null): string => combo
      ? combo.map(c => `<span class="${isRed(c) ? "rc" : ""}">${cardDisplay(c)}</span>`).join(" ")
      : "—";
    const nutsItem = `<div class="br-item">
      <span class="br-label">Nuts</span>
      <span class="br-val br-cards">${cardsMini(S.boardRead.nutsCards)}</span>
      <span class="br-sub">${S.boardRead.nuts}</span>
    </div>`;
    const secondItem = S.boardRead.second
      ? `<div class="br-item">
          <span class="br-label">2nd nuts</span>
          <span class="br-val br-cards">${cardsMini(S.boardRead.secondCards)}</span>
          <span class="br-sub">${S.boardRead.second}</span>
        </div>`
      : "";
    boardReadHtml = `<div class="board-read">
      <div class="br-item"><span class="br-label">Strength</span><span class="br-val win">${eqStr}</span></div>
      ${nutsItem}
      ${secondItem}
      ${heldItem}
    </div>`;
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
  // In training the AI auto-plays the villains, so the action controls only
  // appear on YOUR turn. (In live mode you log every seat, so they show for all.)
  const showActions = !!gs && !S.handOver && next !== null && !needsBoard
    && (S.mode === "live" || next === S.heroSeat);

  // If there's a rec with amount, show it on the bet/raise button for one-tap action
  const recAmt = S.rec && S.rec.amount > 0 ? roundBet(S.rec.amount) : 0;
  const betLabel = recAmt > 0 && S.rec?.action === "bet" ? `Bet ${chipsBet(recAmt)}` : "Bet";
  const raiseLabel = recAmt > 0 && S.rec?.action === "raise" ? `Raise ${chipsBet(recAmt)}` : "Raise";

  // Multiway logging shortcuts: when it's an opponent's turn (live mode), batch
  // the obvious action for everyone up to the hero.
  const oppTurn = showActions && S.mode === "live" && next !== S.heroSeat;
  const quickHtml = oppTurn ? `
    <div class="quick-row">
      <button class="quick-btn" id="fold-to-me">⏩ Fold to me</button>
      ${gs!.currentBet === 0
        ? `<button class="quick-btn" id="check-to-me">⏩ Check to me</button>`
        : `<button class="quick-btn" id="call-to-me">⏩ Call to me</button>`}
    </div>` : "";

  // One-tap raise/bet sizes — for an opponent, so logging their raise is a
  // single tap (your own keeps the bet pad for considered sizing).
  const sizeRowHtml = oppTurn && (legal.includes("raise") || legal.includes("bet")) ? `
    <div class="size-row">
      ${sizeChips(gs!, next!).map((c) =>
        `<button class="size-chip" data-size="${c.bb}">${c.label}<span>${chipsBet(c.bb)}</span></button>`).join("")}
    </div>` : "";

  // Recap of the current street's action, for at-a-glance state checks.
  const recap = showActions && S.mode === "live" ? streetRecap(gs!) : "";
  const recapHtml = recap ? `<div class="recap-strip">${recap}</div>` : "";

  const actionsHtml = showActions ? `
    ${recapHtml}
    ${quickHtml}
    ${sizeRowHtml}
    <div class="action-bar">
      ${legal.includes("fold") ? `<button class="action-btn fold" data-act="fold">Fold</button>` : ""}
      ${legal.includes("check") ? `<button class="action-btn check" data-act="check">Check</button>` : ""}
      ${legal.includes("call") ? `<button class="action-btn call" data-act="call">Call ${chips(gs!.toCall(next!))}</button>` : ""}
      ${legal.includes("bet") ? `<button class="action-btn bet" data-open-bet="bet">${betLabel}</button>` : ""}
      ${legal.includes("raise") ? `<button class="action-btn raise" data-open-bet="raise">${raiseLabel}</button>` : ""}
    </div>` : "";

  app.innerHTML = `
    <div class="game ${S.handOver || S.trainingOver ? "hand-over" : ""}">
      <div class="game-topbar">
        <span>Hand #${S.handNumber}${S.mode === "training" ? " · <strong style=\"color:var(--violet)\">TRAINING</strong>" : ""}</span>
        <div class="topbar-btns">
          ${S.mode === "live" && S.undoStack.length > 0
            ? `<button class="hdr-btn undo" id="undo-btn" title="Undo ${S.undoStack[S.undoStack.length - 1]!.label}">↩ Undo</button>`
            : ""}
          <button class="hdr-btn" id="new-hand">New Hand</button>
        </div>
      </div>

      <div class="stage">
      <div class="table-wrap">
        <div class="poker-table" id="poker-table">
          <div class="felt"></div>
          ${seats}
          <div class="board-center" id="board-area">${boardHtml}</div>
        </div>
      </div>

      <div class="controls">
        <div class="controls-body">
          ${!S.handOver && !S.allInPrompt && !S.rit ? `<div class="status-bar ${isHeroTurn ? "your-turn" : ""}">${
            isHeroTurn ? "<strong>YOUR TURN</strong>" : S.message || ""
          }</div>` : ""}

          <div class="hero-area">
            <div class="hero-cards">${heroHtml}</div>
            ${gs ? `<div class="pot-line"><span class="table-pot">${chips(gs.pot)}</span><span class="pot-street">${gs.street.toUpperCase()}</span></div>` : ""}
            ${handLabelHtml}
            ${boardReadHtml}
            ${recHtml}
            ${canSolveGto() ? `<button class="gto-btn" id="gto-solve">${S.gtoSolving ? "Solving…" : "🧠 Solve GTO"}</button>` : ""}
          </div>
        </div>

        <div class="action-dock">${S.trainingOver ? renderTrainingOver()
          : S.allInPrompt ? renderAllInPrompt()
          : S.rit?.awaitWinner ? renderRunResult()
          : S.handOver ? renderHandResult(positions) : actionsHtml}</div>
      </div>
      </div>
    </div>`;
  S.dealAnim = null; // one-shot: consumed by this render
  S.flashSeat = null;

  // ── Events ──
  $("#new-hand")?.addEventListener("click", () => { S.screen = "setup"; S.dealerSeat = -1; S.handNumber = 0; render(); });
  document.getElementById("undo-btn")?.addEventListener("click", undo);
  document.getElementById("next-hand")?.addEventListener("click", nextHand);
  document.getElementById("train-again")?.addEventListener("click", () => {
    // Restart the tournament with the originally configured table size.
    S.trainingOver = null;
    S.tableSize = S.trainingStartSize;
    if (S.heroSeat >= S.tableSize) S.heroSeat = S.tableSize - 1;
    S.dealerSeat = -1;
    S.handNumber = 0;
    S.seatStacks = [];
    S.handOver = false;
    startTrainingHand();
  });
  document.getElementById("review-hand")?.addEventListener("click", () => { S.reviewOpen = true; renderReview(); });
  document.getElementById("gto-solve")?.addEventListener("click", startGtoSolve);

  // Showdown winner buttons (manual). Settlement handles side pots / uncalled.
  app.querySelectorAll("[data-winner]").forEach(btn =>
    btn.addEventListener("click", () => {
      const val = (btn as HTMLElement).dataset.winner!;
      const remaining = S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0);
      const winners = val === "split" ? remaining : [+val];
      const who = winners.length > 1 ? "Split pot"
        : winners[0] === S.heroSeat ? "You won" : `${S.gs!.positions[winners[0]!]!} won`;
      resolveLive(strengthFromWinners(S.gs!.stacks.length, winners), who);
    }),
  );

  // Showdown: enter a villain's cards
  app.querySelectorAll("[data-vcards]").forEach(btn =>
    btn.addEventListener("click", () => {
      S.pickerTarget = "villain";
      S.pickerVillainSeat = +(btn as HTMLElement).dataset.vcards!;
      S.pickerPicked = []; S.pickerRank = null;
      S.pickerOpen = true;
      renderPicker();
    }),
  );
  // Showdown: confirm the auto-computed winner
  document.getElementById("sd-confirm")?.addEventListener("click", () => {
    const remaining = S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0);
    const auto = computeShowdown(remaining, S.boardCards.slice(0, 5));
    if (auto) recordShowdownResult(auto.winners, auto.label, auto.strength);
  });

  // Run it once / twice
  document.getElementById("run-once")?.addEventListener("click", () => {
    S.allInPrompt = false; openBoardPicker();
  });
  document.getElementById("run-twice")?.addEventListener("click", startRunItTwice);
  // Run-it-twice per-run winner
  app.querySelectorAll("[data-runwinner]").forEach(btn =>
    btn.addEventListener("click", () => {
      const v = (btn as HTMLElement).dataset.runwinner!;
      if (v === "split") {
        ritRecordWinner(S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0));
      } else {
        ritRecordWinner([+v]);
      }
    }),
  );

  app.querySelectorAll("[data-act]").forEach(btn =>
    btn.addEventListener("click", () => {
      const act = (btn as HTMLElement).dataset.act as ActionType;
      const who = next === S.heroSeat ? "You" : (gs?.positions[next!] ?? "");
      pushUndo(`${who} ${act}`);
      doAction(next!, act);
    }),
  );
  document.getElementById("fold-to-me")?.addEventListener("click", () => { pushUndo("fold to you"); advanceOpponents("fold"); });
  document.getElementById("check-to-me")?.addEventListener("click", () => { pushUndo("check to you"); advanceOpponents("check"); });
  document.getElementById("call-to-me")?.addEventListener("click", () => { pushUndo("call to you"); advanceOpponents("call"); });
  app.querySelectorAll("[data-size]").forEach(btn =>
    btn.addEventListener("click", () => {
      S.raiseAmount = +(btn as HTMLElement).dataset.size!;
      const action: ActionType = gs!.currentBet > 0 ? "raise" : "bet";
      const who = next === S.heroSeat ? "You" : (gs?.positions[next!] ?? "");
      pushUndo(`${who} ${action}`);
      doAction(next!, action);
    }),
  );
  app.querySelectorAll("[data-open-bet]").forEach(btn =>
    btn.addEventListener("click", () => {
      S.betPadAction = (btn as HTMLElement).dataset.openBet as "bet" | "raise";
      S.betPadSeat = next!;
      // Pre-fill the amount only for YOUR own action — either the recommended
      // size or a standard open. For an OPPONENT you're recording what they
      // actually did, so open the pad blank and just key their number (presets
      // are still there for quick entry).
      if (next === S.heroSeat) {
        if (S.rec && S.rec.amount > 0 && (S.rec.action === "bet" || S.rec.action === "raise")) {
          S.raiseAmount = roundBet(S.rec.amount);
        } else {
          S.raiseAmount = roundBet(gs!.currentBet > 0
            ? minRaise(gs!.currentBet, gs!.bb)
            : openRaiseSize(gs!.bb));
        }
      } else {
        S.raiseAmount = 0; // blank — enter the opponent's actual size
      }
      S.betPadOpen = true;
      renderBetPad();
    }),
  );

  if (needsBoard) {
    document.getElementById("board-area")?.addEventListener("click", openBoardPicker);
  }

  // Tap a seat to set/correct its stack (rebuys) — live mode only.
  if (S.mode === "live") {
    app.querySelectorAll("[data-seatstack]").forEach(el =>
      el.addEventListener("click", () => {
        S.numpadSeat = +(el as HTMLElement).dataset.seatstack!;
        S.numpadRaw = "";
        openNumpad("seatstack");
      }),
    );
    // Tap the acting opponent's seat → toggle its inline action menu.
    app.querySelectorAll("[data-actmenu]").forEach(el =>
      el.addEventListener("click", () => {
        const seat = +(el as HTMLElement).dataset.actmenu!;
        S.seatMenuSeat = S.seatMenuSeat === seat ? null : seat;
        render();
      }),
    );
    // Pick an action from the inline seat menu.
    app.querySelectorAll("[data-seatact]").forEach(el =>
      el.addEventListener("click", () => {
        const seat = +(el as HTMLElement).dataset.seat!;
        const act = (el as HTMLElement).dataset.seatact!;
        const who = gs?.positions[seat] ?? "";
        S.seatMenuSeat = null;
        if (act === "betraise") {
          S.betPadAction = S.gs!.currentBet > 0 ? "raise" : "bet";
          S.betPadSeat = seat;
          S.raiseAmount = 0; // blank — enter the opponent's actual size
          S.betPadOpen = true;
          renderBetPad();
          return;
        }
        pushUndo(`${who} ${act}`);
        doAction(seat, act as ActionType);
      }),
    );
  }
}

// Batch the obvious action for every opponent up to the hero (live mode).
// Stops (rather than guessing) the moment the intended action isn't legal, so
// nobody is silently folded/called against the run of play.
function advanceOpponents(action: "fold" | "check" | "call"): void {
  let guard = 12;
  while (guard-- > 0) {
    const gs = S.gs;
    if (!gs || S.handOver) break;
    const next = gs.nextToAct();
    if (next === null || next === S.heroSeat) break;
    const legal = gs.legalActionsFor(next);
    let act: ActionType | null = null;
    if (legal.includes(action)) act = action;
    else if (action === "call" && legal.includes("check")) act = "check"; // nothing to call
    if (act === null) break;
    doAction(next, act);
    if (S.pickerOpen || S.allInPrompt) break; // a board/all-in step interrupted
  }
}

// ── Undo: snapshot/restore mid-hand state (live mode) ──
// Capture the current state before a user-initiated mutation. No-op outside
// live mode (training has an AI opponent and isn't hand-logged by tap).
function pushUndo(label: string): void {
  if (S.mode !== "live") return;
  S.undoStack.push({
    label,
    gs: S.gs ? S.gs.clone() : null,
    boardCards: [...S.boardCards],
    allDealt: new Set(S.allDealt),
    handOver: S.handOver,
    handResult: S.handResult,
    decisionLog: S.decisionLog.map((d) => ({ ...d })),
    showdownCards: new Map(S.showdownCards),
    allInPrompt: S.allInPrompt,
    message: S.message,
  });
  if (S.undoStack.length > 50) S.undoStack.shift();
}

function undo(): void {
  const s = S.undoStack.pop();
  if (!s) return;
  S.gs = s.gs;
  S.boardCards = s.boardCards;
  S.allDealt = s.allDealt;
  S.handOver = s.handOver;
  S.handResult = s.handResult;
  S.decisionLog = s.decisionLog;
  S.showdownCards = s.showdownCards;
  S.allInPrompt = s.allInPrompt;
  S.message = s.message;
  // Reverting an action reopens the betting; close any transient overlays and
  // recompute everything derived from the restored game state.
  S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
  S.betPadOpen = false;
  S.rit = null;
  document.getElementById("picker-modal")?.remove();
  document.getElementById("betpad-modal")?.remove();
  updateRec(); updateBoardRead(); updateMessage();
  render();
}

function doAction(seat: number, type: ActionType): void {
  if (!S.gs) return;
  S.seatMenuSeat = null; // any action closes an open inline seat menu
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
    const text = `${folderPos} folded — ${winnerPos} won`;
    if (S.mode === "live") {
      resolveLive(strengthFromWinners(S.gs.stacks.length, [winnerSeat]), text);
    } else {
      const won = trainingSettle(strengthFromWinners(S.gs.stacks.length, [winnerSeat]));
      const heroPnl = won[S.heroSeat]! - S.gs.invested[S.heroSeat]!;
      S.handResult = text;
      saveHandRecord(heroPnl);
      S.handOver = true; S.rec = null;
      updateMessage(); render();
    }
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

  // All players all-in with board still to come → offer run it once or twice.
  const anyCanAct = S.gs.stacks.some((s, i) => !S.gs!.folded[i] && s > 0);
  if (S.gs.roundComplete() && !anyCanAct && S.boardCards.length < 5) {
    S.allInPrompt = true; S.rec = null; updateMessage(); render();
    return;
  }
  if (S.gs.roundComplete() && !anyCanAct) {
    S.handResult = "showdown"; S.handOver = true; S.rec = null;
    updateMessage(); render();
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
    const remaining = S.gs.folded
      .map((f, i) => f ? null : i)
      .filter((i): i is number => i !== null);
    const villains = remaining.filter((i) => i !== S.heroSeat);
    const board5 = S.boardCards.slice(0, 5);

    // If every remaining villain's cards are keyed, read out the winner exactly.
    const allKeyed = board5.length === 5 && villains.every((i) => S.showdownCards.has(i));
    let autoBlock = "";
    if (allKeyed && S.heroCards) {
      const auto = computeShowdown(remaining, board5);
      if (auto) {
        const who = auto.winners.length > 1
          ? "Split pot"
          : auto.winners[0] === S.heroSeat ? "You win" : `${positions[auto.winners[0]!]} wins`;
        autoBlock = `
          <div class="result-text" style="margin-bottom:10px">${who} — ${auto.label}</div>
          <button class="result-btn hero" id="sd-confirm">Confirm & next hand</button>`;
      }
    }

    const villainCardRows = villains.map((i) => {
      const c = S.showdownCards.get(i);
      const cardsHtml = c
        ? `<span class="sd-cards"><span class="${isRed(c[0]) ? "r" : ""}">${cardDisplay(c[0])}</span> <span class="${isRed(c[1]) ? "r" : ""}">${cardDisplay(c[1])}</span></span>`
        : `<span class="sd-unknown">— —</span>`;
      return `<button class="sd-villain-row" data-vcards="${i}">
        <span class="sd-pos">${positions[i]}</span>${cardsHtml}<span class="sd-edit">${c ? "edit" : "tap to enter"}</span>
      </button>`;
    }).join("");

    return `
      <div class="result-panel">
        <div class="result-title">Showdown — ${chips(pot)} pot</div>
        <div class="result-question">Enter opponents' cards (optional) for an exact read:</div>
        <div class="sd-villains">${villainCardRows}</div>
        ${autoBlock || `
        <div class="result-question" style="margin-top:6px">…or just tap who won:</div>
        <div class="result-buttons">
          ${remaining.map(i =>
            `<button class="result-btn ${i === S.heroSeat ? "hero" : ""}" data-winner="${i}">
              ${i === S.heroSeat ? "You won" : positions[i] + " won"}
            </button>`
          ).join("")}
          <button class="result-btn split" data-winner="split">Split pot</button>
        </div>`}
      </div>`;
  }

  // Training showdown — reveal every opponent who was still in the hand.
  const shown = S.mode === "training" && S.handOver
    ? [...S.showdownCards.entries()].filter(([i]) => !S.gs!.folded[i])
    : [];
  const villainReveal = shown.length
    ? `<div class="villain-reveal">
        <span class="hint">Opponents' hands:</span>
        <div class="reveal-rows">
          ${shown.map(([i, c]) => `<div class="reveal-row">
            <span class="reveal-pos">${positions[i] ?? S.gs!.positions[i]}</span>
            <div class="reveal-cards">
              <div class="hero-card dealt ${isRed(c[0]) ? "red" : ""}" style="width:36px;height:50px;font-size:15px">${cardDisplay(c[0])}</div>
              <div class="hero-card dealt ${isRed(c[1]) ? "red" : ""}" style="width:36px;height:50px;font-size:15px">${cardDisplay(c[1])}</div>
            </div>
          </div>`).join("")}
        </div>
      </div>`
    : "";

  const reviewBtn = S.decisionLog.length
    ? `<button class="action-btn check" id="review-hand" style="flex:0 0 auto;padding:16px 14px">📋 Review</button>`
    : "";

  return `
    <div class="result-panel">
      ${villainReveal}
      <div class="result-text">${S.handResult}</div>
      <div class="action-bar" style="margin-top:10px">
        ${reviewBtn}
        <button class="action-btn raise" id="next-hand" style="font-size:16px;padding:16px">NEXT HAND</button>
      </div>
    </div>`;
}

// Post-hand review: compare each hero decision to the engine's recommendation.
function renderReview(): void {
  document.getElementById("review-modal")?.remove();
  if (!S.reviewOpen) return;

  const rows = S.decisionLog.map((d) => {
    const recAmt = d.rec.amount > 0 ? ` ${chipsBet(d.rec.amount)}` : "";
    const chosenAmt = d.chosenAmt > 0 ? ` ${chips(d.chosenAmt)}` : "";
    const matched = d.chosen === d.rec.action;
    const verdict = matched ? "✓ matched" : "✗ deviated";
    return `<div class="review-row ${matched ? "ok" : "bad"}">
      <div class="review-street">${d.street}</div>
      <div class="review-cmp">
        <span>You: <strong>${d.chosen}${chosenAmt}</strong></span>
        <span>Engine: <strong>${d.rec.action}${recAmt}</strong></span>
      </div>
      <div class="review-reason">${d.rec.reasoning}</div>
      <div class="review-verdict">${verdict}</div>
    </div>`;
  }).join("");

  const deviations = S.decisionLog.filter((d) => d.chosen !== d.rec.action).length;
  const summary = deviations === 0
    ? "Every decision matched the engine. 🎯"
    : `${deviations} of ${S.decisionLog.length} decisions deviated from the engine.`;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "review-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>Hand Review</h3>
      <div class="review-summary">${summary}</div>
      ${rows || `<div class="hint" style="text-align:center">No hero decisions to review.</div>`}
      <div class="modal-actions">
        <button class="confirm-btn" id="review-close">Close</button>
      </div>
    </div>`;
  app.appendChild(overlay);

  document.getElementById("review-close")?.addEventListener("click", () => {
    S.reviewOpen = false;
    document.getElementById("review-modal")?.remove();
  });
}

// Villain auto-play is STEPPED with a beat between actions so you actually see
// each opponent fold / call / bet / raise (and the bet chips land), instead of
// the table jumping straight to your turn.
let villainTimer: ReturnType<typeof setTimeout> | null = null;
function cancelVillainTimer(): void {
  if (villainTimer) { clearTimeout(villainTimer); villainTimer = null; }
}
function scheduleVillainStep(delay: number): void {
  cancelVillainTimer();
  villainTimer = setTimeout(villainStep, delay);
}

function autoPlayVillain(): void {
  if (S.mode !== "training") return;
  scheduleVillainStep(850);
}

function villainStep(): void {
  villainTimer = null;
  if (!S.gs || S.handOver || S.mode !== "training" || S.screen !== "game") return;
  if (S.pickerOpen || S.betPadOpen) { scheduleVillainStep(400); return; } // wait out overlays

  // Round done → deal the next street (or go to showdown), then continue.
  if (S.gs.roundComplete() && !S.gs.isComplete()) {
    animateChipsToPot(); // collect this street's bets into the pot
    if (S.gs.street === "river") { trainingShowdown(); return; }
    const anyCanAct = S.gs.stacks.some((s, i) => !S.gs!.folded[i] && s > 0);
    if (!anyCanAct) {
      // Everyone all-in — run the board out one street at a time, then showdown.
      S.dealAnim = { kind: "board", from: S.boardCards.length };
      const cards = getNextBoardCards();
      S.boardCards.push(...cards);
      S.gs.advanceStreet(cards);
      render();
      scheduleVillainStep(S.gs.street === "river" ? 1200 : 1000);
      return;
    }
    S.dealAnim = { kind: "board", from: S.boardCards.length };
    const cards = getNextBoardCards();
    S.boardCards.push(...cards);
    S.gs.advanceStreet(cards);
    updateRec(); updateMessage(); render();
    scheduleVillainStep(1150);
    return;
  }

  const next = S.gs.nextToAct();
  if (next === null || S.gs.isComplete()) {
    if (S.gs.isComplete() || (S.gs.roundComplete() && S.gs.street === "river")) trainingShowdown();
    return;
  }
  if (next === S.heroSeat) {
    updateRec(); updateMessage(); render();
    if (!S.handOver) playSound("turn");
    return; // your turn — wait for input
  }

  // One villain acts, using its own dealt hand and per-seat profile.
  const seatProfile = buildProfiles().get(next) ?? PROFILES[S.archetype]!;
  const seatCards = S.villainHands.get(next) ?? S.villainCards!;
  const vAct = villainDecision(S.gs, next, seatCards, seatProfile, () => Math.random());
  let action = vAct.type;
  // Round bet/raise sizes to clean chips (no fractional-cent bets), capped at
  // the stack and floored at a min-raise over the current bet.
  let amount = action === "bet" || action === "raise" ? roundBet(vAct.amount) : 0;
  if ((action === "bet" || action === "raise") && amount > 0) {
    const max = S.gs.stacks[next]! + S.gs.streetInvested[next]!;
    if (amount > max) amount = max;
    if (amount <= S.gs.currentBet) amount = Math.min(roundBet(S.gs.currentBet) + Math.max(1, roundBet(S.gs.bb)), max);
  }
  const legal = S.gs.legalActionsFor(next);
  if (action === "raise" && !legal.includes("raise")) { action = legal.includes("call") ? "call" : "check"; amount = 0; }
  if (action === "bet" && !legal.includes("bet")) { action = "check"; amount = 0; }
  if (action === "fold" && !legal.includes("fold")) { action = "check"; amount = 0; }

  S.gs.applyAction({ seat: next, type: action, amount });
  S.flashSeat = next; // pulse the seat that just acted
  playSound(action === "fold" ? "fold" : action === "check" ? "check" : "bet");

  // Villain folded everyone else out → hero (or last seat) wins outright.
  if (S.gs.activeSeatCount <= 1) {
    const winnerSeat = S.gs.folded.findIndex(f => !f);
    const winnerPos = winnerSeat === S.heroSeat ? "You" : S.gs.positions[winnerSeat]!;
    const folderPos = S.gs.positions[next]!;
    const won = trainingSettle(strengthFromWinners(S.gs.stacks.length, [winnerSeat]));
    S.handResult = `${folderPos} folded — ${winnerPos} won ${chips(won[winnerSeat]!)}`;
    const heroPnl = won[S.heroSeat]! - S.gs.invested[S.heroSeat]!;
    saveHandRecord(heroPnl);
    S.handOver = true; S.rec = null;
    updateMessage(); render();
    return;
  }

  updateRec(); updateMessage(); render();
  // Faster after a fold/check, a touch slower after chips go in.
  scheduleVillainStep(action === "fold" || action === "check" ? 1000 : 1400);
}

function getNextBoardCards(): Card[] {
  if (!S.gs) return [];
  const street = S.gs.street;
  if (street === "preflop") return [S.trainingBoardCards[0]!, S.trainingBoardCards[1]!, S.trainingBoardCards[2]!];
  if (street === "flop") return [S.trainingBoardCards[3]!];
  if (street === "turn") return [S.trainingBoardCards[4]!];
  return [];
}

// Settle the current training hand and write the result into the persistent
// tournament stacks. Returns the per-seat winnings.
function trainingSettle(strength: number[]): number[] {
  const gs = S.gs!;
  const won = settlePots(gs.invested, gs.folded.map((f) => !f), strength);
  for (let i = 0; i < gs.stacks.length; i++) S.seatStacks[i] = gs.stacks[i]! + won[i]!;
  return won;
}

// Drop seats whose players have left/busted (never the hero). Re-indexes the
// tournament stacks, per-seat maps, hero seat, dealer seat, and table size.
function dropSeats(seats: number[]): void {
  const drop = new Set(seats.filter((s) => s !== S.heroSeat));
  if (drop.size === 0) return;
  const n = getPositions(S.tableSize).length;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!drop.has(i)) keep.push(i);
  const newIndex = new Map<number, number>();
  keep.forEach((old, ni) => newIndex.set(old, ni));

  S.seatStacks = keep.map((i) => S.seatStacks[i] ?? S.stackBB);
  const remap = <T>(m: Map<number, T>): Map<number, T> => {
    const out = new Map<number, T>();
    for (const [k, v] of m) if (newIndex.has(k)) out.set(newIndex.get(k)!, v);
    return out;
  };
  S.playerStats = remap(S.playerStats);
  S.seatTypes = remap(S.seatTypes);
  S.heroSeat = newIndex.get(S.heroSeat)!;
  if (newIndex.has(S.dealerSeat)) {
    S.dealerSeat = newIndex.get(S.dealerSeat)!;
  } else {
    // Button seat left — pass it to the next surviving seat.
    let ds = 0;
    for (let k = 1; k <= n; k++) {
      const cand = (S.dealerSeat + k) % n;
      if (newIndex.has(cand)) { ds = newIndex.get(cand)!; break; }
    }
    S.dealerSeat = ds;
  }
  S.tableSize = keep.length;
}

// Training is a last-player-standing game: between hands, bust out anyone at 0
// chips. Hero busting ends the game; clearing the table wins it.
function advanceTrainingHand(): void {
  cancelVillainTimer();
  if ((S.seatStacks[S.heroSeat] ?? 0) < 1) { S.trainingOver = "bust"; S.handOver = true; render(); return; }
  const n = getPositions(S.tableSize).length;
  const busted: number[] = [];
  for (let i = 0; i < n; i++) if (i !== S.heroSeat && (S.seatStacks[i] ?? 0) < 1) busted.push(i);
  if (busted.length) dropSeats(busted);
  if (S.tableSize <= 1) { S.trainingOver = "win"; S.handOver = true; render(); return; }
  const nn = getPositions(S.tableSize).length;
  S.dealerSeat = (S.dealerSeat + 1) % nn; // button moves on
  startTrainingHand();
}

function trainingShowdown(): void {
  if (!S.gs || !S.heroCards) return;
  // Make sure full board is dealt
  while (S.boardCards.length < 5) {
    const cards = getNextBoardCards();
    if (cards.length === 0) break;
    S.boardCards.push(...cards);
    if (S.gs.street !== "river") S.gs.advanceStreet(cards);
  }

  const board5 = S.boardCards.slice(0, 5);
  const n = S.gs.stacks.length;
  const inHand = S.gs.folded.map((f) => !f);

  // Rank every seat still in the hand on the final board (true multiway).
  const strength = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!inHand[i]) continue;
    const cards = i === S.heroSeat ? S.heroCards : S.villainHands.get(i);
    if (!cards) continue;
    strength[i] = evaluate([cards[0], cards[1], ...board5]);
  }

  // Settle (handles multiway side pots) and persist tournament stacks. Reveal
  // every non-folded villain's hand.
  const won = trainingSettle(strength);
  for (let i = 0; i < n; i++) {
    if (i !== S.heroSeat && inHand[i] && S.villainHands.has(i)) {
      S.showdownCards.set(i, S.villainHands.get(i)!);
    }
  }
  const heroPnl = won[S.heroSeat]! - S.gs.invested[S.heroSeat]!;

  // Winner readout among contesting seats.
  let best = -1;
  for (let i = 0; i < n; i++) if (inHand[i] && strength[i]! > best) best = strength[i]!;
  const winners = [];
  for (let i = 0; i < n; i++) if (inHand[i] && strength[i] === best) winners.push(i);
  const label = best >= 0 ? nutLabel(
    (winners[0] === S.heroSeat ? S.heroCards : S.villainHands.get(winners[0]!))!, board5,
  ) : "";
  if (winners.length > 1) {
    S.handResult = `Split pot — ${label}`;
  } else if (winners[0] === S.heroSeat) {
    S.handResult = `You won ${chips(won[S.heroSeat]!)} — ${label}`;
  } else {
    S.handResult = `${S.gs.positions[winners[0]!]} won ${chips(won[winners[0]!]!)} — ${label}`;
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

// Determine the winner(s) from keyed cards. Returns winning seats + hand label.
function computeShowdown(remaining: number[], board5: Card[]):
  { winners: number[]; label: string; strength: number[] } | null {
  if (!S.heroCards || board5.length < 5) return null;
  const strength = new Array<number>(S.gs!.stacks.length).fill(0);
  const rankBy = new Map<number, number>();
  for (const i of remaining) {
    const cards = i === S.heroSeat ? S.heroCards : S.showdownCards.get(i);
    if (!cards) return null;
    const r = evaluate([cards[0], cards[1], ...board5]);
    rankBy.set(i, r);
    strength[i] = r;
  }
  const max = Math.max(...rankBy.values());
  const winners = remaining.filter((i) => rankBy.get(i) === max);
  const w = winners[0]!;
  const wc = w === S.heroSeat ? S.heroCards : S.showdownCards.get(w)!;
  return { winners, label: describeHand(wc, board5).label, strength };
}

// Settle the pot (side pots / uncalled returns), update running stacks, record.
function resolveLive(strength: number[], resultText: string): void {
  const gs = S.gs;
  if (!gs) return;
  const won = settlePots(gs.invested, gs.folded.map((f) => !f), strength);
  for (let i = 0; i < gs.stacks.length; i++) S.seatStacks[i] = gs.stacks[i]! + won[i]!;
  const heroPnl = won[S.heroSeat]! - gs.invested[S.heroSeat]!;
  S.handResult = resultText;
  saveHandRecord(heroPnl);
  S.handOver = true; S.rec = null;
  // The hand is now persisted (stats + history) — undoing past this point would
  // leave that record dangling, so the trail ends here.
  S.undoStack = [];
  render();
}

function recordShowdownResult(winners: number[], label: string, strength?: number[]): void {
  const gs = S.gs;
  if (!gs) return;
  const str = strength ?? strengthFromWinners(gs.stacks.length, winners);
  const who = winners.length > 1 ? "Split pot"
    : winners[0] === S.heroSeat ? "You" : gs.positions[winners[0]!]!;
  const text = winners.length > 1 ? `Split pot — ${label}` : `${who} won — ${label}`;
  resolveLive(str, text);
}

// ── Run it twice ──
function renderTrainingOver(): string {
  const win = S.trainingOver === "win";
  const stack = chips(S.seatStacks[S.heroSeat] ?? 0);
  return `<div class="result-panel">
    <div class="result-title">${win ? "🏆 You won the table!" : "💀 You busted out"}</div>
    <div class="result-text">${win
      ? `Every opponent is out of chips after ${S.handNumber} hands. Final stack ${stack}.`
      : `Your stack hit zero after ${S.handNumber} hands. Grow it next time.`}</div>
    <div class="action-bar" style="margin-top:12px">
      <button class="action-btn raise" id="train-again" style="font-size:16px;padding:16px">NEW GAME</button>
    </div>
  </div>`;
}

function renderAllInPrompt(): string {
  const gs = S.gs!;
  const left = 5 - S.boardCards.length;
  const streets = left >= 5 ? "Flop, turn & river" : left >= 2 ? "Turn & river" : "River";
  return `<div class="result-panel">
    <div class="result-title">All in! ${chips(gs.pot)} pot</div>
    <div class="result-question">${streets} to come — run it…</div>
    <div class="result-buttons">
      <button class="result-btn hero" id="run-once">Run it once</button>
      <button class="result-btn split" id="run-twice">Run it twice</button>
    </div>
  </div>`;
}

function renderRunResult(): string {
  const gs = S.gs!;
  const remaining = gs.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0);
  const n = S.rit!.run + 1;
  return `<div class="result-panel">
    <div class="result-title">Run ${n} of 2 — who won?</div>
    <div class="result-buttons">
      ${remaining.map((i) =>
        `<button class="result-btn ${i === S.heroSeat ? "hero" : ""}" data-runwinner="${i}">${i === S.heroSeat ? "You" : gs.positions[i]} won run ${n}</button>`
      ).join("")}
      <button class="result-btn split" data-runwinner="split">Split run ${n}</button>
    </div>
  </div>`;
}

function startRunItTwice(): void {
  S.allInPrompt = false;
  S.rit = { run: 0, baseLen: S.boardCards.length, won: new Array(S.gs!.stacks.length).fill(0), summary: [], awaitWinner: false };
  S.pickerTarget = "run"; S.pickerPicked = []; S.pickerRank = null; S.pickerOpen = true;
  render();
}

function ritBoardEntered(cards: Card[]): void {
  for (const c of cards) { S.boardCards.push(c); S.allDealt.add(c); }
  playSound("card");
  S.rit!.awaitWinner = true;
  S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
  document.getElementById("picker-modal")?.remove();
  render();
}

function ritRecordWinner(winners: number[]): void {
  const rit = S.rit!; const gs = S.gs!;
  // Each run contests half the pot; settle it (side pots) and accumulate.
  const runWon = settlePots(gs.invested, gs.folded.map((f) => !f), strengthFromWinners(gs.stacks.length, winners));
  for (let i = 0; i < gs.stacks.length; i++) rit.won[i]! += runWon[i]! / 2;
  const runBoard = S.boardCards.slice(rit.baseLen).map(cardDisplay).join(" ");
  const who = winners.length > 1 ? "Split" : winners[0] === S.heroSeat ? "You" : gs.positions[winners[0]!]!;
  rit.summary.push(`Run ${rit.run + 1} (${runBoard}): ${who}`);
  rit.awaitWinner = false;
  if (rit.run === 0) {
    S.boardCards = S.boardCards.slice(0, rit.baseLen); // reset for run 2 (dealt cards stay excluded)
    rit.run = 1;
    S.pickerTarget = "run"; S.pickerPicked = []; S.pickerRank = null; S.pickerOpen = true;
    render();
  } else {
    for (let i = 0; i < gs.stacks.length; i++) S.seatStacks[i] = gs.stacks[i]! + rit.won[i]!;
    const heroPnl = rit.won[S.heroSeat]! - gs.invested[S.heroSeat]!;
    S.handResult = `Run it twice — ${rit.summary.join(" · ")}`;
    saveHandRecord(heroPnl);
    S.handOver = true; S.rec = null; S.rit = null;
    render();
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

/* ═══════════════════ CARD PICKER (rank → suit) ═══════════════════ */

function renderPicker(): void {
  document.getElementById("picker-modal")?.remove();

  const needed = S.pickerTarget === "run" ? Math.max(1, 5 - S.boardCards.length)
    : (S.pickerTarget === "hero" || S.pickerTarget === "villain") ? 2
    : S.pickerTarget === "flop" ? 3 : 1;
  const villPos = S.gs?.positions[S.pickerVillainSeat] ?? "opponent";
  const title = S.pickerTarget === "hero" ? "Pick your hole cards"
    : S.pickerTarget === "villain" ? `Enter ${villPos}'s cards`
    : S.pickerTarget === "run" ? `Run ${(S.rit?.run ?? 0) + 1} — deal the runout`
    : S.pickerTarget === "flop" ? "Deal the flop"
    : S.pickerTarget === "turn" ? "Deal the turn" : "Deal the river";

  const pickedDisp = S.pickerPicked.map(c =>
    `<span class="picked-tag ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</span>`
  ).join("");

  // Single screen: ranks on top, suits below. Tap a rank, then a suit.
  const selR = S.pickerRank;
  const rankGrid = Array.from({ length: 13 }, (_, r) => {
    const allUsed = [0, 1, 2, 3].every(s => S.allDealt.has(makeCard(r, s)) || S.pickerPicked.includes(makeCard(r, s)));
    const sel = selR === r ? "sel" : "";
    return `<button class="rank-btn ${allUsed ? "used" : ""} ${sel}" data-rank="${r}">${RANKS[r]}</button>`;
  }).join("");

  const suitRow = [0, 1, 2, 3].map(s => {
    const disabled = selR === null;
    const used = selR !== null && (S.allDealt.has(makeCard(selR, s)) || S.pickerPicked.includes(makeCard(selR, s)));
    const red = SUIT_RED[s] ? "red" : "";
    return `<button class="suit-btn ${red} ${used || disabled ? "used" : ""}" data-suit="${s}">${SUITS[s]}</button>`;
  }).join("");

  const hint = selR === null ? "Tap a rank, then its suit" : `${RANKS[selR]} — now tap the suit`;
  const canConfirm = S.pickerPicked.length === needed;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "picker-modal";
  overlay.innerHTML = `
    <div class="modal-content picker-single">
      <h3>${title} (${S.pickerPicked.length}/${needed})</h3>
      ${pickedDisp ? `<div class="picked-row">${pickedDisp}</div>` : ""}
      <div class="pick-label">${hint}</div>
      <div class="rank-grid big">${rankGrid}</div>
      <div class="suit-row">${suitRow}</div>
      <div class="modal-actions">
        <button class="cancel-btn" id="picker-cancel">Cancel</button>
        <button class="confirm-btn" id="picker-confirm" ${canConfirm ? "" : "disabled"}>Confirm</button>
      </div>
    </div>`;

  app.appendChild(overlay);

  // Rank: highlight in place + enable its suits — NO full re-render (no flash).
  overlay.querySelectorAll(".rank-btn:not(.used)").forEach(btn =>
    btn.addEventListener("click", () => {
      const r = +(btn as HTMLElement).dataset.rank!;
      S.pickerRank = r;
      overlay.querySelectorAll(".rank-btn").forEach(b => b.classList.toggle("sel", b === btn));
      overlay.querySelectorAll(".suit-btn").forEach(b => {
        const s = +(b as HTMLElement).dataset.suit!;
        b.classList.toggle("used", S.allDealt.has(makeCard(r, s)) || S.pickerPicked.includes(makeCard(r, s)));
      });
      const hintEl = overlay.querySelector(".pick-label");
      if (hintEl) hintEl.textContent = `${RANKS[r]} — now tap the suit`;
    }),
  );

  // Suit: commit the card once a rank is selected. Handlers on ALL suit buttons
  // (they get enabled in place above), guarded by the live "used" state.
  overlay.querySelectorAll(".suit-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      if (S.pickerRank === null || btn.classList.contains("used")) return;
      const card = makeCard(S.pickerRank, +(btn as HTMLElement).dataset.suit!);
      S.pickerPicked.push(card);
      S.pickerRank = null;
      playSound("card");
      if (S.pickerPicked.length === needed) { confirmPicker(); return; }
      renderPicker(); // a card was placed — rebuild for the next one
    }),
  );

  document.getElementById("picker-cancel")?.addEventListener("click", () => {
    S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    if (!S.heroCards) { S.screen = "setup"; render(); }
  });

  document.getElementById("picker-confirm")?.addEventListener("click", confirmPicker);
}

function confirmPicker(): void {
  const needed = S.pickerTarget === "run" ? Math.max(1, 5 - S.boardCards.length)
    : (S.pickerTarget === "hero" || S.pickerTarget === "villain") ? 2
    : S.pickerTarget === "flop" ? 3 : 1;
  if (S.pickerPicked.length !== needed) return;

  if (S.pickerTarget === "run") {
    ritBoardEntered([...S.pickerPicked]);
    return;
  }

  if (S.pickerTarget === "villain") {
    const [a, b] = S.pickerPicked;
    const combo: [Card, Card] = a! <= b! ? [a!, b!] : [b!, a!];
    const prev = S.showdownCards.get(S.pickerVillainSeat);
    if (prev) { S.allDealt.delete(prev[0]); S.allDealt.delete(prev[1]); }
    S.showdownCards.set(S.pickerVillainSeat, combo);
    S.allDealt.add(combo[0]); S.allDealt.add(combo[1]);
    S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    render();
    return;
  }

  if (S.pickerTarget === "hero") {
    const [a, b] = S.pickerPicked;
    S.heroCards = a! <= b! ? [a!, b!] : [b!, a!];
    S.allDealt.add(a!); S.allDealt.add(b!);
    S.dealAnim = { kind: "hero", from: 0 };
    playSound("deal");
    initGameState();
  } else {
    pushUndo(`deal ${S.pickerTarget}`);
    const dealt = [...S.pickerPicked]; // capture before clearing
    S.dealAnim = { kind: "board", from: S.boardCards.length };
    for (const c of dealt) { S.boardCards.push(c); S.allDealt.add(c); }
    playSound("card");
    S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    animateChipsToPot(); // collect the prior street's bets into the pot
    if (S.gs) {
      S.gs.advanceStreet(dealt); // push the real cards into the game state's board
      const anyCanAct = S.gs.stacks.some((s, i) => !S.gs!.folded[i] && s > 0);
      // Hand finished (river dealt, or all-in runout complete) → go to showdown.
      if (S.gs.isComplete() || (S.gs.street === "river" && S.gs.roundComplete())) {
        S.handResult = "showdown"; S.handOver = true; S.rec = null;
        updateMessage(); render();
        return;
      }
      // Still all-in with more board to come → immediately prompt the next street.
      if (S.gs.roundComplete() && !anyCanAct) {
        openBoardPicker();
        return;
      }
      updateRec(); updateMessage();
    }
    render();
    return;
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

  // Increment buttons ADD to the current amount (tap +Pot to add a pot, +BB to
  // add a blind). "All-in" sets the max.
  const incs = [
    { label: "+ BB", inc: roundBet(gs.bb) },
    { label: "+ ½ Pot", inc: roundBet(potBB * 0.5) },
    { label: "+ Pot", inc: roundBet(potBB) },
  ];

  const prefillBB = S.raiseAmount; // the recommended size — a SUGGESTION
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.id = "betpad-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${label}</h3>
      <div class="betpad-display suggested" id="bp-display">${display}</div>
      <div class="betpad-presets">
        ${incs.map(p => `<button class="preset-btn" data-inc="${p.inc}">${p.label}<br><span>${chipsBet(p.inc)}</span></button>`).join("")}
        <button class="preset-btn" data-set="${maxBB}">All-in<br><span>${chipsBet(maxBB)}</span></button>
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

  let raw = "";          // the user's own entry (dollars); empty until they touch it
  let touched = false;   // false = still showing the prefilled suggestion
  const fmt = (d: number) => (d % 1 === 0 ? String(d) : d.toFixed(2));

  function refresh() {
    const el = document.getElementById("bp-display");
    if (!touched) {
      S.raiseAmount = prefillBB;
      if (el) { el.textContent = prefillBB > 0 ? chipsBet(prefillBB) : "$0"; el.classList.add("suggested"); }
    } else {
      S.raiseAmount = roundBet((parseFloat(raw) || 0) / S.bbValue);
      if (el) { el.textContent = raw ? `$${raw}` : "$0"; el.classList.remove("suggested"); }
    }
  }

  // Current entered dollars (the suggestion is discarded the moment you touch it).
  const curDollars = () => (touched ? parseFloat(raw) || 0 : 0);

  overlay.querySelectorAll(".numpad-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const k = (btn as HTMLElement).dataset.key!;
      if (!touched) { touched = true; raw = ""; } // first keystroke clears the suggestion
      if (k === "⌫") raw = raw.slice(0, -1);
      else if (k === ".") { if (!raw.includes(".")) raw = (raw || "0") + "."; }
      else raw += k;
      refresh();
    }),
  );

  overlay.querySelectorAll(".preset-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const el = btn as HTMLElement;
      let dollars: number;
      if (el.dataset.set !== undefined) {
        dollars = roundBet(+el.dataset.set!) * S.bbValue; // All-in: set
      } else {
        dollars = curDollars() + roundBet(+el.dataset.inc!) * S.bbValue; // add increment
      }
      touched = true;
      raw = fmt(roundBet(dollars / S.bbValue) * S.bbValue);
      refresh();
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
    const who = seat === S.heroSeat ? "You" : (S.gs?.positions[seat] ?? "");
    pushUndo(`${who} ${S.betPadAction}`);
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
      ${allHands.length > 0 ? `<button class="hdr-btn" id="export-csv" style="width:100%;padding:12px;margin-top:4px;font-size:13px">Export CSV</button>` : ""}
      ${allHands.length > 0 ? `<button class="hdr-btn" id="clear-hist" style="width:100%;padding:12px;margin-top:4px;font-size:13px;color:var(--red)">Clear All History</button>` : ""}
    </div>`;

  document.getElementById("back-setup")?.addEventListener("click", () => {
    S.screen = "setup"; render();
  });
  document.getElementById("export-csv")?.addEventListener("click", () => exportCsv(allHands));
  document.getElementById("clear-hist")?.addEventListener("click", () => {
    if (confirm("Clear all hand history?")) {
      clearHistory().then(() => { S.sessionStart = Date.now(); render(); });
    }
  });
}

function exportCsv(hands: HandRecord[]): void {
  const head = ["hand", "time", "tableSize", "heroCards", "board", "pot", "result", "heroPnl"];
  const rows = hands.map((hd, i) => {
    const hc = hd.heroCards.map(cardDisplay).join(" ");
    const bd = hd.boardCards.map(cardDisplay).join(" ");
    const t = new Date(hd.timestamp).toISOString();
    const res = `"${hd.result.replace(/"/g, "'")}"`;
    return [i + 1, t, hd.tableSize, hc, bd, hd.pot.toFixed(2), res, hd.heroPnl.toFixed(2)].join(",");
  });
  const csv = [head.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `montecarloedge-hands-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════ INIT ═══════════════════ */

// Register the service worker for offline / installable PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

loadPlayerStats();
render();
