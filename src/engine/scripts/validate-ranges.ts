import { type Card, parseCard, NUM_CARDS } from "../cards.js";
import { evaluate } from "../evaluator.js";
import { monteCarloEquity, monteCarloEquityVsRange } from "../equity.js";
import { Range } from "../range.js";
import { mulberry32 } from "../rng.js";
import { getRfiRange, getBbDefenseRange } from "../charts/index.js";

const ITERS = 200_000;

function fmt(v: number, dp = 3): string {
  return (v * 100).toFixed(dp) + "%";
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  MonteCarloEdge — Layer 2 Validation: Ranges & Range Equity  ");
console.log("═══════════════════════════════════════════════════════════════\n");

// ─── (1) Range parsing round-trip ────────────────────────────────────────────

console.log("(1) Range parsing round-trip tests\n");

const roundTripCases = [
  "AA",
  "AKs",
  "AKo",
  "AK",
  "AA,KK,QQ,JJ",
  "22+",
  "ATs+",
  "22-66",
  "AA,AKs,AKo,KK,QQ,JJ+",
];

let rtPass = 0;
let rtFail = 0;

for (const input of roundTripCases) {
  const r1 = Range.parse(input);
  const encoded = r1.encode();
  const r2 = Range.parse(encoded);

  const sizeMatch = r1.size === r2.size;
  const combosMatch =
    r1.combos.every((c) => r2.has(c)) && r2.combos.every((c) => r1.has(c));
  const ok = sizeMatch && combosMatch;

  console.log(
    `  ${pad(input, 30)} → ${pad(encoded, 40)} size=${r1.size}→${r2.size}  ${ok ? "PASS" : "FAIL"}`,
  );
  if (ok) rtPass++;
  else rtFail++;
}

console.log(`\nRound-trip: ${rtPass}/${rtPass + rtFail} passed\n`);

// ─── (2) Range-aware MC sampler bias check ───────────────────────────────────

console.log(
  "(2) Sampler bias check: hero vs single-hand range must match direct HU\n",
);

const biasSpots = [
  { hero: "AsKs", villain: "2c2d", label: "AKs vs 22" },
  { hero: "JdJc", villain: "AhKd", label: "JJ vs AKo" },
  { hero: "TsTh", villain: "9s9h", label: "TT vs 99" },
];

let biasPass = 0;
let biasFail = 0;

for (const { hero: hStr, villain: vStr, label } of biasSpots) {
  const hero: [number, number] = [
    parseCard(hStr.slice(0, 2)),
    parseCard(hStr.slice(2, 4)),
  ];
  const villain: [number, number] = [
    parseCard(vStr.slice(0, 2)),
    parseCard(vStr.slice(2, 4)),
  ];
  const singleRange = Range.fromCombos([villain]);

  const direct = monteCarloEquity({
    hero,
    opponents: [villain],
    iterations: ITERS,
    rng: mulberry32(0xface),
  });

  const ranged = monteCarloEquityVsRange({
    hero,
    villainRange: singleRange,
    iterations: ITERS,
    rng: mulberry32(0xface),
  });

  const delta = Math.abs(direct.equity - ranged.equity);
  const threshold = 4 * direct.stderr95;
  const ok = delta < threshold;

  console.log(
    `  ${pad(label, 20)} direct=${fmt(direct.equity)}  range=${fmt(ranged.equity)}  Δ=${(delta * 100).toFixed(3)}pp  (limit ${(threshold * 100).toFixed(3)}pp)  ${ok ? "PASS" : "FAIL"}`,
  );
  if (ok) biasPass++;
  else biasFail++;
}

console.log(`\nSampler bias: ${biasPass}/${biasPass + biasFail} passed\n`);

// ─── (3) Canonical range-vs-range equity spots ────────────────────────────────

console.log("(3) Canonical range-vs-range equity spots\n");

interface Spot {
  label: string;
  tableSize: number;
  openerPos: string;
  expectedLo: number;
  expectedHi: number;
}

const spots: Spot[] = [
  {
    label: "6-max BTN open vs BB defense",
    tableSize: 6,
    openerPos: "BTN",
    expectedLo: 0.50,
    expectedHi: 0.58,
  },
  {
    label: "6-max UTG open vs BB defense",
    tableSize: 6,
    openerPos: "UTG",
    expectedLo: 0.50,
    expectedHi: 0.62,
  },
  {
    label: "HU BTN open vs BB defense",
    tableSize: 2,
    openerPos: "BTN",
    expectedLo: 0.46,
    expectedHi: 0.54,
  },
];

let spotPass = 0;
let spotFail = 0;

for (const spot of spots) {
  const opener = getRfiRange(spot.tableSize, spot.openerPos);
  const defender = getBbDefenseRange(spot.tableSize, spot.openerPos);

  const rng = mulberry32(0xd00d);
  let eqSum = 0;
  let count = 0;

  for (let i = 0; i < ITERS; i++) {
    const heroCombo = opener.sample(rng);
    if (!heroCombo) continue;

    const defFiltered = defender.filter([heroCombo[0], heroCombo[1]]);
    const villCombo = defFiltered.sample(rng);
    if (!villCombo) continue;

    const used = new Uint8Array(NUM_CARDS);
    used[heroCombo[0]] = 1;
    used[heroCombo[1]] = 1;
    used[villCombo[0]] = 1;
    used[villCombo[1]] = 1;

    const deck: Card[] = [];
    for (let c = 0; c < NUM_CARDS; c++) if (!used[c]) deck.push(c);

    for (let j = 0; j < 5; j++) {
      const idx = j + Math.floor(rng() * (deck.length - j));
      const tmp = deck[j]!;
      deck[j] = deck[idx]!;
      deck[idx] = tmp;
    }

    const board = [deck[0]!, deck[1]!, deck[2]!, deck[3]!, deck[4]!];
    const hRank = evaluate([heroCombo[0], heroCombo[1], ...board]);
    const vRank = evaluate([villCombo[0], villCombo[1], ...board]);

    if (hRank > vRank) eqSum += 1;
    else if (hRank === vRank) eqSum += 0.5;
    count++;
  }

  const equity = eqSum / count;
  const ok = equity >= spot.expectedLo && equity <= spot.expectedHi;

  console.log(
    `  ${pad(spot.label, 35)} equity=${fmt(equity)}  expected=${fmt(spot.expectedLo)}-${fmt(spot.expectedHi)}  (${count} samples)  ${ok ? "PASS" : "FAIL"}`,
  );

  console.log(
    `    opener=${opener.size} combos (${opener.percentage.toFixed(1)}%)  defender=${defender.size} combos (${defender.percentage.toFixed(1)}%)`,
  );

  if (ok) spotPass++;
  else spotFail++;
}

console.log(`\nCanonical spots: ${spotPass}/${spotPass + spotFail} passed\n`);

// ─── (4) Range size summary ─────────────────────────────────────────────────

console.log("(4) Range size summary\n");

console.log("  6-max RFI:");
for (const pos of ["UTG", "MP", "CO", "BTN", "SB"]) {
  const r = getRfiRange(6, pos);
  console.log(
    `    ${pad(pos, 6)} ${r.size} combos = ${r.percentage.toFixed(1)}%`,
  );
}

console.log("\n  6-max BB defense:");
for (const pos of ["UTG", "MP", "CO", "BTN", "SB"]) {
  const r = getBbDefenseRange(6, pos);
  console.log(
    `    vs ${pad(pos, 4)} ${r.size} combos = ${r.percentage.toFixed(1)}%`,
  );
}

console.log("\n  9-max RFI:");
for (const pos of ["UTG", "UTG1", "UTG2", "MP", "HJ", "CO", "BTN", "SB"]) {
  const r = getRfiRange(9, pos);
  console.log(
    `    ${pad(pos, 6)} ${r.size} combos = ${r.percentage.toFixed(1)}%`,
  );
}

console.log("\n  HU:");
const huBtn = getRfiRange(2, "BTN");
const huDef = getBbDefenseRange(2, "BTN");
console.log(
  `    BTN open   ${huBtn.size} combos = ${huBtn.percentage.toFixed(1)}%`,
);
console.log(
  `    BB defense ${huDef.size} combos = ${huDef.percentage.toFixed(1)}%`,
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(
  "\n═══════════════════════════════════════════════════════════════",
);

const totalPass = rtPass + biasPass + spotPass;
const totalFail = rtFail + biasFail + spotFail;

console.log(
  `\nLayer 2 ${totalFail === 0 ? "PASSED" : "FAILED"} — ${totalPass}/${totalPass + totalFail} checks`,
);
console.log(`  Round-trip:       ${rtPass}/${rtPass + rtFail}`);
console.log(`  Sampler bias:     ${biasPass}/${biasPass + biasFail}`);
console.log(`  Canonical spots:  ${spotPass}/${spotPass + spotFail}`);

if (totalFail > 0) process.exit(1);
