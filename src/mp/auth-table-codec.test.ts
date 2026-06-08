import { describe, it, expect } from "vitest";
import { mulberry32 } from "../engine/rng.js";
import {
  createAuthTable, sit, startHand, act, publicState, privateHandFor, toActTableSeat,
  type AuthTable,
} from "./mp-engine.js";
import { serializeAuthTable, deserializeAuthTable } from "./auth-table-codec.js";

function table2(): AuthTable {
  const t = createAuthTable("t1", { uid: "u_owner", name: "Owner" }, {
    name: "Test", blinds: { sb: 1, bb: 2 }, startingStack: 200, maxSeats: 6,
  });
  sit(t, "u_bob", "Bob", 1);
  return t;
}
// Full JSON trip (as Firestore would do it), then rebuild.
const roundTrip = (t: AuthTable): AuthTable =>
  deserializeAuthTable(JSON.parse(JSON.stringify(serializeAuthTable(t))));

describe("auth-table codec", () => {
  it("survives a JSON round-trip with identical public + private state", () => {
    const t = table2();
    startHand(t, mulberry32(42));
    const r = roundTrip(t);
    expect(publicState(r)).toEqual(publicState(t));
    expect(privateHandFor(r, "u_owner")).toEqual(privateHandFor(t, "u_owner"));
    expect(privateHandFor(r, "u_bob")).toEqual(privateHandFor(t, "u_bob"));
  });

  it("a deserialized table plays a full hand IDENTICALLY to the in-memory one", () => {
    const a = table2();
    startHand(a, mulberry32(7));
    let b = roundTrip(a); // rebuild from JSON, then play BOTH in lockstep

    let guard = 0;
    while (a.status === "in_hand" && guard++ < 40) {
      const ts = toActTableSeat(a);
      if (ts < 0) break;
      // The round-tripped table must agree on whose turn it is.
      expect(toActTableSeat(b)).toBe(ts);
      const uid = a.seats[ts]!.uid!;
      const toCall = publicState(a).currentBet - publicState(a).seats[ts]!.bet;
      const action = { type: toCall > 0 ? "call" as const : "check" as const };
      expect(act(a, uid, action).ok).toBe(true);
      expect(act(b, uid, action).ok).toBe(true);
      // After each action, persist+restore b — simulating the server reloading
      // the table from Firestore on every callable. It must stay in lockstep.
      b = roundTrip(b);
      expect(publicState(b)).toEqual(publicState(a));
    }
    expect(b.status).toBe(a.status);
    expect(publicState(b).pot).toBe(publicState(a).pot);
    // Chips conserved across the round-tripped hand.
    const total = (t: AuthTable) => t.seats.reduce((s, x) => s + x.chips, 0);
    expect(total(b)).toBe(total(a));
  });
});
