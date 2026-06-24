// One-archetype slice of the proof backtest. Splitting the field into 4 processes lets the
// 1M-hand run finish in ~10min across cores (vs ~40min single-threaded) and — when launched
// detached (nohup) — survives a Claude/harness session reload that would kill a tracked task.
// Seeds MATCH gen-proof.ts (0x5eed + i*7919) so the parallel result is identical to the
// sequential one. Writes atomically (tmp + rename) so a watcher polling the final file never
// sees a half-written slice. Run: ARCH=0 HANDS=250000 npx tsx src/engine/scripts/gen-proof-one.ts
import { writeFileSync, renameSync } from "node:fs";
import { simulate } from "../simulator.js";
import { STATION, NIT, TAG, LAG, type OpponentProfile } from "../opponent.js";
import { mulberry32 } from "../rng.js";

const FIELD: { profile: OpponentProfile; weight: number; label: string }[] = [
  { profile: STATION, weight: 0.35, label: "Calling stations" },
  { profile: NIT, weight: 0.25, label: "Nits" },
  { profile: LAG, weight: 0.20, label: "Loose-aggressive" },
  { profile: TAG, weight: 0.20, label: "Solid regulars" },
];

const i = Number(process.env.ARCH);
const HANDS = Number(process.env.HANDS || 250000);
const out = process.env.OUT || `/tmp/proof_arch_${i}.json`;
const slice = FIELD[i];
if (!slice) throw new Error(`ARCH must be 0..3, got ${process.env.ARCH}`);

const r = simulate({ villainProfile: slice.profile, hands: HANDS, startingStack: 100, bb: 1, rng: mulberry32(0x5eed + i * 7919) });
const result = {
  vs: slice.profile.name,
  label: slice.label,
  weight: slice.weight,
  bb100: +r.bbPer100.toFixed(2),
  ci95: r.ci95.map((x) => +x.toFixed(2)) as [number, number],
  hands: r.handsPlayed,
};
writeFileSync(out + ".tmp", JSON.stringify(result));
renameSync(out + ".tmp", out); // atomic publish
