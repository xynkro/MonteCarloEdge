import { mulberry32 } from "../rng.js";
import { simulate } from "../simulator.js";
import { TAG, LAG, STATION, NIT, type OpponentProfile } from "../opponent.js";

console.log("═══════════════════════════════════════════════════════════════");
console.log("  MonteCarloEdge — Self-Play Backtest (HU, 100bb deep)       ");
console.log("═══════════════════════════════════════════════════════════════\n");

const HANDS = 100_000;
const STACK = 100;
const BB = 1;

interface Target {
  profile: OpponentProfile;
  minBb100: number;
}

const targets: Target[] = [
  { profile: STATION, minBb100: 5 },
  { profile: NIT, minBb100: 3 },
  { profile: TAG, minBb100: -2 },
  { profile: LAG, minBb100: 0 },
];

let pass = 0;
let fail = 0;

for (const { profile, minBb100 } of targets) {
  console.log(`  vs ${profile.name} (${HANDS.toLocaleString()} hands)...`);

  const result = simulate({
    villainProfile: profile,
    hands: HANDS,
    startingStack: STACK,
    bb: BB,
    rng: mulberry32(0xb0a4d),
  });

  const ok = result.bbPer100 >= minBb100;
  const ciOk = result.ci95[0] > minBb100 - 5; // CI lower bound within reasonable range

  console.log(
    `    bb/100 = ${result.bbPer100.toFixed(2)}  ` +
      `95% CI [${result.ci95[0].toFixed(2)}, ${result.ci95[1].toFixed(2)}]  ` +
      `target ≥ ${minBb100}  ${ok ? "PASS" : "FAIL"}`,
  );

  if (ok) pass++;
  else fail++;
}

console.log(
  `\n═══════════════════════════════════════════════════════════════`,
);
console.log(
  `\nSelf-play ${fail === 0 ? "PASSED" : "FAILED"} — ${pass}/${pass + fail} archetypes`,
);

if (fail > 0) process.exit(1);
