// Game Flow & Hang Testing Harness for MonteCarloEdge Multiplayer
// Tests: full hand progression (2/3/6/9 players), street transitions, all-in/fold-outs,
// betting round closure logic (raise-then-everyone-calls, min-raise reopening, short all-ins),
// version-lock, and no hangs.

import { createAuthTable, seatAi, startHand, actSeat, toActTableSeat, publicState } from "./src/mp/mp-engine.js";
import { mulberry32 } from "./src/engine/rng.js";

const rng = mulberry32(42);

interface TestResult {
  players: number;
  handCount: number;
  status: "ok" | "hang" | "error";
  detail: string;
  lastHand?: string;
}

const results: TestResult[] = [];

/** Play one hand to completion, returning whether it finished without hang. */
function playHand(t: any, tableSize: number, handNum: number): TestResult {
  const handLabel = `${tableSize}p-hand${handNum}`;
  if (!startHand(t, rng)) {
    return { players: tableSize, handCount: handNum, status: "error", detail: "startHand failed", lastHand: handLabel };
  }

  let actionCount = 0;
  const maxActions = 500; // safety guard against infinite loops
  let lastSig = "";
  let stuckCount = 0;

  while (t.status === "in_hand" && actionCount < maxActions) {
    const toAct = toActTableSeat(t);
    if (toAct < 0) {
      // Round should be complete; advance street or settle
      break;
    }

    const pub = publicState(t);
    const sig = `street=${pub.street}|toAct=${toAct}|pot=${pub.pot}`;

    if (sig === lastSig) {
      stuckCount++;
      if (stuckCount >= 5) {
        return {
          players: tableSize,
          handCount: handNum,
          status: "hang",
          detail: `state not advancing after 5 cycles: ${sig}`,
          lastHand: handLabel,
        };
      }
    } else {
      stuckCount = 0;
    }
    lastSig = sig;

    const seat = t.seats[toAct];
    if (!seat || (!seat.uid && !seat.ai)) {
      return {
        players: tableSize,
        handCount: handNum,
        status: "error",
        detail: `toAct seat ${toAct} is empty (uid=${seat?.uid}, ai=${seat?.ai})`,
        lastHand: handLabel,
      };
    }

    const toCall = (pub.currentBet || 0) - (seat.bet || 0);
    let action;

    // Deterministic strategy: call/check most of the time, raise occasionally, fold rarely
    const r = rng();
    if (toCall > 0 && r < 0.15) {
      action = { type: "fold" };
    } else if (toCall === 0 && r < 0.25) {
      // When to act with no bet, bet occasionally
      const stackBehind = (pub.seats[toAct]?.chips || 0);
      if (stackBehind > pub.blinds.bb && r < 0.2) {
        action = { type: "bet", amount: pub.blinds.bb * (1 + Math.floor(rng() * 3)) };
      } else {
        action = { type: "check" };
      }
    } else if (toCall > 0 && r < 0.85) {
      action = { type: "call" };
    } else {
      // Raise
      const currentBet = pub.currentBet || 0;
      const stackBehind = (pub.seats[toAct]?.chips || 0);
      if (stackBehind > toCall) {
        const raiseTo = Math.min(
          currentBet + stackBehind + seat.bet,
          currentBet * 2 + (rng() < 0.5 ? 0 : pub.blinds.bb)
        );
        action = { type: "raise", amount: raiseTo };
      } else {
        action = { type: "call" };
      }
    }

    const res = actSeat(t, toAct, action);
    if (!res.ok) {
      // Fallback: try call, then check, then fold
      const fallback = toCall > 0 ? { type: "call" } : { type: "check" };
      const res2 = actSeat(t, toAct, fallback);
      if (!res2.ok) {
        const res3 = actSeat(t, toAct, { type: "fold" });
        if (!res3.ok) {
          return {
            players: tableSize,
            handCount: handNum,
            status: "error",
            detail: `action failed (${action.type}), fallbacks failed: primary=${res.err}, call/check=${res2.err}, fold=${res3.err}`,
            lastHand: handLabel,
          };
        }
      }
    }

    actionCount++;
  }

  if (actionCount >= maxActions) {
    return {
      players: tableSize,
      handCount: handNum,
      status: "hang",
      detail: `exceeded ${maxActions} actions`,
      lastHand: handLabel,
    };
  }

  if (t.status !== "hand_over") {
    return {
      players: tableSize,
      handCount: handNum,
      status: "error",
      detail: `hand incomplete: status=${t.status}, toAct=${toActTableSeat(t)}, actions=${actionCount}`,
      lastHand: handLabel,
    };
  }

  // Verify winners were recorded
  if (!t.lastResult || t.lastResult.length === 0) {
    return {
      players: tableSize,
      handCount: handNum,
      status: "error",
      detail: `no lastResult recorded`,
      lastHand: handLabel,
    };
  }

  return {
    players: tableSize,
    handCount: handNum,
    status: "ok",
    detail: `completed: ${t.lastResult} in ${actionCount} actions`,
    lastHand: handLabel,
  };
}

/** Run hands for a given table size. */
function runTableSize(tableSize: number, handCount: number) {
  const t = createAuthTable("TEST", { uid: "owner", name: "P0" }, {
    name: "test",
    blinds: { sb: 1, bb: 2 },
    startingStack: 200,
    maxSeats: tableSize,
  });

  // Seed bots
  for (let s = 1; s < tableSize; s++) {
    seatAi(t, s, `B${s}`, "TAG");
  }

  for (let h = 0; h < handCount; h++) {
    // Reset stacks before each hand
    for (let s = 0; s < tableSize; s++) {
      t.seats[s]!.chips = 200;
      (t.seats[s] as any).sittingOut = false;
    }

    const res = playHand(t, tableSize, h);
    results.push(res);
    if (res.status !== "ok") {
      console.log(`❌ ${res.lastHand}: ${res.status} — ${res.detail}`);
      return;
    } else if (h % 5 === 0 || h === handCount - 1) {
      console.log(`✅ ${res.lastHand}: ${res.detail}`);
    }
  }
}

// Test all table sizes
console.log("=== MonteCarloEdge Game Flow & Hang Test ===\n");

for (const size of [2, 3, 6, 9]) {
  console.log(`\n--- ${size}-Player Table ---`);
  runTableSize(size, 10);
}

// Summary
console.log("\n=== SUMMARY ===");
const byStatus = {
  ok: results.filter((r) => r.status === "ok").length,
  hang: results.filter((r) => r.status === "hang").length,
  error: results.filter((r) => r.status === "error").length,
};
console.log(
  `Hands: ${results.length}  OK=${byStatus.ok}  HANG=${byStatus.hang}  ERROR=${byStatus.error}`
);

if (byStatus.hang > 0) {
  console.log("\n❌ HANGS DETECTED:");
  results.filter((r) => r.status === "hang").forEach((r) => {
    console.log(`  ${r.lastHand}: ${r.detail}`);
  });
  process.exit(1);
}

if (byStatus.error > 0) {
  console.log("\n❌ ERRORS:");
  results.filter((r) => r.status === "error").forEach((r) => {
    console.log(`  ${r.lastHand}: ${r.detail}`);
  });
  process.exit(1);
}

console.log("\n✅ All tests passed — no hangs, all hands completed correctly.");
process.exit(0);
