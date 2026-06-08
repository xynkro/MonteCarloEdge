import { type Card } from "./cards.js";

export type Street = "preflop" | "flop" | "turn" | "river";
export type ActionType = "fold" | "check" | "call" | "bet" | "raise";

export interface Action {
  seat: number;
  type: ActionType;
  amount: number;
  street: Street;
}

export interface ActionInput {
  seat: number;
  type: ActionType;
  amount: number;
}

export interface GameConfig {
  tableSize: number;
  bb: number;
  sb?: number;
  stacks: number[];
  positions: string[];
  heroSeat: number;
  heroCards: readonly [Card, Card];
  dealerSeat: number;
}

export class GameState {
  readonly tableSize: number;
  readonly bb: number;
  readonly sb: number;
  readonly heroSeat: number;
  readonly heroCards: readonly [Card, Card];
  readonly dealerSeat: number;
  readonly positions: readonly string[];

  street: Street = "preflop";
  board: Card[] = [];
  pot = 0;
  stacks: number[];
  folded: boolean[];
  invested: number[];
  streetInvested: number[];
  currentBet = 0;
  actions: Action[] = [];

  // Opponent-modeling annotation (NOT core game rules): the bluff "story" each
  // villain has committed to THIS hand, so a multi-street bluff barrels one
  // board-credible hand coherently instead of re-rolling each street. Written by
  // the opponent model (opponent.ts). Per-hand by construction — every hand is a
  // fresh GameState, so it never needs resetting. Keyed by seat.
  villainStories: Map<number, {
    rep: "flush" | "straight" | "trips_plus" | "pair_plus";
    suit: number;        // for a flush story; -1 otherwise
    hiRank: number;      // top rank of the represented hand
    coherence: number;   // 0..1 — how credibly/consistently this type bluffs
    openedStreet: Street;
    label: string;       // plain-English rep, e.g. "the flush", "a set"
  }> = new Map();

  private _needsAct: Set<number>;
  private _lastActor = -1;
  // Min-raise / reopening tracking. `_lastRaiseSize` is the increment of the
  // last *full* bet/raise; `_raiseReopened` is whether a facing player may
  // re-raise at the current bet level (a short all-in does not reopen it);
  // `_actedThisStreet` is who has voluntarily acted this street (a not-yet-acted
  // player keeps full raise rights even after a short all-in).
  private _lastRaiseSize = 0;
  private _raiseReopened = true;
  private _actedThisStreet = new Set<number>();

  constructor(config: GameConfig) {
    this.tableSize = config.tableSize;
    this.bb = config.bb;
    this.sb = config.sb ?? config.bb / 2;
    this.heroSeat = config.heroSeat;
    this.heroCards = config.heroCards;
    this.dealerSeat = config.dealerSeat;
    this.positions = config.positions;

    const n = config.stacks.length;
    this.stacks = [...config.stacks];
    this.folded = new Array(n).fill(false);
    this.invested = new Array(n).fill(0);
    this.streetInvested = new Array(n).fill(0);
    this._needsAct = new Set();

    this._postBlinds();
  }

  private _postBlinds(): void {
    const n = this.stacks.length;
    let sbSeat: number, bbSeat: number;
    if (n === 2) {
      sbSeat = this.dealerSeat;
      bbSeat = (this.dealerSeat + 1) % n;
    } else {
      sbSeat = (this.dealerSeat + 1) % n;
      bbSeat = (this.dealerSeat + 2) % n;
    }
    this._invest(sbSeat, this.sb);
    this._invest(bbSeat, this.bb);
    this.currentBet = this.bb;
    this._lastRaiseSize = this.bb; // the BB is the standing raise increment preflop
    this._raiseReopened = true;
    // Only seats that can still act enter the queue — a blind posted all-in for
    // less than the blind has a 0 stack and must NOT be left "to act" (that
    // would deadlock the round, since it has no legal action).
    for (let i = 0; i < n; i++) if (this.stacks[i]! > 0) this._needsAct.add(i);
  }

  private _invest(seat: number, amount: number): void {
    const amt = Math.min(amount, this.stacks[seat]!);
    this.stacks[seat]! -= amt;
    this.invested[seat]! += amt;
    this.streetInvested[seat]! += amt;
    this.pot += amt;
  }

  get activeSeatCount(): number {
    let c = 0;
    for (const f of this.folded) if (!f) c++;
    return c;
  }

  isComplete(): boolean {
    if (this.activeSeatCount <= 1) return true;
    if (this.street === "river" && this._needsAct.size === 0) return true;
    return false;
  }

  roundComplete(): boolean {
    return this._needsAct.size === 0;
  }

  toCall(seat: number): number {
    return Math.max(0, Math.min(this.currentBet - this.streetInvested[seat]!, this.stacks[seat]!));
  }

  potAfterCall(seat: number): number {
    return this.pot + this.toCall(seat);
  }

  potOdds(seat: number): number {
    const tc = this.toCall(seat);
    return tc <= 0 ? 0 : tc / (this.pot + tc);
  }

  effectiveStack(): number {
    let min = Infinity;
    for (let i = 0; i < this.stacks.length; i++) {
      if (!this.folded[i]) min = Math.min(min, this.stacks[i]! + this.streetInvested[i]!);
    }
    return min;
  }

  spr(): number {
    return this.pot > 0 ? this.effectiveStack() / this.pot : Infinity;
  }

  // The active player who acts last postflop (closest to the button) is "in position".
  lastActivePostflop(): number {
    const n = this.stacks.length;
    let last = -1;
    for (let i = 1; i <= n; i++) {
      const seat = (this.dealerSeat + i) % n;
      if (!this.folded[seat]) last = seat;
    }
    return last;
  }

  isInPosition(seat: number): boolean {
    return seat === this.lastActivePostflop();
  }

  streetsRemaining(): number {
    const m: Record<Street, number> = { preflop: 3, flop: 2, turn: 1, river: 0 };
    return m[this.street];
  }

  legalActionsFor(seat: number): ActionType[] {
    if (this.folded[seat] || this.stacks[seat]! <= 0 || !this._needsAct.has(seat))
      return [];
    const tc = this.toCall(seat);
    if (tc > 0) {
      const a: ActionType[] = ["fold", "call"];
      // Raising is allowed only if the action was reopened by a full raise, or
      // this seat hasn't yet acted this street (a short all-in doesn't let an
      // already-acted player re-raise — they may only call or fold).
      const mayReraise = this._raiseReopened || !this._actedThisStreet.has(seat);
      if (this.stacks[seat]! > tc && mayReraise) a.push("raise");
      return a;
    }
    const a: ActionType[] = ["check"];
    if (this.stacks[seat]! > 0) a.push("bet");
    return a;
  }

  nextToAct(): number | null {
    if (this._needsAct.size === 0) return null;
    const n = this.stacks.length;
    const start =
      this._lastActor >= 0 ? (this._lastActor + 1) % n : this._roundStart();
    for (let i = 0; i < n; i++) {
      const seat = (start + i) % n;
      // Defensive: never return a seat that can't actually act.
      if (this._needsAct.has(seat) && !this.folded[seat] && this.stacks[seat]! > 0)
        return seat;
    }
    return null;
  }

  private _roundStart(): number {
    const n = this.stacks.length;
    if (this.street === "preflop") {
      return n === 2 ? this.dealerSeat : (this.dealerSeat + 3) % n;
    }
    return (this.dealerSeat + 1) % n;
  }

  applyAction(input: ActionInput): void {
    const { seat, type } = input;
    this._needsAct.delete(seat);
    this._lastActor = seat;
    this._actedThisStreet.add(seat);

    switch (type) {
      case "fold":
        this.folded[seat] = true;
        break;
      case "check":
        break;
      case "call":
        this._invest(seat, this.toCall(seat));
        break;
      case "bet":
      case "raise": {
        const prevBet = this.currentBet;
        const additional = input.amount - this.streetInvested[seat]!;
        if (additional > 0) this._invest(seat, additional);
        const newBet = this.streetInvested[seat]!;
        const increment = newBet - prevBet;
        if (increment <= 0) break; // no-op (e.g. amount ≤ current bet) — don't reopen
        this.currentBet = newBet;
        const opening = prevBet === 0;
        // A full raise increases the bet by at least the last raise size; a
        // short all-in (smaller increment) does NOT reopen the betting.
        const fullRaise = opening || increment >= this._lastRaiseSize - 1e-9;
        if (fullRaise) {
          this._lastRaiseSize = opening ? newBet : increment;
          this._raiseReopened = true;
          for (let i = 0; i < this.stacks.length; i++) {
            if (i !== seat && !this.folded[i] && this.stacks[i]! > 0) this._needsAct.add(i);
          }
        } else {
          // Short all-in: only players who still owe chips act again (call/fold),
          // and the action is not reopened for re-raising.
          this._raiseReopened = false;
          for (let i = 0; i < this.stacks.length; i++) {
            if (i !== seat && !this.folded[i] && this.stacks[i]! > 0 && this.toCall(i) > 0)
              this._needsAct.add(i);
          }
        }
        break;
      }
    }

    this.actions.push({ ...input, street: this.street });
  }

  advanceStreet(cards: Card[]): void {
    for (const c of cards) this.board.push(c);
    const next: Record<string, Street> = {
      preflop: "flop",
      flop: "turn",
      turn: "river",
    };
    this.street = next[this.street]!;
    this.currentBet = 0;
    this._lastActor = -1;
    this._lastRaiseSize = this.bb; // min bet/raise resets to one BB each street
    this._raiseReopened = true;
    this._actedThisStreet.clear();
    for (let i = 0; i < this.streetInvested.length; i++)
      this.streetInvested[i] = 0;
    this._needsAct.clear();
    for (let i = 0; i < this.folded.length; i++) {
      if (!this.folded[i] && this.stacks[i]! > 0) this._needsAct.add(i);
    }
  }

  clone(): GameState {
    const gs = Object.create(GameState.prototype) as GameState;
    Object.assign(gs, {
      tableSize: this.tableSize,
      bb: this.bb,
      sb: this.sb,
      heroSeat: this.heroSeat,
      heroCards: this.heroCards,
      dealerSeat: this.dealerSeat,
      positions: this.positions,
      street: this.street,
      board: [...this.board],
      pot: this.pot,
      stacks: [...this.stacks],
      folded: [...this.folded],
      invested: [...this.invested],
      streetInvested: [...this.streetInvested],
      currentBet: this.currentBet,
      actions: this.actions.map((a) => ({ ...a })),
      villainStories: new Map(this.villainStories),
      _needsAct: new Set(this._needsAct),
      _lastActor: this._lastActor,
      _lastRaiseSize: this._lastRaiseSize,
      _raiseReopened: this._raiseReopened,
      _actedThisStreet: new Set(this._actedThisStreet),
    });
    return gs;
  }
}
