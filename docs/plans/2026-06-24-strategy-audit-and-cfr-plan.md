# Strategy audit (bluff frequency) + CFR-connection plan

Grounded by a 4-way investigation (empirical bluff measurement over 30,000 self-play hands,
bluff-knob map, GTO baselines, CFR-solver scope), 2026-06-24.

---

## A — Bluffing verdict

**MCE bluffs about right on flop/turn but is systematically RIVER-UNDERBLUFFED (~11 pts under
GTO) across every archetype.** Fix the value-heavy river by lifting the brick give-up / kill
floors — NOT the per-archetype opening frequencies.

Measured vs GTO (all archetypes), 12,046 classified postflop bets:

| Street | MCE bluff% | GTO baseline | Read |
|---|---|---|---|
| Flop | 48.2% | ~40–55% (semi-bluff heavy) | about right |
| Turn | 41.8% | ~35–45% | about right |
| **River** | **22.2%** | **~33% (pot-sized cap)** | **underbluffed −10.8 pts** |

Per-archetype river bluff%: Maniac 26.9 · LAG 20.8 · Nit 19.7 · TAG 18.5 · Station 17.3 — every
one under the ~33% cap; ordering is correct.

**Mechanism (not the opening knobs):** the river deficit comes from the give-up cascade in
`villainPostflopAct` — brick give-up `betProb = barrelFreq*(1-coherence)*0.5 + 0.05`
(`opponent.ts:540`) collapses coherent types (TAG 0.85, Nit 0.80) to ~0.05–0.10 on bricks (most
rivers), and kill `betProb = 0.03` (`opponent.ts:543`). Nothing ever re-injects river bluffs to
hit the pot-odds ratio. The parallel server story engine has the same structural give-up at
`villain-ai.ts:138`.

**Fixes (tune against a re-measure targeting river ~30–33%):**
1. `opponent.ts:540` brick floor 0.05 → ~0.18 (coherence-independent term so coherent types still fire some river bluffs).
2. `opponent.ts:543` kill floor 0.03 → 0.08–0.10 (secondary).
3. `villain-ai.ts:138` server-path giveUp `coherence*0.7` → `coherence*0.55` (mirror, or the online bots keep underbluffing).
4. (Optional) blocker-aware river bluff selection so the *added* bluffs are good bluffs.

Do NOT raise per-archetype `bluffFreq`/`semiBluffFreq` (`opponent.ts:43-73`) — they gate the opens,
and flop/turn are already in-band; raising them over-bluffs the flop while barely helping the river.

---

## B — Study-hub #2: connect the CFR solver

**Goal:** extend live CFR from "river, leading, HU only" to (a) river facing-a-bet, (b) flop via
precomputed blueprint, (c) turn via blueprint-seeded live solve — wired into BOTH the trainer rec
and the server bots, with no latency regression and **never live CFR inside a Firestore transaction.**

**Load-bearing split:** live CFR client-side (trainer); **blueprint-only server-side** (bots) —
`runBots` chains bots inside the `act`/`startHand` transaction (`functions/src/index.ts:387`), so
N bots × ~0.3s live solve = timeout. Bots get O(1) blueprint lookups only.

What exists: `solveSubgame()` (`river-solver.ts:292`) is real vanilla CFR and ALREADY models
facing-a-bet (`:119-126`) — only the root is hardwired to leading (`:319-322`). `equityLeaf`
makes flop/turn single-street + cheap (`:178-211`). Trainer's `liveSolverSpot` gates to
river/lead/HU (`main.ts:719-720`). Bots never touch CFR (`villain-ai.ts:53`).

**Budgets:** trainer solves stay <0.5s background; flop blueprint lookups O(1) <1ms; server bots
keep ~current `villainDecision` cost; bundle delta ≤ ~100KB gzip (flop blueprint as a lazy `.bin`
~0.6–1MB for the client, a texture-bucketed ~90KB-gzip inline table for the server).

### Sliced build order

| Slice | What | Effort |
|---|---|---|
| **0 — River facing-a-bet (trainer, live)** | Solver already models it; add `facingBet` to the spot + seed the root inv/history, drop the `toCall` gate (`main.ts:720`), extend `solverToRec` for fold/call/raise, add facing to the cache key, unit-test non-uniform resolution. **~30 lines, zero latency cost, doubles live coverage.** Ship first. | XS |
| **1 — Flop blueprint generator (offline)** | `gen-flop-blueprint.ts` (mirror `gen-pushfold-chart.ts`); solve 1,755 canonical flops; quantize uint8 → lazy `.bin` (client) + bucketed inline-TS (server). Validate cells vs fresh high-iter solve. | L (one-time compute) |
| **2 — Trainer flop auto-path consults blueprint** | Wire lookup into `liveSolverSpot`/`runLiveSolve`/`render`; flop recs instant + GTO-grade; `source:"blueprint"`; add LRU cap to the unbounded `liveSolveCache` (`main.ts:326`). | S |
| **3 — Server bots + assisted rec consult bucketed blueprint** | Blueprint consult in `villainDecision` for flop, archetype + story layers kept on top, sample via `cryptoRng`. No live CFR in `runBots`. Gate with `stress.ts` perf + chip conservation. | M |
| **4 — Turn via blueprint-seeded live solve** | Cheap turn `equityLeaf` solve seeded from flop blueprint ranges; trainer manual button first. Server stays blueprint-only. | M |
| **5 (optional) — Full turn blueprint** | Only if Slice 4 proves too slow. Largest cost. | XL |

**Failure modes:** root-key/infoKey mismatch on facing-bet → `average()` silently returns uniform
(unit-test it); blueprint miss → fall back to heuristic (never crash a bot tick / persist write);
live CFR leaking into `runBots` → forbidden (perf gate in `stress.ts`); label `source:"blueprint"`
≠ `"solver"` so the trainer is honest; engine purity (fractional, round only at the MP boundary);
bots sample mixes via `rng`/`cryptoRng`, never `Math.random`.
