import { type Card, rankOf, suitOf, makeCard, NUM_CARDS } from "../engine/cards.js";
import { type Combo, Range } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { getPositions, positionsForButton, getRfiRange, getBbDefenseRange } from "../engine/charts/index.js";
import { estimateVillainRange, credibleRep, repIsPolar, scoreRunout, sizeClass, repsCapped } from "../engine/opponent.js";
import { solveSubgame, type RiverResult, type ActionFreq } from "../engine/gto/river-solver.js";
import { solvePushFold, handClassKey, type PushFoldResult } from "../engine/gto/pushfold.js";
import { allCombos, topSlice } from "../engine/hand-strength.js";
import { recommend, type Recommendation, type ProfileMap, type IcmConfig, type HeroStyle } from "../engine/decision.js";
import { PAYOUT_PRESETS } from "../engine/icm.js";
import morphdom from "morphdom";

// Hero play-style presets — dial your own strategy (the "no aggression adjuster"
// gap). aggression scales bluff/barrel/value-thinness/3-bet width; looseness
// scales open/call/defense width.
const HERO_STYLES: Record<string, { label: string; style: HeroStyle; blurb: string }> = {
  gto: { label: "Balanced (GTO)", style: { aggression: 1.0, looseness: 1.0 }, blurb: "Solver-baseline, hard to exploit." },
  tag: { label: "Tight-Aggressive", style: { aggression: 1.15, looseness: 0.82 }, blurb: "Fewer hands, bet/raise them hard." },
  lag: { label: "Loose-Aggressive", style: { aggression: 1.35, looseness: 1.28 }, blurb: "Wide, lots of pressure & bluffs." },
  nit: { label: "Tight / Cautious", style: { aggression: 0.75, looseness: 0.7 }, blurb: "Premiums only, minimal bluffing." },
  maniac: { label: "Maniac", style: { aggression: 1.6, looseness: 1.5 }, blurb: "Max aggression — high variance." },
};
import { gradeDecision, SRC_WORD } from "../engine/grade.js";
import { AUTO, TAG, LAG, STATION, NIT, type OpponentProfile } from "../engine/opponent.js";
import { villainDecision } from "../engine/villain-ai.js";
import { evaluate } from "../engine/evaluator.js";
import { describeHand, nutLabel, readThreats, type Threat } from "../engine/made-hand.js";
import { monteCarloEquityMultiway } from "../engine/equity.js";
import { settlePots, strengthFromWinners } from "../engine/settle.js";
import { openRaiseSize, minRaise } from "../engine/sizing.js";
import { saveHand, getSessionHands, clearHistory, computeStats, type HandRecord, type SessionStats } from "../engine/hand-history.js";
import { emptyStats, observeHand, blendProfile, playerRead, playerTag, type PlayerStats } from "../engine/player-model.js";
import * as MP from "../mp/mp-engine.js";
import type { AuthTable } from "../mp/mp-engine.js";
import type { MPAction, MPUser } from "../mp/types.js";
import * as FB from "../mp/firebase-adapter.js";
import { LEGAL_INTRO, LEGAL_SECTIONS, EXPLAINER_INTRO, EXPLAINER_SECTIONS, type Section } from "./content.js";
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
  screen: "home" | "setup" | "game" | "stats" | "leaks" | "mp-setup" | "mp-table" | "mp-lobby" | "profile" | "settings" | "legal" | "explainer";
  // Player profile (local-first; syncs name/avatar to Firestore when signed in).
  profile: { nickname: string; avatar: string; chips: number };
  // Multiplayer / benchmark (Phase 0 hot-seat + Phase 1 online lobby).
  mp: {
    table: AuthTable | null;
    setup: { players: { name: string; assisted: boolean; ai: string | null }[]; tier: number; sb: number; bb: number; buyIn: number };
    reveal: boolean;          // hot-seat: active player's hole cards revealed
    rec: Recommendation | null;
    auth: MPUser | null;      // signed-in Google user (Phase 1)
    online: { uid: string; name: string }[]; // live presence list
    authBusy: boolean;        // sign-in in flight
    authErr: string;
  };
  mode: "live" | "training";
  sessionStart: number;
  tableSize: number;
  stackBB: number;
  bbValue: number;
  sbValue: number;
  sbManual: boolean; // true once SB is edited directly → stops auto-tracking BB/2
  heroSeat: number;
  dealerSeat: number;
  handNumber: number;
  // Live mode: running per-seat stacks (bb) carried across the session.
  seatStacks: number[];
  archetype: string;
  // Tournament (ICM) mode: when on, push/fold & call-offs use the bubble factor
  // from the table's chip stacks + this payout preset (else cash chip-EV).
  tournament: boolean;
  payoutPreset: string; // key into PAYOUT_PRESETS
  heroStyle: string; // key into HERO_STYLES — your own play style
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
  // Stage 3 — decision grading / coaching feedback. Running session accuracy
  // against the recommendation (mix-aware where a solver gave frequencies).
  gradeStats: { n: number; pts: number; gto: number; mixed: number; off: number };
  lastGrade: { label: string; cls: string } | null;
  // Training "addictiveness": a consecutive-correct streak + one-shot verdict
  // flash drive the dopamine loop. bestStreak persists across sessions.
  streak: number;
  bestStreak: number;
  flashVerdict: "ok" | "bad" | null;
  celebrate: boolean; // one-shot: hero won the pot → table glow
  winnerSeat: number[] | null;   // seats that won the last hand (highlight); cleared on new hand
  potFlyPending: number[] | null; // one-shot: play pot→winner chip travel after next render
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
  boardRead: {
    equity: number | null; made: Threat[]; draws: Threat[];
    // "Story" reads: what aggression represents on this board (no hole-card peeking).
    heroStory: { label: string; cred: string; betToRep: string; capped: boolean } | null;
    villainStory: { label: string; bluffPct: number; note: string; lean: "call" | "careful" | "raise" | ""; size: string } | null;
  } | null;
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
  // One-shot: seat that just folded → plays a card-muck toss animation.
  foldAnim: number | null;
  // Per-seat player names (session-stable; positions still rotate per hand).
  seatNames: string[];
  // Training tournament: end state + the configured starting table size (so
  // "New Game" can rebuild the full table after players have busted out).
  trainingOver: "win" | "bust" | null;
  trainingStartSize: number;
}

const S: AppState = {
  screen: "home",
  profile: { nickname: "You", avatar: "", chips: 10000 },
  mp: {
    table: null,
    setup: {
      players: [{ name: "You", assisted: true, ai: null }, { name: "Rey", assisted: false, ai: "TAG" }],
      tier: 0, sb: 50, bb: 100, buyIn: 10000,
    },
    reveal: false,
    rec: null,
    auth: null,
    online: [],
    authBusy: false,
    authErr: "",
  },
  mode: "live",
  sessionStart: Date.now(),
  tableSize: 6,
  stackBB: 100,
  bbValue: 1,
  sbValue: 0.5,
  sbManual: false,
  heroSeat: 3,
  dealerSeat: -1,
  handNumber: 0,
  seatStacks: [],
  archetype: "Auto",
  tournament: false,
  payoutPreset: "top3",
  heroStyle: "gto",
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
  gradeStats: { n: 0, pts: 0, gto: 0, mixed: 0, off: 0 },
  lastGrade: null,
  streak: 0,
  bestStreak: Number(localStorage.getItem("mce-beststreak") || 0),
  flashVerdict: null,
  celebrate: false,
  winnerSeat: null,
  potFlyPending: null,
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
  foldAnim: null,
  seatNames: [],
  trainingOver: null,
  trainingStartSize: 6,
};

// Cache push/fold solutions by effective-stack depth (equity table is reused).
const pushFoldCache = new Map<number, PushFoldResult>();

// Cache live CFR subgame solves by spot signature so each spot is solved once
// and reused across renders (the solve is too slow to run every frame).
const liveSolveCache = new Map<string, RiverResult>();
// Spot key currently being solved in the background (avoids duplicate solves).
let liveSolveInFlight: string | null = null;

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

// ── DOM morphing (render refactor) ──
// The screens still assign `app.innerHTML = <template>`, but we intercept that
// setter and MORPH the existing DOM to the new HTML instead of nuking it. Kept
// nodes survive, so CSS transitions on persistent elements work and there's far
// less jank. morphdom mutates child nodes directly and never reads app.innerHTML,
// so there's no recursion. Modals mount on document.body (outside `app`) so the
// morph never deletes them. Event handlers are assigned as .onclick/.onchange
// PROPERTIES (via onEl/onId), which is idempotent under node-reuse — re-running
// the wiring each render just overwrites, so no double-binding and no full
// event-delegation rewrite was needed.
Object.defineProperty(app, "innerHTML", {
  configurable: true,
  get(): string { return ""; }, // never read by our code; morphdom reads live nodes
  set(html: string) {
    morphdom(app, `<div>${html}</div>`, {
      childrenOnly: true,
      // Clear property handlers on every REUSED node before re-wiring. Nodes now
      // persist across renders, so a handler attached CONDITIONALLY (e.g.
      // #board-area's openBoardPicker only when needsBoard) would otherwise
      // linger after the condition turns false. render() re-runs ALL wiring
      // immediately after this morph, so every handler still needed is re-added.
      onBeforeElUpdated(fromEl: HTMLElement): boolean {
        if (fromEl.onclick) fromEl.onclick = null;
        if (fromEl.onchange) fromEl.onchange = null;
        return true;
      },
    });
  },
});
function onEl(el: Element | null | undefined, ev: "click" | "change", fn: (e: Event) => void): void {
  if (el) (el as unknown as Record<string, unknown>)["on" + ev] = fn;
}
function onId(id: string, ev: "click" | "change", fn: (e: Event) => void): void {
  onEl(document.getElementById(id), ev, fn);
}

// A revealed card's two faces (front = rank/suit, back = card-back). The outer
// .board-card/.hero-card becomes the 3D container; .deal-in flips inner back→front.
function flipFaces(content: string): string {
  return `<div class="flip-inner"><div class="flip-front">${content}</div><div class="flip-back"></div></div>`;
}

function cardDisplay(c: Card): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}
function isRed(c: Card): boolean {
  return SUIT_RED[suitOf(c)]!;
}
function roundBet(bb: number): number {
  const unit = S.sbValue / S.bbValue;
  if (!(unit > 0)) return bb; // guard: never divide by a 0/NaN SB unit
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
  if (S.screen === "home") renderHome();
  else if (S.screen === "profile") renderProfile();
  else if (S.screen === "settings") renderSettings();
  else if (S.screen === "legal") renderLegal();
  else if (S.screen === "explainer") renderExplainer();
  else if (S.screen === "setup") renderSetup();
  else if (S.screen === "stats") renderStats();
  else if (S.screen === "leaks") renderLeaks();
  else if (S.screen === "mp-setup") renderMpSetup();
  else if (S.screen === "mp-lobby") renderMpLobby();
  else if (S.screen === "mp-table") renderMpTable();
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
  document.body.appendChild(overlay);

  onId("np-remove", "click", () => {
    const seat = S.numpadSeat;
    S.numpadTarget = null; S.numpadRaw = "";
    document.getElementById("numpad-modal")?.remove();
    removePlayer(seat);
  });

  overlay.querySelectorAll(".numpad-btn").forEach(btn =>
    onEl(btn, "click", () => {
      const k = (btn as HTMLElement).dataset.key!;
      if (k === "⌫") S.numpadRaw = S.numpadRaw.slice(0, -1);
      else if (k === ".") { if (!S.numpadRaw.includes(".")) S.numpadRaw = (S.numpadRaw || "0") + "."; }
      else S.numpadRaw += k;
      const d = overlay.querySelector(".betpad-display");
      if (d) d.textContent = `${unit}${S.numpadRaw || "0"}`;
    }),
  );

  onId("np-cancel", "click", () => {
    S.numpadTarget = null; S.numpadRaw = "";
    document.getElementById("numpad-modal")?.remove();
  });
  onId("np-confirm", "click", () => {
    const v = parseFloat(S.numpadRaw);
    if (!isNaN(v) && v > 0) {
      if (target === "sb") {
        S.sbValue = Math.min(v, S.bbValue); // SB can't exceed BB
        // Editing SB locks it — UNLESS it's exactly half the BB, which returns
        // it to auto-tracking (an in-session path back to the default behaviour).
        S.sbManual = Math.abs(S.sbValue - S.bbValue / 2) > 1e-9;
      } else if (target === "bb") {
        S.bbValue = v;
        // SB auto-follows to half the BB unless the user set it manually; either
        // way keep it in (0, BB].
        if (!S.sbManual) S.sbValue = Math.max(0.01, Math.round((v / 2) * 100) / 100);
        else if (S.sbValue > S.bbValue) S.sbValue = S.bbValue;
      } else if (target === "seatstack") {
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

// ── Live CFR solver on the recommendation path ──
// For the spots the subgame solver actually models well — heads-up, postflop,
// hero FIRST TO ACT (the check/bet decision) — we solve in the background and let
// the result DRIVE the recommendation (labeled "solver"), with the MC-equity
// heuristic as the instant fallback shown until the solve lands. Facing a bet,
// multiway, and preflop stay on their own sources (heuristic/chart/nash).
function liveSolverSpot(): string | null {
  const gs = S.gs;
  if (!gs || !S.heroCards || S.handOver || S.trainingOver) return null;
  if (gs.nextToAct() !== S.heroSeat) return null;
  if (activeVillains().length !== 1) return null;
  // RIVER ONLY: the river is a single exact subgame that converges well at ~12k
  // iterations in ~300ms — fast AND accurate. Flop/turn need 20k-80k iters
  // (seconds) to converge; solving them live at low iters yields noisy near-
  // uniform mixes that would be dishonest to label "GTO solved". They stay on the
  // heuristic until a precomputed blueprint stage. (The manual "Solve GTO" button
  // still solves flop/turn on demand, where a longer "Solving…" wait is fine.)
  if (gs.street !== "river") return null;
  if (gs.toCall(S.heroSeat) > 0.0001) return null; // solver models hero leading
  const eff = Math.min(gs.stacks[S.heroSeat]!, gs.stacks[activeVillains()[0]!]!);
  return `${gs.street}|${gs.board.join(",")}|${S.heroCards[0]},${S.heroCards[1]}|p${Math.round(gs.pot)}|s${Math.round(eff)}`;
}

function ensureLiveSolve(key: string): void {
  if (liveSolveCache.has(key) || liveSolveInFlight === key) return;
  liveSolveInFlight = key;
  // Yield so the heuristic paints first; the CFR run is synchronous.
  setTimeout(() => runLiveSolve(key), 20);
}

function runLiveSolve(key: string): void {
  const gs = S.gs;
  // The spot may have advanced while this was queued — only solve if still current.
  if (!gs || !S.heroCards || liveSolverSpot() !== key) {
    if (liveSolveInFlight === key) liveSolveInFlight = null;
    return;
  }
  const villainSeat = activeVillains()[0]!;
  const profile = buildProfiles().get(villainSeat) ?? PROFILES[S.archetype]!;
  const heroRange = heroRangeEstimate();
  const villainRange = estimateVillainRange(gs, villainSeat, profile);
  const eff = Math.min(gs.stacks[S.heroSeat]!, gs.stacks[villainSeat]!);
  try {
    const res = solveSubgame({
      heroRange,
      villainRange: villainRange.size > 0 ? villainRange : topSlice(allCombos(), 0.4).filter([...gs.board]),
      board: gs.board,
      pot: gs.pot,
      stack: Math.max(eff, gs.pot * 0.5),
      iterations: 15000, // river only — converges well, ~0.4s
      rng: mulberry32(0x9e3a),
    }, [S.heroCards[0], S.heroCards[1]]);
    // Always cache (even an empty strategy) so a failed/degenerate solve isn't
    // retried every render — that would be an infinite re-solve loop.
    liveSolveCache.set(key, res);
  } catch {
    liveSolveCache.set(key, { strategy: [], heroEv: 0, iterations: 0 }); // sentinel: keep heuristic
  }
  if (liveSolveInFlight === key) liveSolveInFlight = null;
  if (liveSolverSpot() === key) render(); // refresh to show the solved advice
}

// Turn a solved subgame strategy into a recommendation (hero is first to act, so
// the menu is check / bet@size). Picks the highest-frequency line; carries the
// full mix for display.
function solverToRec(res: RiverResult, base: Recommendation | null): Recommendation {
  const mix = res.strategy.filter((a) => a.freq > 0.005);
  const top = [...mix].sort((a, b) => b.freq - a.freq)[0] ?? res.strategy[0]!;
  const summary = mix
    .map((a) => `${a.action === "bet" ? `bet ${chipsBet(roundBet(a.amount))}` : a.action} ${(a.freq * 100).toFixed(0)}%`)
    .join(" · ");
  return {
    action: top.action,
    amount: top.action === "bet" ? roundBet(top.amount) : 0,
    equity: base?.equity ?? 0,
    realizedEquity: base?.realizedEquity,
    potOdds: 0,
    handLabel: base?.handLabel,
    inPosition: base?.inPosition,
    ev: { fold: 0, call: 0, raise: 0 },
    reasoning: `Solved (CFR): ${summary}`,
    source: "solver",
    mix: mix.map((a) => ({ action: a.action as ActionType, amount: roundBet(a.amount), freq: a.freq })),
  };
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
    document.body.appendChild(overlay);
    onId("gto-close", "click", () => {
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
  document.body.appendChild(overlay);
  onId("gto-close", "click", () => {
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
  // re-initialise to the (possibly changed) buy-in on the next hand, and clear
  // names so the next table gets a fresh cast.
  S.seatStacks = [];
  S.seatNames = [];
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
          <label>Game type</label>
          <select id="gametype">
            <option value="cash" ${!S.tournament ? "selected" : ""}>Cash (chip-EV)</option>
            <option value="mtt" ${S.tournament ? "selected" : ""}>Tournament (ICM)</option>
          </select>
        </div>
      </div>

      ${S.tournament ? `
      <div class="field-row">
        <div class="field">
          <label>Payouts</label>
          <select id="payouts">
            <option value="wta" ${S.payoutPreset === "wta" ? "selected" : ""}>Winner-take-all</option>
            <option value="top2" ${S.payoutPreset === "top2" ? "selected" : ""}>Top 2 (65/35)</option>
            <option value="top3" ${S.payoutPreset === "top3" ? "selected" : ""}>Top 3 (50/30/20)</option>
            <option value="top4" ${S.payoutPreset === "top4" ? "selected" : ""}>Top 4</option>
          </select>
        </div>
        <div class="field"><!-- spacer: keeps Payouts at 50% column width --></div>
      </div>` : ""}

      <div class="field-row">
        <div class="field">
          <label>Blinds <span class="lbl-sub">SB / BB</span></label>
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
      <span class="hint">${S.sbManual ? "Small blind set manually" : "Small blind auto-tracks ½ the big blind — tap it to set your own"}</span>

      <div class="field-row">
        <div class="field">
          <label>Your play style</label>
          <select id="herostyle">
            ${Object.entries(HERO_STYLES).map(([k, v]) =>
              `<option value="${k}" ${S.heroStyle === k ? "selected" : ""}>${v.label}</option>`
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
      <span class="hint style-blurb"><strong>You:</strong> ${HERO_STYLES[S.heroStyle]?.blurb ?? ""}</span>
      <span class="hint arch-desc"><strong>Opponents:</strong> ${ARCH_DESC[S.archetype] ?? ""}</span>

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
      <button class="start-btn" id="start-mp" style="background:linear-gradient(135deg,#f59e0b,#b45309);color:#fff;box-shadow:0 8px 22px rgba(245,158,11,.3);margin-top:8px">👥 MULTIPLAYER / BENCHMARK</button>
      <span class="hint" style="text-align:center">Pass-and-play with friends. Toggle who gets the strategy tool (assisted) vs who plays blind — then benchmark the edge. (Online play with accounts is coming.)</span>

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
        <button class="hdr-btn" id="home-btn">🏠 Home</button>
        <button class="hdr-btn" id="view-stats">Session Stats</button>
        <button class="hdr-btn" id="sound-toggle">${isSoundEnabled() ? "🔊 Sound On" : "🔇 Sound Off"}</button>
      </div>
    </div>`;

  onEl($("#help-toggle"), "click", () => {
    document.getElementById("help-body")?.classList.toggle("hidden");
  });
  onEl($("#tsize"), "change", (e) => {
    S.tableSize = +(e.target as HTMLSelectElement).value;
    const max = getPositions(S.tableSize).length - 1;
    if (S.heroSeat > max) S.heroSeat = max;
    render();
  });
  app.querySelectorAll("[data-numpad]").forEach(btn =>
    onEl(btn, "click", () => openNumpad((btn as HTMLElement).dataset.numpad as NumpadTarget)),
  );
  onEl($("#arch"), "change", (e) => {
    S.archetype = (e.target as HTMLSelectElement).value;
    const d = document.querySelector(".arch-desc");
    if (d) d.innerHTML = `<strong>Opponents:</strong> ${ARCH_DESC[S.archetype] ?? ""}`;
  });
  onId("gametype", "change", (e) => {
    S.tournament = (e.target as HTMLSelectElement).value === "mtt";
    render();
  });
  onId("payouts", "change", (e) => {
    S.payoutPreset = (e.target as HTMLSelectElement).value;
  });
  onId("herostyle", "change", (e) => {
    S.heroStyle = (e.target as HTMLSelectElement).value;
    const b = document.querySelector(".style-blurb");
    if (b) b.innerHTML = `<strong>You:</strong> ${HERO_STYLES[S.heroStyle]?.blurb ?? ""}`;
  });
  onId("per-seat-toggle", "click", () => {
    document.getElementById("per-seat-body")?.classList.toggle("hidden");
  });
  app.querySelectorAll("[data-seat-type]").forEach(sel =>
    onEl(sel, "change", (e) => {
      const seat = +(sel as HTMLElement).dataset.seatType!;
      S.seatTypes.set(seat, (e.target as HTMLSelectElement).value);
    }),
  );
  onId("sound-toggle", "click", () => {
    setSoundEnabled(!isSoundEnabled());
    render();
  });
  app.querySelectorAll(".seat-btn").forEach(btn =>
    onEl(btn, "click", () => { S.heroSeat = +(btn as HTMLElement).dataset.seat!; render(); }),
  );
  onEl($("#start"), "click", () => { S.mode = "live"; startHand(); });
  onId("start-training", "click", () => {
    S.mode = "training";
    S.trainingOver = null;
    S.trainingStartSize = S.tableSize;
    S.dealerSeat = -1;
    S.handNumber = 0;
    S.seatStacks = []; // fresh tournament stacks
    S.streak = 0; // fresh streak for a new training session
    startTrainingHand();
  });
  onId("view-stats", "click", () => {
    S.screen = "stats"; render();
  });
  onId("home-btn", "click", () => { S.screen = "home"; render(); });
  onId("start-mp", "click", () => { S.screen = "mp-setup"; render(); });
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
  S.handOver = false; S.winnerSeat = null;
  S.handResult = "";
  S.showdownCards = new Map();
  S.allInPrompt = false;
  S.rit = null;
  S.raiseAmount = 0;
  S.decisionLog = [];
  S.lastGrade = null;
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
  S.handOver = false; S.winnerSeat = null;
  S.handResult = "";
  S.showdownCards = new Map();
  S.allInPrompt = false;
  S.rit = null;
  S.raiseAmount = 0;
  S.rec = null;
  S.decisionLog = [];
  S.lastGrade = null;
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
    const icm: IcmConfig | undefined = S.tournament
      ? { payouts: PAYOUT_PRESETS[S.payoutPreset] ?? PAYOUT_PRESETS.top3! }
      : undefined;
    const style = (HERO_STYLES[S.heroStyle] ?? HERO_STYLES.gto!).style;
    S.rec = recommend(S.gs, prior, mulberry32(0xface), buildProfiles(), icm, style);
    if (S.rec.amount > 0) S.rec.amount = roundBet(S.rec.amount);
    // Layer the real CFR solver over the heuristic for spots it models well:
    // use a cached solve if we have one, otherwise kick one off in the background
    // (the heuristic shows meanwhile, then gets replaced by "Solved (CFR)").
    const spot = liveSolverSpot();
    if (spot) {
      const cached = liveSolveCache.get(spot);
      if (cached && cached.strategy.length > 0) S.rec = solverToRec(cached, S.rec);
      else if (!cached) ensureLiveSolve(spot); // empty (sentinel) → keep heuristic, don't retry
    }
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
  // Key includes the action count + current bet so the read (esp. the villain
  // story + range-narrowed equity) refreshes when someone bets/raises, not just
  // when the board changes.
  const key = `${S.gs.board.join(",")}|${vils.join(",")}|${S.gs.actions.length}|${S.gs.currentBet}`;
  if (key === S.boardReadKey && S.boardRead) return;
  S.boardReadKey = key;

  let equity: number | null = null;
  // Range-aware read of the threats hero faces. Use the active villains' actual
  // estimated ranges so only realistic holdings count (junk combos like 34o that
  // technically make a wheel don't alarm you). With no villains, fall back to the
  // full universe of holdings so the read still renders.
  let rangeCombos: ReadonlyArray<readonly [Card, Card]> = allCombos().combos;
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
      rangeCombos = ranges.flatMap(r => r.combos);
    }
  }
  const read = readThreats([S.heroCards[0], S.heroCards[1]], S.gs.board, rangeCombos);
  // Made threats: top 3 by likelihood. Draws: show all types (≤4: flush/straight/
  // set/overcards) so a flush or straight draw is never hidden behind overcards.
  // ── "What story am I telling?" — board-credible representation reads. These
  // use only the BOARD + action history + the type's bluff frequency (never any
  // hole cards), so they teach range-reading without cheating. ──
  const board = S.gs.board;
  const rep = credibleRep(board);
  const repBacked = scoreRunout({ ...rep, coherence: 1, openedStreet: S.gs.street }, board) === "scare";
  // Hero's story: did hero check before betting on a street (capped) → less credible.
  const heroPost = S.gs.actions.filter(a => a.seat === S.heroSeat && a.street !== "preflop");
  const heroCapped = heroPost.some((a, i) => a.type === "check" && heroPost.slice(i + 1).some(b => b.type === "bet" || b.type === "raise"));
  const heroCred = heroCapped ? "but you checked earlier — looks capped"
    : repBacked ? "the board backs it" : "thin — board doesn't fully back it yet";
  // Size that credibly tells this story: a polar rep (flush/straight/trips+) needs
  // a pot-ish bet; a merged rep (pair+) ~half-pot. Concrete "bet X to rep Y".
  const betToRep = chips((repIsPolar(rep.rep) ? 1.0 : 0.55) * Math.max(S.gs.bb, S.gs.pot));
  const heroStory = { label: rep.label, cred: heroCred, betToRep, capped: heroCapped };
  // Villain's story: the seat that has bet/raised postflop this hand. Mirrors the
  // engine's bluff-catch read (decision.ts 3A) — the runout × the TYPE tells you
  // how bluff-heavy his line is: a BRICK barreled by a bluffy/incoherent type →
  // call lighter; a SCARE that completed the rep → be careful (credible story).
  let villainStory: { label: string; bluffPct: number; note: string; lean: "call" | "careful" | "raise" | ""; size: string } | null = null;
  let aggr = -1, aggrBet = 0;
  for (const a of S.gs.actions) if (a.seat !== S.heroSeat && a.street !== "preflop" && (a.type === "bet" || a.type === "raise")) { aggr = a.seat; if (a.amount > 0) aggrBet = Math.max(aggrBet, a.amount); }
  if (aggr >= 0) {
    const prof = buildProfiles().get(aggr) ?? PROFILES[S.archetype]!;
    const streetsBet = new Set(S.gs.actions.filter(a => a.seat === aggr && a.street !== "preflop" && (a.type === "bet" || a.type === "raise")).map(a => a.street)).size;
    const baseBluff = streetsBet >= 2 ? prof.barrelFreq : prof.bluffFreq;
    const phase = scoreRunout({ ...rep, coherence: 1, openedStreet: S.gs.street }, board);
    const cls = sizeClass(aggrBet / Math.max(1, S.gs.pot));
    const headsUp = activeVillains().length === 1;
    const clampPct = (lo: number, hi: number, x: number) => Math.round(Math.max(lo, Math.min(hi, x)) * 100);
    // SIZE word teaches: size → geometry → type-flip. Mirrors engine 3A reads.
    const sizeWord = cls === "overbet" ? "Overbet, polar" : cls === "pot" ? "Pot-size, polar"
      : cls === "merged" ? "Half-pot, merged" : cls === "min" ? "Min/blocker — capped" : "Small bet — capped";
    let bluffPct: number, note: string, lean: "call" | "careful" | "raise" | "";
    if (repsCapped(cls)) {
      // HARD UI FIREWALL: only suggest a re-bluff under the EXACT engine gate.
      const canReBluff = prof.coherence >= 0.6 && prof.foldToRaise >= 0.5 && prof.calldownPct < 0.6 && headsUp;
      bluffPct = clampPct(0.05, 0.4, baseBluff * (1 - prof.coherence) + 0.1);
      if (canReBluff) { note = "capped — you can raise-bluff"; lean = "raise"; }
      else { note = "capped/weak — call, don't raise"; lean = "call"; }
    } else if (cls === "overbet" || cls === "pot") {
      if (phase === "scare") { bluffPct = clampPct(0.03, 0.6, baseBluff * (1 - prof.coherence) * 0.6); note = `${rep.label} got there — be careful`; lean = "careful"; }
      else if (phase === "brick" && prof.coherence >= 0.6) { bluffPct = clampPct(0.03, 0.4, baseBluff * (1 - prof.coherence)); note = "value-heavy type — fold"; lean = "careful"; }
      else if (phase === "brick") { bluffPct = clampPct(0.2, 0.9, baseBluff * (1.25 - prof.coherence)); note = "mostly air — call wider"; lean = "call"; }
      else { bluffPct = clampPct(0.05, 0.6, baseBluff); note = "story died here"; lean = ""; }
    } else { // merged
      bluffPct = clampPct(0.1, 0.6, baseBluff); note = "merged range"; lean = "";
    }
    villainStory = { label: rep.label, bluffPct, note: `${sizeWord} · ${note}`, lean, size: cls };
  }
  S.boardRead = { equity, made: read.made.slice(0, 3), draws: read.draws.slice(0, 4), heroStory, villainStory };
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
  // Push seats toward the rim of the felt. Horizontal radius is kept modest so
  // the side seats' boxes (~76px, centered via translate(-50%)) don't spill past
  // the table edge and get clipped by .game{overflow:hidden} on narrow phones.
  return { left: 50 - 41 * Math.sin(a), top: 50 + 38 * Math.cos(a) };
}

// A small head-and-shoulders silhouette avatar so opponents read as people, not
// just labels. Colour varies per seat for distinction; hero is emerald.
const AVATAR_COLORS = ["#5b8def", "#e0566a", "#f59e0b", "#a78bfa", "#3fd6c4",
  "#ec4899", "#f97316", "#22c55e", "#eab308", "#38bdf8"];

// Short first names so each opponent reads as a person, not just a position.
// Kept ≤5 chars to fit the seat chip. Position (BTN/SB/…) stays as a sub-label.
const NAMES = ["Mia", "Leo", "Ava", "Kai", "Zoe", "Max", "Eli", "Ivy", "Sam",
  "Nina", "Rio", "Ada", "Jax", "Remy", "Tom", "Ben", "Cleo", "Dex", "Lola", "Gus"];
// Assign a stable, shuffled name to every seat for the session. Regenerated only
// when the table size changes (or a new session clears S.seatNames).
function ensureSeatNames(n: number): void {
  if (S.seatNames.length === n) return;
  const pool = NAMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  S.seatNames = Array.from({ length: n }, (_, i) => pool[i % pool.length]!);
}
function seatName(i: number): string { return S.seatNames[i] ?? `P${i + 1}`; }
// Animate the current street's bet chips sliding into the pot. Spawns transient
// chip elements on document.body (so the imminent re-render doesn't kill them),
// reading live positions from the rendered .seat-bet tokens and the pot.
const reduceMotion = (): boolean => {
  const pref = localStorage.getItem("mce-motion"); // "auto" | "on" | "off"
  if (pref === "on") return true;
  if (pref === "off") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
};

interface Pt { x: number; y: number }
const centerOf = (el: Element): Pt => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

// Shared transient-chip spawner. Nodes live on document.body (position:fixed) so
// the imminent morphdom re-render — which only touches #app — can't kill them.
// transform/opacity ONLY (compositor) + reduced-motion guarded by the caller.
function spawnChips(froms: Pt[], to: Pt, opts: { count?: number; cls?: string; stagger?: number; life?: number; spread?: number } = {}): void {
  const { count = 2, cls = "", stagger = 32, life = 480, spread = 0 } = opts;
  froms.forEach((f, fi) => {
    for (let k = 0; k < count; k++) {
      const chip = document.createElement("div");
      chip.className = "fly-chip" + (cls ? " " + cls : "");
      chip.style.left = `${f.x}px`;
      chip.style.top = `${f.y - k * 3}px`;
      document.body.appendChild(chip);
      const delay = fi * stagger + k * 26;
      const dx = to.x - f.x + (spread ? (Math.random() * 2 - 1) * spread : 0);
      const dy = to.y - f.y + (spread ? (Math.random() * 2 - 1) * spread : 0);
      requestAnimationFrame(() => {
        chip.style.transition = `transform ${life}ms cubic-bezier(.34,1.3,.64,1) ${delay}ms, opacity ${life}ms ease-in ${delay}ms`;
        chip.style.transform = `translate(${dx}px, ${dy}px) scale(.5)`;
        chip.style.opacity = "0.1";
      });
      setTimeout(() => chip.remove(), life + delay + 80);
    }
  });
}

function pulsePot(): void {
  const potLine = document.querySelector(".pot-line");
  if (potLine && !reduceMotion()) {
    potLine.classList.remove("pot-collect");
    void (potLine as HTMLElement).offsetWidth; // restart the animation
    potLine.classList.add("pot-collect");
  }
}

// Sweep every seat's street bet into the pot (street-end).
function animateChipsToPot(): void {
  pulsePot();
  if (reduceMotion()) return;
  const target = document.querySelector(".board-center") ?? document.querySelector(".poker-table");
  const bets = [...document.querySelectorAll(".seat-bet")] as HTMLElement[];
  if (!target || bets.length === 0) return;
  spawnChips(bets.map(centerOf), centerOf(target), { count: 2 });
}

// A single seat's wager flies into the pot (per-action).
function animateChipBet(seat: number): void {
  pulsePot();
  if (reduceMotion()) return;
  const target = document.querySelector(".board-center") ?? document.querySelector(".poker-table");
  const seatEl = document.querySelector(`.table-seat[data-seat="${seat}"] .seat-bet`)
    ?? document.querySelector(`.table-seat[data-seat="${seat}"]`);
  if (!target || !seatEl) return;
  spawnChips([centerOf(seatEl)], centerOf(target), { count: 3 });
}

// The pot slides out to the winner(s) at showdown — the payoff moment.
function animatePotToWinner(seats: number[]): void {
  if (reduceMotion() || !seats.length) return;
  const potEl = document.querySelector(".pot-line") ?? document.querySelector(".board-center");
  if (!potEl) return;
  const from = centerOf(potEl);
  for (const seat of seats) {
    const seatEl = document.querySelector(`.table-seat[data-seat="${seat}"]`);
    if (!seatEl) continue;
    spawnChips(Array.from({ length: 6 }, () => from), centerOf(seatEl), { count: 1, cls: "win", stagger: 42, life: 560, spread: 10 });
  }
}

// Gold coins rain from the winning seat (celebration).
function animateCoinShower(seat: number): void {
  if (reduceMotion()) return;
  const seatEl = document.querySelector(`.table-seat[data-seat="${seat}"]`);
  if (!seatEl) return;
  const c = centerOf(seatEl);
  for (let i = 0; i < 10; i++) {
    const coin = document.createElement("div");
    coin.className = "fly-chip coin win";
    coin.style.left = `${c.x + Math.sin(i * 1.7) * 26}px`;
    coin.style.top = `${c.y}px`;
    document.body.appendChild(coin);
    const dx = (i % 2 ? 1 : -1) * (18 + i * 4), dy = 70 + (i % 3) * 28, delay = i * 38;
    requestAnimationFrame(() => {
      coin.style.transition = `transform .9s cubic-bezier(.4,.2,.5,1) ${delay}ms, opacity .9s ease-in ${delay}ms`;
      coin.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 2}deg)`;
      coin.style.opacity = "0";
    });
    setTimeout(() => coin.remove(), 1000 + delay);
  }
}

// Stash winners for the highlight + queue the one-shot pot→winner travel.
function markWinners(w: number[]): void { S.winnerSeat = w.slice(); S.potFlyPending = w.slice(); }

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
  ensureSeatNames(positions.length);
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
      S.winnerSeat?.includes(i) ? "winner" : "",
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
    // At showdown, show each revealed opponent's hole cards right at their seat
    // (instead of a separate box below). Above the chip for bottom-half seats.
    const sdc = !isHero && !folded ? S.showdownCards.get(i) : undefined;
    const showCards = (S.handOver || S.trainingOver) && sdc;
    const winC = S.winnerSeat?.includes(i) ? "win" : (S.winnerSeat ? "lose" : "");
    const holeCards = showCards
      ? `<div class="seat-cards ${top < 50 ? "below" : "above"}">${sdc!.map((c, ci) =>
          `<span class="seat-hole reveal ${isRed(c) ? "red" : ""} ${winC}" style="animation-delay:${ci * 130}ms">${cardDisplay(c)}</span>`).join("")}</div>`
      : "";
    return `<div class="${cls} ${oppActor ? "tappable" : ""}" data-seat="${i}" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%">
      ${isDealer ? '<div class="dealer-btn">D</div>' : ""}
      ${tag ? `<div class="seat-tag tag-${tag.toLowerCase()}">${tag}</div>` : ""}
      ${avatar}
      <div class="seat-chip" ${chipAttr}>
        <div class="seat-pos">${isHero ? "YOU" : seatName(i)} <span class="seat-subpos">${pos}</span></div>
        <div class="seat-stack">${chips(stack)}</div>
        ${actText ? `<div class="seat-act">${actText}</div>` : ""}
      </div>
      ${S.foldAnim === i ? `<div class="muck"><span class="muck-card"></span><span class="muck-card"></span></div>` : ""}
      ${holeCards}
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
      return `<div class="board-card dealt ${isRed(c) ? "red" : ""}${anim}">${flipFaces(cardDisplay(c))}</div>`;
    }
    return `<div class="board-card empty"></div>`;
  }).join("");

  // ── Hero cards ──
  const heroHtml = S.heroCards
    ? S.heroCards.map((c, i) =>
        `<div class="hero-card dealt ${isRed(c) ? "red" : ""}${animHero ? ` deal-in" style="animation-delay:${i * 110}ms` : ""}">${flipFaces(cardDisplay(c))}</div>`
      ).join("")
    : `<div class="hero-card empty">?</div><div class="hero-card empty">?</div>`;

  // ── Hand summary: what you have + win% — shown ABOVE the hole cards ──
  let handSummaryHtml = "";
  if (S.heroCards && gs) {
    const d = describeHand(S.heroCards, gs.board);
    const draws = d.draws.length ? ` + ${d.draws.join(" + ")}` : "";
    const eq = S.boardRead?.equity ?? S.rec?.equity ?? null;
    const eqStr = eq === null ? "" : `${(eq * 100).toFixed(0)}%`;
    // Pot odds = the equity you NEED to call profitably (only when facing a bet).
    const odds = S.rec?.potOdds ?? 0;
    handSummaryHtml = `<div class="hand-summary">
      <span class="hand-label ${d.strong ? "strong" : ""}">${d.label}${draws}</span>
      ${eqStr ? `<span class="hand-strength"><strong>${eqStr}</strong> win</span>` : ""}
      ${odds > 0 ? `<span class="hand-odds"><strong>${(odds * 100).toFixed(0)}%</strong> to call</span>` : ""}
    </div>`;
  }

  // ── Board read: the two reads that actually drive a call/bet — what an opponent
  // (within a realistic range) could hold that BEATS YOU now, and what's DRAWING
  // to beat you on the next card. Draws die automatically when no card completes
  // them and on the river. Replaces the old nuts / 2nd-nuts / nuts-out grid. ──
  // Compact read: "Beats you" boxes flank the LEFT of the hero cards, "Drawing"
  // the RIGHT, freeing the row below for the story lines (Villain reps / Bet-to-rep).
  let beatsFlank = "", drawsFlank = "", storyLinesHtml = "";
  if (S.boardRead && !S.handOver && !S.trainingOver) {
    const made = S.boardRead.made.slice(0, 2);
    const draws = S.boardRead.draws.slice(0, 2);
    const tag = (t: Threat) => `<span class="flank-chip">${t.label}</span>`;
    beatsFlank = made.length
      ? `<div class="read-flank beats"><span class="flank-lead">Beats you</span>${made.map(tag).join("")}</div>`
      : `<div class="read-flank ahead"><span class="flank-lead">Beats you</span><span class="flank-chip ok">none yet</span></div>`;
    drawsFlank = draws.length
      ? `<div class="read-flank draws"><span class="flank-lead">Drawing</span>${draws.map(tag).join("")}</div>`
      : `<div class="read-flank draws dim"><span class="flank-lead">Drawing</span><span class="flank-chip">—</span></div>`;
    const hs = S.boardRead.heroStory;
    const vs = S.boardRead.villainStory;
    const leanWord = (l: string) => l === "call" ? "call lighter" : l === "careful" ? "be careful" : l === "raise" ? "raise-bluff spot" : "";
    const vilLine = vs
      ? `<div class="story-line vil ${vs.lean ? "lean-" + vs.lean : ""}">🎭 Villain reps <b>${vs.label}</b> · ~${vs.bluffPct}% bluff${vs.lean ? ` · ${leanWord(vs.lean)}` : ""}</div>`
      : "";
    const heroLine = hs
      ? `<div class="story-line you ${hs.capped ? "capped" : ""}" title="${hs.cred}">🂠 Rep <b>${hs.label}</b> → bet <b>${hs.betToRep}</b>${hs.capped ? ` <span class="story-warn">capped</span>` : ""}</div>`
      : "";
    storyLinesHtml = (vilLine || heroLine) ? `<div class="story-lines">${vilLine}${heroLine}</div>` : "";
  }

  // ── Recommendation ──
  // The reason text leads with "Fold — …" / "Raise — …" etc, which just repeats
  // the big action label above it. Strip that leading "<action> — " prefix.
  const recReason = S.rec ? S.rec.reasoning.replace(/^\s*[A-Za-z][A-Za-z\s/-]*\s—\s/, "") : "";
  // Source badge — be honest about where the advice comes from.
  const SRC: Record<string, { txt: string; cls: string }> = {
    solver: { txt: "🧠 GTO · solved", cls: "src-solver" },
    nash: { txt: "Nash push/fold", cls: "src-nash" },
    chart: { txt: "GTO chart", cls: "src-chart" },
    heuristic: { txt: "equity heuristic", cls: "src-heur" },
  };
  const _solveSpot = liveSolverSpot();
  const solvingNow = !!_solveSpot && !liveSolveCache.has(_solveSpot);
  const srcMeta = S.rec?.source ? SRC[S.rec.source] : undefined;
  const srcBadge = S.rec
    ? `<span class="rec-src ${solvingNow ? "src-solving" : srcMeta?.cls ?? ""}">${
        solvingNow ? "solving GTO…" : srcMeta?.txt ?? ""
      }</span>`
    : "";
  // Mixed-strategy bars (from the solver) — the defining feature of GTO play.
  const mixHtml = S.rec?.mix && S.rec.mix.length > 1
    ? `<div class="rec-mix">${S.rec.mix
        .sort((a, b) => b.freq - a.freq)
        .map((m) => {
          const lbl = m.action === "bet" ? `Bet ${chipsBet(m.amount)}`
            : m.action === "raise" ? `Raise ${chipsBet(m.amount)}`
            : m.action.charAt(0).toUpperCase() + m.action.slice(1);
          return `<div class="mix-row"><span class="mix-act">${lbl}</span>` +
            `<div class="mix-bar"><div class="mix-fill" style="width:${(m.freq * 100).toFixed(0)}%"></div></div>` +
            `<span class="mix-pct">${(m.freq * 100).toFixed(0)}%</span></div>`;
        })
        .join("")}</div>`
    : "";
  // Quiz mode: on YOUR turn in training, hide the recommendation (and its size
  // hints) so you commit blind, then get graded after you act.
  const quizHide = quizMode() && S.mode === "training" && isHeroTurn && !S.handOver && !S.trainingOver;
  const recHtml = !S.rec ? "" : quizHide
    ? `<div class="rec-panel quiz-cover">
         <div class="rec-action">🙈 Your call?</div>
         <div class="rec-reason">Quiz mode — make your decision, then I'll grade it.</div>
       </div>`
    : `<div class="rec-panel">
      <div class="rec-head">
        <div class="rec-action">${S.rec.action}${S.rec.amount > 0 ? ` ${chipsBet(S.rec.amount)}` : ""}</div>
        ${srcBadge}
      </div>
      <div class="rec-reason">${recReason}</div>
      ${mixHtml}
    </div>`;

  // ── Actions ──
  const legal = gs && next !== null ? gs.legalActionsFor(next) : [];
  // In training the AI auto-plays the villains, so the action controls only
  // appear on YOUR turn. (In live mode you log every seat, so they show for all.)
  const showActions = !!gs && !S.handOver && next !== null && !needsBoard
    && (S.mode === "live" || next === S.heroSeat);

  // If there's a rec with amount, show it on the bet/raise button for one-tap action
  // — but NOT in quiz mode (the size would give the answer away).
  const recAmt = S.rec && S.rec.amount > 0 ? roundBet(S.rec.amount) : 0;
  const betLabel = !quizHide && recAmt > 0 && S.rec?.action === "bet" ? `Bet ${chipsBet(recAmt)}` : "Bet";
  const raiseLabel = !quizHide && recAmt > 0 && S.rec?.action === "raise" ? `Raise ${chipsBet(recAmt)}` : "Raise";

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

  // One-shot verdict flash for the just-graded decision (training dopamine).
  const vf = S.flashVerdict === "ok" ? " verdict-pop" : S.flashVerdict === "bad" ? " verdict-shake" : "";
  app.innerHTML = `
    <div class="game ${S.handOver || S.trainingOver ? "hand-over" : ""}${S.celebrate ? " celebrate" : ""}">
      <div class="game-topbar">
        <span>Hand #${S.handNumber}${S.mode === "training" ? " · <strong style=\"color:var(--violet)\">TRAINING</strong>" : ""}${
          S.mode === "training" && S.streak >= 2
            ? ` <span class="streak streak-t${S.streak >= 10 ? 3 : S.streak >= 5 ? 2 : 1}">🔥 ${S.streak}</span>`
            : ""
        }</span>
        <div class="topbar-btns">
          ${S.mode === "training"
            ? `<button class="hdr-btn ${quizMode() ? "quiz-on" : ""}" id="quiz-btn" title="Quiz mode: hide the recommendation, grade your call">${quizMode() ? "🙈 Quiz" : "💡 Coach"}</button>`
            : ""}
          ${S.mode === "training"
            ? `<button class="hdr-btn" id="speed-btn" title="Playback speed">${SPEED_LABEL[trainingSpeed()]}</button>`
            : ""}
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
            isHeroTurn
              // In quiz mode keep the last verdict visible alongside YOUR TURN so
              // it doesn't vanish at fast speeds before the next decision.
              ? (quizMode() && S.mode === "training" && S.lastGrade
                  ? `<span class="last-grade ${S.lastGrade.cls}${vf}">${S.lastGrade.label}</span> · <strong>YOUR TURN</strong>`
                  : "<strong>YOUR TURN</strong>")
            : S.lastGrade ? `<span class="last-grade ${S.lastGrade.cls}${vf}">${S.lastGrade.label}</span>`
            : S.message || ""
          }</div>` : ""}

          <div class="hero-area">
            ${handSummaryHtml}
            <div class="hero-read-row">${beatsFlank}<div class="hero-cards">${heroHtml}</div>${drawsFlank}</div>
            ${gs ? `<div class="pot-line"><span class="table-pot">${chips(gs.pot)}</span><span class="pot-street">${gs.street.toUpperCase()}</span></div>` : ""}
            ${storyLinesHtml}
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
  S.foldAnim = null; // one-shot muck animation consumed
  S.flashVerdict = null; // one-shot verdict animation consumed
  S.celebrate = false; // one-shot win glow consumed
  if (S.potFlyPending) { // one-shot: pot slides to the winner(s), then coin-shower the hero
    const w = S.potFlyPending; S.potFlyPending = null;
    requestAnimationFrame(() => { animatePotToWinner(w); if (w.includes(S.heroSeat)) animateCoinShower(S.heroSeat); });
  }

  // ── Events ──
  onEl($("#new-hand"), "click", () => { S.screen = "setup"; S.dealerSeat = -1; S.handNumber = 0; render(); });
  onId("speed-btn", "click", () => { cycleSpeed(); render(); });
  onId("quiz-btn", "click", () => { toggleQuiz(); render(); });
  onId("undo-btn", "click", undo);
  onId("next-hand", "click", nextHand);
  onId("train-again", "click", () => {
    // Restart the tournament with the originally configured table size.
    S.trainingOver = null;
    S.tableSize = S.trainingStartSize;
    if (S.heroSeat >= S.tableSize) S.heroSeat = S.tableSize - 1;
    S.dealerSeat = -1;
    S.handNumber = 0;
    S.seatStacks = [];
    S.handOver = false; S.winnerSeat = null;
    startTrainingHand();
  });
  onId("review-hand", "click", () => { S.reviewOpen = true; renderReview(); });
  onId("gto-solve", "click", startGtoSolve);

  // Showdown winner buttons (manual). Settlement handles side pots / uncalled.
  app.querySelectorAll("[data-winner]").forEach(btn =>
    onEl(btn, "click", () => {
      const val = (btn as HTMLElement).dataset.winner!;
      const remaining = S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0);
      const winners = val === "split" ? remaining : [+val];
      markWinners(winners);
      const who = winners.length > 1 ? "Split pot"
        : winners[0] === S.heroSeat ? "You won" : `${S.gs!.positions[winners[0]!]!} won`;
      resolveLive(strengthFromWinners(S.gs!.stacks.length, winners), who);
    }),
  );

  // Showdown: enter a villain's cards
  app.querySelectorAll("[data-vcards]").forEach(btn =>
    onEl(btn, "click", () => {
      S.pickerTarget = "villain";
      S.pickerVillainSeat = +(btn as HTMLElement).dataset.vcards!;
      S.pickerPicked = []; S.pickerRank = null;
      S.pickerOpen = true;
      renderPicker();
    }),
  );
  // Showdown: confirm the auto-computed winner
  onId("sd-confirm", "click", () => {
    const remaining = S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0);
    const auto = computeShowdown(remaining, S.boardCards.slice(0, 5));
    if (auto) recordShowdownResult(auto.winners, auto.label, auto.strength);
  });

  // Run it once / twice
  onId("run-once", "click", () => {
    S.allInPrompt = false; openBoardPicker();
  });
  onId("run-twice", "click", startRunItTwice);
  // Run-it-twice per-run winner
  app.querySelectorAll("[data-runwinner]").forEach(btn =>
    onEl(btn, "click", () => {
      const v = (btn as HTMLElement).dataset.runwinner!;
      if (v === "split") {
        ritRecordWinner(S.gs!.folded.map((f, i) => f ? -1 : i).filter((i) => i >= 0));
      } else {
        ritRecordWinner([+v]);
      }
    }),
  );

  app.querySelectorAll("[data-act]").forEach(btn =>
    onEl(btn, "click", () => {
      const act = (btn as HTMLElement).dataset.act as ActionType;
      const who = next === S.heroSeat ? "You" : (gs?.positions[next!] ?? "");
      pushUndo(`${who} ${act}`);
      doAction(next!, act);
    }),
  );
  onId("fold-to-me", "click", () => { pushUndo("fold to you"); advanceOpponents("fold"); });
  onId("check-to-me", "click", () => { pushUndo("check to you"); advanceOpponents("check"); });
  onId("call-to-me", "click", () => { pushUndo("call to you"); advanceOpponents("call"); });
  app.querySelectorAll("[data-size]").forEach(btn =>
    onEl(btn, "click", () => {
      S.raiseAmount = +(btn as HTMLElement).dataset.size!;
      const action: ActionType = gs!.currentBet > 0 ? "raise" : "bet";
      const who = next === S.heroSeat ? "You" : (gs?.positions[next!] ?? "");
      pushUndo(`${who} ${action}`);
      doAction(next!, action);
    }),
  );
  app.querySelectorAll("[data-open-bet]").forEach(btn =>
    onEl(btn, "click", () => {
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
    onId("board-area", "click", openBoardPicker);
  }

  // Tap a seat to set/correct its stack (rebuys) — live mode only.
  if (S.mode === "live") {
    app.querySelectorAll("[data-seatstack]").forEach(el =>
      onEl(el, "click", () => {
        S.numpadSeat = +(el as HTMLElement).dataset.seatstack!;
        S.numpadRaw = "";
        openNumpad("seatstack");
      }),
    );
    // Tap the acting opponent's seat → toggle its inline action menu.
    app.querySelectorAll("[data-actmenu]").forEach(el =>
      onEl(el, "click", () => {
        const seat = +(el as HTMLElement).dataset.actmenu!;
        S.seatMenuSeat = S.seatMenuSeat === seat ? null : seat;
        render();
      }),
    );
    // Pick an action from the inline seat menu.
    app.querySelectorAll("[data-seatact]").forEach(el =>
      onEl(el, "click", () => {
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

  // Log hero's decision against the recommendation, and grade it (Stage 3).
  if (seat === S.heroSeat && S.rec) {
    const entry = { street: S.gs.street, chosen: type, chosenAmt: amount, rec: S.rec };
    S.decisionLog.push(entry);
    const g = gradeDecision(entry);
    // Quiz mode grades only the ACTION TYPE (fold/check/call/bet/raise) — sizing
    // isn't tested — and shows "Correct Raise" / "Wrong — GTO says Raise".
    if (quizMode() && S.mode === "training") {
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const src = SRC_WORD[S.rec.source ?? "heuristic"] ?? "Strategy";
      // Type-only bucket: if the chosen action type appears in a solved mix at a
      // meaningful frequency it's correct/fine; otherwise match the top action.
      let bucket: "ok" | "mix" | "off";
      if (S.rec.mix && S.rec.mix.length > 0) {
        const f = S.rec.mix.filter((m) => m.action === type).reduce((s, m) => s + m.freq, 0);
        bucket = f >= 0.15 ? "ok" : f >= 0.02 ? "mix" : "off";
      } else {
        bucket = type === S.rec.action ? "ok" : "off";
      }
      S.lastGrade = bucket === "off"
        ? { label: `✗ Wrong — ${src} says ${cap(S.rec.action)}`, cls: "g-bad" }
        : bucket === "mix"
          ? { label: `≈ OK — ${cap(type)} is a fine mix`, cls: "g-mix" }
          : { label: `✓ Correct ${cap(type)}`, cls: "g-ok" };
    } else {
      S.lastGrade = { label: g.label, cls: g.cls };
    }
    S.gradeStats.n += 1;
    S.gradeStats.pts += g.score;
    S.gradeStats[g.bucket] += 1;
    // Persist the decision for the leak report (your play vs GTO over time).
    logDecision({
      t: Date.now(), cat: spotCategory(S.gs, seat), chosen: type,
      rec: S.rec.action, bucket: g.bucket, score: g.score,
    });
    // Training dopamine loop: build a consecutive-correct streak, flash the
    // verdict. A "fine mix" keeps the streak; a clear mistake breaks it.
    if (S.mode === "training") {
      if (g.bucket === "off") {
        S.streak = 0;
        S.flashVerdict = "bad";
      } else {
        S.streak += 1;
        S.flashVerdict = "ok";
        if (S.streak > S.bestStreak) {
          S.bestStreak = S.streak;
          try { localStorage.setItem("mce-beststreak", String(S.bestStreak)); } catch { /* ignore */ }
        }
      }
    }
  }

  playSound(type === "fold" ? "fold" : type === "check" ? "check"
    : type === "call" ? "bet" : "bet");

  if (type === "fold") S.foldAnim = seat; // muck-toss animation on the next render
  S.gs.applyAction({ seat, type, amount });

  if (S.gs.activeSeatCount <= 1) {
    const winnerSeat = S.gs.folded.findIndex(f => !f);
    markWinners([winnerSeat]);
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

  // (Opponents' hands are shown at their seats on the table at showdown.)
  const reviewBtn = S.decisionLog.length
    ? `<button class="action-btn check" id="review-hand" style="flex:0 0 auto;padding:16px 14px">📋 Review</button>`
    : "";

  return `
    <div class="result-panel">
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
    const g = gradeDecision(d);
    const refLabel = d.rec.source === "solver" ? "GTO solve" : SRC_WORD[d.rec.source ?? "heuristic"] ?? "strategy";
    // Show the full solved mix when we have one — that's the real lesson.
    const mixLine = d.rec.mix && d.rec.mix.length > 1
      ? `<div class="review-mix">${d.rec.mix.slice().sort((a, b) => b.freq - a.freq)
          .map((m) => `${m.action === "bet" ? `bet ${chipsBet(m.amount)}` : m.action} ${(m.freq * 100).toFixed(0)}%`)
          .join(" · ")}</div>`
      : "";
    return `<div class="review-row ${g.cls === "g-ok" ? "ok" : g.cls === "g-mix" ? "mix" : "bad"}">
      <div class="review-street">${d.street}</div>
      <div class="review-cmp">
        <span>You: <strong>${d.chosen}${chosenAmt}</strong></span>
        <span>${refLabel}: <strong>${d.rec.action}${recAmt}</strong></span>
      </div>
      ${mixLine}
      <div class="review-verdict ${g.cls}">${g.label}</div>
    </div>`;
  }).join("");

  const gd = S.decisionLog.map(gradeDecision);
  const pts = gd.reduce((s, g) => s + g.score, 0);
  const acc = gd.length ? Math.round((pts / gd.length) * 100) : 100;
  const offs = gd.filter((g) => g.bucket === "off").length;
  const summary = gd.length === 0
    ? "No hero decisions to grade."
    : offs === 0
      ? `Hand accuracy ${acc}% — every decision on-strategy. 🎯`
      : `Hand accuracy ${acc}% · ${offs} clear ${offs === 1 ? "mistake" : "mistakes"}.`;

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
  document.body.appendChild(overlay);

  onId("review-close", "click", () => {
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
// Training playback speed (villain step pacing). Persisted across sessions.
const SPEED_TIERS = ["slow", "normal", "fast", "instant"] as const;
type SpeedTier = typeof SPEED_TIERS[number];
const SPEED_FACTOR: Record<SpeedTier, number> = { slow: 1.8, normal: 1, fast: 0.5, instant: 0.04 };
const SPEED_LABEL: Record<SpeedTier, string> = { slow: "🐢 Slow", normal: "▶ Normal", fast: "⏩ Fast", instant: "⚡ Instant" };
function trainingSpeed(): SpeedTier {
  const v = (localStorage.getItem("mce-speed") as SpeedTier) || "normal";
  return SPEED_TIERS.includes(v) ? v : "normal";
}
function cycleSpeed(): void {
  const i = SPEED_TIERS.indexOf(trainingSpeed());
  localStorage.setItem("mce-speed", SPEED_TIERS[(i + 1) % SPEED_TIERS.length]!);
}

// Quiz mode: hide the recommendation so you must decide blind, then grade the
// call ("Correct Call" / "Wrong — GTO says X"). Persisted across sessions.
function quizMode(): boolean { return localStorage.getItem("mce-quiz") === "1"; }
function toggleQuiz(): void { localStorage.setItem("mce-quiz", quizMode() ? "0" : "1"); }

// ── Leak detection: persist every graded decision (your play vs GTO) ──
interface LoggedDecision {
  t: number;        // timestamp
  cat: string;      // spot category (e.g. "Preflop open", "Flop facing bet")
  chosen: ActionType;
  rec: ActionType;  // recommended action
  bucket: "gto" | "mixed" | "off";
  score: number;
}
const DECISIONS_KEY = "mce-decisions";
function loadDecisions(): LoggedDecision[] {
  try { return JSON.parse(localStorage.getItem(DECISIONS_KEY) || "[]"); } catch { return []; }
}
function logDecision(d: LoggedDecision): void {
  const arr = loadDecisions();
  arr.push(d);
  if (arr.length > 1500) arr.splice(0, arr.length - 1500); // rolling cap
  try { localStorage.setItem(DECISIONS_KEY, JSON.stringify(arr)); } catch { /* quota */ }
}
// Plain-English spot category for a decision, from the game state at the time.
function spotCategory(gs: GameState, seat: number): string {
  const street = gs.street;
  if (street === "preflop") {
    const raises = gs.actions.filter(a => a.street === "preflop" && (a.type === "raise" || a.type === "bet")).length;
    if (raises === 0) return "Preflop open";
    if (raises === 1) return "Preflop vs raise";
    return "Preflop vs 3bet+";
  }
  const cap = street.charAt(0).toUpperCase() + street.slice(1);
  return gs.toCall(seat) > 0 ? `${cap} facing bet` : `${cap} as aggressor`;
}

function scheduleVillainStep(delay: number): void {
  cancelVillainTimer();
  villainTimer = setTimeout(villainStep, Math.max(20, delay * SPEED_FACTOR[trainingSpeed()]));
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

  if (action === "fold") S.foldAnim = next; // muck-toss animation
  S.gs.applyAction({ seat: next, type: action, amount });
  S.flashSeat = next; // pulse the seat that just acted
  playSound(action === "fold" ? "fold" : action === "check" ? "check" : "bet");

  // Villain folded everyone else out → hero (or last seat) wins outright.
  if (S.gs.activeSeatCount <= 1) {
    const winnerSeat = S.gs.folded.findIndex(f => !f);
    markWinners([winnerSeat]);
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
  markWinners(winners);
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
  // Win → one-shot celebratory table glow (every mode now, consumed by next render).
  if (heroPnl > 0) S.celebrate = true;

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
  markWinners(winners);
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
  const gs = S.gs;
  if (!gs) return;
  // Guard: only deal a board when the current betting round is actually complete
  // (matches `needsBoard`). Defends against a tap on the felt outside that window
  // (e.g. a persistent #board-area node) dealing a street mid-round.
  if (!(gs.roundComplete() && !gs.isComplete() && !S.handOver)) return;
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

  document.body.appendChild(overlay);

  // Rank: highlight in place + enable its suits — NO full re-render (no flash).
  overlay.querySelectorAll(".rank-btn:not(.used)").forEach(btn =>
    onEl(btn, "click", () => {
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
    onEl(btn, "click", () => {
      if (S.pickerRank === null || btn.classList.contains("used")) return;
      const card = makeCard(S.pickerRank, +(btn as HTMLElement).dataset.suit!);
      S.pickerPicked.push(card);
      S.pickerRank = null;
      playSound("card");
      if (S.pickerPicked.length === needed) { confirmPicker(); return; }
      renderPicker(); // a card was placed — rebuild for the next one
    }),
  );

  onId("picker-cancel", "click", () => {
    S.pickerOpen = false; S.pickerPicked = []; S.pickerRank = null;
    document.getElementById("picker-modal")?.remove();
    if (!S.heroCards) { S.screen = "setup"; render(); }
  });

  onId("picker-confirm", "click", confirmPicker);
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

  document.body.appendChild(overlay);

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
    onEl(btn, "click", () => {
      const k = (btn as HTMLElement).dataset.key!;
      if (!touched) { touched = true; raw = ""; } // first keystroke clears the suggestion
      if (k === "⌫") raw = raw.slice(0, -1);
      else if (k === ".") { if (!raw.includes(".")) raw = (raw || "0") + "."; }
      else raw += k;
      refresh();
    }),
  );

  overlay.querySelectorAll(".preset-btn").forEach(btn =>
    onEl(btn, "click", () => {
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

  onId("bp-cancel", "click", () => {
    S.betPadOpen = false;
    document.getElementById("betpad-modal")?.remove();
  });

  onId("bp-confirm", "click", () => {
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

      ${S.gradeStats.n > 0 ? `
      <div class="stats-card">
        <div class="stat-big" style="color:${(() => { const a = S.gradeStats.pts / S.gradeStats.n; return a >= 0.85 ? "var(--green)" : a >= 0.65 ? "var(--gold)" : "var(--red)"; })()}">
          ${Math.round((S.gradeStats.pts / S.gradeStats.n) * 100)}%
        </div>
        <div class="stat-label">GTO Accuracy (${S.gradeStats.n} decisions)</div>
        <div class="grade-breakdown">
          <span class="g-ok">${S.gradeStats.gto} on-strategy</span>
          <span class="g-mix">${S.gradeStats.mixed} rare mix</span>
          <span class="g-bad">${S.gradeStats.off} mistakes</span>
        </div>
        ${S.bestStreak >= 2 ? `<div class="stat-label" style="margin-top:6px">🔥 Best streak: <strong style="color:#ff9f1c">${S.bestStreak}</strong> correct in a row</div>` : ""}
      </div>` : ""}

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

      <button class="start-btn" id="leak-report" style="background:linear-gradient(135deg,#7c3aed,#5b21b6);color:#fff">🔍 Leak Report</button>
      <button class="start-btn" id="back-setup" style="margin-top:8px">Back to Table</button>
      ${allHands.length > 0 ? `<button class="hdr-btn" id="export-csv" style="width:100%;padding:12px;margin-top:4px;font-size:13px">Export CSV</button>` : ""}
      ${allHands.length > 0 ? `<button class="hdr-btn" id="clear-hist" style="width:100%;padding:12px;margin-top:4px;font-size:13px;color:var(--red)">Clear All History</button>` : ""}
    </div>`;

  onId("leak-report", "click", () => { S.screen = "leaks"; render(); });
  onId("back-setup", "click", () => {
    S.screen = "setup"; render();
  });
  onId("export-csv", "click", () => exportCsv(allHands));
  onId("clear-hist", "click", () => {
    if (confirm("Clear all hand history?")) {
      clearHistory().then(() => {
        S.sessionStart = Date.now();
        S.gradeStats = { n: 0, pts: 0, gto: 0, mixed: 0, off: 0 };
        render();
      });
    }
  });
}

// ── Leak Report: your play vs GTO, aggregated from the persisted decision log ──
function renderLeaks(): void {
  const all = loadDecisions();
  const acc = (xs: LoggedDecision[]) => xs.length ? xs.reduce((s, d) => s + d.score, 0) / xs.length : 0;
  const pctTxt = (v: number) => `${Math.round(v * 100)}%`;

  // Per-category accuracy + sample.
  const byCat = new Map<string, LoggedDecision[]>();
  for (const d of all) { (byCat.get(d.cat) ?? byCat.set(d.cat, []).get(d.cat)!).push(d); }
  const cats = [...byCat.entries()].map(([cat, xs]) => ({ cat, n: xs.length, a: acc(xs), xs }));

  // Biggest leaks: lowest accuracy with a meaningful sample.
  const leaks = cats.filter(c => c.n >= 6).sort((x, y) => x.a - y.a).slice(0, 3);

  // Dominant mistake direction across all errors.
  const cont = (a: ActionType) => a !== "fold";
  let overFold = 0, tooLoose = 0, tooPassive = 0, overAggro = 0;
  for (const d of all) {
    if (d.bucket !== "off") continue;
    if (d.chosen === "fold" && cont(d.rec)) overFold++;
    else if (d.rec === "fold" && cont(d.chosen)) tooLoose++;
    else if ((d.chosen === "check" || d.chosen === "call") && (d.rec === "bet" || d.rec === "raise")) tooPassive++;
    else if ((d.chosen === "bet" || d.chosen === "raise") && (d.rec === "check" || d.rec === "call" || d.rec === "fold")) overAggro++;
  }
  const biases = [
    { k: "fold too much", n: overFold, fix: "You're folding hands GTO continues with — defend wider and don't give up your equity." },
    { k: "play too many hands", n: tooLoose, fix: "You're entering pots GTO folds — tighten up, especially out of position." },
    { k: "play too passively", n: tooPassive, fix: "You check/call where GTO bets or raises — bet your value and your bluffs." },
    { k: "over-bluff / over-bet", n: overAggro, fix: "You bet/raise where GTO checks or folds — pick better spots, respect strength." },
  ].sort((a, b) => b.n - a.n);
  const topBias = biases[0]!.n > 0 ? biases[0]! : null;

  // Trend: recent vs prior block.
  const N = Math.min(50, Math.floor(all.length / 2));
  const recent = N >= 5 ? acc(all.slice(-N)) : null;
  const prior = N >= 5 ? acc(all.slice(-2 * N, -N)) : null;
  const trend = recent !== null && prior !== null ? recent - prior : null;

  const overall = acc(all);
  const accColor = (v: number) => v >= 0.85 ? "var(--green)" : v >= 0.65 ? "var(--gold)" : "var(--red)";
  const bar = (v: number, color: string) =>
    `<div class="leak-bar"><div class="leak-fill" style="width:${Math.round(v * 100)}%;background:${color}"></div></div>`;

  const enough = all.length >= 8;
  app.innerHTML = `
    <div class="setup">
      <h1>🔍 Leak Report</h1>
      <span class="hint" style="text-align:center;display:block;margin-bottom:14px">Your decisions vs GTO · ${all.length} graded · build it up in Training (try Quiz mode)</span>

      ${!enough ? `
        <div class="stats-card"><div class="stat-label" style="text-align:center;padding:20px 0">
          Play a few more training hands to unlock your leak report.<br>(${all.length}/8 decisions)
        </div></div>` : `
        <div class="stats-card">
          <div class="stat-big" style="color:${accColor(overall)}">${pctTxt(overall)}</div>
          <div class="stat-label">Overall GTO accuracy${
            trend !== null ? ` · <span style="color:${trend >= 0.02 ? "var(--green)" : trend <= -0.02 ? "var(--red)" : "var(--muted)"}">${trend >= 0.02 ? "▲ improving" : trend <= -0.02 ? "▼ slipping" : "▬ steady"}</span>` : ""
          }</div>
        </div>

        ${topBias ? `
        <div class="stats-card" style="text-align:left">
          <div class="stat-label" style="text-transform:none;font-weight:800;color:var(--text);margin-bottom:4px">Your #1 tendency: you <span style="color:var(--rose)">${topBias.k}</span></div>
          <div class="hint" style="text-align:left">${topBias.fix}</div>
        </div>` : ""}

        ${leaks.length ? `
        <div class="stats-card" style="text-align:left">
          <div class="stat-label" style="margin-bottom:8px">Biggest leaks (lowest accuracy)</div>
          ${leaks.map(c => `
            <div class="leak-row">
              <div class="leak-head"><span>${c.cat}</span><span style="color:${accColor(c.a)};font-weight:800">${pctTxt(c.a)} · ${c.n} spots</span></div>
              ${bar(c.a, accColor(c.a))}
            </div>`).join("")}
        </div>` : ""}

        <div class="stats-card" style="text-align:left">
          <div class="stat-label" style="margin-bottom:8px">Accuracy by spot</div>
          ${cats.sort((a, b) => b.n - a.n).map(c => `
            <div class="leak-row">
              <div class="leak-head"><span>${c.cat}</span><span style="color:var(--muted)">${pctTxt(c.a)} · ${c.n}</span></div>
              ${bar(c.a, accColor(c.a))}
            </div>`).join("")}
        </div>`}

      <button class="start-btn" id="leak-back" style="margin-top:6px">Back to Stats</button>
      ${all.length > 0 ? `<button class="hdr-btn" id="leak-clear" style="width:100%;padding:12px;margin-top:4px;font-size:13px;color:var(--red)">Reset Leak Data</button>` : ""}
    </div>`;

  onId("leak-back", "click", () => { S.screen = "stats"; render(); });
  onId("leak-clear", "click", () => {
    if (confirm("Reset all leak/decision data?")) { try { localStorage.removeItem(DECISIONS_KEY); } catch { /* */ } render(); }
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

/* ═══════════════════ MULTIPLAYER (Phase 0: local hot-seat) ═══════════════════ */

const mpc = (n: number): string => Math.round(n).toLocaleString();
const mpCard = (c: Card): string => `<span class="mp-card ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</span>`;
const capWord = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Stakes tiers — 100bb max buy-in per the monetization council (chips buy ACCESS,
// never power; a 100bb cap defuses big-stack bullying on a friends table).
const ROOM_TIERS = [
  { name: "Micro", sb: 50, bb: 100, max: 10000 },
  { name: "Mid", sb: 500, bb: 1000, max: 100000 },
  { name: "High", sb: 5000, bb: 10000, max: 1000000 },
];
// AI styles map to the trainer's opponent archetypes (keys of PROFILES).
const AI_SKILLS = [
  { key: "Station", label: "🐟 Fish" },
  { key: "Nit", label: "🪨 Rock" },
  { key: "TAG", label: "🎯 Reg" },
  { key: "LAG", label: "🔥 LAG" },
  { key: "Auto", label: "🦈 Shark" },
];
let _aiTimer: ReturnType<typeof setTimeout> | null = null;
const aiDelayMs = (): number => ({ slow: 1300, normal: 850, fast: 420, instant: 140 })[trainingSpeed()];

function renderMpSetup(): void {
  cancelVillainTimer();
  const su = S.mp.setup;
  const tier = ROOM_TIERS[su.tier]!;
  const minBuy = 20 * su.bb;
  app.innerHTML = `
    <div class="setup">
      <h1>👥 Create Room</h1>
      <span class="hint" style="text-align:center;display:block;margin-bottom:12px">Play vs AI or pass-and-play with friends. Pick stakes, your buy-in, and who's at the table. Assisted seats (🧠) get the GTO tool — benchmark them against blind seats.</span>

      <div class="field"><label>Stakes</label>
        <div class="seg" id="room-tier">${ROOM_TIERS.map((t, i) => `<button class="seg-btn ${su.tier === i ? "sel" : ""}" data-tier="${i}">${t.name}<br><small>${t.sb}/${t.bb}</small></button>`).join("")}</div>
      </div>

      <div class="field"><label>Buy-in <span class="lbl-sub">${su.buyIn.toLocaleString()} chips · ${Math.round(su.buyIn / su.bb)}bb</span></label>
        <input class="buyin-slider" id="room-buyin" type="range" min="${minBuy}" max="${tier.max}" step="${su.bb}" value="${su.buyIn}"/>
        <div class="buyin-ends"><span>${minBuy.toLocaleString()}</span><span>max ${tier.max.toLocaleString()} (100bb)</span></div>
      </div>

      <div class="field"><label>Seats</label>
        ${su.players.map((p, i) => `
          <div class="mp-prow">
            <input class="mp-name" id="mp-name-${i}" value="${p.name.replace(/"/g, "&quot;")}" maxlength="14" />
            <select class="mp-type" id="mp-type-${i}"><option value="" ${!p.ai ? "selected" : ""}>🧑 Human</option>${AI_SKILLS.map((s) => `<option value="${s.key}" ${p.ai === s.key ? "selected" : ""}>${s.label} AI</option>`).join("")}</select>
            ${!p.ai ? `<label class="mp-assist" title="Gets the GTO tool">${p.assisted ? "🧠" : "🙈"}<input type="checkbox" id="mp-assist-${i}" ${p.assisted ? "checked" : ""} style="display:none"/></label>` : `<span class="mp-aibadge">AI</span>`}
            ${su.players.length > 2 ? `<button class="hdr-btn mp-rm" id="mp-rm-${i}">✕</button>` : ""}
          </div>`).join("")}
        ${su.players.length < 6 ? `<div class="mp-addrow"><button class="hdr-btn" id="mp-add">+ Human</button><button class="hdr-btn" id="mp-add-ai">+ AI player</button></div>` : ""}
      </div>

      <button class="start-btn" id="mp-start" style="background:linear-gradient(135deg,#f59e0b,#b45309);color:#fff">START ROOM</button>
      <button class="start-btn" id="mp-online" style="background:linear-gradient(135deg,#4285F4,#1a73e8);color:#fff;margin-top:8px">🌐 Play Online</button>
      <button class="hdr-btn" id="mp-back" style="width:100%;padding:12px;margin-top:6px">Back</button>
    </div>`;

  app.querySelectorAll("[data-tier]").forEach((b) => onEl(b, "click", () => {
    const i = +(b as HTMLElement).dataset.tier!; const t = ROOM_TIERS[i]!;
    su.tier = i; su.sb = t.sb; su.bb = t.bb; su.buyIn = t.max; // default to 100bb
    render();
  }));
  onId("room-buyin", "input", (e) => { su.buyIn = Math.max(minBuy, Math.min(tier.max, +(e.target as HTMLInputElement).value)); render(); });
  su.players.forEach((_, i) => {
    onId(`mp-name-${i}`, "change", (e) => { su.players[i]!.name = (e.target as HTMLInputElement).value.trim() || `P${i + 1}`; });
    onId(`mp-type-${i}`, "change", (e) => { su.players[i]!.ai = (e.target as HTMLSelectElement).value || null; render(); });
    onId(`mp-assist-${i}`, "change", (e) => { su.players[i]!.assisted = (e.target as HTMLInputElement).checked; render(); });
    onId(`mp-rm-${i}`, "click", () => { su.players.splice(i, 1); render(); });
  });
  onId("mp-add", "click", () => { su.players.push({ name: seatName(su.players.length), assisted: false, ai: null }); render(); });
  onId("mp-add-ai", "click", () => { su.players.push({ name: seatName(su.players.length), assisted: false, ai: "TAG" }); render(); });
  onId("mp-back", "click", () => { S.screen = "home"; render(); });
  onId("mp-online", "click", () => { void goOnline(); });
  onId("mp-start", "click", () => {
    const names = su.players.map((p, i) => p.name.trim() || `P${i + 1}`);
    const t = MP.createAuthTable(`local-${Date.now()}`, { uid: "u0", name: names[0]! }, {
      name: `${tier.name} Room`, blinds: { sb: su.sb, bb: su.bb }, startingStack: su.buyIn, maxSeats: su.players.length,
    });
    MP.setAssisted(t, "u0", 0, su.players[0]!.assisted);
    for (let i = 1; i < su.players.length; i++) {
      MP.sit(t, `u${i}`, names[i]!, i);
      MP.setAssisted(t, "u0", i, su.players[i]!.assisted);
    }
    MP.startHand(t, () => Math.random());
    S.mp.table = t; S.mp.reveal = false; S.mp.rec = null; S.screen = "mp-table"; render();
  });
}

// AI seats auto-act (local rooms only) via the trainer's archetype-flavored villain AI.
function scheduleAi(t: AuthTable, seat: number, archetype: string): void {
  if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
  _aiTimer = setTimeout(() => {
    _aiTimer = null;
    if (!t.gs || MP.publicState(t).toAct !== seat) return; // turn moved on
    const g = MP.toGsSeat(t, seat);
    const cards = t.holes.get(seat);
    const uid = t.seats[seat]?.uid;
    if (g < 0 || !cards || !uid) return;
    const prof = PROFILES[archetype] ?? PROFILES.TAG!;
    const dec = villainDecision(t.gs, g, cards, prof, Math.random);
    let r = MP.act(t, uid, { type: dec.type, amount: dec.amount });
    if (!r.ok) { // safety fallback: the AI's action was somehow illegal
      const toCall = MP.publicState(t).currentBet - MP.publicState(t).seats[seat]!.bet;
      r = MP.act(t, uid, { type: toCall > 0 ? "fold" : "check" });
    }
    S.mp.reveal = false; S.mp.rec = null;
    render();
  }, aiDelayMs());
}

function renderMpTable(): void {
  cancelVillainTimer();
  if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; } // never double-schedule an AI
  const t = S.mp.table;
  if (!t) { S.screen = "mp-setup"; render(); return; }
  const ps = MP.publicState(t);

  const boardHtml = ps.board.length ? ps.board.map(mpCard).join("") : `<span class="hint">— preflop —</span>`;
  const seatsHtml = ps.seats.map((s, ti) => {
    if (!s.uid) return "";
    const active = ti === ps.toAct;
    return `<div class="mp-seat ${active ? "active" : ""} ${s.folded ? "folded" : ""}">
      <span class="mp-seat-name">${s.assisted ? "🧠" : "🙈"} ${s.name}${ti === ps.dealerSeat ? " Ⓓ" : ""}</span>
      <span class="mp-seat-chips">🪙 ${mpc(s.chips)}${s.bet > 0 ? ` · bet ${mpc(s.bet)}` : ""}${s.folded ? " · folded" : ""}</span>
    </div>`;
  }).join("");

  let panel = "";
  if (ps.status === "hand_over") {
    panel = `<div class="mp-result">${ps.lastResult || "Hand complete"}</div>
      <button class="start-btn" id="mp-next">NEXT HAND</button>`;
  } else if (ps.toAct >= 0) {
    const seat = ps.seats[ps.toAct]!;
    const toCall = ps.currentBet - seat.bet;
    const aiArch = S.mp.setup.players[ps.toAct]?.ai;
    if (aiArch) {
      const label = AI_SKILLS.find((s) => s.key === aiArch)?.label ?? "AI";
      panel = `<div class="mp-turn"><strong>${seat.name}</strong> · ${label}</div><div class="mp-thinking">thinking<span>.</span><span>.</span><span>.</span></div>`;
    } else if (!S.mp.reveal) {
      panel = `<div class="mp-turn"><strong>${seat.name}</strong>'s turn</div>
        <button class="start-btn" id="mp-reveal">👁 Reveal cards & act</button>
        <span class="hint" style="text-align:center;display:block">Pass the device to ${seat.name}.</span>`;
    } else {
      const ph = MP.privateHandFor(t, seat.uid!);
      const cards = ph.holeCards ? ph.holeCards.map(mpCard).join("") : "";
      const rec = S.mp.rec;
      const tool = seat.assisted
        ? (rec ? `<div class="mp-rec">💡 <strong>${capWord(rec.action)}${rec.amount ? ` ${mpc(rec.amount)}` : ""}</strong> — <span class="hint">${rec.reasoning}</span></div>` : "")
        : `<div class="hint" style="text-align:center">🙈 Blind seat — no strategy tool.</div>`;
      panel = `<div class="mp-turn"><strong>${seat.name}</strong> ${seat.assisted ? "🧠 assisted" : "🙈 blind"}</div>
        <div class="mp-hole">${cards}</div>${tool}
        <div class="action-bar">
          <button class="action-btn fold" id="mp-fold">Fold</button>
          ${toCall > 0 ? `<button class="action-btn call" id="mp-call">Call ${mpc(toCall)}</button>` : `<button class="action-btn check" id="mp-check">Check</button>`}
          <button class="action-btn ${ps.currentBet > 0 ? "raise" : "bet"}" id="mp-bet">${ps.currentBet > 0 ? "Raise" : "Bet"} pot</button>
          <button class="action-btn raise" id="mp-allin">All-in</button>
        </div>`;
    }
  }

  const scores = ps.seats.filter((s) => s.uid).map((s) => ({ n: s.name, net: s.chips - t.startingStack, a: s.assisted }))
    .sort((x, y) => y.net - x.net);
  const sbHtml = `<div class="mp-scoreboard">
    <div class="hint">Net vs buy-in · ${t.handCount} hand${t.handCount === 1 ? "" : "s"}</div>
    ${scores.map((r) => `<div class="mp-score-row"><span>${r.a ? "🧠" : "🙈"} ${r.n}</span><span class="${r.net >= 0 ? "g-ok" : "g-bad"}">${r.net >= 0 ? "+" : ""}${mpc(r.net)}</span></div>`).join("")}</div>`;

  app.innerHTML = `
    <div class="game">
      <div class="game-topbar"><span>${t.name} · 🪙 play chips (no cash value)</span><button class="hdr-btn" id="mp-leave">Leave</button></div>
      <div class="mp-felt"><div class="mp-board">${boardHtml}</div><div class="mp-pot">POT 🪙 ${mpc(ps.pot)} · ${capWord(ps.street)}</div></div>
      <div class="mp-seats">${seatsHtml}</div>
      <div class="controls"><div class="controls-body">${panel}${sbHtml}</div></div>
    </div>`;

  onId("mp-leave", "click", () => { if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; } S.mp.table = null; S.mp.reveal = false; S.mp.rec = null; S.screen = "mp-setup"; render(); });
  // If it's an AI seat's turn, auto-act after a delay (local rooms only).
  if (ps.status === "in_hand" && ps.toAct >= 0) {
    const aiArch = S.mp.setup.players[ps.toAct]?.ai;
    if (aiArch) scheduleAi(t, ps.toAct, aiArch);
  }
  onId("mp-next", "click", () => { MP.startHand(t, () => Math.random()); S.mp.reveal = false; S.mp.rec = null; render(); });
  onId("mp-reveal", "click", () => {
    S.mp.reveal = true;
    const seat = ps.seats[ps.toAct]!;
    S.mp.rec = seat.assisted ? MP.recommendForSeat(t, ps.toAct, recommend, AUTO) : null;
    render();
  });
  const doAct = (action: MPAction): void => {
    MP.act(t, ps.seats[ps.toAct]!.uid!, action);
    S.mp.reveal = false; S.mp.rec = null; render();
  };
  onId("mp-fold", "click", () => doAct({ type: "fold" }));
  onId("mp-check", "click", () => doAct({ type: "check" }));
  onId("mp-call", "click", () => doAct({ type: "call" }));
  onId("mp-bet", "click", () => {
    const seat = ps.seats[ps.toAct]!;
    const target = Math.min(ps.currentBet > 0 ? ps.currentBet + ps.pot : ps.pot, seat.chips + seat.bet);
    doAct({ type: ps.currentBet > 0 ? "raise" : "bet", amount: target });
  });
  onId("mp-allin", "click", () => {
    const seat = ps.seats[ps.toAct]!;
    doAct({ type: ps.currentBet > 0 ? "raise" : "bet", amount: seat.chips + seat.bet });
  });
}

/* ═══════════════════ HOME HUB + PROFILE ═══════════════════ */

const PRESET_AVATARS = ["🦈", "🐺", "🦊", "🐉", "🦁", "🃏", "👑", "🤠", "🥷", "🐯", "🦅", "🐊", "🎩", "💎", "🔥", "🐧", "🦉", "🐸", "🦄", "👽"];
function hashHue(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function avatarChip(av: string, seed: string, size = 40): string {
  const dim = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px`;
  if (av && av !== "auto") return `<span class="avatar" style="${dim}">${av}</span>`;
  const mono = (seed || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar identicon" style="${dim};background:hsl(${hashHue(seed || "x")} 55% 42%)">${mono}</span>`;
}
function loadProfile(): void {
  try {
    const p = JSON.parse(localStorage.getItem("mce-profile") || "null");
    if (p && typeof p === "object") {
      S.profile = { nickname: p.nickname || "You", avatar: p.avatar || "", chips: typeof p.chips === "number" ? p.chips : 10000 };
    }
  } catch { /* default */ }
}
function saveProfile(): void { try { localStorage.setItem("mce-profile", JSON.stringify(S.profile)); } catch { /* quota */ } }

function renderHome(): void {
  cancelVillainTimer();
  const p = S.profile;
  app.innerHTML = `
    <div class="mc-home">
      <div class="mc-bg" aria-hidden="true">
        <span class="mc-glow g-emerald"></span><span class="mc-glow g-gold"></span>
        <span class="mc-suit s1">♠</span><span class="mc-suit s2">♥</span><span class="mc-suit s3">♦</span><span class="mc-suit s4">♣</span>
        <span class="mc-grain"></span>
      </div>

      <header class="mc-topbar">
        <button class="mc-profile" id="home-profile">
          <span class="mc-ring">${avatarChip(p.avatar, p.nickname, 36)}</span>
          <span class="mc-pchips-big">🪙 ${p.chips.toLocaleString()}</span>
        </button>
        <div class="mc-top-right">
          <button class="mc-gear" id="home-settings" aria-label="Settings">⚙</button>
          <button class="mc-store" id="home-store">＋ Chips</button>
        </div>
      </header>

      <div class="mc-hero">
        <div class="mc-fan" aria-hidden="true">
          <span class="mc-hc back"></span>
          <span class="mc-hc red">A<i>♥</i></span>
          <span class="mc-hc">A<i>♠</i></span>
        </div>
        <h1 class="mc-wordmark"><span>MONTECARLO</span><b>EDGE</b></h1>
        <p class="mc-tag">Play the math. Own the table.</p>
      </div>

      <div class="mc-modes">
        <button class="mc-mode train" id="home-train" style="--d:.05s"><span class="mc-mi">🎯</span><span class="mc-mtext"><span class="mc-mt">Train</span><span class="mc-md">Solo vs the GTO engine</span></span><span class="mc-arrow">→</span></button>
        <button class="mc-mode online" id="home-online" style="--d:.12s"><span class="mc-mi">🌐</span><span class="mc-mtext"><span class="mc-mt">Play Online</span><span class="mc-md">Sign in · see who's on</span></span><span class="mc-arrow">→</span></button>
        <button class="mc-mode pass" id="home-pass" style="--d:.19s"><span class="mc-mi">👥</span><span class="mc-mtext"><span class="mc-mt">Create Room</span><span class="mc-md">vs AI or friends · pick stakes</span></span><span class="mc-arrow">→</span></button>
        <button class="mc-mode profile" id="home-profile2" style="--d:.26s"><span class="mc-mi">👤</span><span class="mc-mtext"><span class="mc-mt">Profile</span><span class="mc-md">Avatar · name · chips</span></span><span class="mc-arrow">→</span></button>
      </div>

      <button class="mc-stats" id="home-stats" style="--d:.33s">📊 Stats &amp; Leak Report</button>
      <div class="mc-foot">
        <button class="mc-foot-link" id="home-explainer">How it works</button><span>·</span>
        <button class="mc-foot-link" id="home-legal">Terms</button><span>·</span>
        <button class="mc-foot-link" id="home-settings2">Settings</button>
      </div>
    </div>`;
  onId("home-settings", "click", () => { S.screen = "settings"; render(); });
  onId("home-settings2", "click", () => { S.screen = "settings"; render(); });
  onId("home-explainer", "click", () => { _docReturn = "home"; S.screen = "explainer"; render(); });
  onId("home-legal", "click", () => { _docReturn = "home"; S.screen = "legal"; render(); });
  onId("home-profile", "click", () => { S.screen = "profile"; render(); });
  onId("home-profile2", "click", () => { S.screen = "profile"; render(); });
  onId("home-store", "click", () => { S.screen = "profile"; render(); });
  onId("home-train", "click", () => { S.screen = "setup"; render(); });
  onId("home-online", "click", () => { void goOnline(); });
  onId("home-pass", "click", () => {
    if (S.mp.setup.players[0]) S.mp.setup.players[0]!.name = S.profile.nickname;
    S.screen = "mp-setup"; render();
  });
  onId("home-stats", "click", () => { S.screen = "stats"; render(); });
}

function renderProfile(): void {
  cancelVillainTimer();
  const p = S.profile;
  const last = +(localStorage.getItem("mce-dailychips") || 0);
  const canClaim = Date.now() - last > 20 * 3600 * 1000;
  const packs: [string, string][] = [["50,000", "$4.99"], ["150,000", "$9.99"], ["500,000", "$24.99"]];
  app.innerHTML = `
    <div class="setup">
      <h1>👤 Profile</h1>
      <div style="text-align:center;margin-bottom:10px">${avatarChip(p.avatar, p.nickname, 76)}</div>
      <div class="field"><label>Nickname</label><input class="mp-num" id="pf-nick" maxlength="14" value="${p.nickname.replace(/"/g, "&quot;")}"/></div>
      <div class="field"><label>Avatar</label>
        <div class="avatar-grid">
          <button class="avatar-pick ${!p.avatar ? "sel" : ""}" id="pf-av-auto" title="Auto identicon">${avatarChip("", p.nickname, 38)}</button>
          ${PRESET_AVATARS.map((a) => `<button class="avatar-pick ${p.avatar === a ? "sel" : ""}" data-av="${a}">${a}</button>`).join("")}
        </div>
      </div>
      <div class="mp-scoreboard">
        <div class="mp-score-row"><span>🪙 Chip balance</span><span class="g-ok">${p.chips.toLocaleString()}</span></div>
        <button class="start-btn" id="pf-daily" style="margin-top:8px;${canClaim ? "" : "opacity:.5"}">${canClaim ? "🎁 Claim daily free chips (+5,000)" : "🎁 Claimed — come back tomorrow"}</button>
      </div>
      <div class="field" style="margin-top:12px"><label>Buy chips</label>
        <div class="chip-store">
          ${packs.map(([c, pr]) => `<button class="chip-pack" disabled>🪙 ${c}<br><span>${pr}</span></button>`).join("")}
        </div>
        <span class="hint">Purchases unlock with Stripe (next phase). Chips are play-money — <strong>no cash value, never withdrawable</strong>.</span>
      </div>
      <div class="hint" style="text-align:center;margin-top:8px">${S.mp.auth ? `✓ Synced to your Google account (${S.mp.auth.name})` : "Sign in under Play Online to sync your profile across devices."}</div>
      <button class="hdr-btn" id="pf-back" style="width:100%;padding:12px;margin-top:8px">Back to Home</button>
    </div>`;
  onId("pf-nick", "change", (e) => { S.profile.nickname = (e.target as HTMLInputElement).value.trim() || "You"; saveProfile(); render(); });
  onId("pf-av-auto", "click", () => { S.profile.avatar = ""; saveProfile(); render(); });
  app.querySelectorAll("[data-av]").forEach((b) => onEl(b, "click", () => { S.profile.avatar = (b as HTMLElement).dataset.av!; saveProfile(); render(); }));
  onId("pf-daily", "click", () => {
    if (canClaim) { S.profile.chips += 5000; saveProfile(); try { localStorage.setItem("mce-dailychips", String(Date.now())); } catch { /* */ } render(); }
  });
  onId("pf-back", "click", () => { S.screen = "home"; render(); });
}

/* ═══════════════════ SETTINGS / LEGAL / EXPLAINER ═══════════════════ */

const APP_VERSION = "0.1.0";
let _docReturn: "home" | "settings" = "home";

const motionPref = (): "auto" | "on" | "off" => {
  const v = localStorage.getItem("mce-motion");
  return v === "on" || v === "off" ? v : "auto";
};

function docPage(title: string, intro: string, sections: Section[], extra = ""): void {
  const body = `<p class="doc-intro">${intro}</p>` + sections.map((s) =>
    `<section class="doc-section"><h2>${s.heading}</h2><div class="doc-body">${s.body}</div></section>`).join("");
  app.innerHTML = `<div class="setup doc"><h1>${title}</h1>${body}${extra}
    <button class="hdr-btn" id="doc-back" style="width:100%;padding:12px;margin-top:10px">Back</button></div>`;
  onId("doc-back", "click", () => { S.screen = _docReturn; render(); });
}

function renderLegal(): void { cancelVillainTimer(); docPage("Terms &amp; Legal", LEGAL_INTRO, LEGAL_SECTIONS); }
function renderExplainer(): void {
  cancelVillainTimer();
  docPage("How it works", EXPLAINER_INTRO, EXPLAINER_SECTIONS,
    `<button class="start-btn" id="doc-train" style="margin-top:10px">🎯 Start Training</button>`);
  onId("doc-train", "click", () => { S.screen = "setup"; render(); });
}

function renderSettings(): void {
  cancelVillainTimer();
  const auth = S.mp.auth;
  const motion = motionPref();
  const speed = trainingSpeed();
  const toggle = (id: string, on: boolean) => `<button class="set-toggle ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}"><span class="knob"></span></button>`;
  const row = (label: string, control: string, note = "") =>
    `<div class="set-row"><div class="set-rl"><span class="set-label">${label}</span>${note ? `<span class="set-note">${note}</span>` : ""}</div><div class="set-rc">${control}</div></div>`;
  app.innerHTML = `
    <div class="setup doc">
      <h1>⚙ Settings</h1>
      <div class="set-group"><div class="set-head">Sound &amp; feel</div>
        ${row("Sound effects", toggle("set-sound", isSoundEnabled()))}
        ${row("Reduce motion", `<div class="seg" id="set-motion">${(["auto", "on", "off"] as const).map((v) => `<button class="seg-btn ${motion === v ? "sel" : ""}" data-motion="${v}">${v[0]!.toUpperCase() + v.slice(1)}</button>`).join("")}</div>`, "Auto follows your device. On cuts chip-fly &amp; card animations.")}
      </div>
      <div class="set-group"><div class="set-head">Gameplay</div>
        ${row("Table speed", `<select class="set-select" id="set-speed">${SPEED_TIERS.map((t) => `<option value="${t}" ${speed === t ? "selected" : ""}>${SPEED_LABEL[t]}</option>`).join("")}</select>`, "Villain timing &amp; deal animations.")}
        ${row("Quiz mode", toggle("set-quiz", quizMode()), "Hide the recommendation until after you act, then grade you.")}
      </div>
      <div class="set-group"><div class="set-head">Account</div>
        ${auth
          ? row("Signed in", `<button class="hdr-btn" id="set-signout">Sign out</button>`, `${auth.name} · Google. Sign-out keeps your local data.`)
          : row("Online play", `<button class="hdr-btn" id="set-signin">Sign in</button>`, "Sign in with Google for presence &amp; sync. No ads, no data selling.")}
      </div>
      <div class="set-group"><div class="set-head">Your data</div>
        <div class="set-note" style="margin-bottom:9px">Everything below lives in your browser. We don't sell it or show ads. Wipe any of it, any time.</div>
        ${row("Reset session stats", `<button class="hdr-btn danger" id="set-reset-stats">Reset</button>`)}
        ${row("Clear hand history", `<button class="hdr-btn danger" id="set-clear-history">Clear</button>`, "Resets your leak report. Chips &amp; profile stay.")}
        ${row("Reset profile", `<button class="hdr-btn danger" id="set-reset-profile">Reset</button>`, "Nickname &amp; avatar back to default.")}
        ${row("Reset chip wallet", `<button class="hdr-btn danger" id="set-reset-wallet">Reset</button>`, "Play-money only — no cash value, never cashable. A local reset, not a refund.")}
        ${row("Delete all my data", `<button class="hdr-btn danger" id="set-delete-all">Delete</button>`, "Everything on this device. Cannot be undone.")}
      </div>
      <div class="set-group"><div class="set-head">Legal &amp; how it works</div>
        ${row("How it works", `<button class="hdr-btn" id="set-explainer">Open</button>`)}
        ${row("Terms &amp; legal", `<button class="hdr-btn" id="set-legal">Open</button>`, "Play-money, not gambling — the full terms.")}
      </div>
      <div class="set-group"><div class="set-head">About</div>
        <div class="about-name">MONTECARLO EDGE</div>
        <div class="set-note">A free NLHE GTO trainer + social play-money app. Built by Caspar, a solo developer in Singapore. No ads · no data selling · no real-money wagering. v${APP_VERSION}</div>
        <div class="about-links"><a href="https://github.com/xynkro/MonteCarloEdge" target="_blank" rel="noopener">GitHub</a> · <a href="https://xynkro.github.io/MonteCarloEdge/" target="_blank" rel="noopener">Live app</a></div>
      </div>
      <button class="hdr-btn" id="set-back" style="width:100%;padding:12px;margin-top:6px">Back to Home</button>
    </div>`;

  onId("set-sound", "click", () => { setSoundEnabled(!isSoundEnabled()); render(); });
  app.querySelectorAll("[data-motion]").forEach((b) => onEl(b, "click", () => { try { localStorage.setItem("mce-motion", (b as HTMLElement).dataset.motion!); } catch { /* */ } render(); }));
  onId("set-speed", "change", (e) => { try { localStorage.setItem("mce-speed", (e.target as HTMLSelectElement).value); } catch { /* */ } });
  onId("set-quiz", "click", () => { toggleQuiz(); render(); });
  onId("set-signin", "click", () => { void goOnline(); });
  onId("set-signout", "click", () => { if (confirm("Sign out of online play? Your profile, chips and stats on this device are NOT touched.")) void goOffline().then(render); });
  onId("set-reset-stats", "click", () => { if (confirm("Reset your session stats and best streak? Your hand history and chips stay.")) { S.gradeStats = { n: 0, pts: 0, gto: 0, mixed: 0, off: 0 }; S.streak = 0; S.bestStreak = 0; try { localStorage.removeItem("mce-beststreak"); } catch { /* */ } render(); } });
  onId("set-clear-history", "click", () => { if (confirm("Erase your saved hand + decision log? Your leak report resets to empty. Chips and profile stay.")) { clearHistory(); S.decisionLog = []; try { localStorage.removeItem(DECISIONS_KEY); } catch { /* */ } render(); } });
  onId("set-reset-profile", "click", () => { if (confirm('Reset your nickname to "You" and clear your avatar? Your chips, stats and history stay.')) { S.profile.nickname = "You"; S.profile.avatar = ""; saveProfile(); render(); } });
  onId("set-reset-wallet", "click", () => { if (confirm("Reset your play-money chip balance to the 10,000 starting stack and your daily-claim timer? Chips have no cash value and are never cashable — this is a local reset, not a refund.")) { S.profile.chips = 10000; saveProfile(); try { localStorage.removeItem("mce-dailychips"); } catch { /* */ } render(); } });
  onId("set-delete-all", "click", () => {
    if (confirm("Permanently delete EVERYTHING on this device — profile, chips, stats, hand history and settings — and sign you out? This cannot be undone.")) {
      ["mce-sound", "mce-motion", "mce-speed", "mce-quiz", "mce-beststreak", "mce-dailychips", "mce-player-stats", DECISIONS_KEY, "mce-profile"].forEach((k) => { try { localStorage.removeItem(k); } catch { /* */ } });
      try { clearHistory(); } catch { /* */ }
      if (S.mp.auth) void goOffline();
      location.reload();
    }
  });
  onId("set-explainer", "click", () => { _docReturn = "settings"; S.screen = "explainer"; render(); });
  onId("set-legal", "click", () => { _docReturn = "settings"; S.screen = "legal"; render(); });
  onId("set-back", "click", () => { S.screen = "home"; render(); });
}

// ── Online (Phase 1): Google sign-in + presence lobby ──
let _onlineUnsub: (() => void) | null = null;

async function goOnline(): Promise<void> {
  if (S.mp.authBusy) return;
  S.mp.authBusy = true; S.mp.authErr = ""; S.screen = "mp-lobby"; render();
  try {
    const user = await FB.signInWithGoogle();
    S.mp.auth = user;
    await FB.startPresence(user);
    if (_onlineUnsub) _onlineUnsub();
    _onlineUnsub = await FB.subscribeOnline((list) => { S.mp.online = list; if (S.screen === "mp-lobby") render(); });
  } catch (e) {
    S.mp.authErr = (e as Error)?.message ?? "Sign-in failed";
  } finally {
    S.mp.authBusy = false;
    render();
  }
}

async function goOffline(): Promise<void> {
  if (_onlineUnsub) { _onlineUnsub(); _onlineUnsub = null; }
  await FB.signOutUser().catch(() => {});
  S.mp.auth = null; S.mp.online = [];
}

function renderMpLobby(): void {
  cancelVillainTimer();
  const u = S.mp.auth;
  const body = !u
    ? (S.mp.authBusy
        ? `<div class="mp-result">Opening Google sign-in…</div><span class="hint" style="text-align:center;display:block">Pick your Google account in the popup.</span>`
        : `<div class="mp-result" style="color:var(--red)">${S.mp.authErr || "Not signed in."}</div>
           <button class="start-btn" id="lobby-retry" style="background:linear-gradient(135deg,#4285F4,#1a73e8);color:#fff">Retry Google sign-in</button>
           ${S.mp.authErr ? `<span class="hint" style="text-align:center;display:block">If this keeps failing: enable Google sign-in + add this domain in your Firebase console (see setup notes).</span>` : ""}`)
    : `<div class="mp-result" style="color:var(--emerald)">✓ Signed in as ${u.name}</div>
       <div class="mp-scoreboard">
         <div class="hint">🟢 Online now (${S.mp.online.length})</div>
         ${S.mp.online.length
           ? S.mp.online.map((o) => `<div class="mp-score-row"><span>🟢 ${o.name}${o.uid === u.uid ? " (you)" : ""}</span></div>`).join("")
           : `<div class="mp-score-row"><span class="hint">Just you so far — open this on another device & sign in to see them here.</span></div>`}
       </div>
       <span class="hint" style="text-align:center;display:block;margin-top:10px">🛠 Networked hands (deal friends in from their phones) land next phase — needs server-side dealing. Login + presence are live.</span>
       <button class="hdr-btn" id="lobby-signout" style="width:100%;padding:12px;margin-top:8px">Sign out</button>`;
  app.innerHTML = `
    <div class="setup">
      <h1>🌐 Online Lobby</h1>
      ${body}
      <button class="hdr-btn" id="lobby-back" style="width:100%;padding:12px;margin-top:6px">Back</button>
    </div>`;
  onId("lobby-retry", "click", () => { void goOnline(); });
  onId("lobby-signout", "click", () => { void goOffline().then(render); });
  onId("lobby-back", "click", () => { S.screen = "mp-setup"; render(); });
}

/* ═══════════════════ INIT ═══════════════════ */

// Register the service worker for offline / installable PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

loadProfile();
loadPlayerStats();
render();
initCardTilt();

// Interactive 3D tilt on the hero hole cards: move/drag a pointer over them and
// they rotate in space toward it with a moving glare (holographic-card feel).
// Attached once on document (survives morphdom; cards are targeted live by
// selector). Pure CSS-variable writes — no per-render wiring, no 3D engine.
function initCardTilt(): void {
  let queued = false;
  const setVars = (px: number, py: number): boolean => {
    const wrap = document.querySelector<HTMLElement>(".hero-cards");
    if (!wrap) return false;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const pad = 48; // a little grace so it engages just before you touch them
    if (px < r.left - pad || px > r.right + pad || py < r.top - pad || py > r.bottom + pad) return false;
    const nx = Math.max(-1, Math.min(1, (px - (r.left + r.width / 2)) / (r.width / 2)));
    const ny = Math.max(-1, Math.min(1, (py - (r.top + r.height / 2)) / (r.height / 2)));
    wrap.querySelectorAll<HTMLElement>(".hero-card").forEach((c) => {
      c.style.setProperty("--ry", (nx * 16).toFixed(1) + "deg");
      c.style.setProperty("--rx", (-ny * 16).toFixed(1) + "deg");
      c.style.setProperty("--gx", (nx * 34).toFixed(0) + "px");
      c.style.setProperty("--gy", (ny * 34).toFixed(0) + "px");
      c.style.setProperty("--glare", "0.34");
    });
    return true;
  };
  const reset = (): void => {
    document.querySelectorAll<HTMLElement>(".hero-card").forEach((c) => {
      c.style.setProperty("--rx", "0deg");
      c.style.setProperty("--ry", "0deg");
      c.style.setProperty("--glare", "0");
    });
  };
  const onMove = (px: number, py: number): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (!setVars(px, py)) reset(); });
  };
  document.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY), { passive: true });
  document.addEventListener("pointerdown", (e) => onMove(e.clientX, e.clientY), { passive: true });
  document.addEventListener("pointerup", reset);
  document.addEventListener("pointercancel", reset);
}
