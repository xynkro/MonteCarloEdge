// Proof-page SEED generator (Task 3). Runs heads-up self-play of the MCE strategy (the same
// `recommend` engine the app uses) against each opponent archetype and writes a credible,
// reproducible "MCE-vs-field" bb/100 artifact to public/proof-data.json. This seeds the public
// Proof Page before real-player volume accrues; swap to live aggregates later.
//
// Run: HANDS=100000 npx tsx src/engine/scripts/gen-proof.ts
import { writeFileSync } from "node:fs";
import { simulate } from "../simulator.js";
import { STATION, NIT, TAG, LAG, type OpponentProfile } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const HANDS = Number(process.env.HANDS || 100_000);

// A realistic low-stakes field is weighted toward recreational players; TAG included for honesty.
const field: { profile: OpponentProfile; weight: number; label: string }[] = [
  { profile: STATION, weight: 0.35, label: "Calling stations" },
  { profile: NIT, weight: 0.25, label: "Nits" },
  { profile: LAG, weight: 0.20, label: "Loose-aggressive" },
  { profile: TAG, weight: 0.20, label: "Solid regulars" },
];

const results = field.map(({ profile, weight, label }, i) => {
  const r = simulate({ villainProfile: profile, hands: HANDS, startingStack: 100, bb: 1, rng: mulberry32(0x5eed + i * 7919) });
  return {
    vs: profile.name,
    label,
    weight,
    bb100: +r.bbPer100.toFixed(2),
    ci95: r.ci95.map((x) => +x.toFixed(2)) as [number, number],
    hands: r.handsPlayed,
  };
});

const blendedBb100 = +results.reduce((a, r) => a + r.bb100 * r.weight, 0).toFixed(2);
const totalHands = results.reduce((a, r) => a + r.hands, 0);

const proof = {
  generated: new Date().toISOString().slice(0, 10),
  engine: "MonteCarloEdge GTO engine",
  method: "Heads-up self-play: the MCE strategy vs each opponent archetype, exact-equity decisions. Reproducible (seeded).",
  totalHands,
  blendedBb100,
  results,
};

writeFileSync("public/proof-data.json", JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
console.log(`\nBlended MCE edge vs a typical field: ${blendedBb100 >= 0 ? "+" : ""}${blendedBb100} bb/100 over ${totalHands.toLocaleString()} hands`);
