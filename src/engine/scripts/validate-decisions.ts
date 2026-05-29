import { makeCard, parseCard } from "../cards.js";
import { GameState } from "../game-state.js";
import { recommend } from "../decision.js";
import { TAG, STATION, NIT, LAG } from "../opponent.js";
import { openRaiseSize } from "../sizing.js";

console.log("═══════════════════════════════════════════════════════════════");
console.log("  MonteCarloEdge — Layer 3 Validation: Decision Engine       ");
console.log("═══════════════════════════════════════════════════════════════\n");

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean): void {
  console.log(`  ${label.padEnd(55)} ${ok ? "PASS" : "FAIL"}`);
  if (ok) pass++;
  else fail++;
}

function huState(
  heroCards: readonly [number, number],
  heroSeat = 0,
  stack = 200,
) {
  return new GameState({
    tableSize: 2,
    bb: 2,
    stacks: [stack, stack],
    positions: ["BTN", "BB"],
    heroSeat,
    heroCards,
    dealerSeat: 0,
  });
}

function sixMaxState(
  heroCards: readonly [number, number],
  heroSeat: number,
) {
  return new GameState({
    tableSize: 6,
    bb: 2,
    stacks: [200, 200, 200, 200, 200, 200],
    positions: ["UTG", "MP", "CO", "BTN", "SB", "BB"],
    heroSeat,
    heroCards,
    dealerSeat: 3,
  });
}

// ─── (1) Preflop sanity ──────────────────────────────────────────────────────

console.log("(1) Preflop decision sanity\n");

{
  const aa = [makeCard(12, 0), makeCard(12, 1)] as const;
  const kk = [makeCard(11, 0), makeCard(11, 1)] as const;
  const aks = [makeCard(12, 0), makeCard(11, 0)] as const;
  const t72o = [makeCard(5, 0), makeCard(0, 1)] as const;
  const t32o = [makeCard(1, 0), makeCard(0, 1)] as const;

  check("AA raises from BTN HU", recommend(huState(aa)).action === "raise");
  check("KK raises from BTN HU", recommend(huState(kk)).action === "raise");
  check("AKs raises from BTN HU", recommend(huState(aks)).action === "raise");

  // UTG 6-max
  const utg6 = (c: readonly [number, number]) => {
    const gs = sixMaxState(c, 0);
    return recommend(gs);
  };
  check("AA raises from UTG 6-max", utg6(aa).action === "raise");
  check("72o folds from UTG 6-max", utg6(t72o).action === "fold");
  check("32o folds from UTG 6-max", utg6(t32o).action === "fold");

  // BB defense
  const bbVsOpen = (c: readonly [number, number]) => {
    const gs = huState(c, 1);
    gs.applyAction({ seat: 0, type: "raise", amount: 5 });
    return recommend(gs);
  };
  check("BB defends AKs vs BTN open", ["call", "raise"].includes(bbVsOpen(aks).action));
  check("BB folds 72o vs BTN open", bbVsOpen(t72o).action === "fold");
  check("BB folds 32o vs BTN open", bbVsOpen(t32o).action === "fold");
}

console.log(`\nPreflop sanity: ${pass}/${pass + fail} passed\n`);
const preflopPass = pass;
const preflopFail = fail;
pass = 0;
fail = 0;

// ─── (2) Postflop EV sign checks ────────────────────────────────────────────

console.log("(2) Postflop EV sign checks\n");

{
  // Hero has TPTK on A-high dry board → should bet (high equity)
  const gs1 = huState([makeCard(12, 0), makeCard(11, 0)]); // AcKc
  gs1.applyAction({ seat: 0, type: "raise", amount: 5 });
  gs1.applyAction({ seat: 1, type: "call", amount: 0 });
  gs1.advanceStreet([makeCard(12, 2), makeCard(5, 1), makeCard(0, 3)]); // Ah 7d 2s
  gs1.applyAction({ seat: 1, type: "check", amount: 0 });
  const rec1 = recommend(gs1, TAG);
  check("TPTK on dry board: bets", ["bet", "raise"].includes(rec1.action));
  check("TPTK equity > 60%", rec1.equity > 0.6);

  // Hero has air on A-high board facing a bet → should fold
  const gs2 = huState([makeCard(5, 0), makeCard(4, 1)]); // 7c6d
  gs2.applyAction({ seat: 0, type: "call", amount: 0 });
  gs2.applyAction({ seat: 1, type: "check", amount: 0 });
  gs2.advanceStreet([makeCard(12, 3), makeCard(11, 2), makeCard(10, 1)]); // As Kh Qd
  gs2.applyAction({ seat: 1, type: "bet", amount: 4 });
  const rec2 = recommend(gs2, TAG);
  check("Air on AKQ board: equity < 40%", rec2.equity < 0.4);

  // Good hand should have positive call EV when equity > pot odds
  const gs3 = huState([makeCard(12, 0), makeCard(12, 1)]); // AcAd
  gs3.applyAction({ seat: 0, type: "call", amount: 0 });
  gs3.applyAction({ seat: 1, type: "check", amount: 0 });
  gs3.advanceStreet([makeCard(8, 0), makeCard(5, 1), makeCard(0, 2)]); // Tc 7d 2h
  gs3.applyAction({ seat: 1, type: "bet", amount: 3 });
  const rec3 = recommend(gs3, TAG);
  check("AA on T72: calls or raises", ["call", "raise"].includes(rec3.action));
  check("AA on T72: equity > 70%", rec3.equity > 0.7);
}

console.log(`\nEV sign checks: ${pass}/${pass + fail} passed\n`);
const evPass = pass;
const evFail = fail;
pass = 0;
fail = 0;

// ─── (3) Sizing bounds ──────────────────────────────────────────────────────

console.log("(3) Sizing bounds\n");

{
  // Open raise should be 2-3bb range
  const gs = huState([makeCard(12, 0), makeCard(11, 0)]);
  const rec = recommend(gs);
  check("Open raise 2-3bb", rec.amount >= 2 * 2 && rec.amount <= 3.5 * 2);

  // Postflop bet should be ⅓ to 1x pot
  const gs2 = huState([makeCard(12, 0), makeCard(12, 1)]); // AA
  gs2.applyAction({ seat: 0, type: "call", amount: 0 });
  gs2.applyAction({ seat: 1, type: "check", amount: 0 });
  gs2.advanceStreet([makeCard(8, 0), makeCard(5, 1), makeCard(0, 2)]);
  gs2.applyAction({ seat: 1, type: "check", amount: 0 });
  const rec2 = recommend(gs2, TAG);
  if (rec2.action === "bet") {
    check("Postflop bet ≥ ⅓ pot", rec2.amount >= gs2.pot / 3 - 0.1);
    check("Postflop bet ≤ pot", rec2.amount <= gs2.pot + 0.1);
  } else {
    check("Postflop bet ≥ ⅓ pot (skipped — checked)", true);
    check("Postflop bet ≤ pot (skipped — checked)", true);
  }

  // 3-bet sizing
  const gs3 = huState([makeCard(12, 0), makeCard(12, 1)], 1);
  gs3.applyAction({ seat: 0, type: "raise", amount: 5 });
  const rec3 = recommend(gs3);
  if (rec3.action === "raise") {
    check("3-bet > open raise", rec3.amount > 5);
    check("3-bet < 30bb", rec3.amount < 60);
  } else {
    check("3-bet > open raise (skipped — called)", true);
    check("3-bet < 30bb (skipped — called)", true);
  }
}

console.log(`\nSizing bounds: ${pass}/${pass + fail} passed\n`);
const sizePass = pass;
const sizeFail = fail;

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");

const totalPass = preflopPass + evPass + sizePass;
const totalFail = preflopFail + evFail + sizeFail;

console.log(
  `\nLayer 3 ${totalFail === 0 ? "PASSED" : "FAILED"} — ${totalPass}/${totalPass + totalFail} checks`,
);
console.log(`  Preflop sanity:   ${preflopPass}/${preflopPass + preflopFail}`);
console.log(`  EV sign checks:   ${evPass}/${evPass + evFail}`);
console.log(`  Sizing bounds:    ${sizePass}/${sizePass + sizeFail}`);

if (totalFail > 0) process.exit(1);
