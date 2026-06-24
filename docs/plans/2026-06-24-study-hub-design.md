# Study Hub — design

**Goal:** Add a learning/study dimension to MonteCarloEdge that fills the home space the compact mode tiles opened up, and gives the app depth beyond "play hands." Four features behind a "Sharpen your game" home section: **Range Charts**, **Drills**, **Lessons**, **Stats** (Stats already exists).

**Approved scope (2026-06-24):** build **Range Charts first**, and go deep — RFI + BB-defense (existing engine data) **plus** 3-bet / vs-3-bet ranges (new data I author in the same format).

---

## Home: "Sharpen your game" section

A new labelled block directly under the mode tiles, reusing the compact horizontal tile style:

```
SHARPEN YOUR GAME
[📊 Charts · GTO ranges]  [🎯 Drills · Quick reps]  [📖 Lessons · GTO explained]
```

Each card routes to its screen. Stats/Leaks stays on the existing GTO-accuracy strip. For the Charts slice only the Charts card goes live; Drills/Lessons cards are added when those features land (no dead "coming soon" cards).

## Feature 1 — Range Charts (this slice)

**Screen** `S.screen = "charts"`, `renderCharts()` in `main.ts` (one render path — no new framework).

**Grid:** the canonical 13×13 hand matrix. Ranks A,K,Q,J,T,9..2 on both axes. Cell (row r, col c):
- `r == c` → pair (AA, KK, …)
- `r < c`  → suited (upper-right triangle: AKs, AQs, …)
- `r > c`  → offsuit (lower-left: AKo, AQo, …)

**Cell colour = the action for that hand class in the selected spot**, tested via `Range.has(representativeCombo)` (these ranges are pure class-in/out, so one combo per class suffices):
- raise / 3-bet / 4-bet → accent (emerald→gold by aggression)
- call → azure
- fold → dim glass

**Controls:**
- Table size: 6-max / 9-max / HU (drives `pickChart`).
- Scenario: **Open (RFI)** · **vs Open** (fold/call/3-bet) · **vs 3-Bet** (fold/call/4-bet).
- Position selector: the hero seat (and, for vs-Open/vs-3-Bet, the opener) — chips along the top.

**Readout:** range width ("opens 18% of hands") computed from combo count / 1326.

## Data (new, authored in `src/engine/charts/`)

Existing: `RFI`, `BB_DEFENSE` per position in `preflop-{6max,9max,hu}.ts`.

Add, same `Record<string,string>` poker-notation format:
- `THREEBET` — hero's 3-bet range vs an opener, keyed `"<hero>_vs_<opener>"` for the common spots (BB/SB/BTN/CO vs earlier opens). Value+bluff blended into one "3-bet" set per spot (v1; can split colours later).
- `FOURBET` — opener's 4-bet (or call) range facing a 3-bet, keyed `"<opener>_vs_<threebettor>"` for common spots.
- New getters `getThreeBetRange(size, hero, opener)` / `getFourBetRange(size, opener, threebettor)` in `charts/index.ts`, mirroring the existing cache/alias logic; return `null` for spots not yet covered (UI shows "chart coming for this spot").

Ranges are GTO-approximate standard charts (well-known solver outputs), authored as strings; no engine maths changes, so no gate impact. Coverage is the common spots, expandable.

## Build slices (ship + show each)

1. **Range Charts** — data + grid UI + controls + home Study section w/ Charts card. ← this slice
2. Drills hub + **Range Memory** drill (reuses chart data).
3. Lessons (restructure the existing explainer into a browsable list + per-lesson check).
4. Stats polish (accuracy-over-time line) + remaining drills (Pot-Odds, Push/Fold).

## Non-goals / guardrails

- One render path (`main.ts` + `styles.css`); no second component.
- Engine purity untouched — charts are static data + UI; no `Math.round` in engine, no chip logic.
- No new deps. SW cache bump on the hosting deploy.
