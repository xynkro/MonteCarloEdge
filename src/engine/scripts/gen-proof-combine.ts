// Combine the 4 per-archetype slices (gen-proof-one.ts) into public/proof-data.json, in the
// exact shape gen-proof.ts produces and the Proof page reads. Idempotent: re-runnable once all
// 4 slice files exist. Fails loudly if any slice is missing (so we never publish a partial field).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const parts = [0, 1, 2, 3].map((i) => {
  const p = `/tmp/proof_arch_${i}.json`;
  if (!existsSync(p)) throw new Error(`missing slice ${p} — run all 4 gen-proof-one.ts first`);
  return JSON.parse(readFileSync(p, "utf8"));
});

const totalHands = parts.reduce((a, r) => a + r.hands, 0);
const blendedBb100 = +parts.reduce((a, r) => a + r.bb100 * r.weight, 0).toFixed(2);

const proof = {
  generated: new Date().toISOString().slice(0, 10),
  engine: "MonteCarloEdge GTO engine",
  method: "Heads-up self-play: the MCE strategy vs each opponent archetype, exact-equity decisions. Reproducible (seeded).",
  totalHands,
  blendedBb100,
  results: parts,
};

writeFileSync("public/proof-data.json", JSON.stringify(proof, null, 2));
console.log("COMBINED", { totalHands, blendedBb100, results: parts.map((r) => `${r.vs}:${r.bb100}`) });
