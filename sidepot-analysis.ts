// Detailed analysis of side pot and showdown logic.
import { createAuthTable, seatAi, startHand, actSeat, toActTableSeat, publicState } from "./src/mp/mp-engine.js";
import { mulberry32 } from "./src/engine/rng.js";
import { evaluate } from "./src/engine/evaluator.js";

interface Pot {
  amount: number;
  winners: number[];
  eligibleSeats: number[];
}

function analyzeHand(
  name: string,
  stacks: number[],
  actions: Array<{ type: string; amount?: number }>,
) {
  const n = stacks.length;
  const t = createAuthTable(`test-${name}`, { uid: "owner", name: "Owner" }, {
    name,
    blinds: { sb: 1, bb: 2 },
    startingStack: Math.max(...stacks),
    maxSeats: Math.max(n, 6),
  });

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      t.seats[i]!.chips = stacks[i]!;
    } else {
      seatAi(t, i, `Bot${i}`, "TAG");
      t.seats[i]!.chips = stacks[i]!;
    }
  }

  const totalBefore = t.seats.reduce((a, s) => a + s.chips, 0);

  if (!startHand(t, mulberry32(12345))) {
    console.log(`  FAILED: could not start hand`);
    return;
  }

  let actionIdx = 0;
  while (t.status === "in_hand" && actionIdx < (actions.length + 100)) {
    const seat = toActTableSeat(t);
    if (seat < 0) break;

    if (actionIdx < actions.length) {
      const action = actions[actionIdx]!;
      const res = actSeat(t, seat, { type: action.type as any, amount: action.amount });
      if (!res.ok) {
        const ps = publicState(t);
        const fallback = (ps.currentBet || 0) - (ps.seats[seat]?.bet || 0) > 0 ? "call" : "check";
        actSeat(t, seat, { type: fallback as any });
      }
      actionIdx++;
    } else {
      const ps = publicState(t);
      const fallback = (ps.currentBet || 0) - (ps.seats[seat]?.bet || 0) > 0 ? "call" : "check";
      actSeat(t, seat, { type: fallback as any });
    }
  }

  if (t.status !== "hand_over") {
    let guard = 0;
    while (t.status === "in_hand" && guard++ < 500) {
      const seat = toActTableSeat(t);
      if (seat < 0) break;
      const ps = publicState(t);
      const fallback = (ps.currentBet || 0) - (ps.seats[seat]?.bet || 0) > 0 ? "call" : "check";
      actSeat(t, seat, { type: fallback as any });
    }
  }

  const totalAfter = t.seats.reduce((a, s) => a + s.chips, 0);
  const allInt = t.seats.every((s) => Number.isInteger(s.chips));

  console.log(`\n${name}:`);
  console.log(`  Initial stacks: [${stacks.join(", ")}]`);
  console.log(`  Final stacks: [${t.seats.slice(0, n).map((s) => s.chips).join(", ")}]`);
  console.log(`  Total conserved: ${totalAfter === totalBefore ? "YES" : "NO"} (${totalBefore} → ${totalAfter})`);
  console.log(`  All integer: ${allInt ? "YES" : "NO"}`);
  console.log(`  Result: ${t.lastResult}`);
  console.log(`  Winners: ${t.lastWinners?.join(", ") || "none"}`);
  console.log(`  Last pot: ${t.lastPot}`);

  // Show which seats won/lost
  const deltas = t.seats.slice(0, n).map((s, i) => stacks[i]! - s.chips);
  console.log(`  Seat deltas: ${deltas.map((d, i) => `S${i}:${d > 0 ? "+" : ""}${d}`).join(" ")}`);
}

// Case 1: simple 3-way all-in with uneven stacks
analyzeHand("3way-allin-uneven-detail", [30, 100, 250], [
  { type: "bet", amount: 60 },
  { type: "raise", amount: 200 },
  { type: "call" },
]);

// Case 2: another 3-way scenario
analyzeHand("3way-passive", [50, 100, 150], [
  { type: "bet", amount: 100 },
  { type: "call" },
  { type: "call" },
]);

// Case 3: 4-way with cascading all-ins
analyzeHand("4way-cascade-detail", [20, 50, 120, 300], [
  { type: "bet", amount: 40 },
  { type: "raise", amount: 100 },
  { type: "call" },
  { type: "call" },
]);

// Case 4: heads-up all-in
analyzeHand("hu-simple", [100, 100], [
  { type: "raise", amount: 50 },
  { type: "raise", amount: 200 },
]);
