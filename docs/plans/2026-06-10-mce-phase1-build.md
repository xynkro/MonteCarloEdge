# MCE Phase-1 Monetization Build — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** Turn the validated MCE app into a self-marketing, self-monetizing machine (free trainer hook → visible in-app FOMO → recurring Edge Pass → viral shareable wins → proof page).

**Architecture:** Mostly CLIENT changes over data the server already exposes (per-seat `assisted` was just made per-player). Server adds: result instrumentation (for the proof page + leaderboard) and a referral grant. No new infra; stays on Firebase. Validation via the emulator harness (`npm run emu` + `?emu=1` + `window.__MCE_DEV`) and engine vitest.

**Tech Stack:** vanilla TS + Vite, Firebase (Auth/Firestore/Functions/Hosting), morphdom render, Stripe (founder-set secrets).

**Design ref:** `docs/plans/2026-06-10-mce-monetization-design.md`

---

## Task 1 — FOMO layer (the conversion engine) ⭐ BUILD FIRST

The "5 of 12 at the table run MCE and visibly win; the other guy feels suckered to buy."
Pure client; `publicState.seats[].assisted` already tells every client which seats are entitled.

**Files:**
- Modify: `src/ui/main.ts` (net seat markup — add MCE badge on `assisted` seats; add upsell)
- Modify: `src/ui/styles.css` (`.mce-badge`, `.fomo-upsell`)

**Step 1 — MCE badge on entitled seats (visible to everyone).** In `renderNetTable`'s seat markup, when `s.assisted === true`, render `<div class="mce-badge" title="Running MCE Strategy">⚡ MCE</div>` on the seat. Glowing/gold so the asymmetry is obvious to non-payers.

**Step 2 — Contextual upsell for non-entitled players.** Compute `othersAssisted = seats.filter(s => s.assisted && s.uid !== uid).length` and `iAmAssisted = mySeat?.assisted`. If `!iAmAssisted && othersAssisted > 0 && !hasEdge()`, render a dismissible bar above the action area: `"⚡ ${othersAssisted} players here are running MCE Strategy. Unlock yours →"` → on tap, go to store / call `edgePassCheckout`.

**Step 3 — Moment-of-pain trigger (sharper convert).** When a hand ends (`hand_over`) and an MCE seat won while I (non-entitled) lost, surface a stronger one-tap prompt: `"An MCE player just took that pot. See the line they saw → Unlock MCE"`. Reuse the `netPostAnims` hand_over hook.

**Validation (emulator harness):** create an assisted room as `caspar` (edgePass), sign a 2nd dev user with NO edge, join, deal → assert: (a) caspar's seat shows `.mce-badge`; (b) the non-payer sees `.fomo-upsell` with the right count; (c) the upsell click routes to checkout/store. Screenshot both perspectives.

**Commit:** `feat: in-app FOMO — MCE badge on entitled seats + contextual upsell`

---

## Task 2 — Shareable branded wins (the viral engine)

After a winning session / big pot, generate a branded artifact the user wants to post.

**Files:** `src/ui/main.ts` (post-hand / leave-table hook → "Share win" CTA), new `src/ui/share-card.ts` (render a canvas/SVG card: amount won, hand, "won with MCE ⚡", a join URL + room/app brand), `src/ui/styles.css`.
**Approach:** on `hand_over` where I won a notable pot (or on leaving up money), offer "📸 Share win". Generate an image (canvas → blob) with the result + MCE branding + `montecarloedge.web.app`. Use the Web Share API where available, else download/copy-link. Every share carries the brand + a link = free ad.
**Validation:** emulator — win a hand, tap Share, assert an image blob is produced + the share/download path fires.
**Commit:** `feat: shareable branded win cards`

---

## Task 3 — Proof page + instrumentation (the credibility engine)

**Files:** functions (aggregate per-hand outcomes by `assisted`), a public `/proof` route in the client, seed data from an engine sim script.
**Approach:** server tallies, per resolved hand, chips won/lost bucketed by whether the seat was `assisted` → a `stats/mceVsField` doc (bb/100 differential, hands counted). Client renders a public, auto-updating Proof Page. SEED it now with an engine bot-vs-field sim (reuse `simulate`/the harness) so the page is credible before real volume; swap to live data as it accrues.
**Validation:** emulator — play hands, assert the aggregate doc updates + the page renders the differential. Sim seed reproducible.
**Commit:** `feat: MCE-vs-field proof page + server instrumentation`

---

## Task 4 — Referral rewards (amplifier)

**Files:** functions (a `redeemReferral`/grant callable; ledger), client (invite link with the user's code, redeem on signup).
**Approach:** each user has a referral code; inviting → both get chips (or a free Edge Pass week) on the invitee's first qualifying action. Economy + ledger already exist; add the grant + anti-abuse (one redeem per new uid, server-gated). Add to emu-economy.mjs.
**Commit:** `feat: referral rewards`

---

## Task 5 — Leaderboard + MCE-certified badges (status amplifier)

**Files:** functions (weekly aggregate), client (leaderboard screen + profile badges).
**Approach:** weekly chip-won / win-rate leaderboard; "MCE-certified" badge for Edge Pass users / top performers. Turn on once there's a population (gate behind a min-players threshold so it's never an empty board).
**Commit:** `feat: leaderboard + MCE badges`

---

## Task 6 — Engine-content generator (reach)

**Files:** `src/engine/scripts/gen-content.ts` (new).
**Approach:** a script that runs bot-vs-field sims (reuse `simulate`) and emits shareable artifacts — a result graph + a "solved spot of the day" breakdown (hand, board, GTO line, why) as image/text — the raw material for faceless Shorts/TikTok. Faceless, scalable, capital-light.
**Commit:** `feat: engine content generator for faceless reach`

---

## Stripe gate (founder-only)
Tasks 1–6 are buildable without Stripe live. The upsell (Task 1) routes to checkout, which only *completes* once the founder sets `STRIPE_SECRET` / `EDGE_PASS_PRICE` / `STRIPE_WEBHOOK_SECRET` (after rotating the exposed test key). Claude redeploys once secrets exist; Claude never handles secret values.
