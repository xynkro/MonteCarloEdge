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

  private _needsAct: Set<number>;
  private _lastActor = -1;

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
    for (let i = 0; i < n; i++) this._needsAct.add(i);
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
      if (this.stacks[seat]! > tc) a.push("raise");
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
      if (this._needsAct.has(seat)) return seat;
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
        const additional = input.amount - this.streetInvested[seat]!;
        if (additional > 0) this._invest(seat, additional);
        this.currentBet = this.streetInvested[seat]!;
        for (let i = 0; i < this.stacks.length; i++) {
          if (i !== seat && !this.folded[i] && this.stacks[i]! > 0)
            this._needsAct.add(i);
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
      _needsAct: new Set(this._needsAct),
      _lastActor: this._lastActor,
    });
    return gs;
  }
}
