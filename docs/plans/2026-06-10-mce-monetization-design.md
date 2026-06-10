# MonteCarloEdge — Monetization & Growth Design (Phase 1)

_Date: 2026-06-10 · Status: APPROVED (brainstorming) → next: implementation plan_

## North star
**Make money from MCE.** Everything else — the following, the book, the app, "we
consistently win" — is a means to that.

## Constraints (from brainstorming)
- **Solo dev**, tight timeline.
- **Cold start**: zero audience today. Bottleneck is *audience + proof*, NOT conversion.
- **Capital-light**: founder will NOT grind a personal bankroll / live tournaments for proof.
- **Faceless**: founder will NOT be the on-camera personality. Users are the spokespeople.

## The asset that makes it honest
This week the engine was **validated**: equity proven against exact enumeration, ranges
canonical-GTO, 19/19 decision checks. That turns "we consistently win" from a claim into a
**provable** fact — the foundation the following / book / paywall all rest on.

## Strategy (approved: "A + B reach, book Phase 2")
Lead with **product-led app virality** (the app is the marketing), seed reach with
**faceless engine-generated content**, monetize via **Edge Pass + in-app FOMO**. The
**book + long-form YouTube are Phase 2**, launched to the audience Phase 1 builds.

## The funnel (cold stranger → recurring revenue)
1. **Discover** — faceless engine content (sim clips: "MCE beat a 9-max field +X bb/100") + shared user wins.
2. **Hook (free)** — free Trainer, no signup wall → a leak report that shows where they bleed money. They feel the edge.
3. **Activate** — free online play; some seats wear a glowing **MCE badge** and visibly win. The asymmetry is the pitch ("3 of 6 here run MCE").
4. **Convert** — contextual upsell at the moment of pain → **Edge Pass (recurring)**. This is the "5/12 use it, the other guy feels suckered" engine.
5. **Amplify** — wins auto-generate a **branded shareable card/clip** → users post → **referral reward** → loop.
6. **Prove** — everything feeds the public **Proof Page** (MCE-vs-field win-rate) — the receipt that sells the next cohort and the Phase-2 book.

## Phase 1 build (leverage order)
| # | Build | Role | Stripe-blocked? |
|---|---|---|---|
| 0 | **Stripe live** (founder sets secrets; founder rotates the exposed test key) | revenue gate | — |
| 1 | **FOMO layer** — visible MCE badge on entitled seats + contextual upsell | conversion engine | links to checkout, buildable now |
| 2 | **Shareable branded wins** — post-win artifact + join link | viral engine | no |
| 3 | **Proof page + instrumentation** — measure MCE-vs-field, auto-publish (seed w/ engine sims) | credibility engine | no |
| 4 | **Referral rewards** — invite → both get chips / free Edge Pass week | amplifier | no (economy exists) |
| 5 | **Leaderboard + MCE-certified badges** | status amplifier (at population) | no |
| 6 | **Engine-content generator** — script auto-makes sim clips | reach | no |

## Deferred / cut (YAGNI)
- **Book + long-form YouTube → Phase 2** (launch to a built audience).
- 3D table, fancy avatars, spectator, taunts → council said defer/cut.
- Warm functions (`minInstances`) → only if cold-start measurably hurts conversion.

## Success metrics
- **Loop self-sustains**: install → share → install (measurable viral coefficient > 0).
- **Free → Edge Pass conversion** is non-zero.
- **First dollar** = Stripe live + the FOMO upsell converting one user.

## Stripe setup (founder-only — secrets never touch the chat or my hands)
The code is complete (`functions/src/stripe.js`: checkout + portal + webhook). To go live:
1. **Rotate** the test secret key exposed in chat (Dashboard → Developers → API keys → Roll).
2. Create the **Edge Pass price** ($6.99/mo recurring) → copy `price_…`.
3. Set 3 secrets (paste into the secure prompt, NOT chat):
   `firebase functions:secrets:set STRIPE_SECRET` · `EDGE_PASS_PRICE` · `STRIPE_WEBHOOK_SECRET`
4. Add a **webhook** → endpoint = the deployed `stripeWebhook` URL → events
   `checkout.session.completed`, `customer.subscription.deleted` → copy `whsec_` into `STRIPE_WEBHOOK_SECRET`.
5. Redeploy functions (Claude can do this once secrets exist — no secret values handled).
The **publishable key is not needed** (the client uses the redirect-to-URL checkout flow).
