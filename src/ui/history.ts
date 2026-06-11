// Client-side hand history — captures the user's view of each completed hand into
// localStorage (last 50). No server round-trip; works for training + online uniformly.
// Action log is accumulated during the hand via pushAction(), flushed on recordHand().

export interface HandAction { street: string; type: string; amount: number; bySeat: number }
export interface HandRecord {
  id: string;
  ts: number;
  mode: "training" | "online";
  roomCode?: string;
  blinds: { sb: number; bb: number };
  currency: "play" | "premium";
  mySeat: number;
  position: string;            // "BTN" | "SB" | "BB" | "UTG" | …
  myCards: [number, number] | null;
  board: number[];
  actions: HandAction[];        // every action seen in the hand
  villainShown?: Array<{ seat: number; cards: [number, number] }>;
  myNet: number;                // chips +/- this hand
  finalStack: number;
  result: string;               // "Hero wins by fold" / showdown line / etc.
}

const KEY = "mce-hand-history";
const MAX = 50;

let _buffer: HandAction[] = [];
let _currentHandId: string | null = null;

export function startHandTracking(handId: string): void { _currentHandId = handId; _buffer = []; }
export function pushAction(a: HandAction): void { _buffer.push(a); }
export function getActionsForCurrent(): HandAction[] { return _buffer.slice(); }
export function clearTracking(): void { _currentHandId = null; _buffer = []; }
export function currentHandId(): string | null { return _currentHandId; }

export function recordHand(rec: Omit<HandRecord, "actions"> & { actions?: HandAction[] }): void {
  const full: HandRecord = { ...rec, actions: rec.actions ?? _buffer.slice() };
  const all = loadHistory();
  // Dedupe by id — re-renders can fire the capture twice on the same hand_over snapshot.
  if (all.some((h) => h.id === full.id && h.mode === full.mode)) return;
  all.unshift(full);
  if (all.length > MAX) all.length = MAX;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota — drop the oldest half */
    try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX / 2))); } catch { /* give up */ }
  }
  _buffer = [];
}

export function loadHistory(): HandRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HandRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function clearHistory(): void { try { localStorage.removeItem(KEY); } catch { /* */ } }
