# MCE Strategy — Human & Betting Heuristics Audit

> Code-grounded audit of the live recommendation engine (`recommend()` in `src/engine/decision.ts`).
> 19 agents mapped the decision stack and adversarially re-verified every claimed gap against source.
> Companion to `poker-psychology-and-betting.md` (the cited literature behind these heuristics).

## Verdict

**Partly right — but the headline framing ("too GTO-pure / missing human & betting heuristics") is wrong as stated.**

- The `recommend()` path is **NOT GTO-pure**. It is already heavily exploit-forward postflop.
- The live **CFR solver is a UI-only teaching overlay** (`solveSubgame` is imported only in `main.ts`), **not** the live engine. Postflop recommendations are Monte-Carlo equity + heuristics (`source: "heuristic"`), unless a cached solve overwrites them.
- Where the user is **right**: the exploit layer is **scalar / aggregated** (it reads average `sticky` / `foldy` / `aggro` + bet-size classes), **not tactical / named**. A set of famous population tells never got promoted into an explicit hero deviation — and, the structural kicker, the bluff-read fields the engine leans on are **frozen at the archetype prior and never learned from actual play**.

## What already exists (verified — do NOT rebuild)

| Heuristic | Location |
|---|---|
| Sticky-station value sizing-up (`valueMult` 1.0–1.5×) | `decision.ts:688` |
| Thin-value discount vs stations (`stickyDiscount`) | `decision.ts:699` |
| Semi-bluff gated off pure folders (`semiBluffOK = foldy>0.28`) | `decision.ts:691` |
| Call-cushion vs value-heavy stations | `decision.ts:694` |
| Multi-branch bluff-catch read (size-class × runout × coherence → `callBar`) | `decision.ts:723–776` |
| Counter-bluff / re-bluff (HU only, excludes Station/LAG/Maniac) | `decision.ts:806–841` |
| Implied-odds peel scaled by field stickiness | `decision.ts:850–872` |
| Light-3bet widening vs foldy openers (`exploitMult`) | `decision.ts:563–567` |
| Bet-size tells narrow villain range (`sizeClass` + `narrowPostflop`) | `opponent.ts:185–211` |
| Texture-aware sizing (`texAdj` 0.85–1.15) | `decision.ts:892` |
| Geometric multi-street value planning (`recommendSize`) | `sizing.ts:17–34` |
| Rep-aware bluff sizing (`credibleRep`) | `opponent.ts:398` |
| Adaptive profiles (observed VPIP/PFR/cbet/foldToCbet/foldToRaise/calldown, Bayesian-shrunk, `PRIOR_WEIGHT=12`) | `player-model.ts` + `main.ts buildProfiles` |

## Confirmed gaps (11 survived adversarial verification)

| # | Kind | Gap | Impact | Risk |
|---|---|---|---|---|
| **G4** | human-exploit | **`bluffFreq`/`barrelFreq`/`coherence` are FROZEN at the archetype prior — never learned.** The whole bluff-catch + counter-bluff machinery is keyed on them. | **Structural root** | Low |
| G1 | human-exploit | Donk-lead (OOP lead into the PF raiser) never flagged as weak | High | Med |
| G2 | betting | Raise **size** never read as strength; min-raise = same top-30% slice as a pot-raise | High | Med |
| G3 | human-exploit | **Preflop is profile-blind** (only the 3-bet dial reads a seat). No fold-more vs nits, no trap vs LAGs, no blind-pool read. *(the one place "too GTO-pure" literally lands)* | High | Med |
| G10 | human-exploit | Small/min bluff-catch is a flat `-0.04` for ALL types (maniac stab == nit bet) | Med | Low |
| G6 | betting | Bluff/semi-bluff size never calibrated to villain fold-equity | Med | Low |
| G8 | human-exploit | Blind-vs-blind / limped-pot population weakness not modelled | Med-high | Low |
| G7 | betting | No nut/range-advantage sizing (overbet on advantage boards, small range-cbet on dry) | Med | Med |
| G5 | human-exploit | Check-raise absent — as a villain READ *and* a hero ACTION | Med-high | Read low / action med |
| G12 | betting | SPR-aware commitment only fires for the top value tier; 3bet/4bet sizes are flat multiples | Med | Low-med |
| G11 | human-exploit | No cross-street bluff-**story** memory (busted-story barrel discarded) | Low-med | Low |

All 11 are **engine-purity-safe** (live in the range/profile or sizing-scalar layer; no `Math.round` inside the engine, no break to bb-normalization).

## Build plan

**Ship first — one pass in the opponent-model layer:**
1. **G4 (the root):** add `bluffActs/bluffOpps` (+ barrel) counters to `PlayerStats`; classify value-vs-air at showdown in `observeHand`; add those frequencies to `blendProfile`'s blend list. Un-freezes the fields every bluff-catch/counter-bluff branch already depends on → sharpens reads engine-wide. *(Verify showdown hole-card / "showed" availability in `GameState` first.)*
2. **G10:** replace the flat `-0.04` small-bet adjustment with a coherence-scaled term (mirrors the overbet branch already in the file).
3. **G2 read-side:** condition the `raised` slice on raise pot-fraction + villain passivity instead of a flat `slice(0,0.30)`.
4. **G1 read-side:** add a `donkLead` flag in `narrowPostflop`, weaken the slice when villain led OOP as the PF caller.
5. **G6:** multiply the existing bluff frac by a `foldToCbet/foldToRaise`-derived fold-equity scalar.

**Bigger bets (schedule next):**
- **Named-read layer:** promote the scalar exploit layer into a small table of named population tells (donk=weak, min-raise-from-passive=nuts, check-raise=value, limped/blind pool=under-bluffed), each emitting an explicit hero deviation. *This is the architecture the user is really pointing at.*
- **G3 preflop exploit refactor** — thread each opener's adapted profile into flat/defense/limp-trap widths.
- Hero check-raise as a first-class action (G5 action side).
- Range/nut-advantage sizing engine (G7).
- Cross-street bluff-story memory (G11) — pairs naturally with un-frozen G4 stats.

## Risks
1. **Sample noise** — un-freezing bluff stats (G4) + raise-size reads (G2) can swing hard on tiny samples. Keep shrinkage + gate new tells behind a minimum-opportunity count.
2. **Over-exploitation vs identity** — stacking named deviations makes hero exploitable back and muddies MCE's "GTO trainer" brand. Present exploit tells as **overlays on the GTO baseline** (or behind the `HeroStyle.aggression/looseness` dials), and keep `source`/`reasoning` labels honest so the trainer still teaches the GTO line.
3. **UX, not just engine:** the rich exploit logic is invisible in the terse reasoning string. Surfacing the *named read* ("folding — a min-raise from a passive player here is almost always the nuts") is both a teaching win and a marketing one (people *see* the edge).
