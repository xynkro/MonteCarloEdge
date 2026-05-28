# MonteCarloEdge

Live decision assistant for No-Limit Texas Hold'em home games.

You key in the action as it happens at the table — who sits where, who bet
what, what your cards are, what the board looks like — and the app
recommends your action (fold / call / raise / size) with the math behind
the recommendation. The goal: remove decision error so that only the
inherent variance of the cards remains.

## Build status

**Phase 1: equity engine — complete and validated.**

| Layer | What it proves | Status |
|---|---|---|
| Evaluator unit tests | 7-card hand evaluator correctly identifies and orders every category | 40/40 passing |
| Structural mirror | Any hand vs its own suit-mirror equals exactly 50% (end-to-end pipeline check) | 4/4 passing |
| Exhaustive enumeration | 1,712,304 boards per spot → exact ground-truth equity, derived from a verified evaluator | computed in ~15s |
| Monte Carlo convergence | 200k-iteration sampler must agree with exhaustive within 4× its 95% CI | 7/7 passing |

Remaining phases:

- Phase 2 — preflop range tables (HU through 10-max) + range-aware equity
- Phase 3 — decision engine + self-play backtest against opponent archetypes
- Phase 4 — UI (setup, seat ring, action flow, elimination, card picker)
- Phase 5 — PWA shell, hand history, GitHub Pages deploy

## Scripts

```bash
npm test         # vitest, unit suite
npm run validate # exhaustive + Monte Carlo Layer 1 validation report
```

## Engine layout

- `src/engine/cards.ts` — card encoding (0–51), parsing, deck
- `src/engine/evaluator.ts` — 7-card hand evaluator, packed-integer ranking
- `src/engine/equity.ts` — Monte Carlo and exhaustive equity calculators
- `src/engine/rng.ts` — seedable PRNG (mulberry32) for reproducible runs
- `src/engine/scripts/validate.ts` — Layer 1 validation harness
