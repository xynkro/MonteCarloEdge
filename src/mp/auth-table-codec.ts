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
  gs: GameStateSnapshot | null;
  liveSeats: number[];
  holes: Record<number, [Card, Card]>; // table-seat idx → hole cards (SECRET)
  fullBoard: Card[];
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
    gs: t.gs ? t.gs.toSnapshot() : null,
    liveSeats: [...t.liveSeats],
    holes: Object.fromEntries(t.holes) as Record<number, [Card, Card]>,
    fullBoard: [...t.fullBoard],
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
    gs: s.gs ? GameState.fromSnapshot(s.gs) : null,
    liveSeats: [...s.liveSeats],
    holes: new Map(Object.entries(s.holes).map(([k, v]) => [Number(k), v] as [number, [Card, Card]])),
    fullBoard: [...s.fullBoard],
  };
}
