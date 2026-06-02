// Short-stack self-play: validates the push/fold logic actually helps when the
// stack is shallow (where the old engine kept min-raising/folding). Compares
// bb/100 at a 15bb effective stack vs each archetype.
import { mulberry32 } from "../rng.js";
import { simulate } from "../simulator.js";
import { TAG, LAG, STATION, NIT } from "../opponent.js";

const HANDS = 60_000;
const BB = 1;

for (const STACK of [15, 12]) {
  console.log(`\n=== ${STACK}bb effective ===`);
  for (const profile of [TAG, LAG, STATION, NIT]) {
    const r = simulate({
      villainProfile: profile,
      hands: HANDS,
      startingStack: STACK,
      bb: BB,
      rng: mulberry32(0xb0a4d),
    });
    console.log(
      `  vs ${profile.name.padEnd(8)} bb/100 = ${r.bbPer100.toFixed(2).padStart(8)}  ` +
        `95% CI [${r.ci95[0].toFixed(1)}, ${r.ci95[1].toFixed(1)}]`,
    );
  }
}
