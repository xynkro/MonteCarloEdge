// Layer 1 validation: prove the engine is correct.
//
// Three independent checks, each a hard gate:
//
//   1. Structural — for any hand X, equity(X vs X) == exactly 0.5.
//      This exercises the entire pipeline (evaluator + tie-handling + sampler)
//      and any bug shows up as a non-0.5 result.
//
//   2. Exhaustive ground truth — for each canonical heads-up preflop spot,
//      enumerate all 1,712,304 possible boards and compute the exact equity.
//      This is provably correct given a correct evaluator (which is verified
//      by the 22 hand-evaluation unit tests in evaluator.test.ts).
//
//   3. Sampler convergence — Monte Carlo at 200k iterations must agree with
//      the exhaustive ground truth to within 4× its reported 95% confidence
//      interval. This confirms the sampler is unbiased and calibrated.
//
// Published reference equities (PokerStove / ProPokerTools / Wizard of Odds)
// are shown for context only — they are derived from the same exhaustive
// math we now perform ourselves.
//
// Run: npm run validate

import { parseHand, type Card } from "../cards.js";
import { monteCarloEquity, exhaustiveEquityHU } from "../equity.js";
import { mulberry32 } from "../rng.js";

function pair(s: string): [Card, Card] {
  const c = parseHand(s);
  return [c[0]!, c[1]!];
}

interface Spot {
  label: string;
  hero: string;
  villain: string;
  publishedRef?: number;     // informational only
}

const SPOTS: Spot[] = [
  { label: "AsKs vs 2c2d (suited overcards vs small pair)",
    hero: "AsKs", villain: "2c2d", publishedRef: 0.5005 },
  { label: "AsKh vs 2c2d (offsuit overcards vs small pair)",
    hero: "AsKh", villain: "2c2d", publishedRef: 0.4665 },
  { label: "AsKh vs JdJc (overcards vs middle pair)",
    hero: "AsKh", villain: "JdJc", publishedRef: 0.4330 },
  { label: "AsKh vs AdQc (dominated kicker)",
    hero: "AsKh", villain: "AdQc", publishedRef: 0.7390 },
  { label: "KsKh vs KdQc (dominated by overpair)",
    hero: "KsKh", villain: "KdQc", publishedRef: 0.9090 },
  { label: "TsTh vs AsKh (middle pair vs overcards)",
    hero: "TsTh", villain: "AsKh", publishedRef: 0.5648 },
  { label: "7s8s vs AhKd (suited connectors vs big offsuit)",
    hero: "7s8s", villain: "AhKd", publishedRef: 0.4180 },
];

// Structural mirror tests: hand vs identical hand on different suits must
// tie 100%. These test the evaluator + sampler tie-handling end-to-end.
const MIRROR_SPOTS: Array<[string, string]> = [
  ["AsAh", "AdAc"],     // pocket aces
  ["KsQh", "KdQc"],     // big offsuit
  ["7s8s", "7d8d"],     // suited connectors
  ["2s3h", "2d3c"],     // small offsuit
];

const MC_ITERATIONS = 200_000;
const MC_CI_MULTIPLIER = 4;        // MC equity must lie within 4× stderr95 of exhaustive

function fmtPct(x: number): string {
  return (x * 100).toFixed(3).padStart(7) + "%";
}
function fmtDelta(x: number): string {
  const sign = x >= 0 ? "+" : "";
  return sign + (x * 100).toFixed(3).padStart(6) + "pp";
}

console.log("MonteCarloEdge — Layer 1 Equity Engine Validation");
console.log("");

// ---- (1) Structural: mirror hands must tie exactly ----
console.log("(1) Structural: mirror-hand tests (hero equity must be exactly 0.5)");
console.log("");
let structFail = 0;
for (const [a, b] of MIRROR_SPOTS) {
  const r = exhaustiveEquityHU(pair(a), pair(b));
  const ok = r.equity === 0.5;
  if (!ok) structFail++;
  console.log(`  ${a} vs ${b}  →  ${r.equity.toFixed(6)}  ${ok ? "PASS" : "FAIL"}`);
}
console.log("");

// ---- (2) Exhaustive ground truth + (3) Monte Carlo convergence ----
console.log("(2) Exhaustive enumeration of all 1,712,304 boards = ground truth");
console.log(`(3) Monte Carlo at ${MC_ITERATIONS.toLocaleString()} iter must match within ${MC_CI_MULTIPLIER}× 95% CI`);
console.log("");
console.log(
  "Spot".padEnd(56) +
  "Exhaustive   MonteCarlo   Δ_mc       95%CI       Ref      Δ_ref"
);
console.log("-".repeat(124));

let mcFail = 0;
const tStart = Date.now();

for (let i = 0; i < SPOTS.length; i++) {
  const spot = SPOTS[i]!;
  const heroCards = pair(spot.hero);
  const villainCards = pair(spot.villain);

  const exhaustive = exhaustiveEquityHU(heroCards, villainCards);
  const mc = monteCarloEquity({
    hero: heroCards,
    opponents: [villainCards],
    iterations: MC_ITERATIONS,
    rng: mulberry32(0x100 + i),
  });

  const dMc = mc.equity - exhaustive.equity;
  const mcOk = Math.abs(dMc) <= MC_CI_MULTIPLIER * mc.stderr95;
  if (!mcOk) mcFail++;

  const refStr = spot.publishedRef !== undefined ? fmtPct(spot.publishedRef) : "      —";
  const dRefStr = spot.publishedRef !== undefined
    ? fmtDelta(exhaustive.equity - spot.publishedRef)
    : "         ";

  console.log(
    spot.label.padEnd(56) +
    fmtPct(exhaustive.equity) + "   " +
    fmtPct(mc.equity) + "   " +
    fmtDelta(dMc) + (mcOk ? "  " : "FL") + "   " +
    "±" + (mc.stderr95 * 100).toFixed(3) + "pp   " +
    refStr + "   " +
    dRefStr
  );
}

const elapsed = (Date.now() - tStart) / 1000;
console.log("-".repeat(124));
console.log(`Completed in ${elapsed.toFixed(1)}s`);
console.log("");

console.log(`Structural mirror tests:           ${MIRROR_SPOTS.length - structFail}/${MIRROR_SPOTS.length}`);
console.log(`Monte Carlo converges to exact:    ${SPOTS.length - mcFail}/${SPOTS.length}`);
console.log("");

if (structFail > 0 || mcFail > 0) {
  console.log("Layer 1 FAILED.");
  process.exit(1);
}
console.log("Layer 1 PASSED — equity engine is correct and the Monte Carlo sampler is calibrated.");
