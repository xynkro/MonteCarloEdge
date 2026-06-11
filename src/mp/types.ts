// Multiplayer domain + the BackendAdapter contract.
//
// This is the architectural keystone: the client talks ONLY to a BackendAdapter,
// never to Firebase directly. The local-first prototype implements it with
// BroadcastChannel (two tabs, one acting as the authority); the real backend will
// implement the SAME interface with Firebase Auth + Firestore + Cloud Functions.
// Swapping one for the other changes no UI code.
//
// SECURITY INVARIANT (why this shape): anything secret is returned ONLY to the
// player it belongs to. The public table state never contains another player's
// hole cards or the deck — those live with the authority (host tab locally; Cloud
// Functions in production) and are pushed per-player via subscribeMyHand().

import type { Card } from "../engine/cards.js";

export type MPStreet = "preflop" | "flop" | "turn" | "river" | "showdown";
export type MPActionType = "fold" | "check" | "call" | "bet" | "raise";

export interface MPUser {
  uid: string;
  name: string;
  chips: number;            // server-authoritative play-money balance (NEVER cashable)
  strategyEntitled: boolean; // has the user unlocked the GTO tool (paywall)?
}

// A seat as seen by EVERYONE (public). No hole cards here.
export interface MPSeat {
  uid: string | null;       // null = empty seat (or a bot)
  name: string;
  ai: string | null;        // bot archetype if this seat is AI; null = human/empty
  chips: number;            // stack at the table
  bet: number;              // chips wagered this street
  folded: boolean;
  sittingOut: boolean;
  // Admin-set: does THIS seat get the strategy tool this hand (assisted) or play
  // blind? The core of the benchmark. Independent of personal entitlement so the
  // table owner can run controlled A/B seats.
  assisted: boolean;
}

// The whole table, public info only — safe to broadcast to every client.
export interface PublicTableState {
  id: string;
  ownerUid: string;
  name: string;
  blinds: { sb: number; bb: number };
  status: "waiting" | "in_hand" | "hand_over";
  seats: MPSeat[];
  dealerSeat: number;
  street: MPStreet;
  board: Card[];
  pot: number;
  toAct: number;            // seat index to act, -1 if none
  currentBet: number;
  handId: string | null;
  lastResult: string;       // human-readable showdown / fold result
  lastWinners?: number[];   // table-seat indices that won the last hand (hand_over only)
  lastPot?: number;         // size of the pot just won (hand_over only)
  lastWon?: Record<number, number>; // table-seat → actual amount won
}

// Pushed to a SINGLE player — their own hole cards only.
export interface PrivateHand {
  handId: string;
  holeCards: [Card, Card] | null;
}

export interface MPAction {
  type: MPActionType;
  amount?: number;          // for bet/raise (chips)
}

export interface CreateTableOpts {
  name: string;
  blinds: { sb: number; bb: number };
  startingStack: number;    // chips each seat buys in for
  maxSeats: number;         // 2..9
}

export interface ChipPack { id: string; chips: number; priceUsd: number; label: string }

// The single seam the UI depends on. LocalAdapter (prototype) and FirebaseAdapter
// (production) both implement this; nothing else in the app imports a backend.
export interface BackendAdapter {
  // ── Auth ──
  signInWithGoogle(): Promise<MPUser>;
  signOut(): Promise<void>;
  currentUser(): MPUser | null;
  onUserChanged(cb: (u: MPUser | null) => void): () => void;

  // ── Lobby / tables ──
  createTable(opts: CreateTableOpts): Promise<string>;     // → tableId
  joinTable(tableId: string, seatIdx: number): Promise<void>;
  leaveTable(tableId: string): Promise<void>;
  listOpenTables(): Promise<PublicTableState[]>;

  // ── Realtime subscriptions ──
  subscribeTable(tableId: string, cb: (s: PublicTableState) => void): () => void;
  subscribeMyHand(tableId: string, cb: (h: PrivateHand | null) => void): () => void;

  // ── Admin (table owner only; enforced by the authority) ──
  setSeatAssisted(tableId: string, seatIdx: number, assisted: boolean): Promise<void>;

  // ── Gameplay (server-authoritative — the authority deals/validates/awards) ──
  startHand(tableId: string): Promise<void>;
  act(tableId: string, action: MPAction): Promise<void>;

  // ── Monetization (Stripe in production; stubbed/instant in the local prototype) ──
  chipPacks(): ChipPack[];
  buyChips(packId: string): Promise<void>;   // → Stripe Checkout (prod)
  unlockStrategy(): Promise<void>;           // → "Strategy Pro" subscription (prod)
}
