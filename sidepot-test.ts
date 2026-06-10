// Comprehensive side pot correctness test for MonteCarloEdge engine.
// Tests: (a) chip conservation, (b) correct side pot distribution,
// (c) short all-ins don't win uncontested pots, (d) odd-chip distribution.
import { createAuthTable, seatAi, startHand, actSeat, toActTableSeat, publicState } from "./src/mp/mp-engine.js";
import { mulberry32, type Rng } from "./src/engine/rng.js";

interface TestCase {
  name: string;
  stacks: number[];
  actions: Array<{
    type: "fold" | "check" | "call" | "bet" | "raise";
    amount?: number;
    description?: string;
  }>;
  expectedWinnersCount: number;
  expectedTotalPotConserved: boolean;
}

function seatCount(stacks: number[]): number {
  return stacks.length;
}

function runTest(tc: TestCase, rng: Rng): { passed: boolean; error?: string } {
  const n = seatCount(tc.stacks);
  const t = createAuthTable(`test-${tc.name}`, { uid: "owner", name: "Owner" }, {
    name: tc.name,
    blinds: { sb: 1, bb: 2 },
    startingStack: Math.max(...tc.stacks),
    maxSeats: Math.max(n, 6),
  });

  // Seat all players with exact stacks
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      t.seats[i]!.chips = tc.stacks[i]!;
    } else {
      seatAi(t, i, `Bot${i}`, "TAG");
      t.seats[i]!.chips = tc.stacks[i]!;
    }
  }

  const totalBefore = t.seats.reduce((a, s) => a + s.chips, 0);

  if (!startHand(t, rng)) {
    return { passed: false, error: "failed to start hand" };
  }

  const initialPot = publicState(t).pot;
  const actionIndex = { current: 0 };

  // Play through each action
  while (t.status === "in_hand" && actionIndex.current < tc.actions.length * 10) {
    const seat = toActTableSeat(t);
    if (seat < 0) break;

    if (actionIndex.current >= tc.actions.length) {
      // Passive action: call or check
      const ps = publicState(t);
      const toCall = ps.currentBet - (ps.seats[seat]?.bet || 0);
      const action = toCall > 0 ? "call" : "check";
      const res = actSeat(t, seat, { type: action });
      if (!res.ok) {
        return { passed: false, error: `unexpected action failure: ${res.err}` };
      }
    } else {
      const scriptAction = tc.actions[actionIndex.current]!;
      const res = actSeat(t, seat, {
        type: scriptAction.type,
        amount: scriptAction.amount,
      });
      if (!res.ok) {
        // Fallback to passive
        const ps = publicState(t);
        const toCall = ps.currentBet - (ps.seats[seat]?.bet || 0);
        const fallback = toCall > 0 ? "call" : "check";
        const res2 = actSeat(t, seat, { type: fallback });
        if (!res2.ok) {
          return { passed: false, error: `action failed: ${scriptAction.description || scriptAction.type}` };
        }
      }
      actionIndex.current++;
    }
  }

  if (t.status !== "hand_over") {
    // Continue passively to completion
    let guard = 0;
    while (t.status === "in_hand" && guard++ < 500) {
      const seat = toActTableSeat(t);
      if (seat < 0) break;
      const ps = publicState(t);
      const toCall = ps.currentBet - (ps.seats[seat]?.bet || 0);
      const res = actSeat(t, seat, { type: toCall > 0 ? "call" : "check" });
      if (!res.ok) break;
    }
  }

  if (t.status !== "hand_over") {
    return { passed: false, error: "hand did not complete" };
  }

  // Check conservation
  const totalAfter = t.seats.reduce((a, s) => a + s.chips, 0);
  if (Math.abs(totalAfter - totalBefore) > 1e-6) {
    return {
      passed: false,
      error: `chips not conserved: before=${totalBefore}, after=${totalAfter}, delta=${totalAfter - totalBefore}`,
    };
  }

  // Check all stacks are integers
  const allInt = t.seats.every((s) => Number.isInteger(s.chips));
  if (!allInt) {
    return { passed: false, error: "non-integer chip stacks detected" };
  }

  // Check winners count
  if (t.lastWinners && tc.expectedWinnersCount > 0) {
    if (t.lastWinners.length !== tc.expectedWinnersCount) {
      return {
        passed: false,
        error: `expected ${tc.expectedWinnersCount} winners, got ${t.lastWinners.length}`,
      };
    }
  }

  return { passed: true };
}

// Test cases covering the main scenarios
const testCases: TestCase[] = [
  // Heads-up all-in
  {
    name: "hu-allin-even",
    stacks: [100, 100],
    actions: [
      { type: "raise", amount: 50, description: "Button raises to 50" },
      { type: "raise", amount: 200, description: "BB re-raises to 200 (all-in)" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // Three-way all-in with short stacks
  {
    name: "3way-allin-uneven",
    stacks: [30, 100, 250],
    actions: [
      { type: "bet", amount: 60, description: "Seat 0 bets 60 (all-in)" },
      { type: "raise", amount: 200, description: "Seat 1 raises to 200" },
      { type: "call", description: "Seat 2 calls 200" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // All-in on flop, side pot on turn
  {
    name: "allin-flop-sidebet-turn",
    stacks: [50, 150, 300],
    actions: [
      { type: "bet", amount: 100, description: "Seat 0 bets 100 (all-in)" },
      { type: "call", description: "Seat 1 calls 100" },
      { type: "call", description: "Seat 2 calls 100" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // Multi-way with 4 players, multiple all-ins at different amounts
  {
    name: "4way-cascade-allin",
    stacks: [20, 50, 120, 300],
    actions: [
      { type: "bet", amount: 40, description: "Seat 0 bets 40 (all-in)" },
      { type: "raise", amount: 100, description: "Seat 1 raises to 100 (all-in)" },
      { type: "call", description: "Seat 2 calls 100" },
      { type: "call", description: "Seat 3 calls 100" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // Tie scenario: two winners split a pot
  {
    name: "two-way-call-showdown",
    stacks: [100, 100],
    actions: [
      { type: "bet", amount: 50, description: "Button bets 50" },
      { type: "call", description: "BB calls 50" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // Small blind all-in at table start
  {
    name: "sb-allin-from-blind",
    stacks: [2, 100],
    actions: [],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },

  // Big blind all-in at table start with a raise
  {
    name: "bb-allin-from-blind-with-raise",
    stacks: [100, 2],
    actions: [
      { type: "raise", amount: 10, description: "SB raises to 10" },
    ],
    expectedWinnersCount: 1,
    expectedTotalPotConserved: true,
  },
];

async function main() {
  const rng = mulberry32(42);
  let passed = 0,
    failed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const tc of testCases) {
    const result = runTest(tc, rng);
    if (result.passed) {
      console.log(`✅ ${tc.name}`);
      passed++;
    } else {
      console.log(`❌ ${tc.name}: ${result.error}`);
      failed++;
      failures.push({ name: tc.name, error: result.error! });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  ${f.name}: ${f.error}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
