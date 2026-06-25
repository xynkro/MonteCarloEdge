import { describe, it, expect } from "vitest";
import { mulberry32 } from "../engine/rng.js";
import {
  createAuthTable, sit, leave, startHand, act, publicState, privateHandFor, toActTableSeat,
  type AuthTable,
} from "./mp-engine.js";

function playToShowdown(t: AuthTable, seed: number) {
  startHand(t, mulberry32(seed));
  let guard = 0;
  while (t.status === "in_hand" && guard++ < 40) {
    const ts = toActTableSeat(t);
    if (ts < 0) break;
    const ps = publicState(t);
    act(t, t.seats[ts]!.uid!, { type: ps.currentBet - ps.seats[ts]!.bet > 0 ? "call" : "check" });
  }
}

function tableWith2(): AuthTable {
  const t = createAuthTable("t1", { uid: "u_owner", name: "Owner" }, {
    name: "Test", blinds: { sb: 1, bb: 2 }, startingStack: 200, maxSeats: 6,
  });
  sit(t, "u_bob", "Bob", 1);
  return t;
}
const totalChips = (t: AuthTable) => t.seats.reduce((a, s) => a + s.chips, 0);

describe("mp-engine authority", () => {
  it("deals only each player their OWN hole cards; public state has none", () => {
    const t = tableWith2();
    const before = totalChips(t);
    startHand(t, mulberry32(1));
    const mine = privateHandFor(t, "u_owner").holeCards!;
    const bobs = privateHandFor(t, "u_bob").holeCards!;
    expect(mine).toHaveLength(2);
    expect(bobs).toHaveLength(2);
    expect(mine).not.toEqual(bobs);
    // Public state carries NO hole cards (structural — MPSeat has no card fields).
    const ps = JSON.stringify(publicState(t));
    expect(ps).not.toContain("holeCards");
    expect(ps).not.toContain("holes");
    // Blinds posted; nothing created/destroyed. During a hand the live stacks
    // are in gs (projected to seats[].chips) + the pot; conserved against `before`.
    const ps0 = publicState(t);
    expect(ps0.seats.reduce((a, s) => a + s.chips, 0) + ps0.pot).toBe(before);
  });

  it("plays a full passive hand to showdown and conserves chips", () => {
    const t = tableWith2();
    const before = totalChips(t);
    startHand(t, mulberry32(7));
    let guard = 0;
    while (t.status === "in_hand" && guard++ < 40) {
      const ts = toActTableSeat(t);
      if (ts < 0) break;
      const uid = t.seats[ts]!.uid!;
      const ps = publicState(t);
      const toCall = ps.currentBet - ps.seats[ts]!.bet;
      const r = act(t, uid, { type: toCall > 0 ? "call" : "check" });
      expect(r.ok).toBe(true);
    }
    expect(t.status).toBe("hand_over");
    expect(totalChips(t)).toBe(before); // chips conserved across the whole hand
  });

  it("accumulates per-seat opponent stats at showdown (adaptive reads)", () => {
    const t = tableWith2();
    for (let h = 0; h < 3; h++) playToShowdown(t, h + 1);
    // Both seated players have observed stats accumulated across the hands played.
    expect(t.seatStats!.get(0)!.hands).toBeGreaterThanOrEqual(1);
    expect(t.seatStats!.get(1)!.hands).toBeGreaterThanOrEqual(1);
  });

  it("resets a seat's stats when the occupant leaves", () => {
    const t = tableWith2();
    playToShowdown(t, 2);
    expect(t.seatStats!.get(1)!.hands).toBeGreaterThanOrEqual(1);
    leave(t, "u_bob");
    expect(t.seatStats!.has(1)).toBe(false); // a fresh occupant starts clean
  });

  it("rejects out-of-turn and non-seated actions", () => {
    const t = tableWith2();
    startHand(t, mulberry32(3));
    const toAct = toActTableSeat(t);
    const notToAct = t.seats.findIndex((s, i) => !!s.uid && i !== toAct);
    expect(act(t, t.seats[notToAct]!.uid!, { type: "check" }).ok).toBe(false); // not your turn
    expect(act(t, "u_ghost", { type: "check" }).ok).toBe(false);                // not seated
  });
});
