# Proof promotion kit — the 1,000,000-hand backtest

**Asset:** montecarloedge.web.app/proof.html · **Data:** 1,000,000 hands, blended **+117.75 bb/100**, wins every archetype (Station +201, LAG +103, regs +68, Nit +52), seeded + reproducible.

**Audience:** skeptical serious players (r/poker, r/GTOpoker, poker X). They've seen a hundred scammy "GTO" apps. **The reproducibility — not the bb/100 — is the hook.** Lead with transparency, disclose the caveats yourself, invite them to break it. Never hard-sell.

---

## Reddit post (r/poker, r/GTOpoker, r/poker_theory)

**Title:** I built a GTO trainer and backtested its engine over 1,000,000 hands — seeded, so you can reproduce it. Roast my methodology.

**Body:**

Every "GTO" app makes a win-rate claim with zero evidence behind it. That always bugged me, so when I built mine (a GTO trainer) I did the opposite — ran the *actual* recommendation engine (the same code behind the in-app advice) through **1,000,000 hands** of heads-up self-play against a weighted field of opponent archetypes — calling stations, nits, LAGs, solid regs — with **exact-equity decisions**, and seeded the RNG so the whole run is reproducible.

Result (field weighted toward a recreational pool):

| vs | bb/100 | 95% CI |
|---|---|---|
| Calling stations | **+201** | 192 – 210 |
| Loose-aggressive | **+103** | 96 – 110 |
| Solid regulars | **+68** | 62 – 74 |
| Nits | **+52** | 47 – 57 |
| **Blended** | **+117.75** | |

Full breakdown + method: montecarloedge.web.app/proof.html

**The honest caveats (because you'll — rightly — look for them):**

- This is the **engine vs calibrated opponent bots, heads-up.** It is **not** a claim about *your* results at a real table, where opponents are tougher and most pots are multiway.
- **+118 bb/100 looks absurd, and it should** — unbalanced bots (stations that never fold, nits that fold too much) are a turkey shoot for exact-equity play. The number isn't the point. The point is the strategy is *provably* winning, the equity math is *exact* (validated against full enumeration), and the **whole thing is reproducible** — same seed, same result, every time.
- I'm posting *because* I want it broken. **What would make this more convincing to you?** Different field weights? A tougher reg profile? Exploitability/Nash-distance instead of self-play? Genuinely asking.

(It's a free trainer if you want to poke at the engine itself — link in the proof page. No pitch beyond that.)

**Posting notes:** Reddit punishes self-promo — post from a real account with history, reply to every methodology critique in good faith, don't drop-and-run. The "roast it" frame is doing the work; keep it.

---

## X / Twitter thread

**1/** Every "GTO" poker app claims a win rate. None show their work.

So I backtested mine over **1,000,000 hands** — and seeded it so you can reproduce the exact result. 🧵

**2/** The *actual* recommendation engine (same code as the in-app advice) played 1,000,000 hands of heads-up self-play vs a realistic field — stations, nits, LAGs, regs — using exact-equity decisions.

**3/** Blended **+117.75 bb/100**, wins every archetype:
🟢 Stations +201
🟢 LAGs +103
🟢 Regs +68
🟢 Nits +52
[attach proof card]

**4/** The honest part 👇
This is the engine vs *calibrated bots*, not a promise about your real-table results. The bb/100 is sky-high because unbalanced bots are a turkey shoot. The real flex: it's **exact, and reproducible.**

**5/** Same seed → same result, every time. Run it yourself:
🔗 montecarloedge.web.app/proof.html

Play the math.

**Posting notes:** tweet 3 carries the proof-card image. Pin the thread. The reproducibility line (4–5) is the differentiator vs every other poker-app account.

---

## Where each links

All roads → `montecarloedge.web.app/proof.html` (the methodology + breakdown) → "Play the math" → the app. The proof page is the credibility landing; the app is the conversion.
