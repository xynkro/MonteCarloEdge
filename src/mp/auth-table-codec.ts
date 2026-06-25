// Round-trips an AuthTable to/from plain JSON for Firestore persistence by the
// server-authoritative engine (Cloud Functions). The SECRET snapshot (deck-derived
// holes + full board + serialized GameState) is stored only in the no-client-read
// `tables/{id}/private/state` doc; clients never deserialize it.
//
// JSON-safety: Card is a number (0–51), so the only non-JSON members are the
// GameState (Maps/Sets — handled by GameState.toSnapshot) and the holes Map.

import type { Card } from "../engine/cards.js";
import { GameState, type GameStateSnapshot } from "../engine/game-state.js";
import type { AuthTable, AuthSeat } from "./mp-engine.js";
import type { PlayerStats } from "../engine/player-model.js";

export interface AuthTableSnapshot {
  id: string;
  ownerUid: string;
  name: string;
  blinds: { sb: number; bb: number };
  startingStack: number;
  maxSeats: number;
  seats: AuthSeat[];
  buttonSeat: number;
  status: AuthTable["status"];
  handId: string | null;
  handCount: number;
  lastResult: string;
  lastWinners?: number[];
  lastPot?: number;
  lastWon?: Record<number, number>;
  isPublic?: boolean;
  boughtIn?: number;
  bankedOut?: number;
  spectators?: Array<{ uid: string; name: string }>;
  lastAction?: { seat: number; type: string; amount: number } | null;
  botTrace?: Array<{ seat: number; type: string; amount: number }>;
  gs: GameStateSnapshot | null;
  liveSeats: number[];
  holes: Record<number, [Card, Card]>; // table-seat idx → hole cards (SECRET)
  fullBoard: Card[];
  seatStats?: Record<number, PlayerStats>; // table-seat → accumulated observed stats
}

export function serializeAuthTable(t: AuthTable): AuthTableSnapshot {
  return {
    id: t.id,
    ownerUid: t.ownerUid,
    name: t.name,
    blinds: { ...t.blinds },
    startingStack: t.startingStack,
    maxSeats: t.maxSeats,
    seats: t.seats.map((s) => ({ ...s })),
    buttonSeat: t.buttonSeat,
    status: t.status,
    handId: t.handId,
    handCount: t.handCount,
    lastResult: t.lastResult,
    lastWinners: t.lastWinners ?? [],
    lastPot: t.lastPot ?? 0,
    lastWon: t.lastWon ?? {},
    isPublic: t.isPublic !== false,
    boughtIn: t.boughtIn ?? t.startingStack,
    bankedOut: t.bankedOut ?? 0,
    spectators: (t.spectators ?? []).map((s) => ({ uid: s.uid, name: s.name })),
    lastAction: t.lastAction ?? null,
    botTrace: (t.botTrace ?? []).slice(),
    gs: t.gs ? t.gs.toSnapshot() : null,
    liveSeats: [...t.liveSeats],
    holes: Object.fromEntries(t.holes) as Record<number, [Card, Card]>,
    fullBoard: [...t.fullBoard],
    seatStats: t.seatStats ? Object.fromEntries(t.seatStats) as Record<number, PlayerStats> : {},
  };
}

export function deserializeAuthTable(s: AuthTableSnapshot): AuthTable {
  return {
    id: s.id,
    ownerUid: s.ownerUid,
    name: s.name,
    blinds: { ...s.blinds },
    startingStack: s.startingStack,
    maxSeats: s.maxSeats,
    seats: s.seats.map((x) => ({ ...x })),
    buttonSeat: s.buttonSeat,
    status: s.status,
    handId: s.handId,
    handCount: s.handCount,
    lastResult: s.lastResult,
    lastWinners: s.lastWinners ?? [],
    lastPot: s.lastPot ?? 0,
    lastWon: s.lastWon ?? {},
    isPublic: s.isPublic !== false,
    // Old rooms (pre-cap) deserialize as uncapped so they don't brick mid-life; they're purged.
    boughtIn: s.boughtIn ?? Number.MAX_SAFE_INTEGER,
    bankedOut: s.bankedOut ?? 0,
    spectators: (s.spectators ?? []).map((x) => ({ uid: x.uid, name: x.name })),
    lastAction: s.lastAction ? { seat: s.lastAction.seat, type: s.lastAction.type as NonNullable<AuthTable["lastAction"]>["type"], amount: s.lastAction.amount } : null,
    botTrace: (s.botTrace ?? []).map((x) => ({ seat: x.seat, type: x.type as NonNullable<AuthTable["lastAction"]>["type"], amount: x.amount })),
    gs: s.gs ? GameState.fromSnapshot(s.gs) : null,
    liveSeats: [...s.liveSeats],
    holes: new Map(Object.entries(s.holes).map(([k, v]) => [Number(k), v] as [number, [Card, Card]])),
    fullBoard: [...s.fullBoard],
    seatStats: new Map(Object.entries(s.seatStats ?? {}).map(([k, v]) => [Number(k), v] as [number, PlayerStats])),
  };
}
