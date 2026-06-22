import { type Card, rankOf, suitOf, makeCard, NUM_CARDS } from "../engine/cards.js";
import { type Combo, Range } from "../engine/range.js";
import { mulberry32 } from "../engine/rng.js";
import { GameState, type ActionType } from "../engine/game-state.js";
import { getPositions, positionsForButton, getRfiRange, getBbDefenseRange } from "../engine/charts/index.js";
import { estimateVillainRange, credibleRep, repIsPolar, scoreRunout, sizeClass, repsCapped } from "../engine/opponent.js";
import { shareWin, buildWinCanvas } from "./share-card.js";
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
  gto: { label: "Balanced", style: { aggression: 1.0, looseness: 1.0 }, blurb: "Equilibrium baseline — hard to exploit." },
  tag: { label: "Tight-Aggressive", style: { aggression: 1.15, looseness: 0.82 }, blurb: "Fewer hands, bet/raise them hard." },
  lag: { label: "Loose-Aggressive", style: { aggression: 1.35, looseness: 1.28 }, blurb: "Wide, lots of pressure & bluffs." },
  nit: { label: "Tight / Cautious", style: { aggression: 0.75, looseness: 0.7 }, blurb: "Premiums only, minimal bluffing." },
  maniac: { label: "Maniac", style: { aggression: 1.6, looseness: 1.5 }, blurb: "Max aggression — high variance." },
};
// Short labels for the in-game style cycler pill + recommendation card tag.
const HERO_STYLE_SHORT: Record<string, string> = { gto: "Bal", tag: "TAG", lag: "LAG", nit: "Nit", maniac: "Mnc" };
const HERO_STYLE_ORDER = ["gto", "tag", "lag", "maniac", "nit"] as const;
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
import * as IAP from "../mp/revenuecat.js";
import { LEGAL_INTRO, LEGAL_SECTIONS, EXPLAINER_INTRO, EXPLAINER_SECTIONS, type Section } from "./content.js";
import { playSound, setSoundEnabled, isSoundEnabled } from "./sound.js";
import * as Hist from "./history.js";

const RANKS = "23456789TJQKA";
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_RED = [false, true, true, false];

// Refined line-icons (currentColor) — replace cartoony emoji on home tiles.
const _svg = (b: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
const ICON_TARGET = _svg(`<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="3.7"/><path d="M12 1.4v3.1M12 19.4v3.2M1.4 12h3.1M19.4 12h3.2"/><circle cx="12" cy="12" r="1.05" fill="currentColor" stroke="none"/>`);
const ICON_GLOBE = _svg(`<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.7 2.4 2.7 14.4 0 16.8c-2.7-2.4-2.7-14.4 0-16.8z"/><path d="M5.4 6.5c1.9 1.2 11.3 1.2 13.2 0M5.4 17.5c1.9-1.2 11.3-1.2 13.2 0"/>`);
const ICON_BAG = _svg(`<path d="M5.6 7.8h12.8l-.85 11.1a1.7 1.7 0 0 1-1.7 1.6H8.15a1.7 1.7 0 0 1-1.7-1.6z"/><path d="M8.7 7.8V6.3a3.3 3.3 0 0 1 6.6 0v1.5"/>`);
const ICON_USER = _svg(`<circle cx="12" cy="8" r="3.9"/><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0"/>`);
const ICON_BOLT = _svg(`<path d="M12.8 2.4 4.7 13.3h6l-1.4 8.3 8.1-10.9h-6z" fill="currentColor" fill-opacity=".14"/>`);
const ICON_CHART = _svg(`<path d="M4 20h16"/><rect x="5.3" y="11.5" width="3.2" height="6.5" rx=".7"/><rect x="10.4" y="7" width="3.2" height="11" rx=".7"/><rect x="15.5" y="13.5" width="3.2" height="4.5" rx=".7"/>`);
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
  screen: "home" | "landing" | "setup" | "game" | "stats" | "leaks" | "mp-setup" | "mp-table" | "mp-lobby" | "mp-net" | "profile" | "settings" | "legal" | "explainer" | "store" | "signin" | "inbox" | "compose" | "admin" | "onboard" | "history";
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
  // Phase 2: live networked room (driven by Firestore snapshots from the backend).
  net: {
    code: string | null;
    pub: Record<string, any> | null; // public table snapshot
    myHand: [number, number] | null; // my own hole cards
    myRec: { action: string; amount: number; handLabel: string; reasoning: string; equity: number; potOdds: number; source: string } | null; // MCE Strategy advice (assisted seats)
    serverChips: number | null;      // server-held balance
    joinCode: string;
    busy: boolean;
    busyId: string;        // which store action is pending (product id / "restore") — scopes the spinner
    err: string;
    cog: boolean;          // in-lobby settings sheet visible
    publicRooms: Array<{ code: string; name: string; sb: number; bb: number; occupied: number; max: number; currency: string }> | null;
    publicRoomsBusy: boolean;
    rebuy: { open: boolean; amount: number; err: string };
    chat: { open: boolean; msgs: import("../mp/firebase-adapter.js").ChatMsg[]; draft: string; lastReadTs: number };
  };
  edgePass: boolean;        // Stripe Edge Pass subscription active (server-confirmed)
  wallet: { play: number | null; premium: number | null }; // server balances (signed in)
  lastWeekly: number;       // last weekly-claim timestamp (server)
  weeklyStreak: number;     // consecutive weekly claims (drives the ladder)
  collectibles: string[];   // owned cosmetic collectibles (server)
  isAdmin: boolean;         // super-admin custom claim
  inbox: import("../mp/firebase-adapter.js").InboxMsg[];
  compose: { toUid: string; toName: string; text: string; giftAmt: number; busy: boolean; err: string; sent: string };
  ledger: Record<string, any>[];
  mode: "live" | "training";
  sessionStart: number;
  tableSize: number;
  stackBB: number;
  bbValue: number;
  sbValue: number;
  currency: "usd" | "chips"; // table money display ($ for train/live, <i class=ic-coin></i> for Create Room)
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
  profile: { nickname: "You", avatar: "", chips: 1000 },
  mp: {
    table: null,
    setup: {
      players: [{ name: "You", assisted: true, ai: null }, { name: "Rey", assisted: false, ai: "TAG" }],
      tier: 0, sb: 5, bb: 10, buyIn: 1000,
    },
    reveal: false,
    rec: null,
    auth: null,
    online: [],
    authBusy: false,
    authErr: "",
  },
  net: { code: null, pub: null, myHand: null, myRec: null, serverChips: null, joinCode: "", busy: false, busyId: "", err: "", cog: false, publicRooms: null, publicRoomsBusy: false, rebuy: { open: false, amount: 0, err: "" }, chat: { open: false, msgs: [], draft: "", lastReadTs: 0 } },
  edgePass: false,
  wallet: { play: null, premium: null },
  lastWeekly: 0,
  weeklyStreak: 0,
  collectibles: [],
  isAdmin: false,
  inbox: [],
  compose: { toUid: "", toName: "", text: "", giftAmt: 0, busy: false, err: "", sent: "" },
  ledger: [],
  mode: "live",
  sessionStart: Date.now(),
  tableSize: 6,
  stackBB: 100,
  bbValue: 1,
  currency: "usd",
  sbValue: 0.5,
  sbManual: false,
  heroSeat: 3,
  dealerSeat: -1,
  handNumber: 0,
  seatStacks: [],
  archetype: "Auto",
  tournament: false,
  payoutPreset: "top3",
  heroStyle: (() => { try { const v = localStorage.getItem("mce-hero-style"); return (v && HERO_STYLES[v]) ? v : "gto"; } catch { return "gto"; } })(),
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
// Card face: a BIG rank centred with the suit directly below it — rank-dominant so the
// number/letter is easy to read at a glance. The face fills the card (.flip-front fix).
// cardDisplay stays the bare glyph for the share-card canvas / tiny seat cards.
function cardFace(c: Card): string {
  const r = RANKS[rankOf(c)], s = SUITS[suitOf(c)];
  return `<span class="cf-r">${r}</span><span class="cf-s">${s}</span>`;
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
  if (S.currency === "chips") return `<i class=ic-coin></i> ${Math.round(v).toLocaleString()}`;
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

// Last rendered screen — drives the iOS-style slide-in transition on screen change.
let _lastRenderedScreen: typeof S.screen | null = null;
// Screens to NOT animate into (the game tables — animation flicker on the card render path).
const NO_TRANSITION_SCREENS = new Set<typeof S.screen>(["game", "mp-net", "mp-table"]);
function _markScreenTransition(): void {
  if (typeof document === "undefined") return;
  const app = document.getElementById("app"); if (!app) return;
  // Only mark a transition when the screen actually changed.
  if (_lastRenderedScreen === S.screen) return;
  const prev = _lastRenderedScreen; _lastRenderedScreen = S.screen;
  if (prev == null) return; // first render — no animation
  if (NO_TRANSITION_SCREENS.has(S.screen)) return;
  // Trigger a one-shot slide-in by re-adding the class (drop the class first to restart the CSS animation).
  app.classList.remove("screen-in");
  void app.offsetWidth; // force reflow so the animation restarts
  app.classList.add("screen-in");
}
function render(): void {
  // Age gate blocks everything EXCEPT the Terms/How-it-works docs, so they're
  // readable from the gate itself before confirming.
  if (!ageConfirmed() && S.screen !== "legal" && S.screen !== "explainer") { renderAgeGate(); return; }
  _markScreenTransition();
  if (S.screen === "home") renderHome();
  else if (S.screen === "landing") renderLanding();
  else if (S.screen === "profile") renderProfile();
  else if (S.screen === "settings") renderSettings();
  else if (S.screen === "legal") renderLegal();
  else if (S.screen === "explainer") renderExplainer();
  else if (S.screen === "store") renderStore();
  else if (S.screen === "signin") renderSignIn();
  else if (S.screen === "inbox") renderInbox();
  else if (S.screen === "compose") renderCompose();
  else if (S.screen === "admin") renderAdmin();
  else if (S.screen === "onboard") renderOnboard();
  else if (S.screen === "setup") renderSetup();
  else if (S.screen === "stats") renderStats();
  else if (S.screen === "leaks") renderLeaks();
  else if (S.screen === "mp-setup") renderMpSetup();
  else if (S.screen === "mp-lobby") renderMpLobby();
  else if (S.screen === "mp-table") renderMpTable();
  else if (S.screen === "mp-net") renderNetTable();
  else if (S.screen === "history") renderHistory();
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
      <h3>🧠 MCE Solve · CFR (${S.gs?.street ?? "river"})</h3>
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
      <div class="setup-footer setup-top">
        <button class="hdr-btn" id="home-btn">← Leave Training Mode</button>
        <button class="hdr-btn" id="view-stats">Session Stats</button>
        <button class="hdr-btn" id="sound-toggle">${isSoundEnabled() ? "🔊 Sound On" : "🔇 Sound Off"}</button>
      </div>

      <div class="brand">
        <img class="brand-logo" src="${import.meta.env.BASE_URL}brand/emblem.svg" alt="" onerror="this.style.display='none'" />
        <h1 class="brand-wordmark"><span>MONTECARLO</span><b>EDGE</b><small>Play the player. Own the table.</small></h1>
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

      <button class="start-btn" id="start-training" style="background:linear-gradient(135deg,var(--violet),var(--violet-2));color:#fff;box-shadow:0 8px 22px rgba(124,92,255,.3)">TRAINING MODE</button>
      <span class="hint" style="text-align:center">Training: practice against the AI. It deals cards, makes villain decisions, reveals hands at showdown.</span>
      <button class="start-btn" id="start">🃏 LIVE IN PERSON</button>
      <span class="hint" style="text-align:center">Live game tracker: you're at a real table — tap each opponent's action and the app calls your play in real time.</span>

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
    try { localStorage.setItem("mce-hero-style", S.heroStyle); } catch { /* */ }
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
  onEl($("#start"), "click", () => { endRoom(); S.mode = "live"; S.currency = "usd"; startHand(); });
  onId("start-training", "click", () => {
    endRoom();
    S.mode = "training";
    S.currency = "usd";
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
  onId("home-btn", "click", () => { endRoom(); S.currency = "usd"; S.screen = "home"; render(); });
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

// True when the table is in full-bleed landscape mode (the WSOP broadcast layout
// in styles.css). Wires a one-time matchMedia listener so rotating re-renders the
// seat ring (seat coords differ by orientation; rotation isn't a state change).
let _orientWired = false;
function landscapeTable(): boolean {
  if (typeof matchMedia !== "function") return false;
  const mq = matchMedia("(orientation: landscape) and (max-height: 600px)");
  if (!_orientWired) { _orientWired = true; try { mq.addEventListener("change", () => render()); } catch { /* older Safari */ } }
  return mq.matches;
}
// Seat position (% of the .poker-table box) for visual order `vis` (0 = hero) of `n` seats.
// PORTRAIT: the original even ellipse. LANDSCAPE (full-bleed WSOP stadium): the SAME
// full ring, just wider + a touch taller so players line the whole rim of the wide
// stadium felt (top row, both sides, bottom corners) with the hero at bottom-centre —
// exactly like the WSOP broadcast table. The action bar lives in a bottom strip below
// the felt, so no seat is ever covered.
function tableSeatPos(vis: number, n: number): { left: number; top: number } {
  const a = (vis * 2 * Math.PI) / n;
  if (landscapeTable()) {
    if (vis === 0) return { left: 50, top: 84 }; // hero lifted so its stack clears the bottom action bar
    return { left: 50 - 47 * Math.sin(a), top: 50 + 45 * Math.cos(a) };
  }
  return { left: 50 - 41 * Math.sin(a), top: 50 + 38 * Math.cos(a) };
}
function seatCoord(seatIdx: number): { left: number; top: number } {
  const n = getPositions(S.tableSize).length;
  const vis = (seatIdx - S.heroSeat + n) % n;
  return tableSeatPos(vis, n);
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

// A burst of falling confetti for the win-the-room celebration. Deterministic spread (even
// distribution, no RNG needed). Pure CSS animation — pointer-events:none so it never blocks.
function confettiHtml(): string {
  const colors = ["#f5c451", "#3ecf8e", "#ffffff", "#7c5cff", "#ff9f1c", "#4fd0ee"];
  let s = "";
  for (let i = 0; i < 20; i++) {
    const left = (i * 50 + (i % 3) * 11) % 100;
    const c = colors[i % colors.length]!;
    const delay = (i % 7) * 0.11;
    const dur = 2.1 + (i % 5) * 0.32;
    const rot = (i * 47) % 360;
    s += `<i style="left:${left}%;background:${c};animation-delay:${delay.toFixed(2)}s;animation-duration:${dur.toFixed(2)}s;--r:${rot}deg"></i>`;
  }
  return `<div class="wr-confetti" aria-hidden="true">${s}</div>`;
}

// Copy a room code to the clipboard with a brief visual "Copied!" confirmation on the
// tapped button (no silent copy — the user needs to know it worked).
function copyCodeWithFeedback(code: string, e: unknown): void {
  try { void navigator.clipboard?.writeText(code); } catch { /* */ }
  const btn = (e as Event)?.currentTarget as HTMLElement | null;
  if (!btn) return;
  btn.classList.add("copied");
  const hint = btn.querySelector(".lc-hint");
  const prev = hint?.textContent;
  if (hint) hint.textContent = "Copied! ✓";
  setTimeout(() => { btn.classList.remove("copied"); if (hint && prev != null) hint.textContent = prev; }, 1300);
}

// Generated mascot avatar set (Higgsfield recraft). Hero is always the shark (the brand
// mascot + Caspar's icon); other seats cycle through the 5 remaining personas by seat index
// so each seat keeps a stable, distinct face.
const SEAT_AVATARS = ["fox", "owl", "bear", "panther", "eagle"] as const;
function avatarHtml(seat: number, isHero: boolean): string {
  const color = isHero ? "#00d68f" : AVATAR_COLORS[seat % AVATAR_COLORS.length]!;
  const name = isHero ? "shark" : SEAT_AVATARS[seat % SEAT_AVATARS.length]!;
  return `<div class="seat-avatar img" style="color:${color}"><img src="/avatars/${name}.webp" alt="" loading="lazy" draggable="false"></div>`;
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
      return `<div class="board-card dealt ${isRed(c) ? "red" : ""}${anim}">${flipFaces(cardFace(c))}</div>`;
    }
    return `<div class="board-card empty"></div>`;
  }).join("");

  // ── Hero cards ──
  const heroHtml = S.heroCards
    ? S.heroCards.map((c, i) =>
        `<div class="hero-card dealt ${isRed(c) ? "red" : ""}${animHero ? ` deal-in" style="animation-delay:${i * 110}ms` : ""}">${flipFaces(cardFace(c))}</div>`
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
    solver: { txt: "🧠 MCE · solved (CFR)", cls: "src-solver" },
    nash: { txt: "Nash push/fold", cls: "src-nash" },
    chart: { txt: "reference chart", cls: "src-chart" },
    heuristic: { txt: "equity heuristic", cls: "src-heur" },
  };
  const _solveSpot = liveSolverSpot();
  const solvingNow = !!_solveSpot && !liveSolveCache.has(_solveSpot);
  const srcMeta = S.rec?.source ? SRC[S.rec.source] : undefined;
  const srcBadge = S.rec
    ? `<span class="rec-src ${solvingNow ? "src-solving" : srcMeta?.cls ?? ""}">${
        solvingNow ? "solving…" : srcMeta?.txt ?? ""
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
        ${S.heroStyle && S.heroStyle !== "gto" ? `<span class="rec-style style-${S.heroStyle}" title="Recommendation tilted by your '${HERO_STYLES[S.heroStyle]?.label}' style — tap topbar pill to change">${HERO_STYLE_SHORT[S.heroStyle]}</span>` : ""}
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
            ? `<button class="hdr-btn style-pill style-${S.heroStyle}" id="style-btn" title="Your play style — tap to cycle. LAG/Maniac bluff more, Nit bluffs less.">${HERO_STYLE_SHORT[S.heroStyle] ?? "Bal"}</button>`
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
          ${gs ? `<div class="pot-line"><span class="table-pot">${chips(gs.pot)}</span><span class="pot-street">${gs.street.toUpperCase()}</span></div>` : ""}
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
            ${storyLinesHtml}
            <div class="rec-row">${recHtml}${canSolveGto() ? `<button class="gto-btn" id="gto-solve">${S.gtoSolving ? "Solving…" : "🧠 Solve"}</button>` : ""}</div>
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
  onEl($("#new-hand"), "click", () => {
    if (_roomActive) { endRoom(); S.currency = "usd"; S.screen = "mp-setup"; render(); return; } // chip room → back to Play Online
    S.screen = "setup"; S.dealerSeat = -1; S.handNumber = 0; render();
  });
  onId("speed-btn", "click", () => { cycleSpeed(); render(); });
  onId("style-btn", "click", () => {
    const i = HERO_STYLE_ORDER.indexOf(S.heroStyle as typeof HERO_STYLE_ORDER[number]);
    S.heroStyle = HERO_STYLE_ORDER[(i + 1) % HERO_STYLE_ORDER.length]!;
    try { localStorage.setItem("mce-hero-style", S.heroStyle); } catch { /* */ }
    // If we're at an online table, push the new style to the server so the next MCE rec
    // tilts the same way as Training. Fire-and-forget (no UI block).
    if (S.net.code) {
      const hs = S.heroStyle as "gto" | "tag" | "lag" | "nit" | "maniac";
      void FB.setSeatPrefs(S.net.code, { heroStyle: hs }).catch(() => { /* */ });
    }
    updateRec(); // refresh the trainer recommendation under the new style on the spot
    render();
  });
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
        ? { label: `✗ Off — the ${src} line is ${cap(S.rec.action)}`, cls: "g-bad" }
        : bucket === "mix"
          ? { label: `≈ OK — ${cap(type)} is a fine ${src} mix`, cls: "g-mix" }
          : { label: `✓ ${src} line · ${cap(type)}`, cls: "g-ok" };
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
  flashActionCallout(seat, type, amount);

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
    const refLabel = d.rec.source === "solver" ? "MCE solve" : SRC_WORD[d.rec.source ?? "heuristic"] ?? "strategy";
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
  flashActionCallout(next, action, amount);

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
  // Chip-room: push the hand result to the real wallet so wins/losses bank.
  syncRoomWallet();

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

  // All-time cumulative-P&L sparkline. allStats.pnlHistory is already the running total
  // across every recorded hand (training + live), so it fills the page even when THIS
  // session has 0 hands — which is exactly when the page looked empty before.
  const cumSeries = allStats.pnlHistory;
  const sparkSvg = ((): string => {
    if (cumSeries.length < 2) return "";
    const W = 320, H = 64, pad = 4;
    const lo = Math.min(0, ...cumSeries), hi = Math.max(0, ...cumSeries);
    const span = Math.max(1, hi - lo);
    const x = (i: number) => pad + (i / (cumSeries.length - 1)) * (W - pad * 2);
    const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
    const pts = cumSeries.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const zeroY = y(0).toFixed(1);
    const end = cumSeries[cumSeries.length - 1]!;
    // Bright explicit colours (the CSS --green/--red read too dark on the near-black card).
    const stroke = end >= 0 ? "#3ee089" : "#ff5d7a";
    const endX = x(cumSeries.length - 1).toFixed(1), endY = y(end).toFixed(1);
    const area = `${pad},${zeroY} ${pts} ${endX},${zeroY}`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="cumulative P&L">
      <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
      </linearGradient></defs>
      <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="rgba(255,255,255,.14)" stroke-width="1" stroke-dasharray="3 3"/>
      <polygon points="${area}" fill="url(#sparkFill)"/>
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 4px ${stroke}66)"/>
      <circle cx="${endX}" cy="${endY}" r="3.6" fill="${stroke}" style="filter:drop-shadow(0 0 5px ${stroke})"/>
    </svg>`;
  })();

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
        <div class="stat-label">MCE Accuracy (${S.gradeStats.n} decisions)</div>
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

      ${sparkSvg ? `
      <div class="stats-card">
        <div class="stat-label" style="margin-bottom:8px">All-Time Trend · ${allStats.hands} hands</div>
        ${sparkSvg}
        <div class="spark-foot"><span>${allStats.hands} hands tracked</span><span style="color:${cumSeries[cumSeries.length-1]! >= 0 ? "var(--green)" : "var(--red)"}">${fmt(cumSeries[cumSeries.length-1]!)} all-time</span></div>
      </div>` : (allHands.length > hands.length ? `
      <div class="stats-card">
        <div class="stat-label">All Time: ${allStats.hands} hands, ${fmt(allStats.totalPnl)}</div>
      </div>` : "")}

      <button class="start-btn" id="leak-report" style="background:linear-gradient(135deg,var(--violet),var(--violet-2));color:#fff">🔍 Leak Report</button>
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
    { k: "fold too much", n: overFold, fix: "You're folding hands the MCE line continues with — defend wider and don't give up your equity." },
    { k: "play too many hands", n: tooLoose, fix: "You're entering pots the MCE line folds — tighten up, especially out of position." },
    { k: "play too passively", n: tooPassive, fix: "You check/call where the MCE line bets or raises — bet your value and your bluffs." },
    { k: "over-bluff / over-bet", n: overAggro, fix: "You bet/raise where the MCE line checks or folds — pick better spots, respect strength." },
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
      <span class="hint" style="text-align:center;display:block;margin-bottom:14px">Your decisions vs the MCE line · ${all.length} graded · build it up in Training (try Quiz mode)</span>

      ${!enough ? `
        <div class="stats-card"><div class="stat-label" style="text-align:center;padding:20px 0">
          Play a few more training hands to unlock your leak report.<br>(${all.length}/8 decisions)
        </div></div>` : `
        <div class="stats-card">
          <div class="stat-big" style="color:${accColor(overall)}">${pctTxt(overall)}</div>
          <div class="stat-label">Overall MCE accuracy${
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
  { name: "1/2", sb: 1, bb: 2, max: 200 },
  { name: "5/10", sb: 5, bb: 10, max: 1000 },
  { name: "25/50", sb: 25, bb: 50, max: 5000 },
  { name: "50/100", sb: 50, bb: 100, max: 10000 },
  { name: "100/200", sb: 100, bb: 200, max: 20000 },
  { name: "500/1000", sb: 500, bb: 1000, max: 100000 },
];
// AI styles map to the trainer's opponent archetypes (keys of PROFILES).
// "rand" = a random style assigned at room start (so you can spam-add a varied
// table without configuring each seat).
const AI_ARCHES = ["Station", "Nit", "TAG", "LAG", "Auto"];
const AI_SKILLS = [
  { key: "rand", label: "🎲 Random" },
  { key: "Station", label: "🐟 Fish" },
  { key: "Nit", label: "🪨 Rock" },
  { key: "TAG", label: "🎯 Reg" },
  { key: "LAG", label: "🔥 LAG" },
  { key: "Auto", label: "🦈 Shark" },
];
let _aiTimer: ReturnType<typeof setTimeout> | null = null;
const aiDelayMs = (): number => ({ slow: 1300, normal: 850, fast: 420, instant: 140 })[trainingSpeed()];

// Chip-room (Play Online) wallet session: the buy-in is staked from the wallet
// and the wallet is synced to (start − buyIn + current stack) after every hand,
// so winning/losing at the table moves your real chip balance.
let _roomActive = false, _roomStartWallet = 0, _roomBuyIn = 0;
function syncRoomWallet(): void {
  if (!_roomActive) return;
  const stackChips = (S.seatStacks[S.heroSeat] ?? 0) * S.bbValue;
  S.profile.chips = Math.max(0, Math.round(_roomStartWallet - _roomBuyIn + stackChips));
  saveProfile();
}
function endRoom(): void { _roomActive = false; }

function renderMpSetup(): void {
  cancelVillainTimer();
  const su = S.mp.setup;
  if (!S.mp.auth) {
    app.innerHTML = `
    <div class="setup">
      <div class="doc-top"><button class="hdr-btn" id="mp-back">← Back</button><h1>🌐 Play Online</h1><span style="width:54px"></span></div>
      <div class="hint" style="text-align:center;margin:30px 0 16px">Sign in to play online — your chips are saved to your account and you can join friends by room code.</div>
      <button class="si-btn primary" id="mp-signin">Sign in / Register</button>
    </div>`;
    onId("mp-back", "click", () => { S.screen = "home"; render(); });
    onId("mp-signin", "click", () => { S.screen = "signin"; render(); });
    return;
  }
  const tier = ROOM_TIERS[su.tier]!;
  const premium = _roomCurrency === "premium";
  const sym = premium ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>";
  const bal = premium ? (S.wallet.premium ?? 0) : (S.wallet.play ?? 0);
  const minBuy = 20 * su.bb;
  const maxBuy = Math.max(minBuy, Math.min(tier.max, bal));
  const canAfford = bal >= minBuy;
  if (canAfford) su.buyIn = Math.max(minBuy, Math.min(maxBuy, su.buyIn || maxBuy));
  const online = S.mp.online;
  const noPrem = premium && bal <= 0;
  app.innerHTML = `
    <div class="setup">
      <div class="doc-top"><button class="hdr-btn" id="mp-back">← Back</button><h1>🌐 Play Online</h1>${online.length ? `<button class="online-pill ${_onlineOpen ? "open" : ""}" id="online-pill" title="Who's online">🟢 ${online.length}</button>` : `<span style="width:54px"></span>`}</div>
      ${_onlineOpen && online.length ? `<div class="online-list">${online.map((p) => `<span class="ol-chip">🟢 ${esc(p.name)}</span>`).join("")}</div>` : ""}

      <div class="room-bal"><span>Balance <strong><i class=ic-coin></i> ${fmtBal(S.wallet.play)}</strong> · <strong><i class=ic-gem></i> ${fmtBal(S.wallet.premium)}</strong></span><button class="hdr-btn" id="room-buychips">＋ Buy chips</button></div>

      <div class="join-card">
        <label>Join a room</label>
        <div class="net-join"><input class="mp-num join-code" id="net-code" placeholder="CODE" maxlength="8" autocapitalize="characters" autocomplete="off" value="${S.net.joinCode.replace(/"/g, "")}"/><button class="join-btn" id="net-join">Join</button><button class="join-btn spectate" id="net-spectate">👁 Watch</button></div>
        <span class="hint">Ask the host for their 4-letter code — Watch to spectate without paying a buy-in.</span>
      </div>
      ${S.net.err ? `<div class="room-broke" style="margin:8px 0">${esc(S.net.err)}</div>` : ""}

      ${myRooms().length ? `<div class="your-games">
        <div class="pr-head"><label>↩ Your games · resume</label></div>
        <div class="pr-list">${myRooms().map((r) => `<div class="pr-row yg" data-resume="${r.code}"><span class="pr-code">${r.code}</span><span class="pr-meta">${esc(r.label)}</span><button class="yg-x" data-forget="${r.code}" title="Forget this room">✕</button></div>`).join("")}</div>
      </div>` : ""}

      <div class="public-rooms">
        <div class="pr-head"><label>Online games${S.net.publicRooms ? ` · ${S.net.publicRooms.length}` : ""}</label><button class="hdr-btn pr-refresh" id="pr-refresh" title="Refresh">${S.net.publicRoomsBusy ? '<span class="spin"></span>' : "↻"}</button></div>
        ${S.net.publicRooms === null
          ? (S.net.publicRoomsBusy ? `<div class="net-wait"><span class="spin"></span><span>Finding open rooms…</span></div>` : `<span class="hint">Tap ↻ to find open public rooms.</span>`)
          : (S.net.publicRooms.length === 0
            ? `<span class="hint">No open public rooms right now — be the first to create one.</span>`
            : `<div class="pr-list">${S.net.publicRooms.map((r) => `<button class="pr-row" data-code="${r.code}"><span class="pr-code">${r.code}</span><span class="pr-meta">${r.currency === "premium" ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>"} ${r.sb}/${r.bb}</span><span class="pr-seats">${r.occupied}/${r.max} seats</span></button>`).join("")}</div>`)}
      </div>

      <button class="create-toggle ${_createOpen ? "open" : ""}" id="create-toggle">
        <span class="ct-main">＋ Create your own room</span>
        <span class="ct-sub">${_createOpen ? "Set it up below" : "Private or public · stakes & buy-in"}</span>
        <span class="ct-chev">${_createOpen ? "▾" : "▸"}</span>
      </button>

      ${_createOpen ? `
      <div class="create-panel">
        <div class="cur-seg" id="room-cur">
          <button class="${!premium ? "sel" : ""}" data-cur="play"><i class=ic-coin></i> Chips</button>
          <button class="${premium ? "sel" : ""}" data-cur="premium"><i class=ic-gem></i> Premium Chips</button>
        </div>

        <div class="${noPrem ? "room-greyed" : ""}">
          ${noPrem ? `<div class="room-broke">You have no <i class=ic-gem></i> Premium Chips. Win them at premium tables, or buy them in the Store.</div><button class="start-btn" id="room-buyprem" style="background:var(--gold-foil);color:#2a1c05;margin:8px 0">Get Premium Chips</button>` : ""}

          <div class="field"><label>Stakes ${premium ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>"}</label>
            <div class="seg room-stakes" id="room-tier">${ROOM_TIERS.map((t, i) => `<button class="seg-btn ${su.tier === i ? "sel" : ""}" data-tier="${i}" ${noPrem ? "disabled" : ""}><span class="rs-name">${t.name}</span></button>`).join("")}</div>
          </div>

          ${canAfford && !noPrem ? `
          <div class="field"><label>Your buy-in</label>
            <div class="buyin-value">${sym} ${su.buyIn.toLocaleString()}<span> · ${Math.round(su.buyIn / su.bb)}bb</span></div>
            <input class="buyin-slider" id="room-buyin" type="range" min="${minBuy}" max="${maxBuy}" step="${Math.max(1, Math.round(su.bb))}" value="${su.buyIn}"/>
            <div class="buyin-ends"><span>min ${minBuy.toLocaleString()}</span><span>you have ${sym} ${bal.toLocaleString()}</span></div>
          </div>` : (!noPrem ? `<div class="room-broke">You need at least ${sym} ${minBuy.toLocaleString()} to sit at ${tier.name}. Lower the stakes or top up.</div>` : "")}

          <button class="opts-toggle ${_createOptsOpen ? "open" : ""}" id="opts-toggle">⚙ Table options${_createOptsOpen ? "" : ` <span class="ot-peek">· ${_roomPublic ? "Public" : "Private"} · ${hasEdge() && _roomAssisted ? "MCE on" : "MCE off"}</span>`}<span class="ct-chev">${_createOptsOpen ? "▾" : "▸"}</span></button>
          ${_createOptsOpen ? `
          <div class="opts-panel">
            <div class="field"><label>MCE Strategy overlay</label>
              <button class="mce-toggle ${hasEdge() && _roomAssisted ? "on" : ""} ${!hasEdge() ? "locked" : ""}" id="room-mce" ${noPrem ? "disabled" : ""}>${!hasEdge() ? "🔒 Edge Pass" : _roomAssisted ? "🧠 ON" : "OFF"}</button>
              <span class="hint" style="display:block;margin-top:4px">${!hasEdge() ? "Live in-game GTO recommendations — unlock with Edge Pass in the Store." : "Show the live MCE recommendation at your seat this room."}</span>
            </div>
            <div class="field"><label>Room visibility</label>
              <div class="cur-seg" id="room-priv">
                <button class="${_roomPublic ? "sel" : ""}" data-priv="public">🌐 Public</button>
                <button class="${!_roomPublic ? "sel" : ""}" data-priv="private">🔒 Private</button>
              </div>
            </div>
            <div class="field"><label>Bot speed</label>
              <div class="seg" id="room-speed">${SPEED_TIERS.map((t) => `<button class="seg-btn ${trainingSpeed() === t ? "sel" : ""}" data-speed="${t}">${SPEED_LABEL[t]}</button>`).join("")}</div>
              <span class="hint" style="display:block;margin-top:4px">Adjustable mid-game from the ⚙ cog too.</span>
            </div>
          </div>` : ""}

          ${canAfford && !noPrem ? `<button class="start-btn" id="net-create" style="background:linear-gradient(135deg,#4285F4,#1a73e8);color:#fff;margin-top:10px">${S.net.busy ? '<span class="spin dark"></span>' : `🌐 Create ${premium ? "<i class=ic-gem></i> Premium" : "<i class=ic-coin></i> Play"} Room`}</button>` : ""}
        </div>
      </div>` : ""}

    </div>`;
  onId("mp-back", "click", () => { S.screen = "home"; render(); });
  onId("online-pill", "click", () => { _onlineOpen = !_onlineOpen; render(); });
  app.querySelectorAll("[data-resume]").forEach((b) => onEl(b, "click", () => void joinNetRoom((b as HTMLElement).dataset.resume!)));
  app.querySelectorAll("[data-forget]").forEach((b) => onEl(b, "click", (e) => { e.stopPropagation(); removeMyRoom((b as HTMLElement).dataset.forget!); render(); }));
  onId("create-toggle", "click", () => { _createOpen = !_createOpen; render(); });
  onId("opts-toggle", "click", () => { _createOptsOpen = !_createOptsOpen; render(); });
  onId("room-buychips", "click", () => { S.screen = "store"; render(); });
  onId("room-buyprem", "click", () => { S.screen = "store"; render(); });
  app.querySelectorAll("#room-cur [data-cur]").forEach((b) => onEl(b, "click", () => { _roomCurrency = (b as HTMLElement).dataset.cur === "premium" ? "premium" : "play"; S.net.err = ""; render(); }));
  app.querySelectorAll("[data-tier]").forEach((b) => onEl(b, "click", () => { const i = +(b as HTMLElement).dataset.tier!; const t = ROOM_TIERS[i]!; su.tier = i; su.sb = t.sb; su.bb = t.bb; su.buyIn = Math.min(t.max, premium ? (S.wallet.premium ?? 0) : (S.wallet.play ?? 0)); render(); }));
  onId("room-buyin", "input", (e) => { su.buyIn = Math.max(minBuy, Math.min(maxBuy, +(e.target as HTMLInputElement).value)); render(); });
  onId("room-mce", "click", () => { if (!hasEdge()) { S.screen = "store"; render(); return; } _roomAssisted = !_roomAssisted; render(); });
  onId("net-create", "click", () => { void createNetRoom(); });
  onId("net-code", "input", (e) => { S.net.joinCode = (e.target as HTMLInputElement).value.trim().toUpperCase(); });
  onId("net-join", "click", () => { const v = (document.getElementById("net-code") as HTMLInputElement | null)?.value.trim().toUpperCase() || S.net.joinCode; void joinNetRoom(v); });
  onId("net-spectate", "click", () => { const v = (document.getElementById("net-code") as HTMLInputElement | null)?.value.trim().toUpperCase() || S.net.joinCode; void spectateNetRoom(v); });
  app.querySelectorAll("#room-priv [data-priv]").forEach((b) => onEl(b, "click", () => { _roomPublic = (b as HTMLElement).dataset.priv !== "private"; render(); }));
  app.querySelectorAll("#room-speed [data-speed]").forEach((b) => onEl(b, "click", () => { try { localStorage.setItem("mce-speed", (b as HTMLElement).dataset.speed!); } catch { /* */ } render(); }));
  onId("pr-refresh", "click", () => { void netRefreshPublic(); });
  app.querySelectorAll("[data-code]").forEach((b) => onEl(b, "click", () => { const c = (b as HTMLElement).dataset.code!; S.net.joinCode = c; void joinNetRoom(c); }));
  // Auto-fetch on first open (avoids requiring a tap to discover the list exists).
  if (S.net.publicRooms === null && !S.net.publicRoomsBusy) void netRefreshPublic();
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
      <span class="mp-seat-chips"><i class=ic-coin></i> ${mpc(s.chips)}${s.bet > 0 ? ` · bet ${mpc(s.bet)}` : ""}${s.folded ? " · folded" : ""}</span>
    </div>`;
  }).join("");

  let panel = "";
  if (ps.status === "hand_over") {
    // Last-man detection (training mode): hero seat is the only seated player with chips.
    const seated = ps.seats.filter((s) => !!s.uid);
    const heroSeated = seated.find((s) => s.assisted) ?? seated[0]; // training "you" = first assisted
    const wonRoom = !!heroSeated && heroSeated.chips > 0 && seated.length >= 2 && seated.every((s) => s === heroSeated || s.chips === 0);
    if (wonRoom) {
      const final = heroSeated.chips;
      panel = `
        <div class="win-room">
          ${confettiHtml()}
          <div class="wr-trophy">🏆</div>
          <div class="wr-title">YOU WIN THE TABLE</div>
          <div class="wr-sub">Last player standing</div>
          <div class="wr-stack"><span class="wr-final"><i class=ic-coin></i> ${mpc(final)}</span></div>
          <div class="wr-actions">
            <button class="hdr-btn" id="mp-rematch">↻ Rematch (reset stacks)</button>
            <button class="hdr-btn" id="mp-home">🏠 Home</button>
          </div>
        </div>`;
    } else {
      panel = `<div class="mp-result">${ps.lastResult || "Hand complete"}</div>
        <button class="start-btn" id="mp-next">NEXT HAND</button>`;
    }
  } else if (ps.toAct >= 0) {
    const seat = ps.seats[ps.toAct]!;
    const toCall = ps.currentBet - seat.bet;
    const aiArch = S.mp.setup.players[ps.toAct]?.ai;
    if (aiArch) {
      const label = AI_SKILLS.find((s) => s.key === aiArch)?.label ?? "AI";
      panel = `<div class="mp-turn"><strong>${seat.name}</strong> · ${label}</div><div class="net-wait"><span class="spin"></span><span>thinking…</span></div>`;
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
      <div class="game-topbar"><span>${t.name} · <i class=ic-coin></i> play chips (no cash value)</span><button class="hdr-btn" id="mp-leave">Leave</button></div>
      <div class="mp-felt"><div class="mp-board">${boardHtml}</div><div class="mp-pot">POT <i class=ic-coin></i> ${mpc(ps.pot)} · ${capWord(ps.street)}</div></div>
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
  onId("mp-rematch", "click", () => {
    // Reset every seated player back to the original buy-in, then deal. AuthSeat fields
    // only — bet/folded live on the GameState which is null at hand_over.
    const buy = t.startingStack;
    t.seats.forEach((s) => { if (s.uid) { s.chips = buy; s.sittingOut = false; } });
    MP.startHand(t, () => Math.random()); S.mp.reveal = false; S.mp.rec = null; render();
  });
  onId("mp-home", "click", () => { S.screen = "home"; render(); });
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

/* ═══════════════════ NETWORKED ROOMS (Phase 2 — live backend) ═══════════════════ */

let _netTableUnsub: (() => void) | null = null, _netHandUnsub: (() => void) | null = null;
let _netChatUnsub: (() => void) | null = null;
let _roomCurrency: "play" | "premium" = "play";
let _roomAssisted = false; // MCE Strategy overlay toggle (Edge Pass only)
let _roomPublic = true;    // public-by-default — listed in Online Games when waiting
let _createOpen = false;   // Play Online: "Create your own" config collapsed by default (declutter)
let _createOptsOpen = false; // …and the secondary table-options (MCE/privacy/bot speed) nested under it
let _onlineOpen = false;   // Play Online: the "who's online" name list expanded
// "Your games": a LOCAL bookmark of rooms you created. The room persists server-side, but
// listPublicRooms only returns WAITING rooms — so once you've dealt a hand it drops off the
// public list and a bot game you leave looks "gone". This list lets you jump back into it.
type MyRoom = { code: string; label: string; ts: number };
function myRooms(): MyRoom[] { try { return JSON.parse(localStorage.getItem("mce-myrooms") || "[]") as MyRoom[]; } catch { return []; } }
function addMyRoom(code: string, label: string): void {
  try { const list = myRooms().filter((r) => r.code !== code); list.unshift({ code, label, ts: Date.now() }); localStorage.setItem("mce-myrooms", JSON.stringify(list.slice(0, 6))); } catch { /* */ }
}
function removeMyRoom(code: string): void { try { localStorage.setItem("mce-myrooms", JSON.stringify(myRooms().filter((r) => r.code !== code))); } catch { /* */ } }
function clearNetSubs(): void {
  if (_netTableUnsub) { _netTableUnsub(); _netTableUnsub = null; }
  if (_netHandUnsub) { _netHandUnsub(); _netHandUnsub = null; }
  if (_netChatUnsub) { _netChatUnsub(); _netChatUnsub = null; }
  _netReplayGen++; // cancel any in-flight bot-replay so it can't paint a stale frame after we detach
}

function stripMessagePrefix(m: string): string { return m.replace(/^[^:]*:\s*/, "").trim(); }

function friendlyErr(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  const m = (e as Error)?.message ?? "Something went wrong.";
  if (code.includes("operation-not-allowed") || /requested action is invalid/i.test(m)) return "Google sign-in isn't enabled in your Firebase console yet.";
  if (code.includes("unauthorized-domain")) return "This domain isn't authorized in Firebase Auth settings.";
  if (code.includes("permission")) {
    const clean = stripMessagePrefix(m);
    return clean && !/insufficient permissions/i.test(clean) && !/^permission/i.test(clean)
      ? clean : "You're not in this hand anymore — refresh the table.";
  }
  if (code.includes("not-found")) return "Room not found — check the code.";
  if (code.includes("popup")) return "Sign-in popup was blocked or closed.";
  if (code.includes("failed-precondition") || code.includes("resource-exhausted")) {
    const clean = stripMessagePrefix(m);
    if (/^illegal\b/i.test(clean) || /^(check|call|bet|raise|fold)$/i.test(clean)) return "That move just became invalid — the table updated.";
    return clean;
  }
  return m;
}

// Gate an action on being signed in. Instead of a (mobile-unreliable) popup, send
// them to the sign-in screen; they retry the action once signed in.
async function ensureSignedIn(): Promise<boolean> {
  if (S.mp.auth) return true;
  S.screen = "signin"; render();
  return false;
}

async function enterRoom(code: string): Promise<void> {
  clearNetSubs();
  S.net.code = code; S.net.pub = null; S.net.myHand = null; S.net.myRec = null; S.net.err = "";
  S.screen = "mp-net"; render();
  // Push the user's chosen Bluff-Lab style to the server seat so the MCE rec for THIS player
  // tilts the same way as their Training table. Fire-and-forget — failure is silent (the
  // server falls back to GTO/Balanced). The callable also no-ops cleanly for spectators.
  if (S.heroStyle && S.heroStyle !== "gto") {
    const hs = S.heroStyle as "gto" | "tag" | "lag" | "nit" | "maniac";
    void FB.setSeatPrefs(code, { heroStyle: hs }).catch(() => { /* spectator / not seated yet */ });
  }
  try {
    _netTableUnsub = await FB.subscribeRoom(code, (pub) => onNetSnapshot(pub as Record<string, any> | null));
    const uid = S.mp.auth?.uid;
    if (uid) _netHandUnsub = await FB.subscribeMyHand(code, uid, (h) => { S.net.myHand = h?.holeCards ?? null; S.net.myRec = (h as { rec?: typeof S.net.myRec })?.rec ?? null; if (S.screen === "mp-net") render(); });
    // Chat is its own subcollection (separate listener so room snapshots stay tight).
    S.net.chat = { open: false, msgs: [], draft: "", lastReadTs: 0 };
    _netChatUnsub = FB.subscribeChat(code, (msgs) => { S.net.chat.msgs = msgs; if (S.screen === "mp-net") render(); });
  } catch (e) { S.net.err = friendlyErr(e); render(); }
}

async function netRefreshPublic(): Promise<void> {
  if (S.net.publicRoomsBusy) return;
  S.net.publicRoomsBusy = true; if (S.screen === "mp-setup") render(); // silent when prefetching from home
  try {
    const { rooms } = await FB.listPublicRooms();
    S.net.publicRooms = rooms;
  } catch { S.net.publicRooms = []; }
  finally { S.net.publicRoomsBusy = false; if (S.screen === "mp-setup") render(); }
}

async function createNetRoom(): Promise<void> {
  if (S.net.busy) return;
  S.net.err = "";
  if (!(await ensureSignedIn())) return;
  const su = S.mp.setup; const tier = ROOM_TIERS[su.tier]!;
  S.net.busy = true; render();
  try {
    // Create EMPTY (no AI) — bots are added in the lobby. MCE overlay only if entitled.
    const { code } = await FB.createRoom({ tier: tier.name, buyIn: su.buyIn, name: S.profile.nickname, bots: [], currency: _roomCurrency, assisted: hasEdge() && _roomAssisted, isPublic: _roomPublic });
    addMyRoom(code, `${tier.name} · ${su.buyIn.toLocaleString()} ${_roomCurrency === "premium" ? "premium" : "chips"}`);
    S.net.busy = false; await enterRoom(code);
  } catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}

function normalizeCode(code: string): string {
  let c = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.startsWith("MCE") && c.length > 4) c = c.slice(3);
  return c.length === 4 ? `MCE-${c}` : "";
}

async function spectateNetRoom(code: string): Promise<void> {
  if (S.net.busy) return;
  S.net.err = "";
  const norm = normalizeCode(code);
  if (!norm) { S.net.err = "Enter the 4-letter room code (e.g. XK4P)."; render(); return; }
  if (!(await ensureSignedIn())) return;
  S.net.busy = true; render();
  try { await FB.spectateRoom(norm, S.profile.nickname); S.net.busy = false; await enterRoom(norm); }
  catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}

async function joinNetRoom(code: string): Promise<void> {
  if (S.net.busy) return;
  S.net.err = "";
  // Accept any human form — "XK4P", "mce-xk4p", "MCE XK4P" — and normalise to MCE-XXXX.
  let c = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.startsWith("MCE") && c.length > 4) c = c.slice(3);
  if (c.length !== 4) { S.net.err = "Enter the 4-letter room code (e.g. XK4P)."; render(); return; }
  code = `MCE-${c}`;
  if (!(await ensureSignedIn())) return;
  S.net.busy = true; render();
  try { await FB.joinRoom(code, S.profile.nickname); S.net.busy = false; await enterRoom(code); }
  catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}

let _fomoDismissed = false; // user closed the "unlock MCE" upsell this session
let _netActing = false; // optimistic: true between tapping an action and the next snapshot
let _netResyncing = false; // true while a stale-frame recovery re-subscribe is in flight (loop guard)
let _pendingLeave = false; // tapped Leave mid-hand → bank + exit automatically on the next hand-over
let _bustLinger: ReturnType<typeof setTimeout> | null = null; // bust-rebuy linger timer
let _netActingSince = 0; // timestamp the in-flight action started (drives the "still loading…" escalation)
let _netBetOpen = false; // bet-sizing keypad panel open
let _netBetAmt = 0; // current keypad value = total bet / raise-to
let _netBetTyped = ""; // raw digits the user has keyed (empty = showing the suggested default)
async function netAct(action: { type: string; amount?: number }): Promise<void> {
  const code = S.net.code, pub = S.net.pub;
  if (!code || !pub || _netActing) return;
  _netActing = true; _netActingSince = Date.now();
  // Local action SFX (server replay also plays bot SFX via the snapshot-diff hook).
  playSound(action.type === "fold" ? "fold" : action.type === "check" ? "check" : action.type === "call" ? "chip" : "bet");
  // Escalate the spinner copy if the round-trip is slow (cold start / heavy bot tick) so it
  // reads "still loading…" instead of looking stuck. A single re-render at ~1.6s is enough.
  const _actEscalate = setTimeout(() => { if (_netActing && S.screen === "mp-net") render(); }, 1600);
  // Safety: a dropped/slow snapshot or a hung call must NEVER freeze the table. Release the
  // lock after 6s so the player can retry instead of being stuck on "sending…" forever.
  const _actSafety = setTimeout(() => { clearTimeout(_actEscalate); if (_netActing) { _netActing = false; if (S.screen === "mp-net") render(); } }, 6000);
  // OPTIMISTIC LOCAL APPLY — reflect MY action instantly (chips + bet slide, pot grows)
  // before the server round-trips. The authoritative snapshot replaces this ~300ms later.
  const uid = S.mp.auth?.uid;
  const seats = (pub.seats || []) as Array<{ uid: string | null; chips: number; bet: number; folded: boolean }>;
  const mi = uid ? seats.findIndex((s) => s.uid === uid) : -1;
  if (mi >= 0) {
    const s = seats[mi]!, cur = (pub.currentBet as number) || 0;
    if (action.type === "fold") s.folded = true;
    else if (action.type === "call") { const add = Math.max(0, Math.min(cur - s.bet, s.chips)); s.chips -= add; s.bet += add; pub.pot = ((pub.pot as number) || 0) + add; }
    else if (action.type === "bet" || action.type === "raise") { const add = Math.max(0, Math.min((action.amount ?? 0) - s.bet, s.chips)); s.chips -= add; s.bet += add; pub.pot = ((pub.pot as number) || 0) + add; pub.currentBet = Math.max(cur, s.bet); }
  }
  if (S.screen === "mp-net") render();
  try { await FB.actRoom(code, action, pub.version as number); _netResyncing = false; }
  catch (e) {
    clearTimeout(_actSafety); clearTimeout(_actEscalate); _netActing = false;
    const msg = friendlyErr(e);
    // STALE/COALESCED-FRAME RECOVERY: the server rejects with "no hand in progress" / "not your
    // turn" precisely when our S.net.pub is frozen on a dead in_hand frame (the hand-over/next
    // frame was coalesced away by onSnapshot). Don't strand the user on the stale error + stale
    // controls — drop the stale snapshot and re-subscribe so a fresh onSnapshot delivers the
    // authoritative state. _netResyncing gates this to ONE resync per failed act so a genuinely
    // out-of-turn tap (state already correct) can't spin an infinite refetch loop; the flag clears
    // on the next successful act (and on room entry/leave).
    // Match the RAW server message (not the friendly one) so an "illegal: raise" rejection —
    // which means our buttons were stale/desynced from the server's turn state — also triggers
    // a re-subscribe to pull the authoritative frame and correct the controls.
    const raw = (e as Error)?.message ?? "";
    if (/no hand in progress|not your turn|illegal/i.test(raw + " " + msg) && !_netResyncing && S.net.code) {
      _netResyncing = true; S.net.err = "";
      void enterRoom(S.net.code); // clearNetSubs + fresh subscribeRoom → immediate authoritative frame
      return;
    }
    S.net.err = msg; if (S.screen === "mp-net") render();
  }
}
async function netDeal(silent = false): Promise<void> {
  const code = S.net.code; if (!code) return;
  stopAutoDeal();
  try { await FB.dealHand(code); }
  catch (e) {
    // Auto-deal races are expected (another client / the auto-advance dealt first). Even on a
    // MANUAL tap, "Hand already in progress" just means the hand we wanted is already starting —
    // never flash that as a red error on the hand-over screen. Surface only genuine failures.
    const msg = friendlyErr(e);
    if (!silent && !/already in progress|already started|in progress/i.test(msg)) { S.net.err = msg; render(); }
  }
}

// ── AUTO-DEAL: nobody waits for the host. 5s after hand_over every seated human's client
// counts down and triggers the next hand; the server's in_hand guard makes the race harmless.
let _autoDealT: ReturnType<typeof setInterval> | null = null;
let _autoDealAt = 0; // epoch ms when the auto-deal fires (drives the countdown label)
// On bust, linger on the showdown result + revealed cards BEFORE auto-opening the rebuy sheet,
// so the player actually sees what beat them instead of an instant rebuy prompt.
let _bustHandId: string | null = null;
let _bustShownAt = 0;
const BUST_REVEAL_LINGER = 5000;
function stopAutoDeal(): void { if (_autoDealT) { clearInterval(_autoDealT); _autoDealT = null; } _autoDealAt = 0; }
function startAutoDeal(code: string): void {
  if (_autoDealT) return;
  // Linger on a SHOWDOWN (revealed cards present) so you can actually read the opponent's
  // hand before the next deal; stay snappy on a fold-out (nothing was shown).
  const showdown = !!S.net.pub && Object.keys((S.net.pub as { revealedHoles?: Record<string, unknown> }).revealedHoles || {}).length > 0;
  _autoDealAt = Date.now() + (showdown ? 9000 : 4500);
  _autoDealT = setInterval(() => {
    const pub = S.net.pub;
    if (S.screen !== "mp-net" || S.net.code !== code || !pub || pub.status !== "hand_over") { stopAutoDeal(); return; }
    if (Date.now() >= _autoDealAt) { void netDeal(true); return; } // netDeal stops the timer
    render(); // tick the countdown
  }, 500);
}

// ── Networked-table chip physics — reuse the trainer's animations on snapshot transitions.
// Bets sit in front of each seat during a street, sweep into the pot when the street turns,
// then the pot flies to the winner at showdown (just like a real table).
function netPreAnims(prev: Record<string, any>, pub: Record<string, any>): void {
  // Street advanced mid-hand → collect this street's bets into the pot. Runs on the OLD
  // DOM (the .seat-bet chips are still rendered) so the chips fly from the right spots.
  if (prev.status === "in_hand" && pub.status === "in_hand" && prev.street !== pub.street) animateChipsToPot();
}
// History capture state for the LIVE online hand. Module-level so transitions across
// multiple netPostAnims calls within a hand share continuity.
let _histStartChips: number | null = null;
// Bot stagger driven by the same speed tier as the trainer (saved to localStorage). Lets
// the user dial the per-action delay so a 5-handed pot doesn't feel like a slot machine.
// Per-tier bot stagger. Slow is genuinely deliberate (~2s/action) so a multi-bot pot doesn't
// blast through — used by both the visual callout stagger AND the snapshot-apply deferral.
const BOT_STAGGER_BY_TIER: Record<SpeedTier, number> = { slow: 2000, normal: 850, fast: 380, instant: 90 };
const botStaggerMs = (): number => BOT_STAGGER_BY_TIER[trainingSpeed()];

// ── Turn-by-turn online replay ─────────────────────────────────────────────────
// A new server tick may carry `botFrames`: the REAL public table state captured after each
// bot acted (server-authoritative). We replay them in order, paced by the speed tier, so the
// bots visibly take turns — exactly like the local trainer — then land on the authoritative
// final snapshot. Because every frame is a real server state, the existing per-transition
// animators (netPreAnims/netPostAnims) just work on each step; there is NO client-side
// engine simulation (that was the v116–v118 trap). This is the one render path.
let _netReplayGen = 0; // bumped on every snapshot → cancels any in-flight replay
type NetFrame = { seat: number; type: string; amount: number };

// Apply ONE state transition: pre-anim on the OLD dom, swap state + render, post-anim, then
// (for a replayed bot step) flash that seat's callout + spotlight.
function applyNetTransition(prev: Record<string, any> | null, next: Record<string, any>, cue: NetFrame | null): void {
  if (S.screen === "mp-net" && prev) netPreAnims(prev, next);
  S.net.pub = next;
  if (S.screen === "mp-net") {
    render();
    if (prev) netPostAnims(prev, next);
    if (cue) flashSeatCue(cue.seat, cue.type, cue.amount);
  }
}

function onNetSnapshot(pubRaw: Record<string, any> | null): void {
  const gen = ++_netReplayGen; // supersede any running replay
  if (!pubRaw) { S.net.pub = null; _netActing = false; _netBetOpen = false; if (S.screen === "mp-net") render(); return; }
  // Split the replay frames off the doc; the snapshot we KEEP is the final authoritative state.
  const frames = (Array.isArray(pubRaw.botFrames) ? pubRaw.botFrames : []) as Array<{ seat: number; type: string; amount: number; pub: Record<string, any> }>;
  const finalPub: Record<string, any> = { ...pubRaw }; delete finalPub.botFrames;
  const prev = S.net.pub as Record<string, any> | null;

  // Queued leave (tapped Leave mid-hand): the instant the hand is over, bank + exit; while it's
  // still running, fold out on our turn so it resolves. Guarantees the stack is ALWAYS banked.
  if (_pendingLeave && S.screen === "mp-net") {
    if (finalPub.status === "hand_over" || finalPub.status === "waiting") {
      S.net.pub = finalPub; _pendingLeave = false; void netLeave(); return;
    }
    const myUid = S.mp.auth?.uid;
    const ta = (finalPub.seats as Array<{ uid?: string | null; bet?: number }>)?.[finalPub.toAct as number];
    if (finalPub.status === "in_hand" && ta && ta.uid === myUid && !_netActing) {
      S.net.pub = finalPub; render();
      const toCall = ((finalPub.currentBet as number) || 0) - (ta.bet || 0);
      void netAct(toCall > 0 ? { type: "fold" } : { type: "check" });
      return;
    }
  }

  // Replay only a genuinely NEW tick that actually has bot steps, and only when a prior state
  // is already on-screen (skip on first load / re-subscribe so we never replay a stale chain).
  const newTick = !!prev && typeof finalPub.version === "number" && typeof prev.version === "number" && finalPub.version > prev.version;
  if (!(S.screen === "mp-net" && newTick && frames.length > 0)) {
    applyNetTransition(prev, finalPub, null);
    _netActing = false; _netBetOpen = false; S.net.err = ""; _bustLinger = null;
    return;
  }

  // Paced replay: step through each captured frame, then apply the AUTHORITATIVE final
  // snapshot. The per-frame publicState snapshots lack `revealedHoles` (added only in persist)
  // and `version`, so each frame is patched: `version` ← finalPub's (keeps the newTick gate
  // working if a fresh tick lands mid-replay), `lastAction` ← null (flashSeatCue is the SOLE
  // callout source during replay — otherwise the seat template renders a duplicate callout).
  _netActing = false; _netBetOpen = false; S.net.err = "";
  finalPub.lastAction = null;
  const stagger = botStaggerMs();
  let i = 0;
  const step = (): void => {
    if (gen !== _netReplayGen) return;            // a newer snapshot took over
    if (S.screen !== "mp-net") return;            // left the table → drop the replay (don't resurrect pub)
    const f = frames[i]!;
    if (f.pub) { f.pub.lastAction = null; f.pub.version = finalPub.version; }
    applyNetTransition(S.net.pub as Record<string, any> | null, f.pub, { seat: f.seat, type: f.type, amount: f.amount });
    i++;
    if (i < frames.length) setTimeout(step, stagger);
    // Final frame done → RENDER the authoritative snapshot (carries revealedHoles + the
    // "won with…" banner the per-frame snapshots lack). netPostAnims won't re-fire the winner
    // sweep because prev.status is already hand_over.
    else applyNetTransition(S.net.pub as Record<string, any> | null, finalPub, null);
  };
  step();
}
// Visual-only floating callout at a seat. Sound is the caller's responsibility so
// trainer can reuse this without double-firing the SFX that's already played at action time.
// Deferred via queueMicrotask + RAF so it survives any synchronous render() in the same tick
// (morphdom otherwise wipes the dynamically-appended child).
function flashActionCallout(seat: number, type: string, amount: number): void {
  const inject = (): void => {
    const seatEl = document.querySelector(`.table-seat[data-seat="${seat}"]`);
    if (!seatEl) return;
    const label = type === "fold" ? "FOLD" : type === "check" ? "CHECK" : type === "call" ? "CALL" : `${type.toUpperCase()} ${mpc(amount)}`;
    const seatTop = parseFloat((seatEl as HTMLElement).style.top || "50");
    // Place the callout on the OUTWARD side of the seat (away from the board centre) so it
    // never drifts over the community cards. The very top seat hugs the top edge, so it
    // shows just below itself instead (still clear of the board).
    const placement = seatTop <= 20 ? "below" : seatTop < 50 ? "above" : "below";
    const el = document.createElement("div");
    el.className = `action-call ${type} ${placement} bot-replay`;
    el.textContent = label;
    seatEl.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  };
  // Run after the current synchronous render cycle so morphdom doesn't drop our child.
  requestAnimationFrame(() => requestAnimationFrame(inject));
}
// Visual "acting now" cue for a replayed bot step: floating action callout + a moving
// spotlight on the seat. SFX + chip-fly are handled by netPostAnims's per-frame state diff
// (one action per frame), so this stays PURELY the "who is acting" cue — no sound, no chips —
// to avoid doubling up under the staggered replay.
function flashSeatCue(seat: number, type: string, amount: number): void {
  flashActionCallout(seat, type, amount);
  document.querySelectorAll(".table-seat.acting-now").forEach((el) => el.classList.remove("acting-now"));
  const seatEl = document.querySelector(`.table-seat[data-seat="${seat}"]`) as HTMLElement | null;
  if (!seatEl) return;
  seatEl.classList.add("acting-now");
  // Self-clear so the last bot's spotlight fades after its beat instead of lingering forever.
  const hold = Math.max(700, botStaggerMs() - 100);
  setTimeout(() => { seatEl.classList.remove("acting-now"); }, hold);
}
function blindPosition(pub: Record<string, any>, seatIdx: number): string {
  const seats = (pub.seats as Array<{ uid: string | null; ai: string | null }> | undefined) ?? [];
  const occupied = seats.map((s, ti) => ({ s, ti })).filter((x) => x.s.uid || x.s.ai);
  if (occupied.length === 0) return "?";
  const dealer = Number(pub.dealerSeat ?? 0);
  const btnOrder = occupied.findIndex((x) => x.ti === dealer);
  if (btnOrder < 0) return "?";
  const myOrder = occupied.findIndex((x) => x.ti === seatIdx);
  if (myOrder < 0) return "?";
  const rel = (myOrder - btnOrder + occupied.length) % occupied.length;
  if (occupied.length === 2) return rel === 0 ? "BTN/SB" : "BB";
  const positions = ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "MP+1", "HJ", "CO", "CO+1"];
  return positions[rel] ?? `+${rel}`;
}
function netPostAnims(prev: Record<string, any>, pub: Record<string, any>): void {
  const uid = S.mp.auth?.uid;
  // Hand just started (waiting/hand_over → in_hand) → deal sweep SFX + history reset.
  if (prev.status !== "in_hand" && pub.status === "in_hand") {
    playSound("deal");
    if (pub.handId) Hist.startHandTracking(String(pub.handId));
    const mi = (pub.seats as Array<{ uid: string | null; chips?: number }> | undefined)?.findIndex((s) => s?.uid === uid) ?? -1;
    _histStartChips = mi >= 0 ? Number((pub.seats as Array<{ chips?: number }>)[mi]?.chips ?? 0) : null;
  }
  // Just entered hand_over → fly the pot to the server-reported winner(s) + coin shower.
  // Uses pub.lastWinners (robust — works even for instant fold-outs that skip an in_hand frame).
  if (prev.status !== "hand_over" && pub.status === "hand_over") {
    const winners = (pub.lastWinners || []) as number[];
    // The turn-by-turn replay has already paced us to this final frame, so fire the
    // pot→winner sweep + coin shower immediately — no extra trace-length delay (that delay
    // was what made bets/folds land AFTER "you won"). On the immediate-apply path there were
    // no bots to pace anyway, so firing now is correct there too.
    const fireHandOver = (): void => {
      if (winners.length) requestAnimationFrame(() => { animatePotToWinner(winners); winners.forEach((w) => animateCoinShower(w)); });
      const mySeat = (pub.seats as Array<{ uid: string | null }> | undefined)?.findIndex((s) => s?.uid === uid) ?? -1;
      const iWon = mySeat >= 0 && winners.includes(mySeat);
      playSound(iWon ? "win" : "chip");
    };
    fireHandOver();
    const mySeat = (pub.seats as Array<{ uid: string | null }> | undefined)?.findIndex((s) => s?.uid === uid) ?? -1;
    // History capture: snapshot what just happened from MY view, drop into localStorage.
    if (mySeat >= 0 && pub.handId && Hist.currentHandId() === String(pub.handId)) {
      const mySeatData = (pub.seats as Array<{ chips: number; uid: string | null }>)[mySeat];
      const final = Number(mySeatData?.chips ?? 0);
      const start = _histStartChips ?? final;
      Hist.recordHand({
        id: String(pub.handId),
        ts: Date.now(),
        mode: "online",
        roomCode: S.net.code ?? undefined,
        blinds: (pub.blinds as { sb: number; bb: number }) ?? { sb: 0, bb: 0 },
        currency: (pub.currency as "play" | "premium") ?? "play",
        mySeat,
        position: blindPosition(pub, mySeat),
        myCards: S.net.myHand ? [S.net.myHand[0]!, S.net.myHand[1]!] : null,
        board: ((pub.board as number[]) ?? []).slice(),
        villainShown: Object.entries((pub.revealedHoles as Record<string, [number, number]>) || {})
          .filter(([k]) => Number(k) !== mySeat)
          .map(([k, v]) => ({ seat: Number(k), cards: v })),
        myNet: final - start,
        finalStack: final,
        result: String(pub.lastResult ?? ""),
      });
      Hist.clearTracking();
      _histStartChips = null;
    }
  }
  // Per-action animation: with turn-by-turn replay each frame's diff is exactly ONE bot's
  // action, so fly its chips / play its SFX here (the floating callout + "acting now"
  // spotlight come from the replay's flashSeatCue). My OWN action already showed
  // optimistically (netAct), so skip it via wasMe to avoid a double chip-fly / sound.
  if (prev.status === "in_hand" && pub.status === "in_hand" && prev.street === pub.street) {
    const oldS = (prev.seats || []) as Array<{ bet?: number; folded?: boolean; uid?: string | null }>;
    const newS = (pub.seats || []) as Array<{ bet?: number; folded?: boolean; uid?: string | null }>;
    newS.forEach((s, i) => {
      const wasFolded = !!oldS[i]?.folded, nowFolded = !!s.folded;
      const wasMe = oldS[i]?.uid === uid && uid;
      const oldBet = oldS[i]?.bet || 0;
      const newBet = s.bet || 0;
      if (newBet > oldBet) {
        if (!wasMe) { requestAnimationFrame(() => animateChipBet(i)); playSound(newBet > oldBet * 1.5 ? "bet" : "chip"); }
        Hist.pushAction({ street: String(pub.street ?? "preflop"), type: newBet === oldBet ? "call" : "bet", amount: newBet - oldBet, bySeat: i });
      } else if (nowFolded && !wasFolded) {
        if (!wasMe) playSound("fold");
        Hist.pushAction({ street: String(pub.street ?? "preflop"), type: "fold", amount: 0, bySeat: i });
      }
    });
  }
  // New community card dealt → flutter.
  const oldBoard = (prev.board || []) as number[];
  const newBoard = (pub.board || []) as number[];
  if (newBoard.length > oldBoard.length) playSound("card");
}
// Live decision clock — ticks the countdown number on the active seat every 500ms
// (snapshots only fire on actions, so the number needs its own heartbeat). Self-stops
// when we leave the table or the hand ends.
let _netClock: ReturnType<typeof setInterval> | null = null;
function startNetClock(): void {
  if (_netClock != null) return;
  _netClock = setInterval(() => {
    const pub = S.net.pub;
    if (S.screen !== "mp-net" || !pub || pub.status !== "in_hand") { stopNetClock(); return; }
    const secs = Math.max(0, Math.ceil((((pub.deadlineMs as number) || 0) - Date.now()) / 1000));
    document.querySelectorAll(".turn-clock").forEach((el) => { (el as HTMLElement).textContent = String(secs); el.classList.toggle("urgent", secs <= 5); });
    // Self-timeout: when MY clock hits zero, auto-act so the hand can never hang on me
    // (check if it's free, otherwise fold — standard time-bank-expiry behaviour). Each
    // client enforces its own turn, so a stalled/AFK player never freezes the table.
    if (secs <= 0 && !_netActing) {
      autoFoldMyTurn(pub, S.mp.auth?.uid);
    }
  }, 500);
}
function stopNetClock(): void { if (_netClock != null) { clearInterval(_netClock); _netClock = null; } }

function autoFoldMyTurn(pub: Record<string, any>, uid: string | undefined): void {
  const ta = (pub.seats as Array<{ uid?: string | null; bet?: number }>)?.[pub.toAct as number];
  if (pub && pub.status === "in_hand" && ta && ta.uid === uid && !_netActing) {
    const toCall = ((pub.currentBet as number) || 0) - (ta.bet || 0);
    void netAct(toCall > 0 ? { type: "fold" } : { type: "check" });
  }
}

async function netLeave(): Promise<void> {
  const code = S.net.code;
  if (!code) { _leaveCleanup(); return; }
  S.net.busy = true; render();
  try {
    await FB.leaveRoom(code); // server banks the table stack back to the wallet, THEN we exit
    _leaveCleanup();
  } catch (e) {
    S.net.busy = false;
    const msg = friendlyErr(e);
    // CRITICAL: never navigate away on a mid-hand reject — that stranded the stack on the seat
    // (wallet never credited). Instead QUEUE the leave: stop dealing into a new hand, fold out
    // if it's our turn, and the next hand-over snapshot banks + exits automatically.
    // Detect via the server's machine-readable details code (Firebase callable errors expose
    // `.details`); fall back to the legacy message regex for servers/clients deployed before the
    // code existed. Reading the code — not the wording — is what keeps the stack from stranding.
    const inHand = (e as { details?: { code?: string } })?.details?.code === "IN_HAND";
    if (inHand || /finish the hand|before leaving|in[_ ]?hand|in progress/i.test(msg)) {
      _pendingLeave = true; S.net.err = ""; stopAutoDeal();
      const pub = S.net.pub as Record<string, any> | null;
      if (pub) autoFoldMyTurn(pub, S.mp.auth?.uid);
      render();
    } else {
      S.net.err = msg; render(); // genuine failure → surface it, stay put (chips stay safe on the seat)
    }
  }
}
function _leaveCleanup(): void {
  clearNetSubs(); stopNetClock(); stopAutoDeal();
  if (_bustLinger) { clearTimeout(_bustLinger); _bustLinger = null; }
  S.net.code = null; S.net.pub = null; S.net.myHand = null; S.net.myRec = null; S.net.err = "";
  _netResyncing = false; _pendingLeave = false; S.net.busy = false;
  S.screen = "mp-setup"; render();
}

async function netAddBot(archetype: string): Promise<void> {
  const code = S.net.code; if (!code || S.net.busy) return;
  S.net.busy = true; render();
  try { await FB.addBot(code, archetype); S.net.busy = false; render(); }
  catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}

async function netSetSeatPrefs(prefs: { assisted?: boolean; recStyle?: import("../mp/firebase-adapter.js").RecStyle }): Promise<void> {
  const code = S.net.code; if (!code) return;
  try { await FB.setSeatPrefs(code, prefs); }
  catch (e) { S.net.err = friendlyErr(e); render(); }
}

async function netSetRoomPrefs(prefs: { isPublic?: boolean }): Promise<void> {
  const code = S.net.code; if (!code) return;
  try { await FB.setRoomPrefs(code, prefs); }
  catch (e) { S.net.err = friendlyErr(e); render(); }
}

async function netKickBot(seatIdx: number): Promise<void> {
  const code = S.net.code; if (!code) return;
  try { await FB.kickBot(code, seatIdx); }
  catch (e) { S.net.err = friendlyErr(e); render(); }
}

function openRebuySheet(): void {
  const pub = S.net.pub; if (!pub) return;
  S.net.rebuy.open = true; S.net.rebuy.err = "";
  if (S.net.rebuy.amount === 0) S.net.rebuy.amount = (pub.startingStack as number) || 20 * (((pub.blinds as { bb?: number })?.bb) || 10);
  render();
}
function closeRebuySheet(): void { S.net.rebuy.open = false; S.net.rebuy.err = ""; render(); }
function rebuyKeypress(key: string): void {
  const cur = S.net.rebuy.amount;
  if (key === "back") S.net.rebuy.amount = Math.floor(cur / 10);
  else if (key === "00") S.net.rebuy.amount = Math.min(10_000_000, cur * 100);
  else S.net.rebuy.amount = Math.min(10_000_000, cur * 10 + Number(key));
  S.net.rebuy.err = ""; render();
}
let _rebuySubmittedAt = 0;
async function netRebuy(): Promise<void> {
  const code = S.net.code, amt = S.net.rebuy.amount;
  if (!code || amt <= 0) return;
  try {
    await FB.rebuyRoom(code, amt);
    _rebuySubmittedAt = Date.now();
    S.net.rebuy.open = false; S.net.rebuy.amount = 0; S.net.rebuy.err = "";
    playSound("chip"); // chips into pocket — confirms the buy-in landed
    render();
  } catch (e) { S.net.rebuy.err = friendlyErr(e); render(); }
}
function wireRebuyHandlers(): void {
  onId("rb-close", "click", closeRebuySheet);
  onId("rb-x", "click", closeRebuySheet);
  onId("rb-confirm", "click", () => void netRebuy());
  onId("rb-store", "click", () => { closeRebuySheet(); S.screen = "store"; render(); });
  onId("rb-leave", "click", () => { closeRebuySheet(); void netLeave(); });
  app.querySelectorAll("[data-rb]").forEach((b) => onEl(b, "click", () => { S.net.rebuy.amount = Math.max(0, +(b as HTMLElement).dataset.rb!); S.net.rebuy.err = ""; render(); }));
  app.querySelectorAll("[data-key]").forEach((b) => onEl(b, "click", () => rebuyKeypress((b as HTMLElement).dataset.key!)));
}

function openChatDrawer(): void {
  S.net.chat.open = true;
  // Mark everything currently visible as read so the unread badge resets.
  const latest = S.net.chat.msgs.reduce((a, m) => Math.max(a, m.ts ?? 0), 0);
  S.net.chat.lastReadTs = Math.max(S.net.chat.lastReadTs, latest);
  render();
  // Scroll to newest right after the DOM mounts.
  setTimeout(() => { const s = document.getElementById("ch-stream"); if (s) s.scrollTop = s.scrollHeight; }, 0);
}
function closeChatDrawer(): void { S.net.chat.open = false; render(); }
async function netSendChat(text: string): Promise<void> {
  const code = S.net.code; if (!code) return;
  const clean = text.trim(); if (!clean) return;
  // Optimistic local clear so typing feels snappy; server is the rate-limit authority.
  S.net.chat.draft = "";
  const input = document.getElementById("ch-input") as HTMLInputElement | null;
  if (input) input.value = "";
  try { await FB.sendChat(code, clean); }
  catch (e) { S.net.err = friendlyErr(e); render(); }
}
function wireChatHandlers(): void {
  onId("net-chat", "click", openChatDrawer);
  onId("ch-close", "click", closeChatDrawer);
  onId("ch-x", "click", closeChatDrawer);
  onId("ch-send", "click", () => { const v = (document.getElementById("ch-input") as HTMLInputElement | null)?.value ?? S.net.chat.draft; void netSendChat(v); });
  const input = document.getElementById("ch-input") as HTMLInputElement | null;
  if (input) {
    onEl(input, "input", (e) => { S.net.chat.draft = (e.target as HTMLInputElement).value; const btn = document.getElementById("ch-send") as HTMLButtonElement | null; if (btn) btn.disabled = !S.net.chat.draft.trim(); });
    onEl(input, "keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); void netSendChat(input.value); } });
  }
  app.querySelectorAll(".ch-preset").forEach((b) => onEl(b, "click", () => { void netSendChat((b as HTMLElement).dataset.preset!); }));
}

// ── Shared room-settings cog (used by BOTH the lobby waiting-room AND the in-game table) ──
const COG_BOT_LABEL = (a: string): string => (({ Station: "Fish 🐟", TAG: "Reg 🎯", LAG: "LAG 🔥", Nit: "Nit 🪨", Auto: "Auto 🧮" }) as Record<string, string>)[a] || a;
const COG_STYLE_OPTS: Array<{ k: import("../mp/firebase-adapter.js").RecStyle; label: string; blurb: string }> = [
  { k: "balanced", label: "🧭 Balanced", blurb: "Auto-adapts from villain's action — safe default." },
  { k: "tag",      label: "🎯 TAG",      blurb: "Tight-Aggressive — solid regs, value-heavy ranges." },
  { k: "lag",      label: "🔥 LAG",      blurb: "Loose-Aggressive — wide opens, lots of barrels." },
  { k: "nit",      label: "🪨 Nit",      blurb: "Super tight — premiums only, fold to pressure." },
  { k: "station",  label: "🐟 Station",  blurb: "Calling fish — never folds, draws to anything." },
  { k: "maniac",   label: "🌪 Maniac",   blurb: "Over-aggressive — random shoves, max bluff." },
];
type CogSeat = { uid: string | null; ai: string | null; chips: number; assisted?: boolean; recStyle?: import("../mp/firebase-adapter.js").RecStyle };
function netCogSheetHtml(pub: Record<string, any>, seats: CogSeat[], uid: string | undefined): string {
  if (!S.net.cog) return "";
  const status = pub.status as string;
  const mySeat = seats.find((s) => s.uid === uid);
  const assistedOn = !!mySeat?.assisted;
  const myStyle = (mySeat?.recStyle ?? "balanced") as import("../mp/firebase-adapter.js").RecStyle;
  const isOwner = pub.ownerUid === uid;
  const isPublic = pub.isPublic !== false;
  const botSeats = seats.map((s, ti) => ({ s, ti })).filter((x) => x.s.ai);
  const styleBlurb = COG_STYLE_OPTS.find((x) => x.k === myStyle)?.blurb ?? "";
  return `
    <div class="cog-backdrop" id="cog-close"></div>
    <div class="cog-sheet">
      <div class="cog-head"><span>Room settings</span><button class="hdr-btn" id="cog-x" aria-label="Close room settings">✕</button></div>
      <div class="cog-section"><div class="cog-label">Your seat</div>
        <div class="cog-row"><span>MCE Strategy</span>
          <button class="mce-toggle ${hasEdge() && assistedOn ? "on" : ""} ${!hasEdge() ? "locked" : ""}" id="cog-mce">${!hasEdge() ? "🔒 Edge Pass" : assistedOn ? "🧠 ON" : "OFF"}</button>
        </div>
        ${hasEdge() && assistedOn ? `<div class="cog-style-block">
          <div class="cog-style-head"><span>Villain read</span><span class="cog-style-blurb">${esc(styleBlurb)}</span></div>
          <div class="cog-style-grid">${COG_STYLE_OPTS.map((o) => `<button class="cog-style-btn ${myStyle === o.k ? "sel" : ""}" data-style="${o.k}"><span class="cs-lbl">${o.label}</span></button>`).join("")}</div>
        </div>` : ""}
      </div>
      ${isOwner ? `<div class="cog-section"><div class="cog-label">Room (host)</div>
        <div class="cog-row"><span>Visibility</span>
          <button class="mce-toggle ${isPublic ? "on" : ""}" id="cog-priv">${isPublic ? "🌐 Public" : "🔒 Private"}</button>
        </div>
        ${botSeats.length > 0 && status === "waiting" ? `<div class="cog-row"><span>Kick a bot</span>
          <div class="cog-kick-list">${botSeats.map(({ s, ti }) => `<button class="hdr-btn cog-kick" data-seat="${ti}">${COG_BOT_LABEL(s.ai!)}</button>`).join("")}</div>
        </div>` : ""}
      </div>` : ""}
      <div class="cog-section"><div class="cog-label">Pace</div>
        <div class="cog-row"><span>Bot speed</span>
          <div class="seg cog-speed">${SPEED_TIERS.map((t) => `<button class="seg-btn ${trainingSpeed() === t ? "sel" : ""}" data-speed="${t}">${SPEED_LABEL[t]}</button>`).join("")}</div>
        </div>
        <span class="hint">How fast bots take their turns. Change it any time — even mid-hand.</span>
      </div>
      <div class="cog-section"><div class="cog-label">Buy-in</div>
        <div class="cog-row"><span>Top up your stack</span><button class="hdr-btn" id="cog-rebuy">Rebuy →</button></div>
        <span class="hint">Available when you bust or while the room is waiting.</span>
      </div>
      <div class="cog-section"><div class="cog-label">Audio</div>
        <div class="cog-row"><span>Sound effects</span>
          <button class="mce-toggle ${isSoundEnabled() ? "on" : ""}" id="cog-sound">${isSoundEnabled() ? "🔊 ON" : "🔇 OFF"}</button>
        </div>
      </div>
    </div>`;
}
function wireNetCog(pub: Record<string, any>, seats: CogSeat[], uid: string | undefined): void {
  const mySeat = seats.find((s) => s.uid === uid);
  const assistedOn = !!mySeat?.assisted;
  const isPublic = pub.isPublic !== false;
  onId("net-cog", "click", () => { S.net.cog = true; render(); });
  onId("cog-close", "click", () => { S.net.cog = false; render(); });
  onId("cog-x", "click", () => { S.net.cog = false; render(); });
  onId("cog-mce", "click", () => {
    if (!hasEdge()) { S.net.cog = false; S.screen = "store"; render(); return; }
    void netSetSeatPrefs({ assisted: !assistedOn });
  });
  onId("cog-priv", "click", () => { void netSetRoomPrefs({ isPublic: !isPublic }); });
  onId("cog-rebuy", "click", () => { S.net.cog = false; openRebuySheet(); });
  onId("cog-sound", "click", () => { setSoundEnabled(!isSoundEnabled()); render(); });
  app.querySelectorAll(".cog-speed [data-speed]").forEach((b) => onEl(b, "click", () => { try { localStorage.setItem("mce-speed", (b as HTMLElement).dataset.speed!); } catch { /* */ } render(); }));
  app.querySelectorAll(".cog-style-grid [data-style]").forEach((b) => onEl(b, "click", () => { void netSetSeatPrefs({ recStyle: (b as HTMLElement).dataset.style as import("../mp/firebase-adapter.js").RecStyle }); }));
  app.querySelectorAll(".cog-kick").forEach((b) => onEl(b, "click", () => { void netKickBot(+(b as HTMLElement).dataset.seat!); }));
}

// FREE value layer (everyone, no Edge Pass): your win% + the nuts. The PAID MCE overlay
// (rep read + recommended line) stays gated. Memoized per (hand, board) so the Monte-Carlo
// only runs once per street, not every render.
let _netRead: { key: string; eqPct: number; label: string; nuts: string } | null = null;
function computeNuts(board: Card[]): string {
  if (board.length < 3) return "Aces";
  const used = new Set<number>(board);
  let bestR = -1; let bestHold: [Card, Card] = [0, 1];
  for (let a = 0; a < NUM_CARDS; a++) { if (used.has(a)) continue;
    for (let b = a + 1; b < NUM_CARDS; b++) { if (used.has(b)) continue;
      const r = evaluate([a, b, ...board]); if (r > bestR) { bestR = r; bestHold = [a, b]; } } }
  return nutLabel(bestHold, board);
}
function netHandRead(): { eqPct: number; label: string; nuts: string } | null {
  const myHand = S.net.myHand, pub = S.net.pub;
  if (!myHand || !pub || pub.status !== "in_hand") return null;
  const board = ((pub.board as Card[]) || []);
  const live = ((pub.seats as Array<{ uid: string | null; ai: string | null; folded: boolean }>) || []).filter((s) => (s.uid || s.ai) && !s.folded);
  const nOpp = Math.max(1, live.length - 1);
  const key = `${myHand[0]},${myHand[1]}|${board.join("-")}|${nOpp}`;
  if (_netRead && _netRead.key === key) return _netRead;
  let eqPct = 0;
  try {
    const villain = topSlice(allCombos(), 1).filter([...board, myHand[0], myHand[1]]);
    const res = monteCarloEquityMultiway({ hero: [myHand[0], myHand[1]], villainRanges: Array.from({ length: nOpp }, () => villain), board, iterations: 2000, rng: mulberry32(0x5eed ^ (board.length << 8)) });
    eqPct = Math.round(res.equity * 100);
  } catch { eqPct = 0; }
  const label = describeHand([myHand[0], myHand[1]], board).label;
  _netRead = { key, eqPct, label, nuts: computeNuts(board) };
  return _netRead;
}

// Full training-style read pills for an MCE-on (Edge Pass) online seat: hand label + win%,
// the BEATS-YOU / DRAWING flanks, and the hero "rep → bet" story line. Reuses the SAME pure
// engine reads as the trainer (describeHand / readThreats / credibleRep), so the values match
// the training table exactly. The cards keep the .net-hero look, flanked like the trainer.
function netReadBlock(board: readonly Card[], myHand: readonly Card[], eqPct: number, potOdds: number, pot: number, bb: number, sym: string): string {
  const cards = `<div class="net-hero">${myHand.map((c) => `<span class="hero-card ${isRed(c) ? "red" : ""}">${cardFace(c)}</span>`).join("")}</div>`;
  const hero2: [Card, Card] = [myHand[0]!, myHand[1]!];
  const d = describeHand(hero2, board);
  const nuts = board.length >= 3 ? `<span class="hand-odds">🥜 ${esc(computeNuts([...board]))}</span>` : "";
  const summary = `<div class="hand-summary"><span class="hand-label ${d.strong ? "strong" : ""}">${esc(d.label)}${d.draws.length ? ` + ${esc(d.draws.join(" + "))}` : ""}</span>${eqPct > 0 ? `<span class="hand-strength"><strong>${eqPct}%</strong> win</span>` : ""}${potOdds > 0 ? `<span class="hand-odds"><strong>${Math.round(potOdds * 100)}%</strong> to call</span>` : ""}${nuts}</div>`;
  if (board.length < 3) return `${summary}<div class="hero-read-row">${cards}</div>`;
  const threats = readThreats(hero2, board, allCombos().combos);
  const tag = (t: Threat) => `<span class="flank-chip">${esc(t.label)}</span>`;
  const made = threats.made.slice(0, 2), draws = threats.draws.slice(0, 2);
  const beatsFlank = made.length
    ? `<div class="read-flank beats"><span class="flank-lead">Beats you</span>${made.map(tag).join("")}</div>`
    : `<div class="read-flank ahead"><span class="flank-lead">Beats you</span><span class="flank-chip ok">none yet</span></div>`;
  const drawsFlank = draws.length
    ? `<div class="read-flank draws"><span class="flank-lead">Drawing</span>${draws.map(tag).join("")}</div>`
    : `<div class="read-flank draws dim"><span class="flank-lead">Drawing</span><span class="flank-chip">—</span></div>`;
  const rep = credibleRep(board);
  const betToRep = Math.round((repIsPolar(rep.rep) ? 1.0 : 0.55) * Math.max(bb, pot));
  const heroLine = `<div class="story-lines"><div class="story-line you">🂠 Rep <b>${esc(rep.label)}</b> → bet <b>${sym} ${mpc(betToRep)}</b></div></div>`;
  return `${summary}<div class="hero-read-row">${beatsFlank}${cards}${drawsFlank}</div>${heroLine}`;
}

// Showdown banner: name the WINNING hand ("Bot 6 won with two pair") from the winner's
// revealed cards + board, reusing the same describeHand() the read panel uses (so it says
// "top pair"/"trips"/"a flush" etc., not a raw category). Falls back to the server's plain
// result string ("won (all folded)" / "won the showdown") when there's nothing revealed to read.
function netShowdownResult(pub: Record<string, any>): string {
  const fallback = esc(String(pub.lastResult || "Hand over"));
  const reveal = (pub.revealedHoles || {}) as Record<string, [number, number]>;
  const winners = (pub.lastWinners || []) as number[];
  const board = (pub.board as Card[]) || [];
  if (winners.length === 0 || board.length < 3) return fallback;
  const w = winners[0]!;
  const wh = reveal[String(w)];
  if (!wh || wh.length < 2) return fallback;
  const wseat = (pub.seats as Array<{ name?: string; uid?: string | null }>)?.[w];
  const isMe = !!wseat?.uid && wseat.uid === S.mp.auth?.uid;
  const name = isMe ? "You" : (wseat?.name || "Player");
  let label = "";
  try { label = describeHand([wh[0]!, wh[1]!], board).label || ""; } catch { label = ""; }
  if (!label) return fallback;
  const split = winners.length > 1 ? " · split pot" : "";
  return `${esc(name)} won with ${esc(label.toLowerCase())}${split}`;
}

// Online bet/raise keypad as a bottom-sheet MODAL — mirrors the training renderBetPad
// (presets + numpad), appended to <body> so it sits over the dimmed table. Re-synced on
// every render; removed when the pad is closed / it's no longer my turn.
function renderNetBetPad(): void {
  document.getElementById("netbetpad-modal")?.remove();
  const pub = S.net.pub; const uid = S.mp.auth?.uid;
  if (!_netBetOpen || _netActing || !pub || pub.status !== "in_hand") return;
  const seats = (pub.seats || []) as Array<{ uid: string | null; chips: number; bet: number }>;
  const me = seats.find((s) => s.uid === uid);
  if (!me || seats[pub.toAct as number]?.uid !== uid) return;
  const cur = (pub.currentBet as number) || 0;
  const bb = ((pub.blinds as { bb?: number })?.bb) || 2;
  const myMax = me.chips + me.bet;
  const minTo = cur > 0 ? Math.min(myMax, cur * 2) : Math.min(myMax, bb);
  const toCall = cur - me.bet;
  const potNow = (pub.pot as number) || 0;
  const sym = ((pub.currency as string) || "play") === "premium" ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>";
  const clamp = (v: number) => Math.max(minTo, Math.min(myMax, Math.round(v)));
  const label = cur > 0 ? "Raise to" : "Bet";
  const half = clamp(cur + (potNow + Math.max(0, toCall)) / 2);
  const pot = clamp(cur + potNow + Math.max(0, toCall));
  const amt0 = clamp(_netBetAmt || minTo);
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop"; overlay.id = "netbetpad-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <h3>${label}</h3>
      <div class="betpad-display${_netBetTyped ? "" : " suggested"}" id="nbp-display">${sym} ${mpc(amt0)}<span class="betpad-bb">${(amt0 / bb).toFixed(1)} bb${toCall > 0 ? ` · to call ${mpc(toCall)}` : ""}</span></div>
      <div class="betpad-presets">
        <button class="preset-btn" data-bp="min">Min<br><span>${sym} ${mpc(minTo)}</span></button>
        <button class="preset-btn" data-bp="half">½ Pot<br><span>${sym} ${mpc(half)}</span></button>
        <button class="preset-btn" data-bp="pot">Pot<br><span>${sym} ${mpc(pot)}</span></button>
        <button class="preset-btn" data-bp="max">All-in<br><span>${sym} ${mpc(myMax)}</span></button>
      </div>
      <div class="betpad-grid">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k) => k ? `<button class="numpad-btn" data-key="${k}">${k}</button>` : "<div></div>").join("")}</div>
      <div class="modal-actions">
        <button class="cancel-btn" id="nbp-cancel">Cancel</button>
        <button class="confirm-btn" id="nbp-confirm">${label} ${sym} ${mpc(amt0)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const refresh = (): void => {
    const a = clamp(_netBetAmt || minTo);
    const disp = document.getElementById("nbp-display");
    if (disp) { disp.innerHTML = `${sym} ${mpc(_netBetAmt || 0)}<span class="betpad-bb">${((_netBetAmt || 0) / bb).toFixed(1)} bb${toCall > 0 ? ` · to call ${mpc(toCall)}` : ""}</span>`; disp.classList.toggle("suggested", !_netBetTyped); }
    const conf = document.getElementById("nbp-confirm");
    if (conf) conf.innerHTML = `${label} ${sym} ${mpc(a)}`;
  };
  overlay.querySelectorAll(".numpad-btn").forEach((b) => onEl(b, "click", () => {
    const k = (b as HTMLElement).dataset.key!;
    if (k === "⌫") _netBetTyped = _netBetTyped.slice(0, -1);
    else if (_netBetTyped.length < 7) _netBetTyped += k;
    _netBetAmt = +_netBetTyped || 0; refresh();
  }));
  overlay.querySelectorAll(".preset-btn").forEach((b) => onEl(b, "click", () => {
    const k = (b as HTMLElement).dataset.bp;
    _netBetAmt = k === "min" ? minTo : k === "half" ? half : k === "pot" ? pot : myMax;
    _netBetTyped = String(_netBetAmt); refresh();
  }));
  onId("nbp-cancel", "click", () => { _netBetOpen = false; overlay.remove(); });
  onId("nbp-confirm", "click", () => { _netBetOpen = false; overlay.remove(); void netAct({ type: cur > 0 ? "raise" : "bet", amount: clamp(_netBetAmt || minTo) }); });
}

function renderNetTable(): void {
  cancelVillainTimer();
  const code = S.net.code, uid = S.mp.auth?.uid;
  if (!code) { S.screen = "mp-setup"; render(); return; }
  const pub = S.net.pub;
  if (!pub) {
    app.innerHTML = `<div class="setup"><div class="doc-top"><span style="width:54px"></span><h1>🌐 ${code}</h1><button class="hdr-btn" id="net-leave">Leave</button></div><div class="net-wait"><span class="spin"></span><span>Connecting…</span></div>${S.net.err ? `<div class="room-broke">${esc(S.net.err)}</div>` : ""}</div>`;
    onId("net-leave", "click", () => void netLeave());
    return;
  }
  const seats = (pub.seats || []) as Array<{ uid: string | null; ai: string | null; name: string; chips: number; bet: number; folded: boolean; inHand?: boolean }>;
  const status = pub.status as string;
  const currency = (pub.currency as string) === "premium" ? "premium" : "play";
  const sym = currency === "premium" ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>";
  const isOwner = pub.ownerUid === uid;
  const lobby = status === "waiting";
  const revealed = (pub.revealedHoles || {}) as Record<string, [number, number]>;
  // Busted seats are hidden from the table — they're effectively sidelined until they
  // rebuy. Server still has them seated so a rebuy puts them right back in. For the busted
  // player themselves, the rebuy sheet auto-opens as the prompt.
  //
  // A seat is "sidelined" when it has 0 chips AND is NOT in the current live hand. The
  // `inHand` flag matters DURING a hand: an all-in player has chips=0 behind but inHand=true
  // (still contesting the pot, must stay visible), while a bot that busted a prior hand has
  // chips=0 and inHand=false (sat out of this deal → hide it). Between hands nobody is
  // inHand, so this reduces to the simple chips>0 check.
  const allOccupied = seats.map((s, ti) => ({ s, ti })).filter((x) => x.s.uid || x.s.ai);
  const isSidelined = (x: { s: { chips: number; inHand?: boolean } }): boolean => x.s.chips === 0 && !x.s.inHand;
  const sidelined = allOccupied.filter(isSidelined);
  const occupied = allOccupied.filter((x) => !isSidelined(x));
  // Lobby display order: humans above bots (does NOT affect table-seat indices ti).
  const lobbyOrder = (status === "waiting") ? [...occupied].sort((a, b) => (a.s.uid ? 0 : 1) - (b.s.uid ? 0 : 1)) : occupied;
  const humans = occupied.filter((x) => x.s.uid).length;
  const spectators = (pub.spectators ?? []) as Array<{ uid: string; name: string }>;
  const isSpectator = !!uid && !seats.some((s) => s.uid === uid) && spectators.some((s) => s.uid === uid);
  const specPills = spectators.length > 0 ? `<div class="spec-row">👁 ${spectators.length} watching <span class="spec-names">${spectators.slice(0, 6).map((s) => `<span class="spec-pill">${esc(s.name)}</span>`).join("")}${spectators.length > 6 ? `<span class="spec-pill more">+${spectators.length - 6}</span>` : ""}</span></div>` : "";

  // Chat drawer (lobby + table). Shared HTML; opened from the 💬 topbar button.
  const myUid = uid ?? "";
  const chat = S.net.chat;
  const unread = chat.open ? 0 : chat.msgs.filter((m) => m.uid !== myUid && (m.ts ?? 0) > chat.lastReadTs).length;
  const chatDrawer = chat.open ? `
    <div class="cog-backdrop" id="ch-close"></div>
    <div class="chat-drawer">
      <div class="cog-head"><span>💬 Room chat</span><button class="hdr-btn" id="ch-x" aria-label="Close chat">✕</button></div>
      <div class="ch-stream" id="ch-stream">
        ${chat.msgs.length === 0
          ? `<div class="hint" style="text-align:center;padding:20px 0">Say hi — your messages go to seated players and spectators.</div>`
          : chat.msgs.map((m) => `<div class="ch-msg${m.uid === myUid ? " mine" : ""}"><span class="ch-who">${esc(m.name)}</span><span class="ch-txt">${esc(m.text)}</span></div>`).join("")}
      </div>
      <div class="ch-presets">${["gl", "nh", "hurry up 🐌", "wp"].map((p) => `<button class="hdr-btn ch-preset" data-preset="${esc(p)}">${esc(p)}</button>`).join("")}</div>
      <div class="ch-input-row">
        <input class="ch-input" id="ch-input" type="text" maxlength="120" placeholder="Say something…" value="${esc(chat.draft)}"/>
        <button class="join-btn" id="ch-send"${chat.draft.trim() ? "" : " disabled"}>Send</button>
      </div>
    </div>` : "";

  // Rebuy sheet — shown on bust (auto) or via cog (manual). Same UI in lobby + table view.
  const mySeatLocal = seats.find((s) => s.uid === uid);
  const busted = !!mySeatLocal && mySeatLocal.chips === 0 && status === "hand_over";
  // Suppress auto-reopen for 4s after submit so the snapshot has time to reflect new
  // stack; without this guard, "rebuy submitted ↔ snapshot still shows chips=0" races and
  // the sheet pops right back open, masking the success.
  const recentlyRebought = (Date.now() - _rebuySubmittedAt) < 4000;
  if (busted && !S.net.rebuy.open && !S.net.cog && !recentlyRebought) {
    const hid = String(pub.handId ?? "");
    if (_bustHandId !== hid) { _bustHandId = hid; _bustShownAt = Date.now(); }
    const waited = Date.now() - _bustShownAt;
    if (waited >= BUST_REVEAL_LINGER) {
      S.net.rebuy.open = true;
      if (S.net.rebuy.amount === 0) S.net.rebuy.amount = (pub.startingStack as number) || 20 * (((pub.blinds as { bb?: number })?.bb) || 10);
    } else if (!_bustLinger) {
      _bustLinger = setTimeout(() => { _bustLinger = null; if (S.screen === "mp-net") render(); }, BUST_REVEAL_LINGER - waited + 60);
    }
  }
  const myBb = ((pub.blinds as { bb?: number })?.bb) || 10;
  const minBuy = 20 * myBb;
  const tierMax = (pub.startingStack as number) || (1000 * myBb / 10); // approximation; server clamps anyway
  const myWallet = currency === "premium" ? (S.wallet.premium ?? 0) : (S.wallet.play ?? 0);
  const rebuyAmt = Math.max(0, S.net.rebuy.amount);
  const newStack = (mySeatLocal?.chips ?? 0) + rebuyAmt;
  const rbValid = rebuyAmt > 0 && rebuyAmt <= myWallet && newStack >= minBuy && newStack <= tierMax;
  const rebuySheet = S.net.rebuy.open ? `
    ${lobby ? `<div class="cog-backdrop" id="rb-close"></div>`
      : !busted ? `<div class="cog-backdrop cog-backdrop-clear" id="rb-close"></div>` : ""}
    <div class="cog-sheet rebuy-sheet${!lobby ? " rebuy-floating" : ""}">
      <div class="cog-head"><span>${busted ? "💥 Busted — top up" : "Top up your stack"}</span><button class="hdr-btn" id="rb-x" aria-label="Close">✕</button></div>
      <div class="rb-display">
        <span class="rb-sym">${sym}</span><span class="rb-amt">${mpc(rebuyAmt)}</span>
        <span class="rb-bb">${(rebuyAmt / myBb).toFixed(1)} bb · new stack ${sym} ${mpc(newStack)}</span>
      </div>
      <div class="rb-quick">
        <button class="hdr-btn" data-rb="${minBuy}">Min ${minBuy}</button>
        <button class="hdr-btn" data-rb="${Math.min(tierMax - (mySeatLocal?.chips ?? 0), Math.round(tierMax / 2))}">Half cap</button>
        <button class="hdr-btn" data-rb="${tierMax - (mySeatLocal?.chips ?? 0)}">Max ${sym} ${mpc(tierMax - (mySeatLocal?.chips ?? 0))}</button>
      </div>
      <div class="rb-pad">
        ${[1,2,3,4,5,6,7,8,9].map((n) => `<button class="rb-key" data-key="${n}">${n}</button>`).join("")}
        <button class="rb-key" data-key="00">00</button>
        <button class="rb-key" data-key="0">0</button>
        <button class="rb-key" data-key="back">⌫</button>
      </div>
      ${S.net.rebuy.err ? `<div class="room-broke">${esc(S.net.rebuy.err)}</div>` : ""}
      <div class="rb-actions">
        ${myWallet < rebuyAmt ? `<button class="start-btn rb-store" id="rb-store">Need chips → Store</button>` : `<button class="start-btn rb-confirm" id="rb-confirm" ${rbValid ? "" : "disabled"}>Rebuy ${sym} ${mpc(rebuyAmt)}</button>`}
        ${busted ? `<button class="hdr-btn rb-leave" id="rb-leave">Leave table</button>` : ""}
      </div>
      <p class="hint" style="text-align:center;margin-top:6px">Wallet ${sym} ${mpc(myWallet)} · min ${minBuy} · max stack ${tierMax}</p>
    </div>` : "";

  // ── LOBBY = a real waiting room (NOT the oval table) — distinct screen so adding a
  // bot never feels like the hand started. Roster, AI picker, share code, explicit START.
  if (lobby) {
    const botLabel = (a: string): string => (({ Station: "Fish 🐟", TAG: "Reg 🎯", LAG: "LAG 🔥", Nit: "Nit 🪨", Auto: "Auto 🧮" }) as Record<string, string>)[a] || a;
    const mySeat = seats.find((s) => s.uid === uid) as { assisted?: boolean } | undefined;
    const assistedOn = !!mySeat?.assisted;
    const canAddAi = isOwner && currency === "play" && occupied.length < seats.length;
    const isPublic = pub.isPublic !== false;
    // Compact pills (2-3 per row) instead of one row per seat — 12 seats no longer overflow.
    const openSeats = seats.length - occupied.length;
    const roster = `<div class="roster-pills">${lobbyOrder.map(({ s, ti }) => {
      if (s.uid) return `<span class="roster-pill${s.uid === uid ? " me" : ""}">${s.uid === uid ? "🧠" : "🙂"} ${esc(s.name)}${ti === 0 ? " 👑" : ""}<b>${mpc(s.chips)}</b></span>`;
      return `<span class="roster-pill bot">🤖 ${esc(s.name)} <i>${botLabel(s.ai!)}</i><b>${mpc(s.chips)}</b></span>`;
    }).join("")}</div>${openSeats > 0 ? `<div class="roster-open">＋ ${openSeats} open seat${openSeats > 1 ? "s" : ""} — share the code</div>` : ""}`;
    const cogSheet = netCogSheetHtml(pub, seats as CogSeat[], uid);
    app.innerHTML = `
      <div class="net-game lobby-screen">
        <div class="game-topbar"><span>Room <strong>${code}</strong> · ${sym} ${currency === "premium" ? "premium" : "play"} · ${isPublic ? "🌐" : "🔒"}</span><div class="topbar-btns"><button class="hdr-btn ch-toggle" id="net-chat" title="Chat">💬${unread > 0 ? `<span class="ch-badge">${unread}</span>` : ""}</button><button class="hdr-btn" id="net-cog" title="Settings">⚙</button><button class="hdr-btn" id="net-leave">Leave</button></div></div>
        <div class="lobby-wrap">
          <div class="lobby-hero">
            <div class="lobby-badge">● WAITING ROOM</div>
            <button class="lobby-code" id="net-copy"><span class="lc-code">${code}</span><span class="lc-hint">tap to copy 📋</span></button>
            <p class="lobby-sub">Share this code — friends open <strong>Play Online → Join with code</strong>.</p>
          </div>
          <div class="lobby-roster">
            <div class="roster-head"><span>Players</span><span>${occupied.length} / ${seats.length}</span></div>
            ${roster}
            ${specPills}
          </div>
          ${canAddAi ? `<div class="lobby-addai"><div class="la-label">Add a practice bot</div><div class="la-btns">${[["Station", "🐟 Fish"], ["TAG", "🎯 Reg"], ["LAG", "🔥 LAG"], ["rand", "🎲 Random"]].map(([a, l]) => `<button class="hdr-btn add-ai" data-arch="${a}"${S.net.busy ? " disabled" : ""}>${l}</button>`).join("")}</div></div>`
        : currency === "premium" ? `<div class="lobby-note"><i class=ic-gem></i> Premium room — humans only. Share the code to fill seats.</div>` : ""}
          ${assistedOn ? `<div class="lobby-mce">💡 <strong>MCE Strategy is ON</strong> — you'll get live GTO advice on your turn.</div>` : ""}
          ${isSpectator
            ? (openSeats > 0
              ? `<button class="start-btn lobby-start" id="net-seat"${S.net.busy ? " disabled" : ""}>${S.net.busy ? '<span class="spin dark"></span>' : "Take a seat"}</button>`
              : `<div class="lobby-note">👁 Watching · room is full.</div>`)
            : `<button class="start-btn lobby-start" id="net-deal"${occupied.length < 2 ? " disabled" : ""}>${S.net.busy ? '<span class="spin dark"></span>' : occupied.length < 2 ? "Waiting for players…" : "▶ START GAME"}</button>`}
          <p class="lobby-foot">${occupied.length < 2 ? (isOwner ? "Add a bot or wait for a friend to join." : "Waiting for more players…") : "Anyone can start — everyone in?"}</p>
          ${S.net.err ? `<div class="room-broke">${esc(S.net.err)}</div>` : ""}
        </div>
        ${cogSheet}
        ${rebuySheet}
        ${chatDrawer}
      </div>`;
    onId("net-leave", "click", () => void netLeave());
    onId("net-seat", "click", () => { if (S.net.code) void joinNetRoom(S.net.code); });
    onId("net-copy", "click", (e) => copyCodeWithFeedback(code, e));
    onId("net-deal", "click", () => void netDeal());
    app.querySelectorAll(".add-ai").forEach((b) => onEl(b, "click", () => void netAddBot((b as HTMLElement).dataset.arch!)));
    wireNetCog(pub, seats as CogSeat[], uid);
    wireRebuyHandlers();
    wireChatHandlers();
    return;
  }

  const N = Math.max(2, occupied.length);
  const myOrder = Math.max(0, occupied.findIndex((x) => x.s.uid === uid));
  const coord = (orderIdx: number) => tableSeatPos((orderIdx - myOrder + N) % N, N);
  // Blind positions (table-seat indices) so newbies see SB/BB, not just the dealer button.
  // Heads-up: the button IS the small blind (shown as D); 3+: SB is left of the button, BB next.
  const _no = occupied.length, _btnO = occupied.findIndex((x) => x.ti === pub.dealerSeat);
  const sbSeat = _btnO < 0 ? -1 : _no === 2 ? pub.dealerSeat : occupied[(_btnO + 1) % _no]!.ti;
  const bbSeat = _btnO < 0 ? -1 : _no === 2 ? occupied[(_btnO + 1) % 2]!.ti : occupied[(_btnO + 2) % _no]!.ti;
  const seatHtml = occupied.map((x, orderIdx) => {
    const { s, ti } = x; const { left, top } = coord(orderIdx);
    const me = !!s.uid && s.uid === uid;
    const active = ti === pub.toAct && status === "in_hand";
    const rev = revealed[String(ti)];
    const cards = !lobby && !me && rev ? rev : null;
    const cls = ["table-seat", me ? "hero-seat" : "", s.folded ? "folded" : "", active ? "active" : ""].filter(Boolean).join(" ");
    // Turn timer: the server already sends deadlineMs (40s/turn) — drain a bar on the
    // active seat so you can FOLLOW whose turn it is + how long they have (WSOP feel).
    const secsLeft = active ? Math.max(0, Math.min(45, (((pub.deadlineMs as number) || 0) - Date.now()) / 1000)) : 0;
    const betChip = s.bet > 0 && !s.folded ? `<div class="seat-bet ${top < 50 ? "below" : "above"}"><span class="chip-dot"></span>${mpc(s.bet)}</div>` : "";
    const holeCards = cards ? `<div class="seat-cards ${top < 50 ? "below" : "above"}">${cards.map((c) => `<span class="seat-hole reveal ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</span>`).join("")}</div>` : "";
    // Mirror the training table seat: avatar silhouette + name/role + stack.
    // FOMO: every player sees who is running MCE Strategy — the asymmetry IS the sales pitch.
    const mceBadge = (s as { assisted?: boolean }).assisted ? `<div class="mce-badge" title="Running MCE Strategy">⚡ MCE</div>` : "";
    // Last-action callout: server sets lastAction on each act, clears on street advance.
    // Unique key per (seat,type,amount) so morphdom re-mounts the node → animation replays.
    const la = pub.lastAction as { seat: number; type: string; amount: number } | null | undefined;
    const showCallout = la && la.seat === ti && status === "in_hand";
    const calloutLabel = showCallout ? (la.type === "fold" ? "FOLD" : la.type === "check" ? "CHECK" : la.type === "call" ? "CALL" : `${la.type.toUpperCase()} ${mpc(la.amount)}`) : "";
    const calloutHtml = showCallout ? `<div class="action-call ${la.type} ${top <= 20 ? "below" : top < 50 ? "above" : "below"}" data-k="${la.seat}-${la.type}-${la.amount}">${calloutLabel}</div>` : "";
    return `<div class="${cls}" data-seat="${ti}" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%">
      ${ti === pub.dealerSeat ? '<div class="dealer-btn">D</div>' : ti === sbSeat ? '<div class="dealer-btn sb">SB</div>' : ti === bbSeat ? '<div class="dealer-btn bb">BB</div>' : ""}
      ${mceBadge}
      ${avatarHtml(ti, me)}
      <div class="seat-chip">
        <div class="seat-pos">${me ? "YOU" : esc(s.name)}${s.ai ? ` <span class="seat-subpos">BOT</span>` : ""}</div>
        <div class="seat-stack">${sym} ${mpc(s.chips)}</div>
        ${s.folded ? `<div class="seat-act">folded</div>` : ""}
        ${active && secsLeft > 0 ? `<div class="turn-bar"><div class="tb-fill" style="animation-duration:${secsLeft.toFixed(1)}s"></div></div><div class="turn-clock${secsLeft <= 5 ? " urgent" : ""}">${Math.ceil(secsLeft)}</div>` : ""}
      </div>
      ${betChip}
      ${holeCards}
      ${calloutHtml}
    </div>`;
  }).join("");
  const board = (pub.board as number[]) || [];
  // Board: 5 cards laid DIRECTLY in .board-center (a centered horizontal row) — exactly like
  // the training table, not the old wrapping .net-board grid.
  const center = [0, 1, 2, 3, 4].map((i) => board[i] != null
    ? `<div class="board-card dealt deal-in ${isRed(board[i]!) ? "red" : ""}">${flipFaces(cardFace(board[i]!))}</div>`
    : `<div class="board-card empty"></div>`).join("");
  // Pot: identical pill + felt position as the training table (.pot-line at 67%, between
  // the hero seat and the board) so online and training read the same.
  const potHtml = `<div class="pot-line"><span class="table-pot">${mpc((pub.pot as number) || 0)}</span><span class="pot-street">${capWord(pub.street || "preflop")}</span></div>`;

  // STALE/COALESCED-FRAME GUARD: a folded seat can never legitimately be to-act. If toAct points
  // at MY own seat and that seat reads folded, we are either (a) on a dropped hand-over frame, or
  // (b) on the ~300ms optimistic re-render right after I tapped Fold (the client sets s.folded=true
  // at netAct but does NOT advance pub.toAct, so toAct still == my seat). In BOTH cases we want to
  // leave the `else if (myTurn)` branch — but case (b) is the normal happy path and must keep
  // showing the in-flight "Sending…" view, NOT the "…to act…" wait. So suppress only when we are
  // NOT mid-send: _netActing distinguishes the optimistic-fold frame (true) from a genuinely stale
  // frozen frame (false, because the send already completed/failed).
  // Action UI shows only when it's genuinely my turn. The engine NEVER makes a 0-chip (all-in)
  // seat act (game-state.ts nextToAct guards stacks>0), so requiring chips>0 here can't hide a
  // legit turn — it only suppresses a desynced "your turn" frame that would otherwise offer an
  // illegal Raise (the chips=0 + Check/Raise glitch). _netActing keeps "Sending…" during a send.
  const myTurn = status === "in_hand" && pub.toAct >= 0 && seats[pub.toAct]?.uid === uid
    && !(seats[pub.toAct]?.folded && !_netActing)
    && (((seats[pub.toAct] as { chips?: number })?.chips ?? 0) > 0 || _netActing);
  // Did I win the hand that just ended? Server tells us directly (pub.lastWinners), so it's
  // robust even when an instant fold-out skips the in_hand frame. Drives the Share-win CTA.
  const mySeatIdx = seats.findIndex((s) => s.uid === uid);
  const lastWon = (pub.lastWon || {}) as Record<number, number>;
  const iWonAmt = (status === "hand_over" && mySeatIdx >= 0) ? Math.round(lastWon[mySeatIdx] ?? 0) : 0;
  // FREE read for EVERYONE in-hand: your win% + the nuts (the hook). Strategy stays paid.
  // If I hold Edge Pass, the MCE engine already computed my SITUATIONAL equity (vs villain's
  // actual betting range) — use THAT so the strip and the MCE card never disagree. Free
  // players get the client estimate (vs a generic range) as the hook.
  // Folded players are out of the hand — no live read, no bet recommendation (just watch).
  const iFolded = mySeatIdx >= 0 && !!(seats[mySeatIdx] as { folded?: boolean })?.folded;
  const _r = (status === "in_hand" && S.net.myHand && !iFolded) ? netHandRead() : null;
  const _recEq = (S.net.myRec && typeof (S.net.myRec as { equity?: number }).equity === "number") ? Math.round((S.net.myRec as { equity: number }).equity * 100) : null;
  const eqShown = _recEq ?? (_r ? _r.eqPct : 0);
  const freeRead = _r ? `<div class="net-read"><span class="nr-hand">${esc(_r.label)}</span><span class="nr-eq"><b>${eqShown}%</b> win</span>${_r.nuts ? `<span class="nr-nuts">🥜 ${esc(_r.nuts)}</span>` : ""}</div>` : "";
  // MCE on for my seat → the FULL training read pills (label + win% + BEATS-YOU/DRAWING +
  // rep→bet); otherwise the free single-line hook. Same component for the turn + waiting views.
  const myAssisted = !!(seats.find((s) => s.uid === uid) as { assisted?: boolean } | undefined)?.assisted;
  const heroRead = iFolded
    ? `<div class="net-folded">You folded — watching the hand 👀</div>`
    : S.net.myHand
      ? (myAssisted && S.net.myHand.length === 2
          ? netReadBlock((pub.board as Card[]) || [], S.net.myHand, eqShown, (S.net.myRec as { potOdds?: number } | null)?.potOdds ?? 0, (pub.pot as number) || 0, ((pub.blinds as { bb?: number })?.bb) || 2, sym)
          : `<div class="net-hero">${S.net.myHand.map((c) => `<span class="hero-card ${isRed(c) ? "red" : ""}">${cardFace(c)}</span>`).join("")}</div>${freeRead}`)
      : freeRead;
  let controls = "";
  if (lobby) {
    const canAddAi = isOwner && currency === "play" && occupied.length < seats.length;
    const aiBtns = [["Station", "🐟 Fish"], ["TAG", "🎯 Reg"], ["LAG", "🔥 LAG"], ["rand", "🎲 Random"]];
    controls = `
      <div class="net-share">Share code <button class="net-copy" id="net-copy"><strong>${code}</strong> 📋</button></div>
      ${canAddAi ? `<div class="lobby-ai"><span class="hint">＋ AI:</span>${aiBtns.map(([a, l]) => `<button class="hdr-btn add-ai" data-arch="${a}">${l}</button>`).join("")}</div>` : currency === "premium" ? `<div class="hint" style="text-align:center">Premium room — humans only. Share the code.</div>` : ""}
      ${isOwner ? `<button class="start-btn" id="net-deal" ${occupied.length < 2 ? "disabled style=opacity:.5" : ""}>${S.net.busy ? '<span class="spin dark"></span>' : occupied.length < 2 ? "Waiting for players…" : "DEAL"}</button>` : `<div class="hint" style="text-align:center">Waiting for the host to deal…</div>`}`;
  } else if (status === "hand_over") {
    const shareBtn = iWonAmt > 0 ? `<button class="share-win-btn" id="net-share-win">📸 Share this win · +${mpc(iWonAmt)}</button>` : "";
    const mySeated = occupied.some((x) => x.s.uid === uid && x.s.chips > 0);
    // Last-man-standing detection: I'm seated with chips AND every other seat that ever
    // took a seat is busted (chips=0). We count opponents over allOccupied — NOT occupied —
    // because the instant a bot busts it's SIDELINED out of `occupied` (chips=0 && !inHand,
    // see ~4404), so by hand_over `occupied` is just me. Gating on `occupied.length >= 2`
    // would therefore never fire, and we'd auto-deal into a server-side "Need 2+ players
    // with chips" error and stall instead of celebrating the win.
    const totalOpponents = allOccupied.filter((x) => !(x.s.uid === uid)).length;
    const liveOpponents = allOccupied.filter((x) => !(x.s.uid === uid) && x.s.chips > 0).length;
    const wonTheRoom = mySeated && totalOpponents >= 1 && liveOpponents === 0;
    if (wonTheRoom) {
      stopAutoDeal();
      const myFinal = (seats.find((s) => s.uid === uid)?.chips ?? 0);
      const profit = myFinal - (pub.startingStack as number || 0);
      const canRefill = isOwner && currency === "play" && occupied.length < seats.length;
      controls = `
        <div class="win-room">
          ${confettiHtml()}
          <div class="wr-trophy">🏆</div>
          <div class="wr-title">YOU WIN THE ROOM</div>
          <div class="wr-sub">Last player standing${totalOpponents === 1 ? " · heads-up" : ""}</div>
          <div class="wr-stack"><span class="wr-final">${sym} ${mpc(myFinal)}</span>${profit > 0 ? `<span class="wr-profit">+${mpc(profit)}</span>` : ""}</div>
          ${shareBtn}
          <div class="wr-actions">
            ${canRefill ? `<button class="hdr-btn add-ai" data-arch="TAG">＋ Add a bot</button>` : ""}
            <button class="hdr-btn" id="net-leave-win">Bank ${sym} ${mpc(myFinal)} + leave</button>
          </div>
        </div>`;
    } else {
      // SINGLE-DRIVER AUTO-DEAL: only ONE client (the lowest-seat human) auto-deals the next
      // hand. When EVERY seated human auto-deals (the old behaviour) the two deals race, and the
      // loser's Firestore listener COALESCES the hand_over frame into the following in_hand frame
      // — silently dropping the showdown reveal. That's the human-vs-human "opponent cards never
      // show" bug; me-vs-bot was immune because the lone human is always the sole dealer. Everyone
      // keeps a manual NEXT HAND button as the fallback if the driver lags or leaves.
      const iAutoDeal = mySeated && seats.find((s) => s.uid)?.uid === uid;
      if (iAutoDeal) startAutoDeal(code); else if (mySeated) stopAutoDeal();
      const secs = _autoDealAt ? Math.max(0, Math.ceil((_autoDealAt - Date.now()) / 1000)) : 5;
      const dealLabel = S.net.busy ? '<span class="spin dark"></span>' : iAutoDeal ? `▶ NEXT HAND · ${secs}s` : "▶ NEXT HAND";
      controls = `<div class="mp-result">${netShowdownResult(pub)}</div>${shareBtn}${mySeated ? `<button class="start-btn" id="net-deal">${dealLabel}</button>` : `<div class="hint" style="text-align:center">Next hand starting…</div>`}`;
    }
  } else if (myTurn) {
    const seat = seats[pub.toAct]!; const cur = (pub.currentBet as number) || 0;
    const toCall = cur - seat.bet; const bb = ((pub.blinds as { bb?: number })?.bb) || 2;
    const myMax = seat.chips + seat.bet; // all-in total (stack behind + already-in bet)
    const minTo = cur > 0 ? Math.min(myMax, cur * 2) : Math.min(myMax, bb);
    const hero = heroRead;
    // MCE Strategy overlay — live GTO advice for assisted (Edge Pass) seats.
    const rec = S.net.myRec;
    const mceCard = rec ? `<div class="net-mce">
      <div class="nm-row"><span class="nm-tag">💡 MCE</span><span class="nm-action">${capWord(rec.action)}${rec.amount > 0 ? ` ${sym} ${mpc(rec.amount)}` : ""}</span><span class="nm-src">${esc(rec.source)}</span></div>
      <div class="nm-meta">${rec.handLabel ? `${esc(rec.handLabel)} · ` : ""}${Math.round((rec.equity || 0) * 100)}% eq${rec.potOdds ? ` · ${Math.round(rec.potOdds * 100)}% to call` : ""}</div>
      ${rec.reasoning ? `<div class="nm-why">${esc(rec.reasoning)}</div>` : ""}
    </div>` : "";
    if (_netActing) {
      controls = `${hero}<div class="net-wait sending"><span class="spin"></span><span>${Date.now() - _netActingSince > 1500 ? "Still loading… warming up the table" : "Sending…"}</span></div>`;
    } else {
      // Matches the training table: Fold / Check-or-Call / Bet-or-Raise. All-in is reached
      // via the keypad's All-in preset (no standalone button).
      controls = `<div class="net-readwrap">${hero}${mceCard}</div>
      <div class="action-bar">
        ${toCall > 0 ? `<button class="action-btn fold" id="na-fold">Fold</button>` : ""}
        ${toCall > 0 ? `<button class="action-btn call" id="na-call">Call ${mpc(toCall)}</button>` : `<button class="action-btn check" id="na-check">Check</button>`}
        <button class="action-btn ${cur > 0 ? "raise" : "bet"}" id="na-bet">${cur > 0 ? "Raise" : "Bet"}</button>
      </div>`;
    }
  } else {
    controls = `${heroRead}<div class="net-wait"><span class="spin"></span><span>${esc(seats[pub.toAct]?.name || "Opponent")} to act…</span></div>`;
  }

  // FOMO upsell: a non-entitled player at a table where others run MCE Strategy. The
  // visible asymmetry is the pitch — "they have the edge, you don't, unlock yours".
  const iAmAssisted = !!(seats.find((s) => s.uid === uid) as { assisted?: boolean } | undefined)?.assisted;
  const othersAssisted = seats.filter((s) => (s as { assisted?: boolean }).assisted && s.uid && s.uid !== uid).length;
  const upsellHtml = (!iAmAssisted && !hasEdge() && othersAssisted > 0 && !_fomoDismissed)
    ? `<div class="fomo-upsell" id="fomo-upsell"><span>⚡ <strong>${othersAssisted} player${othersAssisted === 1 ? "" : "s"}</strong> here ${othersAssisted === 1 ? "is" : "are"} running <strong>MCE Strategy</strong>. Unlock yours →</span><button class="fomo-x" id="fomo-x" aria-label="dismiss">✕</button></div>`
    : "";
  app.innerHTML = `
    <div class="game net-game">
      <div class="game-topbar"><span>Room <strong>${code}</strong> · ${sym} ${currency === "premium" ? "premium" : "play"}${spectators.length ? ` · 👁 ${spectators.length}` : ""}${sidelined.length ? ` · 💤 ${sidelined.length}` : ""}${isSpectator ? " · watching" : ""}</span><div class="topbar-btns">${!isSpectator ? `<button class="hdr-btn style-pill style-${S.heroStyle}" id="net-style-btn" title="Your play style — tap to cycle. LAG/Maniac bluff more, Nit bluffs less.">${HERO_STYLE_SHORT[S.heroStyle] ?? "Bal"}</button>` : ""}<button class="hdr-btn ch-toggle" id="net-chat" title="Chat">💬${unread > 0 ? `<span class="ch-badge">${unread}</span>` : ""}</button><button class="hdr-btn" id="net-cog" title="Settings">⚙</button><button class="hdr-btn" id="net-leave">Leave</button></div></div>
      <div class="stage">
        <div class="table-wrap"><div class="poker-table"><div class="felt"></div>${seatHtml}<div class="board-center">${center}</div>${potHtml}</div></div>
        <div class="controls"><div class="controls-body">${upsellHtml}${_pendingLeave ? `<div class="hint" style="text-align:center;margin-bottom:6px">⏳ Banking your chips & leaving after this hand…</div>` : ""}${controls}${S.net.err ? `<div class="room-broke" style="margin-top:8px">${esc(S.net.err)}</div>` : ""}</div></div>
      </div>
      ${netCogSheetHtml(pub, seats as CogSeat[], uid)}
      ${rebuySheet}
      ${chatDrawer}
    </div>`;
  onId("fomo-upsell", "click", () => { S.screen = "store"; render(); });
  onId("fomo-x", "click", (e) => { (e as Event).stopPropagation(); _fomoDismissed = true; render(); });
  onId("net-leave", "click", () => void netLeave());
  onId("net-leave-win", "click", () => void netLeave());
  onId("net-deal", "click", () => void netDeal());
  // Online Bluff-Lab pill — same cycle as the trainer's style-btn, plus push to the server
  // so the server-computed MCE recommendation tilts to the new style on the next hand.
  onId("net-style-btn", "click", () => {
    const i = HERO_STYLE_ORDER.indexOf(S.heroStyle as typeof HERO_STYLE_ORDER[number]);
    S.heroStyle = HERO_STYLE_ORDER[(i + 1) % HERO_STYLE_ORDER.length]!;
    try { localStorage.setItem("mce-hero-style", S.heroStyle); } catch { /* */ }
    if (S.net.code) {
      const hs = S.heroStyle as "gto" | "tag" | "lag" | "nit" | "maniac";
      void FB.setSeatPrefs(S.net.code, { heroStyle: hs }).catch(() => { /* */ });
    }
    render();
  });
  onId("net-share-win", "click", () => {
    const cards = S.net.myHand ? S.net.myHand.map((c) => ({ t: cardDisplay(c), red: isRed(c) })) : undefined;
    void shareWin({ amount: iWonAmt, sym, cards });
  });
  onId("net-copy", "click", (e) => copyCodeWithFeedback(code, e));
  app.querySelectorAll(".add-ai").forEach((b) => onEl(b, "click", () => void netAddBot((b as HTMLElement).dataset.arch!)));
  wireNetCog(pub, seats as CogSeat[], uid);
  wireRebuyHandlers();
  wireChatHandlers();
  onId("na-fold", "click", () => void netAct({ type: "fold" }));
  onId("na-check", "click", () => void netAct({ type: "check" }));
  onId("na-call", "click", () => void netAct({ type: "call" }));
  onId("na-bet", "click", () => {
    const seat = seats[pub.toAct]!; const cur = (pub.currentBet as number) || 0;
    const myMax = seat.chips + seat.bet; const bb = ((pub.blinds as { bb?: number })?.bb) || 2;
    const minTo = cur > 0 ? Math.min(myMax, cur * 2) : Math.min(myMax, bb);
    if (myMax <= minTo) { void netAct(myMax <= cur ? { type: "call" } : { type: cur > 0 ? "raise" : "bet", amount: myMax }); return; } // short stack → all-in call or all-in raise
    _netBetTyped = ""; // start the keypad showing the suggested default
    _netBetAmt = Math.max(minTo, Math.min(myMax, cur > 0 ? cur + (pub.pot as number) : (pub.pot as number) || bb)); // default = pot
    // If MCE recommends a sized action, seed THAT as the greyed default (overridable by typing) —
    // parity with the trainer keypad. Non-sized recs (fold/check/call) keep the pot default.
    if (S.net.myRec && S.net.myRec.amount > 0 && (S.net.myRec.action === "bet" || S.net.myRec.action === "raise")) _netBetAmt = Math.max(minTo, Math.min(myMax, Math.round(S.net.myRec.amount)));
    _netBetOpen = true; render();
  });
  // Bet/raise keypad is a bottom-sheet MODAL (same as the training table) — appended to
  // <body> so morphdom never wipes it; re-synced on every render.
  renderNetBetPad();
  if (status === "in_hand") startNetClock(); else stopNetClock();
}

/* ═══════════════════ SIGN IN / REGISTER ═══════════════════ */

let _signinMode: "signin" | "register" = "signin";
// Live economy subscriptions: two-wallet balance + Edge Pass, the inbox, and the
// admin claim. Started on sign-in / restore; torn down on sign-out.
let _walletUnsub: (() => void) | null = null, _inboxUnsub: (() => void) | null = null;
// NOTE: "mp-setup" is deliberately EXCLUDED — presence/online heartbeats fire every
// few seconds, and re-rendering Play Online mid-typing wiped the join-code input.
// Wallet changes still must show live there (the balance, buy-in slider max, and
// affordability gating all derive from it), so the wallet sub additionally calls
// renderMpSetupLive(): a full re-render that carries the join-code input's value,
// focus, and caret across the rebuild. Wallet snapshots only fire on real wallet
// changes (claims, purchases, settlements), never on heartbeats, so this can't
// reintroduce the mid-typing wipe.
const ECON_SCREENS = new Set(["home", "inbox", "compose", "admin", "store", "profile", "settings"]);
function renderIfEcon(): void { if (ECON_SCREENS.has(S.screen)) render(); }
function renderMpSetupLive(): void {
  if (S.screen !== "mp-setup") return;
  const inp = document.getElementById("net-code") as HTMLInputElement | null;
  const hadFocus = !!inp && document.activeElement === inp;
  const val = inp ? inp.value : null;
  const selStart = inp?.selectionStart ?? null, selEnd = inp?.selectionEnd ?? null;
  render();
  const next = document.getElementById("net-code") as HTMLInputElement | null;
  if (!next) return;
  if (val !== null) next.value = val;
  if (hadFocus) {
    next.focus();
    if (selStart !== null && selEnd !== null) { try { next.setSelectionRange(selStart, selEnd); } catch { /* */ } }
  }
}
function stopEconomySubs(): void {
  if (_walletUnsub) { _walletUnsub(); _walletUnsub = null; }
  if (_inboxUnsub) { _inboxUnsub(); _inboxUnsub = null; }
  if (_onlineUnsub) { _onlineUnsub(); _onlineUnsub = null; }
  S.wallet = { play: null, premium: null }; S.inbox = []; S.isAdmin = false; S.edgePass = false; S.mp.online = [];
  _walletLoaded = false; _weeklyShown = false;
}
async function startEconomySubs(uid: string): Promise<void> {
  stopEconomySubs();
  // Native: identify the RevenueCat SDK with the Firebase uid so IAP grants map to this user.
  // No-op on web / placeholder keys (the bridge guards internally).
  void IAP.rcConfigure(uid);
  try {
    _walletUnsub = await FB.subscribeWallet(uid, (w) => { S.wallet = { play: w.play, premium: w.premium }; S.edgePass = w.edgePass; S.lastWeekly = w.lastWeekly; S.weeklyStreak = w.weeklyStreak; S.collectibles = w.collectibles; _walletLoaded = true; renderIfEcon(); renderMpSetupLive(); maybeShowWeekly(); });
    _inboxUnsub = await FB.subscribeInbox(uid, (msgs) => { S.inbox = msgs; renderIfEcon(); });
    _onlineUnsub = await FB.subscribeOnline((list) => { S.mp.online = list.filter((p) => p.uid !== uid); renderIfEcon(); });
    FB.isAdminClaim().then((a) => {
      S.isAdmin = a; renderIfEcon();
      // Admins auto-get a real Edge Pass entitlement (server-side) so the live MCE
      // overlay works in networked rooms too, not just the UI unlock.
      if (a && !S.edgePass) FB.adminSetEdgePass(uid, true).catch(() => {});
    }).catch(() => {});
  } catch { /* */ }
}
/** Back-compat: re-pull entitlement (the live wallet sub also keeps it fresh). */
async function refreshEntitlement(): Promise<void> { const uid = S.mp.auth?.uid; if (uid) await startEconomySubs(uid); }
function unread(): number { return S.inbox.filter((m) => !m.read).length; }
// OAuth via redirect: flag the pending sign-in, then navigate to the provider. The
// page leaves immediately (no hanging popup promise); consumeRedirect() on the next
// load finishes the job. A 12s safety clears the spinner if the redirect never starts.
async function startOAuth(which: "google" | "apple"): Promise<void> {
  if (S.net.busy) return;
  // Native shell: an OAuth redirect would navigate away from the bundled app, so sign in
  // INLINE via the native plugin (FB.signInWithGoogle/Apple bridge to it) and finish here —
  // no redirect, no consumeRedirect() resume on reload.
  if ((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
    // Backstop: native has no redirect to fall back on, so if the sign-in ever hangs (stalled
    // Firebase call) clear the spinner and offer a retry instead of spinning forever.
    setTimeout(() => { if (S.net.busy && S.screen === "signin") { S.net.busy = false; S.net.err = "Sign-in timed out — check your connection and try again."; render(); } }, 25000);
    void doSignIn(() => (which === "apple" ? FB.signInWithApple() : FB.signInWithGoogle()));
    return;
  }
  S.net.busy = true; S.net.err = ""; render();
  try { localStorage.setItem("mce-signed-in", "1"); localStorage.setItem("mce-auth-pending", which); } catch { /* */ }
  setTimeout(() => { if (S.net.busy && S.screen === "signin") { S.net.busy = false; render(); } }, 12000);
  try { await FB.signInRedirect(which); }
  catch (e) { S.net.busy = false; try { localStorage.removeItem("mce-auth-pending"); } catch { /* */ } S.net.err = friendlyErr(e); render(); }
}
async function doSignIn(fn: () => Promise<MPUser>, regName?: string): Promise<void> {
  if (S.net.busy) return;
  S.net.busy = true; S.net.err = ""; render();
  try {
    const u = await fn();
    S.mp.auth = u;
    try { localStorage.setItem("mce-signed-in", "1"); } catch { /* */ }
    // Default the table nickname to the real account name (so seats don't all show
    // "You"). Keep any custom nickname the player already set.
    if (regName) { S.profile.nickname = regName; saveProfile(); }
    else if (!S.profile.nickname || S.profile.nickname === "You") { S.profile.nickname = u.name; saveProfile(); }
    void FB.startPresence(u).catch(() => {});
    void startEconomySubs(u.uid);
    S.net.busy = false;
    // Brand-new account → onboard. Email-register passes regName; native Google/Apple sets u.isNew
    // (the web redirect path handles its own routing in initAuth). Returning users → home.
    S.screen = (regName || u.isNew) && !onboarded() ? "onboard" : "home";
    render();
  } catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}
// ── Passkey / Face ID helpers (WebAuthn). Platform support is probed once + cached;
// "enrolled" is a local hint — the real passkey lives in the device / iCloud keychain. ──
let _passkeyOk: boolean | null = null;
let _passkeyMsg = "";
function passkeyEnrolled(): boolean { try { return localStorage.getItem("mce-passkey") === "1"; } catch { return false; } }
function ensurePasskeyProbe(): void {
  if (_passkeyOk !== null) return;
  _passkeyOk = false; // settle to false while the async probe is in flight
  void FB.passkeySupported().then((ok) => { if (ok && _passkeyOk !== true) { _passkeyOk = true; render(); } });
}
async function doPasskeyRegister(): Promise<void> {
  if (S.net.busy) return;
  S.net.busy = true; _passkeyMsg = ""; render();
  try {
    await FB.passkeyRegister(S.profile.nickname);
    try { localStorage.setItem("mce-passkey", "1"); } catch { /* */ }
    _passkeyMsg = "✓ Face ID enabled — you can sign back in with it.";
  } catch { _passkeyMsg = "Couldn't set up Face ID — try again."; }
  S.net.busy = false; render();
}

function renderSignIn(): void {
  cancelVillainTimer();
  const reg = _signinMode === "register";
  app.innerHTML = `
    <div class="signin">
      <div class="si-bg" aria-hidden="true"><span class="mc-glow g-emerald"></span><span class="mc-glow g-gold"></span></div>
      <div class="si-brand"><div class="si-cards"><span class="si-c back"></span><span class="si-c red">A<i>♥</i></span><span class="si-c">A<i>♠</i></span></div>
        <h1 class="si-word"><span>MONTECARLO</span><b>EDGE</b></h1></div>
      <p class="si-sub">${reg ? "Create your account" : "Sign in to continue"} — your chips save to your account &amp; you can play online.</p>

      ${_passkeyOk ? `<button class="si-btn passkey" id="si-passkey">Sign in with Face ID</button>` : ""}
      <button class="si-btn apple" id="si-apple"> Continue with Apple</button>
      <button class="si-btn google" id="si-google"> Continue with Google</button>
      <div class="si-or"><span>or with email</span></div>
      ${reg ? `<input class="si-input" id="si-name" placeholder="Nickname" maxlength="14" value="${S.profile.nickname.replace(/"/g, "&quot;")}"/>` : ""}
      <input class="si-input" id="si-email" type="email" autocomplete="email" placeholder="Email address"/>
      <input class="si-input" id="si-pw" type="password" autocomplete="${reg ? "new-password" : "current-password"}" placeholder="${reg ? "Password (min 6)" : "Password"}"/>
      ${S.net.err ? `<div class="room-broke">${S.net.err}</div>` : ""}
      <button class="si-btn primary" id="si-submit">${S.net.busy ? '<span class="spin dark"></span>' : reg ? "Create account" : "Sign in"}</button>
      <div class="si-links">
        <button class="mc-foot-link" id="si-toggle">${reg ? "Have an account? Sign in" : "New? Create account"}</button>
        ${!reg ? `<button class="mc-foot-link" id="si-reset">Forgot password?</button>` : ""}
      </div>
      <button class="si-skip" id="si-back">Skip — Poker Training only</button>
    </div>`;
  onId("si-passkey", "click", () => void doSignIn(async () => { const u = await FB.passkeySignIn(); try { localStorage.setItem("mce-passkey", "1"); } catch { /* */ } return u; }));
  onId("si-apple", "click", () => void startOAuth("apple"));
  onId("si-google", "click", () => void startOAuth("google"));
  onId("si-submit", "click", () => {
    const email = (document.getElementById("si-email") as HTMLInputElement | null)?.value.trim() ?? "";
    const pw = (document.getElementById("si-pw") as HTMLInputElement | null)?.value ?? "";
    const name = (document.getElementById("si-name") as HTMLInputElement | null)?.value.trim() || S.profile.nickname;
    if (!email || !pw) { S.net.err = "Enter your email and password."; render(); return; }
    void doSignIn(() => (reg ? FB.registerEmail(email, pw, name) : FB.signInEmail(email, pw)), reg ? name : undefined);
  });
  onId("si-toggle", "click", () => { _signinMode = reg ? "signin" : "register"; S.net.err = ""; render(); });
  onId("si-reset", "click", () => {
    const email = (document.getElementById("si-email") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!email) { S.net.err = "Enter your email first, then tap Forgot."; render(); return; }
    void FB.sendReset(email).then(() => { S.net.err = "Reset email sent — check your inbox."; render(); }).catch((e) => { S.net.err = friendlyErr(e); render(); });
  });
  onId("si-back", "click", () => { S.net.err = ""; S.screen = "home"; render(); });
  ensurePasskeyProbe();
}

/* ═══════════════════ FIRST-TIME ONBOARDING ═══════════════════ */

function onboarded(): boolean { try { return localStorage.getItem("mce-onboarded") === "1"; } catch { return true; } }
function renderOnboard(): void {
  cancelVillainTimer();
  const p = S.profile;
  let region = ""; try { region = localStorage.getItem("mce-region") || ""; } catch { /* */ }
  app.innerHTML = `
    <div class="signin">
      <div class="si-bg" aria-hidden="true"><span class="mc-glow g-emerald"></span><span class="mc-glow g-gold"></span></div>
      <div class="si-brand"><div class="si-cards"><span class="si-c back"></span><span class="si-c red">A<i>♥</i></span><span class="si-c">A<i>♠</i></span></div>
        <h1 class="si-word"><span>WELCOME TO</span><b>MONTECARLOEDGE</b></h1></div>
      <p class="si-sub">You're in${S.mp.auth ? `, ${esc(S.mp.auth.name)}` : ""}! Set up your profile — you can change all of this later.</p>
      <div class="field"><label>Nickname</label><input class="si-input" id="ob-nick" maxlength="14" value="${esc(p.nickname === "You" ? (S.mp.auth?.name ?? "") : p.nickname)}" placeholder="Your table name"/></div>
      <div class="field"><label>Avatar</label>
        <div class="avatar-grid">
          <button class="avatar-pick ${!p.avatar ? "sel" : ""}" id="ob-av-auto" title="Auto">${avatarChip("", p.nickname, 38)}</button>
          ${PRESET_AVATARS.map((a) => `<button class="avatar-pick ${p.avatar === a ? "sel" : ""}" data-ob-av="${a}">${a}</button>`).join("")}
        </div>
      </div>
      <div class="field"><label>Region (optional)</label><input class="si-input" id="ob-region" placeholder="e.g. Singapore" value="${esc(region)}"/></div>
      <button class="si-btn primary" id="ob-done">Let's play →</button>
    </div>`;
  onId("ob-av-auto", "click", () => { S.profile.avatar = ""; saveProfile(); render(); });
  app.querySelectorAll("[data-ob-av]").forEach((b) => onEl(b, "click", () => { S.profile.avatar = (b as HTMLElement).dataset.obAv!; saveProfile(); render(); }));
  onId("ob-done", "click", () => {
    const nick = (document.getElementById("ob-nick") as HTMLInputElement | null)?.value.trim() || S.mp.auth?.name || "Player";
    const reg = (document.getElementById("ob-region") as HTMLInputElement | null)?.value.trim() || "";
    S.profile.nickname = nick; saveProfile();
    try { localStorage.setItem("mce-region", reg); localStorage.setItem("mce-onboarded", "1"); } catch { /* */ }
    const uid = S.mp.auth?.uid; if (uid) void FB.updateName(uid, nick).catch(() => {});
    S.screen = "home"; render();
  });
}

/* ═══════════════════ MESSAGING · GIFTING · ADMIN ═══════════════════ */

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function fmtBal(n: number | null): string { return n == null ? "—" : Math.round(n).toLocaleString(); }
function unreadCount(): number { return S.inbox.filter((m) => !m.read).length; }
// Admin gets the MCE overlay / Edge Pass unlocked automatically (UI), alongside real
// Stripe subscribers. (Server-side, admins self-grant a real entitlement on sign-in.)
function hasEdge(): boolean { return S.edgePass || S.isAdmin; }

// Admin "preview as a regular player": a client-only toggle that suppresses every
// admin affordance so the owner can QA the normal experience. It does NOT drop the
// real claim (server still trusts the token) — it's purely a view filter.
let _viewAsPlayer = false;
try { _viewAsPlayer = localStorage.getItem("mce-view-as-player") === "1"; } catch { /* */ }
function effectiveAdmin(): boolean { return S.isAdmin && !_viewAsPlayer; }
function setViewAsPlayer(v: boolean): void { _viewAsPlayer = v; try { localStorage.setItem("mce-view-as-player", v ? "1" : "0"); } catch { /* */ } S.screen = "home"; render(); }

let _inboxErr = ""; // transient delete/action error shown on the inbox screen
function renderInbox(): void {
  cancelVillainTimer();
  const uid = S.mp.auth?.uid;
  const msgs = S.inbox;
  app.innerHTML = `
    <div class="setup doc">
      <div class="doc-top"><button class="hdr-btn" id="ib-back">← Back</button><h1>✉️ Inbox</h1><button class="hdr-btn" id="ib-new">＋ New</button></div>
      <div class="set-head" style="margin:4px 0 6px">🟢 Online now · ${S.mp.online.length}</div>
      ${S.mp.online.length ? `<div class="inbox-online">${S.mp.online.map((p) => `<button class="io-chip" data-uid="${esc(p.uid)}" data-name="${esc(p.name)}">🟢 ${esc(p.name)}</button>`).join("")}</div>` : `<div class="hint" style="margin-bottom:12px">No one else online right now — tap a name here when friends are on to message or gift them.</div>`}
      <div class="set-head" style="margin:4px 0 6px">Messages</div>
      ${msgs.length === 0 ? `<div class="hint" style="text-align:center;margin-top:14px">No messages yet.<br/>Tap a player above or ＋ New to message / gift.</div>` : msgs.map((m) => {
        const icon = m.kind === "gift" ? "🎁" : m.kind === "admin" ? "🛡" : "💬";
        const body = (m.kind === "gift" || m.kind === "admin")
          ? `sent you ${m.currency === "premium" ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>"} <strong>${(m.chips || 0).toLocaleString()}</strong>${m.text ? ` — “${esc(m.text)}”` : ""}`
          : esc(m.text || "");
        return `<div class="inbox-row ${m.read ? "" : "unread"}">
          <span class="ib-ic">${icon}</span>
          <div class="ib-body"><div class="ib-from">${esc(m.fromName)}</div><div class="ib-text">${body}</div></div>
          <div class="ib-actions">
            ${m.from && m.from !== "admin" ? `<button class="hdr-btn ib-reply" data-uid="${esc(m.from)}" data-name="${esc(m.fromName)}">Reply</button>` : ""}
            <button class="hdr-btn ib-delete" data-id="${esc(m.id)}" title="Delete" aria-label="Delete message">✕</button>
          </div>
        </div>`;
      }).join("")}
      ${_inboxErr ? `<div class="room-broke" style="margin-top:10px">${esc(_inboxErr)}</div>` : ""}
    </div>`;
  onId("ib-back", "click", () => { _inboxErr = ""; S.screen = "home"; render(); });
  onId("ib-new", "click", () => { S.compose = { toUid: "", toName: "", text: "", giftAmt: 0, busy: false, err: "", sent: "" }; S.screen = "compose"; render(); });
  app.querySelectorAll(".io-chip").forEach((b) => onEl(b, "click", () => { const el = b as HTMLElement; S.compose = { toUid: el.dataset.uid!, toName: el.dataset.name!, text: "", giftAmt: 0, busy: false, err: "", sent: "" }; S.screen = "compose"; render(); }));
  app.querySelectorAll(".ib-reply").forEach((b) => onEl(b, "click", () => {
    const el = b as HTMLElement;
    S.compose = { toUid: el.dataset.uid!, toName: el.dataset.name!, text: "", giftAmt: 0, busy: false, err: "", sent: "" };
    S.screen = "compose"; render();
  }));
  app.querySelectorAll(".ib-delete").forEach((b) => onEl(b, "click", () => {
    const msgId = (b as HTMLElement).dataset.id;
    if (!msgId || !uid) return;
    // Fire-and-forget: the live subscribeInbox listener drops the row via Firestore's latency
    // compensation (the local delete applies instantly), mirroring markRead — no optimistic
    // mutation needed. On failure the SDK rolls the row back; surface why.
    _inboxErr = "";
    FB.deleteMessage(uid, msgId).catch((e) => { _inboxErr = friendlyErr(e); render(); });
  }));
  // Mark everything read (fire-and-forget).
  if (uid) msgs.filter((m) => !m.read).forEach((m) => void FB.markRead(uid, m.id).catch(() => {}));
}

function renderCompose(): void {
  cancelVillainTimer();
  const c = S.compose;
  const online = S.mp.online;
  app.innerHTML = `
    <div class="setup doc">
      <div class="doc-top"><button class="hdr-btn" id="co-back">← Back</button><h1>✉️ New message</h1><span style="width:54px"></span></div>
      ${c.toUid
        ? `<div class="co-to">To <strong>${esc(c.toName)}</strong> · <button class="mc-foot-link" id="co-clear">change</button></div>`
        : `<div class="field"><label>To — players online now</label>${online.length ? `<div class="co-online">${online.map((p) => `<button class="hdr-btn co-pick" data-uid="${esc(p.uid)}" data-name="${esc(p.name)}">🙂 ${esc(p.name)}</button>`).join("")}</div>` : `<div class="hint">No one else is online right now. Reply from your inbox, or have a friend sign in.</div>`}</div>`}
      <div class="field"><label>Message</label><textarea class="si-input" id="co-text" rows="3" maxlength="500" placeholder="Say something…">${esc(c.text)}</textarea></div>
      <div class="field"><label>Gift play chips (optional) — you have <i class=ic-coin></i> ${fmtBal(S.wallet.play)}</label>
        <input class="si-input" id="co-gift" type="number" min="0" step="50" value="${c.giftAmt || ""}" placeholder="0"/></div>
      ${c.err ? `<div class="room-broke">${esc(c.err)}</div>` : ""}${c.sent ? `<div class="se-active">${esc(c.sent)}</div>` : ""}
      <button class="si-btn primary" id="co-send" ${!c.toUid || c.busy ? "disabled style=opacity:.5" : ""}>${c.busy ? "…" : c.giftAmt > 0 ? `Send + gift <i class=ic-coin></i> ${c.giftAmt.toLocaleString()}` : "Send"}</button>
    </div>`;
  onId("co-back", "click", () => { S.screen = "inbox"; render(); });
  onId("co-clear", "click", () => { c.toUid = ""; c.toName = ""; render(); });
  app.querySelectorAll(".co-pick").forEach((b) => onEl(b, "click", () => { const el = b as HTMLElement; c.toUid = el.dataset.uid!; c.toName = el.dataset.name!; render(); }));
  onId("co-text", "input", (e) => { c.text = (e.target as HTMLTextAreaElement).value; });
  onId("co-gift", "input", (e) => { c.giftAmt = Math.max(0, Math.floor(+(e.target as HTMLInputElement).value || 0)); });
  onId("co-send", "click", () => void doSend());
}
async function doSend(): Promise<void> {
  const c = S.compose;
  if (!c.toUid || c.busy) return;
  c.busy = true; c.err = ""; c.sent = ""; render();
  try {
    if (c.giftAmt > 0) await FB.giftChips(c.toUid, c.giftAmt, c.text.trim().slice(0, 200));
    else if (c.text.trim()) await FB.sendMessage(c.toUid, c.text.trim());
    else { c.busy = false; c.err = "Write a message or set a gift amount."; render(); return; }
    c.busy = false; c.sent = `Sent to ${c.toName}!`; c.text = ""; c.giftAmt = 0; render();
  } catch (e) { c.busy = false; c.err = friendlyErr(e); render(); }
}

let _ledgerUnsub: (() => void) | null = null;
let _usersUnsub: (() => void) | null = null;
let _adminUsers: import("../mp/firebase-adapter.js").AdminUser[] = [];
function renderAdmin(): void {
  cancelVillainTimer();
  if (!S.isAdmin) { S.screen = "home"; render(); return; }
  const c = S.compose;
  const myUid = S.mp.auth?.uid ?? "";
  if (!_ledgerUnsub) FB.subscribeLedger((rows) => { S.ledger = rows; if (S.screen === "admin") render(); }).then((u) => { _ledgerUnsub = u; }).catch(() => {});
  if (!_usersUnsub) FB.subscribeUsers((us) => { _adminUsers = us; if (S.screen === "admin") render(); }).then((u) => { _usersUnsub = u; }).catch(() => {});
  app.innerHTML = `
    <div class="setup doc">
      <div class="doc-top"><button class="hdr-btn" id="ad-back">← Back</button><h1>🛡 Admin</h1><span style="width:54px"></span></div>

      <div class="set-group"><div class="set-head">You</div>
        <button class="hdr-btn" id="ad-myuid" style="width:100%;word-break:break-all">UID ${esc(myUid)} · 📋 copy</button>
      </div>

      <div class="set-group"><div class="set-head">All users · ${_adminUsers.length}</div>
        ${_adminUsers.length === 0
          ? `<div class="hint">Loading users… (needs the admin claim). If this stays empty, run functions/scripts/set-admin.mjs then sign out + in.</div>`
          : _adminUsers.slice().sort((a, b) => (a.uid === myUid ? -1 : b.uid === myUid ? 1 : 0)).map((u) => `
            <div class="admin-user">
              <div class="au-main">
                <div class="au-name">${esc(u.name)}${u.edgePass ? " 🧠" : ""}${u.uid === myUid ? " · you" : ""}</div>
                <div class="au-bal"><i class=ic-coin></i> ${u.play.toLocaleString()} · <i class=ic-gem></i> ${u.premium.toLocaleString()}</div>
              </div>
              <div class="au-actions">
                <button class="hdr-btn au-act" data-u="${u.uid}" data-cur="play" data-amt="500">+500<i class=ic-coin></i></button>
                <button class="hdr-btn au-act" data-u="${u.uid}" data-cur="premium" data-amt="100">+100<i class=ic-gem></i></button>
                <button class="hdr-btn au-edge ${u.edgePass ? "on" : ""}" data-u="${u.uid}" data-on="${u.edgePass ? "0" : "1"}">${u.edgePass ? "Edge ✓" : "Edge"}</button>
                ${u.uid === myUid ? "" : `<button class="hdr-btn danger au-del" data-u="${u.uid}" data-n="${esc(u.name)}">🗑</button>`}
              </div>
            </div>`).join("")}
      </div>

      <div class="set-group"><div class="set-head">Custom grant (by UID)</div>
        <div class="field"><label>Recipient UID</label><input class="si-input" id="ad-uid" placeholder="paste a UID from above" value="${esc(c.toUid)}"/></div>
        <div class="field"><label>Currency</label><select class="mp-type" id="ad-cur"><option value="play"><i class=ic-coin></i> Play</option><option value="premium"><i class=ic-gem></i> Premium</option></select></div>
        <div class="field"><label>Amount (negative = deduct)</label><input class="si-input" id="ad-amt" type="number" value="${c.giftAmt || ""}"/></div>
        ${c.err ? `<div class="room-broke">${esc(c.err)}</div>` : ""}${c.sent ? `<div class="se-active">${esc(c.sent)}</div>` : ""}
        <button class="si-btn primary" id="ad-give" ${c.busy ? "disabled" : ""}>${c.busy ? "…" : "Grant"}</button>
      </div>

      <div class="set-group"><div class="set-head">Ledger — last ${S.ledger.length}</div>
        ${S.ledger.length === 0 ? `<div class="hint">No transfers yet.</div>` : S.ledger.map((r) => `<div class="ledger-row"><span>${r.type === "admin" ? "🛡" : r.type === "edgepass" ? "🧠" : r.type === "buy" ? "🛍" : "🎁"} ${r.currency === "premium" ? "<i class=ic-gem></i>" : r.currency === "play" ? "<i class=ic-coin></i>" : ""} ${r.amount != null ? Number(r.amount).toLocaleString() : (r.on ? "on" : "off")}</span><span class="hint">${esc(r.fromName || r.from)} → ${esc(r.toName || r.to)}</span></div>`).join("")}
      </div>

      <div class="set-group"><div class="set-head">View</div>
        <div class="set-note" style="margin-bottom:9px">See the app exactly as a regular player does. Your access is unchanged; return via the banner on Home.</div>
        <button class="hdr-btn" id="ad-preview" style="width:100%;padding:12px">👁 Preview as a regular player</button>
      </div>
    </div>`;
  onId("ad-back", "click", () => { S.screen = "home"; render(); });
  onId("ad-myuid", "click", () => { try { void navigator.clipboard?.writeText(myUid); } catch { /* */ } });
  onId("ad-preview", "click", () => setViewAsPlayer(true));
  onId("ad-uid", "input", (e) => { c.toUid = (e.target as HTMLInputElement).value.trim(); });
  onId("ad-amt", "input", (e) => { c.giftAmt = Math.floor(+(e.target as HTMLInputElement).value || 0); });
  onId("ad-give", "click", () => void doAdminGift());
  app.querySelectorAll(".au-act").forEach((b) => onEl(b, "click", () => { const el = b as HTMLElement; void doAdminGiftUser(el.dataset.u!, el.dataset.cur as "play" | "premium", +el.dataset.amt!); }));
  app.querySelectorAll(".au-edge").forEach((b) => onEl(b, "click", () => { const el = b as HTMLElement; void doAdminEdge(el.dataset.u!, el.dataset.on === "1"); }));
  app.querySelectorAll(".au-del").forEach((b) => onEl(b, "click", () => { const el = b as HTMLElement; void doAdminDeleteUser(el.dataset.u!, el.dataset.n ?? "user"); }));
}
async function doAdminGiftUser(uid: string, cur: "play" | "premium", amt: number): Promise<void> {
  try { await FB.adminGift(uid, cur, amt); try { playSound("chip"); } catch { /* */ } }
  catch (e) { S.compose.err = friendlyErr(e); render(); }
}
async function doAdminEdge(uid: string, on: boolean): Promise<void> {
  try { await FB.adminSetEdgePass(uid, on); } catch (e) { S.compose.err = friendlyErr(e); render(); }
}
async function doAdminDeleteUser(uid: string, name: string): Promise<void> {
  // Two-stage confirm so a misclick can't nuke an account. The server still re-checks
  // the admin claim — the UI gate is convenience, not security.
  if (!confirm(`Delete ${name}'s account? Their Firestore profile, inbox, presence, and Auth user will be removed.`)) return;
  if (!confirm("Last chance — this is irreversible. Continue?")) return;
  try { await FB.adminDeleteUser(uid); S.compose.sent = `Deleted ${name}`; render(); }
  catch (e) { S.compose.err = friendlyErr(e); render(); }
}
async function doAdminGift(): Promise<void> {
  const c = S.compose;
  const cur = ((document.getElementById("ad-cur") as HTMLSelectElement | null)?.value === "premium") ? "premium" : "play";
  if (!c.toUid || !c.giftAmt || c.busy) return;
  c.busy = true; c.err = ""; c.sent = ""; render();
  try { const r = await FB.adminGift(c.toUid, cur, c.giftAmt); c.busy = false; c.sent = `Done — new balance ${r.balance.toLocaleString()}`; render(); }
  catch (e) { c.busy = false; c.err = friendlyErr(e); render(); }
}

/* ── Weekly free-chips claim: a Monday dopamine moment. The reward is DETERMINISTIC
   and FREE (a fixed grant) — satisfying juice, but NOT a randomized/paid loot box
   (which would be a regulated gambling mechanic for a non-gambling app). ── */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let _weeklyShown = false;
let _walletLoaded = false; // true once the FIRST real wallet snapshot has arrived
// Treat "never claimed" as claimable ONLY after the wallet has loaded — otherwise we
// pop the modal on the stale lastWeekly=0 default, then the server says "already claimed".
function canClaimWeekly(): boolean { return !!S.mp.auth && _walletLoaded && (!S.lastWeekly || Date.now() - S.lastWeekly >= WEEK_MS); }
function maybeShowWeekly(): void {
  if (_weeklyShown || S.screen !== "home" || !canClaimWeekly()) return;
  _weeklyShown = true;
  showWeeklyClaim();
}
function countUp(el: HTMLElement | null, to: number, instant: boolean): void {
  if (!el) return;
  if (instant) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t: number) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString(); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const WEEKLY_LADDER = [500, 600, 750, 1000];
function nextWeeklyAmt(): number { return WEEKLY_LADDER[Math.min(S.weeklyStreak, WEEKLY_LADDER.length - 1)]!; }
function showWeeklyClaim(): void {
  if (document.getElementById("weekly-modal")) return;
  const reduce = reduceMotion();
  const amt = nextWeeklyAmt();
  const wkNum = S.weeklyStreak + 1; // the week you're claiming
  const ladder = WEEKLY_LADDER.map((v, i) => `<span class="wk-rung ${i === Math.min(S.weeklyStreak, 3) ? "now" : i < S.weeklyStreak ? "done" : ""}">${v.toLocaleString()}</span>`).join("");
  const wrap = document.createElement("div");
  wrap.id = "weekly-modal"; wrap.className = "weekly-modal";
  wrap.innerHTML = `
    <div class="weekly-card">
      <div class="wk-ring" aria-hidden="true"></div>
      <div class="wk-coin"><i class=ic-coin></i></div>
      <h2>Week ${wkNum}</h2>
      <p class="wk-sub">${S.weeklyStreak > 0 ? `🔥 ${S.weeklyStreak}-week streak` : "Your weekly free chips"}</p>
      <div class="wk-amt">+<span id="wk-num">${amt.toLocaleString()}</span></div>
      <div class="wk-ladder">${ladder}</div>
      <button class="si-btn primary" id="wk-claim">CLAIM</button>
      <button class="wk-later" id="wk-later">Later</button>
    </div>`;
  document.body.appendChild(wrap);
  let closed = false;
  const close = () => { if (closed) return; closed = true; wrap.classList.add("closing"); setTimeout(() => wrap.remove(), 280); };
  wrap.querySelector("#wk-later")!.addEventListener("click", close);
  wrap.querySelector("#wk-claim")!.addEventListener("click", async () => {
    const btn = wrap.querySelector("#wk-claim") as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "…";
    try {
      const r = await FB.claimWeekly();
      S.lastWeekly = Date.now(); // kill any re-show race immediately (don't wait for the sub)
      const card = wrap.querySelector(".weekly-card")!;
      card.classList.add("claimed");
      if (!reduce) coinBurst(card as HTMLElement, 18);
      try { playSound("chip"); } catch { /* */ }
      countUp(wrap.querySelector("#wk-num"), r.granted ?? amt, reduce);
      btn.textContent = "✓ Claimed!";
      setTimeout(close, 1500);
    } catch (e) {
      // Most likely "already claimed this week" — never leave the modal stuck.
      S.lastWeekly = Date.now();
      const msg = friendlyErr(e);
      const sub = wrap.querySelector(".wk-sub"); if (sub) sub.textContent = /already|precondition/i.test(msg) ? "Already claimed — see you next week!" : msg;
      btn.textContent = "OK"; btn.disabled = false;
      btn.onclick = close;
      setTimeout(close, 2400);
    }
  });
}
function coinBurst(card: HTMLElement, n: number): void {
  for (let i = 0; i < n; i++) {
    const c = document.createElement("span");
    c.className = "wk-fly"; c.textContent = "<i class=ic-coin></i>";
    const ang = (i / n) * 2 * Math.PI + (i * 0.7);
    const dist = 64 + (i % 5) * 18;
    c.style.setProperty("--dx", `${(Math.cos(ang) * dist).toFixed(0)}px`);
    c.style.setProperty("--dy", `${(Math.sin(ang) * dist - 24).toFixed(0)}px`);
    c.style.animationDelay = `${((i % 6) * 0.03).toFixed(2)}s`;
    card.appendChild(c);
    setTimeout(() => c.remove(), 1400);
  }
}

/* ═══════════════════ HOME HUB + PROFILE ═══════════════════ */

const PRESET_AVATARS = [
  "🦈", "🐺", "🦊", "🐉", "🦁", "🐯", "🐻", "🐼", "🦏", "🐗", "🦌", "🦅", "🦉", "🐊", "🐢", "🐙",
  "🦭", "🐬", "🦓", "🦄", "🐸", "🐧", "🐳", "🦋", "🦜", "🦚", "🦂", "🐲", "🦛", "🐅",
  "🃏", "👑", "🎩", "<i class=ic-gem></i>", "🔥", "⚡", "🌟", "🍀", "🎰", "🎲",
  "🤠", "🥷", "🤖", "👾", "💀", "🤡", "😎", "🧠", "👽", "🦾"];
function hashHue(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
// Animal-emoji avatars that have a premium generated mascot — render the artwork instead.
const MASCOT_EMOJI: Record<string, string> = { "🦈": "shark", "🦊": "fox", "🦉": "owl", "🐻": "bear", "🐅": "panther", "🦅": "eagle" };
function avatarChip(av: string, seed: string, size = 40): string {
  const dim = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px`;
  const mascot = MASCOT_EMOJI[av];
  if (mascot) return `<span class="avatar mascot" style="${dim}"><img src="/avatars/${mascot}.webp" alt="" draggable="false"></span>`;
  if (av && av !== "auto") return `<span class="avatar" style="${dim}">${av}</span>`;
  const mono = (seed || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar identicon" style="${dim};background:hsl(${hashHue(seed || "x")} 55% 42%)">${mono}</span>`;
}
// Bust-rescue (monetization council's #1 trust mechanic): a player can never be
// wall-jammed broke behind a paywall. Below one micro min-buy-in → free top-up.
const BUST_RESCUE = 200;
function bustRescue(): void { if (S.profile.chips < BUST_RESCUE) { S.profile.chips = BUST_RESCUE; saveProfile(); } }

function loadProfile(): void {
  try {
    const p = JSON.parse(localStorage.getItem("mce-profile") || "null");
    if (p && typeof p === "object") {
      S.profile = { nickname: p.nickname || "You", avatar: p.avatar || "", chips: typeof p.chips === "number" ? p.chips : 1000 };
    }
  } catch { /* default */ }
  bustRescue();
}
function saveProfile(): void { try { localStorage.setItem("mce-profile", JSON.stringify(S.profile)); } catch { /* quota */ } }

// One-time 18+ age gate (flagged by both the monetization council AND the legal
// review as a defensibility table-stake for a poker-themed app).
function ageConfirmed(): boolean { try { return localStorage.getItem("mce-age-ok") === "1"; } catch { return true; } }
function renderAgeGate(): void {
  cancelVillainTimer();
  app.innerHTML = `
    <div class="age-gate">
      <div class="age-card">
        <div class="age-mark">🂡</div>
        <h1>MONTECARLO<b>EDGE</b></h1>
        <p class="age-lead">You must be <strong>18 or older</strong> (or your local age of majority) to use MonteCarloEdge.</p>
        <p class="age-fine">Chips are <strong>play-money only</strong> — no cash value, never cashable or redeemable. MonteCarloEdge is a poker trainer and social game <strong>for entertainment only</strong> — it is <strong>not gambling</strong> and offers no real-money wagering, prizes, or payouts of any kind. Practice or success here <strong>does not imply future success</strong> at real-money gambling.</p>
        <button class="start-btn" id="age-yes">I'm 18 or older — enter</button>
        <button class="hdr-btn" id="age-no" style="width:100%;padding:12px;margin-top:8px">Under 18 — leave</button>
        <p class="age-agree">By entering you confirm you're 18+ and agree to the <button class="age-link" id="age-terms">Terms</button> &amp; <button class="age-link" id="age-explain">How it works</button>.</p>
      </div>
    </div>`;
  onId("age-yes", "click", () => { try { localStorage.setItem("mce-age-ok", "1"); } catch { /* */ } S.screen = introSeen() ? "home" : "landing"; render(); });
  onId("age-no", "click", () => { app.innerHTML = `<div class="age-gate"><div class="age-card"><div class="age-mark">🚫</div><p class="age-lead">Come back when you're 18.</p></div></div>`; });
  onId("age-terms", "click", () => { _docReturn = "home"; S.screen = "legal"; render(); }); // readable pre-confirm; Back → gate
  onId("age-explain", "click", () => { _docReturn = "home"; S.screen = "explainer"; render(); });
}

// Cosmetics — the ONLY chip sink (play-money in, in-app flair out; never anything
// of value, never the killed chips→goods cash-out).
// Pricing (from the monetization council). Anchor: $9.90 ≈ 1,000 play chips. Buy
// actions are "Soon" until Stripe keys are wired; the catalog + trust copy ship now.
// `id` is the store product id (App Store Connect / Play Console / RevenueCat). Must match
// CHIP_PACKS / EDGE_PRODUCTS in functions/src/revenuecat-grants.ts.
const PLAY_PACKS = [
  { id: "chips_500", chips: "500", price: "$4.99" },
  { id: "chips_1000", chips: "1,000", price: "$9.90", badge: "Anchor" },
  { id: "chips_2400", chips: "2,400", price: "$19.90", bonus: "+20%" },
  { id: "chips_7000", chips: "7,000", price: "$49", bonus: "Best for Mid" },
  { id: "chips_16000", chips: "16,000", price: "$99" },
  { id: "chips_40000", chips: "40,000", price: "$199", badge: "Best value" },
];
const EDGE_TIERS = [
  { id: "edge_1mo", label: "1 month · online", price: "$9.99", sub: "one-time · does not renew" },
  { id: "edge_monthly", label: "Monthly", price: "$6.99/mo", sub: "Most flexible" },
  { id: "edge_annual", label: "Annual", price: "$49.99/yr", sub: "$4.17/mo · save 40%", best: true },
];
function renderStore(): void {
  cancelVillainTimer();
  const loggedIn = !!S.mp.auth;
  const playBal = loggedIn ? S.wallet.play : S.profile.chips;
  const claimReady = canClaimWeekly();
  const daysLeft = loggedIn && S.lastWeekly ? Math.max(0, Math.ceil((WEEK_MS - (Date.now() - S.lastWeekly)) / 86_400_000)) : 0;
  const iapOn = IAP.rcConfigured(); // native IAP live? else packs stay "Soon", Edge uses Stripe (web)
  const pack = (pk: { id: string; chips: string; price: string; badge?: string; bonus?: string }, sym: string) => `
    <div class="pack ${pk.badge ? "best" : ""}">${pk.badge ? `<span class="pack-badge">${pk.badge}</span>` : ""}
      <div class="pack-amt">${sym} ${pk.chips}</div>${pk.bonus ? `<div class="pack-bonus">${pk.bonus}</div>` : ""}
      ${iapOn ? `<button class="pack-buy" data-pid="${pk.id}" ${S.net.busy && S.net.busyId !== pk.id ? "disabled" : ""}>${S.net.busy && S.net.busyId === pk.id ? '<span class="spin dark"></span>' : pk.price}</button>`
        : `<button class="pack-buy soon" disabled>${pk.price} · Soon</button>`}
    </div>`;
  app.innerHTML = `
    <div class="setup doc">
      <div class="doc-top"><button class="hdr-btn" id="store-back">← Back</button><h1>🛍 Store</h1><span style="width:54px"></span></div>
      <div class="store-bal">Balance <strong><i class=ic-coin></i> ${fmtBal(playBal)}</strong></div>

      <div class="set-group"><div class="set-head">🎁 Weekly free chips</div>
        ${!loggedIn ? `<div class="set-note">Sign in to claim free play chips every week — the streak grows your reward (500 › 600 › 750 › 1,000).</div>`
          : claimReady ? `<button class="start-btn" id="store-claim" style="background:linear-gradient(135deg,#f7cf72,#b8860b);color:#2a1c05">🎁 Claim <i class=ic-coin></i> ${nextWeeklyAmt().toLocaleString()} · week ${S.weeklyStreak + 1}</button>`
          : `<div class="set-note">Next free chips in <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong> · 🔥 ${S.weeklyStreak}-week streak.</div>`}
      </div>

      <div class="set-group"><div class="set-head">Edge Pass · the Monte Carlo Edge, live</div>
        ${!hasEdge() ? `<div class="edge-banner"><div class="eb-copy"><span class="eb-eyebrow">⚡ Edge Pass</span><span class="eb-title">Read every villain's range — live</span><span class="eb-sub">Equity · pot odds · the line, at your seat</span></div></div>` : ""}
        <div class="set-note" style="margin-bottom:9px">The real-time MCE overlay in online play + hand-history review + leak report. <strong>Solo Train stays 100% free, forever.</strong></div>
        ${hasEdge() ? `<div class="se-active">✓ Edge Pass active${S.isAdmin && !S.edgePass ? " (admin)" : ""}</div>${S.edgePass && !S.isAdmin ? `<button class="hdr-btn" id="edge-manage" style="width:100%;margin-top:8px">Manage subscription</button>` : ""}`
          : `${(iapOn ? EDGE_TIERS : EDGE_TIERS.filter((t) => t.id === "edge_monthly")).map((t) => `<div class="edge-tier ${t.best ? "best" : ""}"><div class="et-main"><div class="et-price">${t.price}</div><div class="et-sub">${t.sub}</div></div><button class="et-buy" data-pid="${t.id}" ${S.net.busy && S.net.busyId !== t.id ? "disabled" : ""}>${S.net.busy && S.net.busyId === t.id ? '<span class="spin dark"></span>' : "Get"}</button></div>`).join("")}
          <span class="hint">7-day free trial · cancel anytime in one tap.</span>`}
      </div>

      <div class="set-group"><div class="set-head"><i class=ic-coin></i> Play chips</div>
        <div class="set-note" style="margin-bottom:9px">Practice currency · refills free every Monday (+streak). AI rooms + learning tables. Buy-in capped at 100bb, so chips never buy an edge.${iapOn ? "" : " <em>Chip packs arrive with the mobile app — Edge Pass is available now.</em>"}</div>
        <div class="pack-grid">${PLAY_PACKS.map((pk) => pack(pk, "<i class=ic-coin></i>")).join("")}</div>
      </div>

      ${iapOn ? `<button class="hdr-btn" id="store-restore" style="width:100%;padding:12px;margin-top:10px" ${S.net.busy && S.net.busyId !== "restore" ? "disabled" : ""}>${S.net.busy && S.net.busyId === "restore" ? '<span class="spin"></span>' : "Restore purchases"}</button>` : ""}
      <button class="hdr-btn" id="store-back2" style="width:100%;padding:12px;margin-top:10px">Back</button>
    </div>`;
  onId("store-back", "click", () => { S.screen = "home"; render(); });
  onId("store-back2", "click", () => { S.screen = "home"; render(); });
  onId("store-restore", "click", () => { void doRestore(); });
  onId("store-claim", "click", () => { _weeklyShown = false; showWeeklyClaim(); });
  onId("edge-manage", "click", () => { void manageEdgePass(); });
  // Edge tiers: native → RevenueCat IAP for the specific tier; web → Stripe Checkout (monthly).
  app.querySelectorAll<HTMLButtonElement>(".et-buy[data-pid]").forEach((b) =>
    b.addEventListener("click", () => { void buyEdge(b.dataset.pid!); }));
  // Chip packs: only rendered as live buttons on native (iapOn); web shows "Soon".
  app.querySelectorAll<HTMLButtonElement>(".pack-buy[data-pid]").forEach((b) =>
    b.addEventListener("click", () => { void buyPack(b.dataset.pid!); }));
}

// Native chip-pack purchase via RevenueCat. The webhook credits chipsPlay; subscribeWallet then
// refreshes the balance reactively — we never touch the wallet client-side.
async function buyPack(pid: string): Promise<void> {
  if (!(await ensureSignedIn())) { S.screen = "signin"; render(); return; }
  if (S.net.busy) return;
  S.net.busy = true; S.net.busyId = pid; render();
  try { await IAP.rcPurchase(pid); }
  catch (e) { S.net.err = friendlyErr(e); }
  S.net.busy = false; S.net.busyId = ""; render();
}

// Restore purchases (native). Re-syncs RevenueCat; an active Edge Pass re-lands via the webhook →
// subscribeWallet. Chip packs are permanent (consumable, not restorable).
async function doRestore(): Promise<void> {
  if (!(await ensureSignedIn())) { S.screen = "signin"; render(); return; }
  if (S.net.busy) return;
  S.net.busy = true; S.net.busyId = "restore"; render();
  try { const any = await IAP.rcRestore(); S.net.err = any ? "" : "No active purchases to restore."; }
  catch (e) { S.net.err = friendlyErr(e); }
  S.net.busy = false; S.net.busyId = ""; render();
}

// Edge Pass purchase. Native → RevenueCat IAP for the tapped tier; web → existing Stripe path.
async function buyEdge(pid: string): Promise<void> {
  if (!IAP.rcConfigured()) { S.net.busyId = pid; void startEdgePass(); return; }
  if (!(await ensureSignedIn())) { S.screen = "signin"; render(); return; }
  if (S.net.busy) return;
  S.net.busy = true; S.net.busyId = pid; render();
  try { await IAP.rcPurchase(pid); }
  catch (e) { S.net.err = friendlyErr(e); }
  S.net.busy = false; S.net.busyId = ""; render();
}

// Edge Pass: redirect to Stripe Checkout (the secret keys live server-side; the
// client only ever receives a redirect URL). Requires sign-in.
const checkoutOrigin = (): string => location.origin + location.pathname;
async function startEdgePass(): Promise<void> {
  if (!(await ensureSignedIn())) { S.screen = "signin"; render(); return; }
  if (S.net.busy) return;
  S.net.busy = true; render();
  try {
    const { url } = await FB.edgePassCheckout(checkoutOrigin());
    if (url) { location.href = url; return; }
    S.net.busy = false; S.net.err = "Checkout unavailable — Stripe not configured yet."; render();
  } catch (e) { S.net.busy = false; S.net.err = friendlyErr(e); render(); }
}
async function manageEdgePass(): Promise<void> {
  try { const { url } = await FB.billingPortal(checkoutOrigin()); if (url) location.href = url; }
  catch (e) { S.net.err = friendlyErr(e); render(); }
}

// Fullscreen welcome-film player — a self-contained overlay (no morphdom state) so it
// survives re-renders. Tap-initiated, so audio is allowed to autoplay.
function openIntroFilm(): void {
  if (document.getElementById("intro-overlay")) return;
  const B = import.meta.env.BASE_URL;
  const ov = document.createElement("div");
  ov.id = "intro-overlay"; ov.className = "intro-overlay";
  ov.innerHTML = `<button class="intro-close" aria-label="Close">✕ Close</button>
    <video class="intro-video" src="${B}textures/welcome.mp4" poster="${B}textures/welcome.jpg" playsinline autoplay controls></video>`;
  document.body.appendChild(ov);
  const v = ov.querySelector("video") as HTMLVideoElement | null;
  v?.play?.().catch(() => { /* user can hit play */ });
  const close = (): void => { try { v?.pause(); } catch { /* */ } ov.remove(); };
  ov.querySelector(".intro-close")?.addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  v?.addEventListener("ended", close);
}

// First-visit gate for the cinematic landing. Once a new user picks any path off the
// landing (train / sign in / enter), it's marked seen and never shown again.
function introSeen(): boolean { try { return localStorage.getItem("mce-intro-seen") === "1"; } catch { return true; } }
function markIntroSeen(): void { try { localStorage.setItem("mce-intro-seen", "1"); } catch { /* */ } }

// New-user landing — a focused, cinematic first screen built around the welcome film.
// Shown once after the age gate; funnels to the free trainer (online play needs sign-in).
function renderLanding(): void {
  const B = import.meta.env.BASE_URL;
  const loggedIn = !!S.mp.auth;
  app.innerHTML = `
    <div class="mc-home lp">
      <div class="mc-bg" aria-hidden="true">
        <span class="mc-glow g-emerald"></span><span class="mc-glow g-gold"></span>
        <span class="mc-suit s1">♠</span><span class="mc-suit s2">♥</span><span class="mc-suit s3">♦</span><span class="mc-suit s4">♣</span>
        <span class="mc-grain"></span>
      </div>
      <div class="lp-wrap">
        <div class="lp-hero">
          <h1 class="mc-wordmark"><span>MONTECARLO</span><b>EDGE</b></h1>
          <p class="lp-sub">The GTO poker trainer that reads the table with you — live equity, pot odds, and the exact line, right in your hand.</p>
        </div>
        <button class="lp-film" id="lp-watch" aria-label="Play the welcome film">
          <img class="lp-poster" src="${B}textures/welcome.jpg" alt="">
          <span class="lp-play"><span class="lp-play-tri">▶</span></span>
          <span class="lp-film-cap">Watch the 30-second film</span>
        </button>
        <div class="lp-vps">
          <div class="lp-vp"><span class="lp-vp-i">${ICON_TARGET}</span><b>Train the math</b><span>Solo vs a validated CFR / Monte-Carlo engine.</span></div>
          <div class="lp-vp"><span class="lp-vp-i">${ICON_BOLT}</span><b>Live GTO reads</b><span>Equity · pot odds · the recommended line, every hand.</span></div>
          <div class="lp-vp"><span class="lp-vp-i">${ICON_GLOBE}</span><b>Play online</b><span>Rooms with friends for play-money chips.</span></div>
        </div>
        <div class="lp-cta">
          <button class="lp-primary" id="lp-train">Start Training — Free <span>→</span></button>
          ${loggedIn ? "" : `<button class="lp-secondary" id="lp-signin">Sign in to play online</button>`}
          <button class="lp-skip" id="lp-skip">Enter the app →</button>
        </div>
        <p class="lp-legal">Play-money only · 18+ · not real-money gambling.</p>
      </div>
    </div>`;
  onId("lp-watch", "click", () => openIntroFilm());
  onId("lp-train", "click", () => { markIntroSeen(); S.screen = "setup"; render(); });
  onId("lp-signin", "click", () => { markIntroSeen(); S.screen = "signin"; render(); });
  onId("lp-skip", "click", () => { markIntroSeen(); S.screen = "home"; render(); });
}

function renderHome(): void {
  cancelVillainTimer();
  bustRescue(); // never broke at the hub
  const p = S.profile;
  const loggedIn = !!S.mp.auth;
  // PREFETCH + WARM the public-rooms function while the user is reading the home screen, so
  // tapping "Play Online" lands on a ready lobby instead of a cold-start "Loading…" wait.
  if (loggedIn && S.net.publicRooms === null && !S.net.publicRoomsBusy) {
    setTimeout(() => { if (S.mp.auth && S.net.publicRooms === null && !S.net.publicRoomsBusy) void netRefreshPublic(); }, 0);
  }
  app.innerHTML = `
    <div class="mc-home">
      <div class="mc-bg" aria-hidden="true">
        <video class="mc-bg-video" autoplay muted loop playsinline preload="auto" poster="${import.meta.env.BASE_URL}textures/hero-bg.webp"><source src="${import.meta.env.BASE_URL}textures/hero-loop.mp4" type="video/mp4"></video>
        <span class="mc-glow g-emerald"></span><span class="mc-glow g-gold"></span>
        <span class="mc-suit s1">♠</span><span class="mc-suit s2">♥</span><span class="mc-suit s3">♦</span><span class="mc-suit s4">♣</span>
        <span class="mc-grain"></span>
      </div>

      <header class="mc-topbar">
        <button class="mc-profile" id="home-profile">
          <span class="mc-ring">${avatarChip(p.avatar, loggedIn ? p.nickname : "?", 36)}</span>
          ${loggedIn ? `<span class="mc-pmeta2"><span class="mc-pname">${esc(S.mp.auth!.name)}</span><span class="mc-bal2"><i class=ic-coin></i> ${fmtBal(S.wallet.play)}${(S.wallet.premium ?? 0) > 0 ? ` · <i class=ic-gem></i> ${fmtBal(S.wallet.premium)}` : ""}</span></span>` : `<span class="mc-pchips-big locked">🔒 Sign in</span>`}
        </button>
        <div class="mc-top-right">
          ${loggedIn ? `<button class="mc-gear" id="home-inbox" aria-label="Inbox">✉️${unreadCount() ? `<span class="ib-badge">${unreadCount()}</span>` : ""}</button>` : ""}
          <button class="mc-gear" id="home-settings" aria-label="Settings">⚙</button>
          ${loggedIn ? `<button class="mc-store" id="home-store">＋ Chips</button>` : `<button class="mc-store" id="home-signin2">Sign in</button>`}
        </div>
      </header>

      <div class="mc-hero">
        <div class="mc-fan" aria-hidden="true">
          <span class="mc-hc back"></span>
          <span class="mc-hc red">A<i>♥</i></span>
          <span class="mc-hc">A<i>♠</i></span>
        </div>
        <h1 class="mc-wordmark"><span>MONTECARLO</span><b>EDGE</b></h1>
        <p class="mc-tag">Play the player. Own the table.</p>
        <button class="mc-watch" id="home-watch">▶ Watch the film</button>
      </div>

      ${loggedIn ? "" : `<button class="mc-login-banner" id="home-signin-banner">🔒 <strong>Not logged in</strong> — sign in to save your chips &amp; play online. <span>Train is free →</span></button>`}
      ${S.isAdmin && _viewAsPlayer ? `<button class="mc-login-banner preview" id="home-exit-preview">👁 <strong>Player preview</strong> — you're seeing the app as a normal player. <span>Exit →</span></button>` : ""}

      <button class="mce-card" id="home-mce">
        <span class="mce-shimmer" aria-hidden="true"></span>
        <span class="mce-icon">${ICON_BOLT}</span>
        <span class="mce-body">
          <span class="mce-eyebrow">What is MCE Strategy?</span>
          <span class="mce-title">Your edge at every table</span>
          <span class="mce-sub">A live, in-hand GTO read on your villain's range — equity, pot odds, recommended line. Learn how it gives you the edge.</span>
        </span>
        <span class="mce-cta">Learn →</span>
      </button>

      <div class="mc-modes">
        <button class="mc-mode train" id="home-train" style="--d:.05s"><span class="mc-mi">${ICON_TARGET}</span><span class="mc-mtext"><span class="mc-mt">Train</span><span class="mc-md">Solo vs the MCE Engine · free</span></span><span class="mc-arrow">→</span></button>
        <button class="mc-mode online ${loggedIn ? "" : "locked"}" id="home-pass" style="--d:.12s"><span class="mc-mi">${ICON_GLOBE}</span><span class="mc-mtext"><span class="mc-mt">Play Online</span><span class="mc-md">${loggedIn ? "Create a room · play for chips" : "Sign in to play"}</span></span><span class="mc-arrow">${loggedIn ? "→" : "🔒"}</span></button>
        <button class="mc-mode pass ${loggedIn ? "" : "locked"}" id="home-store-tile" style="--d:.19s"><span class="mc-mi">${ICON_BAG}</span><span class="mc-mtext"><span class="mc-mt">Store</span><span class="mc-md">${loggedIn ? "Chips · cosmetics · Edge Pass" : "Sign in to shop"}</span></span><span class="mc-arrow">${loggedIn ? "→" : "🔒"}</span></button>
        <button class="mc-mode profile" id="home-profile2" style="--d:.26s"><span class="mc-mi">${ICON_USER}</span><span class="mc-mtext"><span class="mc-mt">Profile</span><span class="mc-md">Avatar · name · chips</span></span><span class="mc-arrow">→</span></button>
      </div>

      <button class="mc-stats" id="home-stats" style="--d:.33s">${ICON_CHART} Stats &amp; Leak Report</button>
      <div class="mc-foot">
        <button class="mc-foot-link" id="home-proof">The Proof</button><span>·</span>
        <button class="mc-foot-link" id="home-explainer">How it works</button><span>·</span>
        <button class="mc-foot-link" id="home-legal">Terms</button><span>·</span>
        <button class="mc-foot-link" id="home-settings2">Settings</button>
        ${effectiveAdmin() ? `<span>·</span><button class="mc-foot-link" id="home-admin" style="color:var(--gold-2)">🛡 Admin</button>` : ""}
      </div>
    </div>`;
  onId("home-inbox", "click", () => { S.screen = "inbox"; render(); });
  onId("home-exit-preview", "click", () => setViewAsPlayer(false));
  onId("home-admin", "click", () => { S.compose = { toUid: "", toName: "", text: "", giftAmt: 0, busy: false, err: "", sent: "" }; S.screen = "admin"; render(); });
  onId("home-settings", "click", () => { S.screen = "settings"; render(); });
  onId("home-settings2", "click", () => { S.screen = "settings"; render(); });
  onId("home-proof", "click", () => { try { window.open("/proof.html", "_blank", "noopener"); } catch { location.assign("/proof.html"); } });
  onId("home-explainer", "click", () => { _docReturn = "home"; S.screen = "explainer"; render(); });
  onId("home-mce", "click", () => { _docReturn = "home"; S.screen = "explainer"; render(); });
  onId("home-watch", "click", () => openIntroFilm());
  onId("home-legal", "click", () => { _docReturn = "home"; S.screen = "legal"; render(); });
  onId("home-profile", "click", () => { S.screen = loggedIn ? "profile" : "signin"; render(); });
  onId("home-profile2", "click", () => { S.screen = "profile"; render(); });
  onId("home-signin2", "click", () => { S.screen = "signin"; render(); });
  onId("home-signin-banner", "click", () => { S.screen = "signin"; render(); });
  onId("home-store", "click", () => { S.screen = "store"; render(); });
  onId("home-store-tile", "click", () => { S.screen = loggedIn ? "store" : "signin"; render(); });
  onId("home-train", "click", () => { S.screen = "setup"; render(); });
  onId("home-pass", "click", () => {
    if (!loggedIn) { S.screen = "signin"; render(); return; }
    if (S.mp.setup.players[0]) S.mp.setup.players[0]!.name = S.profile.nickname;
    S.screen = "mp-setup"; render();
  });
  onId("home-stats", "click", () => { S.screen = "stats"; render(); });
  // iOS WebKit won't autoplay a muted inline <video> inserted via innerHTML on the strength
  // of the `autoplay` attribute alone (esp. in a standalone PWA) — nudge it: set muted as a
  // PROPERTY + call play(); retry once on the first tap if it was blocked. (Low Power Mode
  // blocks autoplay entirely → the poster image shows, which is the intended fallback.)
  const bgv = app.querySelector(".mc-bg-video") as HTMLVideoElement | null;
  if (bgv) {
    bgv.muted = true; bgv.playsInline = true;
    const tryPlay = (): void => { void bgv.play().catch(() => { /* blocked → poster shows */ }); };
    tryPlay();
    const once = (): void => { tryPlay(); document.removeEventListener("touchend", once); document.removeEventListener("click", once); };
    document.addEventListener("touchend", once, { once: true, passive: true });
    document.addEventListener("click", once, { once: true });
  }
  maybeShowWeekly(); // Monday dopamine pop, if a free claim is waiting
}

let _histExpanded: string | null = null;
function renderHistory(): void {
  cancelVillainTimer();
  const hands = Hist.loadHistory();
  const totalNet = hands.reduce((a, h) => a + h.myNet, 0);
  const wins = hands.filter((h) => h.myNet > 0).length;
  const showdowns = hands.filter((h) => h.board.length >= 5).length;
  const cardHTML = (c: number) => `<span class="hh-card ${isRed(c) ? "red" : ""}">${cardDisplay(c)}</span>`;
  app.innerHTML = `
    <div class="setup">
      <div class="doc-top"><button class="hdr-btn" id="hh-back">← Back</button><h1>📜 Hand history</h1><span style="width:54px"></span></div>
      ${hands.length === 0
        ? `<div class="hint" style="text-align:center;margin:36px 0">No hands recorded yet. Play a few and they'll show up here automatically.</div>`
        : `<div class="hh-summary">
            <div class="hh-stat"><span class="hh-stat-num ${totalNet >= 0 ? "g-ok" : "g-bad"}">${totalNet >= 0 ? "+" : ""}${mpc(totalNet)}</span><span class="hh-stat-lbl">net chips</span></div>
            <div class="hh-stat"><span class="hh-stat-num">${wins}/${hands.length}</span><span class="hh-stat-lbl">won</span></div>
            <div class="hh-stat"><span class="hh-stat-num">${showdowns}</span><span class="hh-stat-lbl">showdowns</span></div>
          </div>
          <div class="hh-list">${hands.map((h) => {
            const isOpen = _histExpanded === h.id;
            const myCards = h.myCards ? `${cardHTML(h.myCards[0])}${cardHTML(h.myCards[1])}` : `<span class="hint">— folded preflop —</span>`;
            const boardHtml = h.board.length ? h.board.map(cardHTML).join("") : `<span class="hint">preflop only</span>`;
            const ago = relTime(Date.now() - h.ts);
            return `<div class="hh-row${isOpen ? " open" : ""}" data-id="${esc(h.id)}">
              <button class="hh-head" data-toggle="${esc(h.id)}">
                <span class="hh-cards-line">${myCards}</span>
                <span class="hh-pos">${esc(h.position)}</span>
                <span class="hh-stakes">${h.currency === "premium" ? "<i class=ic-gem></i>" : "<i class=ic-coin></i>"} ${h.blinds.sb}/${h.blinds.bb}</span>
                <span class="hh-net ${h.myNet > 0 ? "g-ok" : h.myNet < 0 ? "g-bad" : ""}">${h.myNet > 0 ? "+" : ""}${mpc(h.myNet)}</span>
                <span class="hh-ago">${ago}</span>
              </button>
              ${isOpen ? `<div class="hh-detail">
                <div class="hh-board"><span class="hh-lbl">Board</span><span class="hh-cards">${boardHtml}</span></div>
                <div class="hh-result">${esc(h.result || "—")}</div>
                <div class="hh-actions-log">
                  ${h.actions.length === 0 ? `<span class="hint">no per-action log captured</span>` : h.actions.map((a) => `<span class="hh-act ${a.type}">${esc(a.street)}: seat ${a.bySeat} ${esc(a.type)}${a.amount > 0 ? ` ${mpc(a.amount)}` : ""}</span>`).join("")}
                </div>
              </div>` : ""}
            </div>`;
          }).join("")}</div>
          <button class="hdr-btn" id="hh-clear" style="width:100%;margin-top:14px;color:var(--red)">Clear history</button>`}
    </div>`;
  onId("hh-back", "click", () => { S.screen = "profile"; render(); });
  onId("hh-clear", "click", () => { if (confirm("Delete all locally-saved hand history?")) { Hist.clearHistory(); _histExpanded = null; render(); } });
  app.querySelectorAll("[data-toggle]").forEach((b) => onEl(b, "click", () => { const id = (b as HTMLElement).dataset.toggle!; _histExpanded = _histExpanded === id ? null : id; render(); }));
}

function relTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

function renderProfile(): void {
  cancelVillainTimer();
  const p = S.profile;
  const loggedIn = !!S.mp.auth;
  app.innerHTML = `
    <div class="setup">
      <div class="doc-top"><button class="hdr-btn" id="pf-back">← Back</button><h1>👤 Profile</h1><span style="width:54px"></span></div>
      <div style="text-align:center;margin-bottom:10px">${avatarChip(p.avatar, p.nickname, 76)}</div>
      <div class="field"><label>Nickname (shown at the tables)</label><input class="mp-num" id="pf-nick" maxlength="14" value="${esc(p.nickname)}"/></div>
      <div class="field"><label>Avatar</label>
        <div class="avatar-grid">
          <button class="avatar-pick ${!p.avatar ? "sel" : ""}" id="pf-av-auto" title="Auto identicon">${avatarChip("", p.nickname, 38)}</button>
          ${PRESET_AVATARS.map((a) => `<button class="avatar-pick ${p.avatar === a ? "sel" : ""}" data-av="${a}">${a}</button>`).join("")}
        </div>
      </div>
      <div class="mp-scoreboard">
        <div class="mp-score-row"><span><i class=ic-coin></i> Play chips</span><span class="g-ok">${fmtBal(loggedIn ? S.wallet.play : p.chips)}</span></div>
        ${loggedIn ? `<div class="mp-score-row"><span><i class=ic-gem></i> Premium chips</span><span class="g-ok">${fmtBal(S.wallet.premium)}</span></div>` : ""}
        <span class="hint" style="display:block;margin-top:6px">${loggedIn ? "Free play chips every week — claim on Home / in the Store. Win <i class=ic-gem></i> at premium tables." : "Sign in (Play Online) to save your chips to your account + play online."}</span>
      </div>
      ${loggedIn ? `<button class="hdr-btn" id="pf-store" style="width:100%;padding:12px;margin-top:10px">🛍 Store · buy chips</button>` : ""}
      <button class="hdr-btn" id="pf-history" style="width:100%;padding:12px;margin-top:6px">📜 Hand history</button>
      <div class="hint" style="text-align:center;margin-top:10px">${loggedIn ? `✓ Signed in as ${esc(S.mp.auth!.name)}` : "Not signed in"}</div>
      ${loggedIn
        ? `<button class="hdr-btn" id="pf-signout" style="width:100%;padding:12px;margin-top:6px;color:var(--red)">Sign out</button>`
        : `<button class="si-btn primary" id="pf-signin" style="margin-top:6px">Sign in / Register</button>`}
      <button class="hdr-btn" id="pf-back2" style="width:100%;padding:12px;margin-top:6px">Back to Home</button>
    </div>`;
  onId("pf-nick", "change", (e) => { S.profile.nickname = (e.target as HTMLInputElement).value.trim() || "Player"; saveProfile(); render(); });
  onId("pf-av-auto", "click", () => { S.profile.avatar = ""; saveProfile(); render(); });
  app.querySelectorAll("[data-av]").forEach((b) => onEl(b, "click", () => { S.profile.avatar = (b as HTMLElement).dataset.av!; saveProfile(); render(); }));
  onId("pf-store", "click", () => { S.screen = "store"; render(); });
  onId("pf-history", "click", () => { S.screen = "history"; render(); });
  onId("pf-signin", "click", () => { S.screen = "signin"; render(); });
  onId("pf-signout", "click", () => { if (confirm("Sign out of your account?")) void goOffline().then(() => { S.screen = "home"; render(); }); });
  onId("pf-back", "click", () => { S.screen = "home"; render(); });
  onId("pf-back2", "click", () => { S.screen = "home"; render(); });
}

/* ═══════════════════ SETTINGS / LEGAL / EXPLAINER ═══════════════════ */

let _docReturn: "home" | "settings" = "home";

const motionPref = (): "auto" | "on" | "off" => {
  const v = localStorage.getItem("mce-motion");
  return v === "on" || v === "off" ? v : "auto";
};

function docPage(title: string, intro: string, sections: Section[], extra = "", media = ""): void {
  const body = `<p class="doc-intro">${intro}</p>` + sections.map((s) =>
    `<section class="doc-section"><h2>${s.heading}</h2><div class="doc-body">${s.body}</div></section>`).join("");
  app.innerHTML = `<div class="setup doc"><h1>${title}</h1>${media}${body}${extra}
    <button class="hdr-btn" id="doc-back" style="width:100%;padding:12px;margin-top:10px">Back</button></div>`;
  onId("doc-back", "click", () => { S.screen = _docReturn; render(); });
}

function renderLegal(): void { cancelVillainTimer(); docPage("Terms &amp; Legal", LEGAL_INTRO, LEGAL_SECTIONS); }
function renderExplainer(): void {
  cancelVillainTimer();
  const B = import.meta.env.BASE_URL;
  const media = `<figure class="howto-video">
      <video class="howto-vid" autoplay muted loop playsinline preload="metadata" poster="${B}textures/howto-mce.webp"><source src="${B}textures/howto-mce.mp4" type="video/mp4"></video>
      <figcaption class="howto-cap"><span class="howto-eyebrow">How it works</span><span class="howto-title">Watch the Edge read the table</span></figcaption>
    </figure>`;
  docPage("How it works", EXPLAINER_INTRO, EXPLAINER_SECTIONS,
    `<button class="start-btn" id="doc-train" style="margin-top:10px">${ICON_TARGET} Start Training</button>`, media);
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
            + (_passkeyOk ? row("Face ID sign-in", `<button class="hdr-btn" id="set-passkey">${passkeyEnrolled() ? "Re-enroll" : "Set up"}</button>`, _passkeyMsg || "One Face ID tap restores online play — even after iOS signs you out. Uses your device passkey.") : "")
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
  onId("set-reset-wallet", "click", () => { if (confirm("Reset your play-money chip balance to the 1,000 starting stack and your daily-claim timer? Chips have no cash value and are never cashable — this is a local reset, not a refund.")) { S.profile.chips = 1000; saveProfile(); try { localStorage.removeItem("mce-dailychips"); } catch { /* */ } render(); } });
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
  onId("set-passkey", "click", () => void doPasskeyRegister());
  ensurePasskeyProbe();
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
    const code = (e as { code?: string })?.code ?? "";
    // Map the common Firebase setup errors to a clear, actionable message —
    // "The requested action is invalid" almost always = the Google provider isn't
    // enabled, or this domain isn't authorized, in the Firebase console.
    if (code === "auth/operation-not-allowed" || /requested action is invalid|invalid/i.test((e as Error)?.message ?? "")) {
      S.mp.authErr = "Google sign-in isn't switched on yet. In the Firebase console: Authentication → Sign-in method → enable Google, and add xynkro.github.io under Authorized domains.";
    } else if (code === "auth/unauthorized-domain") {
      S.mp.authErr = "This domain isn't authorized. Add xynkro.github.io in Firebase → Authentication → Settings → Authorized domains.";
    } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      S.mp.authErr = "Sign-in was cancelled.";
    } else if (code === "auth/popup-blocked") {
      S.mp.authErr = "Your browser blocked the sign-in popup — allow popups for this site and retry.";
    } else {
      S.mp.authErr = (e as Error)?.message ?? "Sign-in failed";
    }
  } finally {
    S.mp.authBusy = false;
    render();
  }
}

async function goOffline(): Promise<void> {
  if (_onlineUnsub) { _onlineUnsub(); _onlineUnsub = null; }
  await FB.signOutUser().catch(() => {});
  void IAP.rcLogout();
  stopEconomySubs();
  S.mp.auth = null; S.net.serverChips = null;
  try { localStorage.removeItem("mce-signed-in"); } catch { /* */ }
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

// Register the service worker for offline / installable PWA — WEB ONLY. In the native
// (Capacitor) shell the assets are already bundled locally and refreshed via app updates, so
// a SW on top only risks serving a stale build after an update. Skip it on native.
const _isNativeShell = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
if ("serviceWorker" in navigator && !_isNativeShell) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

loadProfile();
loadPlayerStats();
// New visitors (never seen the intro, no prior/active sign-in) get the cinematic landing
// after the age gate; returning & signed-in users go straight to home.
try {
  const seen = localStorage.getItem("mce-intro-seen") === "1";
  const known = localStorage.getItem("mce-signed-in") === "1" || localStorage.getItem("mce-auth-pending") != null;
  const everUsed = localStorage.getItem("mce-age-ok") === "1"; // already past the age gate before → returning visitor
  if (!seen && !known && !everUsed) S.screen = "landing";
} catch { /* */ }
render();
initCardTilt();
// Native (Capacitor) shell: status bar + hide launch splash. The native bridge injects
// window.Capacitor before our bundle runs, so we gate on it — the web build never even fetches
// the native chunk (zero web cost), and on native it lazy-loads the plugins.
if ((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
  void import("../native.js").then((m) => m.initNative()).catch(() => {});
  // Safety net: if the native chunk fails to import (or initNative throws), never leave the launch
  // splash stuck up. Hide it unconditionally after a few seconds via an independent dynamic import.
  setTimeout(() => { void import("@capacitor/splash-screen").then((m) => m.SplashScreen.hide()).catch(() => {}); }, 4000);
}

// Finalize OAuth redirects + restore a previous sign-in. Only loads Firebase if the
// user has signed in (or just initiated a redirect) — stays lazy for fresh visitors.
async function initAuth(): Promise<void> {
  let pending = false, hadFlag = false;
  try { pending = localStorage.getItem("mce-auth-pending") != null; hadFlag = localStorage.getItem("mce-signed-in") === "1"; } catch { /* */ }
  if (!pending && !hadFlag) return;
  // 1) Complete any redirect sign-in just returned from Google/Apple.
  try {
    const r = await FB.consumeRedirect();
    try { localStorage.removeItem("mce-auth-pending"); } catch { /* */ }
    if (r && "user" in r) {
      S.mp.auth = r.user;
      try { localStorage.setItem("mce-signed-in", "1"); } catch { /* */ }
      void FB.startPresence(r.user).catch(() => {});
      void startEconomySubs(r.user.uid);
      S.net.busy = false;
      S.screen = r.isNew && !onboarded() ? "onboard" : "home";
      render();
    } else if (r && "error" in r) {
      S.net.busy = false; try { localStorage.removeItem("mce-signed-in"); } catch { /* */ }
      S.net.err = friendlyErr(r.error); S.screen = "signin"; render();
    }
  } catch { /* */ }
  // 2) Keep auth state live for returning sessions / sign-out elsewhere.
  void FB.onAuthChanged((u) => {
    if (u && !S.mp.auth) { S.mp.auth = u; if (!S.profile.nickname || S.profile.nickname === "You") { S.profile.nickname = u.name; saveProfile(); } void FB.startPresence(u).catch(() => {}); void startEconomySubs(u.uid); if (S.screen === "home" || S.screen === "signin") render(); }
    else if (!u && S.mp.auth) { S.mp.auth = null; void IAP.rcLogout(); stopEconomySubs(); try { localStorage.removeItem("mce-signed-in"); } catch { /* */ } if (S.screen === "home") render(); }
  });
}
void initAuth();

// ── DEV harness (emulator/localhost ONLY — inert in production) ──────────────
// Exposes window.__MCE_DEV so the validation harness can sign in as test users and
// drive/inspect the live app state without Google OAuth. Gated on FB.DEV_EMU, which is
// false off localhost, so this object never exists in the deployed app.
if (FB.DEV_EMU) {
  (window as unknown as { __MCE_DEV: unknown }).__MCE_DEV = {
    get S() { return S; },
    render,
    async signIn(label = "caspar") {
      const u = await FB.devSignIn(label);
      S.mp.auth = u; S.profile.nickname = label; saveProfile();
      try { localStorage.setItem("mce-signed-in", "1"); } catch { /* */ }
      void FB.startPresence(u).catch(() => {});
      void startEconomySubs(u.uid);
      S.screen = "home"; render();
      return u.uid;
    },
    go(screen: string) { S.screen = screen; render(); },
    previewCard(amount = 320) { // dev-only: render the share-win card to screenshot it
      const cv = buildWinCanvas({ amount, sym: "<i class=ic-coin></i>", cards: [{ t: "A♥", red: true }, { t: "K♥", red: true }], tag: "Top set" });
      cv.id = "_cardprev";
      cv.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:380px;height:380px;z-index:99999;border-radius:18px;box-shadow:0 0 0 9999px rgba(0,0,0,.7)";
      document.getElementById("_cardprev")?.remove();
      document.body.appendChild(cv);
    },
    claimWeekly: () => FB.claimWeekly(),
    passkeySupported: () => FB.passkeySupported(),
    passkeyRegister: () => FB.passkeyRegister("caspar"),
    passkeySignIn: () => FB.passkeySignIn(),
    mp: FB,        // raw MP adapter (createRoom/addBot/dealHand/actRoom/joinRoom…) for the test harness
    enterRoom,     // subscribe to a room so S.net.pub tracks the authoritative snapshot
  };
  // eslint-disable-next-line no-console
  console.log("%c🔧 __MCE_DEV ready — call __MCE_DEV.signIn('caspar')", "color:#1f9d6b;font-weight:bold");
}

// Returning from Stripe Checkout: clear the query param + re-pull entitlement (the
// webhook may land a beat after the redirect, so poll a couple of times).
try {
  const ep = new URLSearchParams(location.search).get("edgepass");
  if (ep) {
    history.replaceState(null, "", location.pathname);
    if (ep === "success") {
      S.screen = "store";
      setTimeout(() => void refreshEntitlement(), 1500);
      setTimeout(() => void refreshEntitlement(), 5000);
    }
  }
} catch { /* */ }

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

// ── iOS-style edge-swipe back gesture ─────────────────────────────────────────
// Active on menu / non-game screens (home, settings, store, profile, mp-setup, lobby, etc.).
// BLOCKED at the game table (training, online, live-in-person) so you can't accidentally swipe
// out mid-hand. Also blocked at root screens (home/landing/signin) and while a modal is open.
const BACK_BLOCKED_SCREENS = new Set(["game", "mp-net", "mp-table", "home", "landing", "signin", "onboard"]);
// Try the standard back-button ids in order; whichever exists on this screen, click it.
// Falls back to S.screen → "home" if no back button is found.
function _navigateBackForSwipe(): boolean {
  const ids = ["mp-back", "doc-back", "store-back", "pf-back", "hh-back", "ib-back", "co-back", "ad-back", "si-back", "set-back", "lobby-back", "mp-home", "home-btn"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { (el as HTMLElement).click(); return true; }
  }
  // Fallback for screens whose Back button is inside a modal/sub-route.
  S.screen = "home"; render();
  return true;
}
function initSwipeBack(): void {
  if (typeof window === "undefined") return;
  const app = document.getElementById("app");
  if (!app) return;
  const EDGE_PX = 28;       // start zone: left edge
  const COMMIT_PX = 90;     // pull distance to commit the back
  const MAX_X = () => window.innerWidth;
  let active = false, startX = 0, startY = 0, dx = 0, peekFrame = 0;
  const reset = (animate: boolean): void => {
    if (animate) {
      app.style.transition = "transform .18s cubic-bezier(.2,.8,.3,1), opacity .18s";
      app.style.transform = ""; app.style.opacity = "";
      setTimeout(() => { app.style.transition = ""; }, 200);
    } else {
      app.style.transition = ""; app.style.transform = ""; app.style.opacity = "";
    }
    active = false; dx = 0;
  };
  document.addEventListener("touchstart", (e) => {
    if (BACK_BLOCKED_SCREENS.has(S.screen)) return;
    if (document.querySelector(".modal-backdrop")) return; // a modal owns the gesture space
    const t = e.touches[0]; if (!t) return;
    if (t.clientX > EDGE_PX) return;
    active = true; startX = t.clientX; startY = t.clientY; dx = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!active) return;
    const t = e.touches[0]; if (!t) return;
    const ddx = t.clientX - startX; const ddy = Math.abs(t.clientY - startY);
    // Vertical-dominant motion → cancel (scroll wins).
    if (ddy > Math.abs(ddx) * 0.8 && ddy > 12) { reset(true); return; }
    dx = Math.max(0, ddx);
    if (peekFrame) cancelAnimationFrame(peekFrame);
    peekFrame = requestAnimationFrame(() => {
      // Live peek: drag the screen with the finger, slight opacity fade as it pulls.
      const f = Math.min(1, dx / MAX_X());
      app.style.transform = `translateX(${dx.toFixed(1)}px)`;
      app.style.opacity = String(1 - f * 0.25);
    });
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (!active) return;
    if (peekFrame) { cancelAnimationFrame(peekFrame); peekFrame = 0; }
    if (dx >= COMMIT_PX) {
      // Complete the swipe: finish the slide-out, then navigate back. The new screen
      // renders with the .screen-in animation (defined in styles.css) for the iOS feel.
      app.style.transition = "transform .22s cubic-bezier(.2,.8,.3,1), opacity .22s";
      app.style.transform = `translateX(${MAX_X()}px)`; app.style.opacity = "0";
      setTimeout(() => {
        app.style.transition = ""; app.style.transform = ""; app.style.opacity = "";
        active = false; dx = 0;
        _navigateBackForSwipe();
      }, 200);
    } else {
      reset(true);
    }
  }, { passive: true });
  document.addEventListener("touchcancel", () => { if (active) reset(true); }, { passive: true });
}
// Defer to next tick so #app is mounted.
setTimeout(initSwipeBack, 0);
