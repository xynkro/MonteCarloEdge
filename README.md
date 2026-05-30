# MonteCarloEdge

Live decision assistant for No-Limit Texas Hold'em home games.

You key in the action as it happens at the table — who sits where, who bet
what, what your cards are, what the board looks like — and the app
recommends your action (fold / call / raise / size) with the math behind
the recommendation. The goal: remove decision error so that only the
inherent variance of the cards remains.

## Build status

Live: **https://xynkro.github.io/MonteCarloEdge/**

**Phase 1: equity engine — complete and validated.**

| Layer | What it proves | Status |
|---|---|---|
| Evaluator unit tests | 7-card hand evaluator correctly identifies and orders every category | 40/40 passing |
| Structural mirror | Any hand vs its own suit-mirror equals exactly 50% (end-to-end pipeline check) | 4/4 passing |
| Exhaustive enumeration | 1,712,304 boards per spot → exact ground-truth equity, derived from a verified evaluator | computed in ~15s |
| Monte Carlo convergence | 200k-iteration sampler must agree with exhaustive within 4× its 95% CI | 7/7 passing |

**Phase 2: ranges + range-aware equity — complete and validated.**

| Layer | What it proves | Status |
|---|---|---|
| Range round-trip | Parse → encode → re-parse produces identical combo sets | 9/9 passing |
| Sampler bias | Single-hand range vs direct HU equity agree within statistical tolerance | 3/3 passing |
| Canonical equity spots | Range-vs-range equity for known positions falls within expected bounds | 3/3 passing |

**Phase 3: decision engine + self-play — complete and validated.**

| Layer | What it proves | Status |
|---|---|---|
| Preflop sanity | Premium hands raise, trash folds, BB defends/folds correctly | 9/9 passing |
| EV sign checks | Equity estimates match board texture, positive EV → call/raise | 5/5 passing |
| Sizing bounds | Opens 2-3bb, postflop ⅓–1× pot, 3-bets > open | 5/5 passing |
| Self-play vs Station | Hero is +EV against calling station (100k hands HU) | bb/100 > 5 |
| Self-play vs Nit | Hero is +EV against nit | bb/100 > 3 |
| Self-play vs TAG | Hero holds vs tight-aggressive opponent | bb/100 > −2 |
| Self-play vs LAG | Hero is +EV against loose-aggressive opponent | bb/100 > 0 |

**Phase 4: app + advanced engine — complete.**

- Installable, offline PWA (oval table UI, card picker, numpad, sounds, animations).
- Multi-way equity, position-aware equity realization, board-texture-aware sizing.
- Adaptive opponent modeling (learns each seat's VPIP/PFR/c-bet/fold tendencies).
- Training mode vs the AI, post-hand review, session P&L stats, CSV export.

**Phase 5: GTO solver (CFR) — complete and validated.**

| Layer | What it proves | Status |
|---|---|---|
| CFR on Kuhn poker | Engine converges to the known analytic equilibrium (value −1/18, Q never bluffed first-in, Q calls ~⅓, K value-bets 3× the J bluff) | 5/5 passing |
| River subgame solver | Exact CFR solve of a river spot → GTO mixed strategy; nuts bets, air mixes checks, freqs sum to 1 | 4/4 passing |
| Turn solver | Street-aware CFR over all river runouts; nuts never loses, value-bets vs calling ranges, deterministic | 5/5 passing |
| Preflop push/fold Nash | Jam/call equilibrium matches known push/fold theory (tightens with depth, BB calls tighter, ~27% call at 10bb) | 7/7 passing |

In-app: "🧠 Solve GTO" runs the CFR solver live — preflop push/fold (≤20bb HU),
or the turn/river subgame solver — and shows the optimal mixed strategy with EV.

## Scripts

```bash
npm test                  # vitest, unit suite (226 tests)
npm run validate          # exhaustive + Monte Carlo Layer 1 validation report
npm run validate-ranges   # Layer 2: range parsing, sampler bias, canonical spots
npm run validate-decisions # Layer 3: decision sanity, EV checks, sizing bounds
npm run self-play         # HU self-play backtest vs 4 opponent archetypes (100k hands)
```

## Engine layout

- `src/engine/cards.ts` — card encoding (0–51), parsing, deck
- `src/engine/evaluator.ts` — 7-card hand evaluator, packed-integer ranking
- `src/engine/equity.ts` — Monte Carlo and exhaustive equity calculators
- `src/engine/rng.ts` — seedable PRNG (mulberry32) for reproducible runs
- `src/engine/range.ts` — Range class (parse, filter, sample, encode)
- `src/engine/charts/` — preflop RFI + BB defense charts (HU, 6-max, 9-max)
- `src/engine/hand-strength.ts` — Chen formula hand ranking, range slicing
- `src/engine/game-state.ts` — hand state tracker (streets, actions, pot math)
- `src/engine/sizing.ts` — geometric + SPR-based bet sizing
- `src/engine/opponent.ts` — 4 opponent archetypes (TAG, LAG, Station, Nit)
- `src/engine/decision.ts` — decision engine: recommend fold/call/raise + sizing
- `src/engine/simulator.ts` — HU self-play backtest harness
- `src/engine/scripts/validate.ts` — Layer 1 validation harness
- `src/engine/scripts/validate-ranges.ts` — Layer 2 validation
- `src/engine/scripts/validate-decisions.ts` — Layer 3 validation
- `src/engine/scripts/self-play.ts` — self-play backtest runner
