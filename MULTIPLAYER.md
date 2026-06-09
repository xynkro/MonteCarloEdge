# MonteCarloEdge — Multiplayer + Freemium Plan

Turning the single-player GTO trainer into a **free-to-play social poker** product:
play with friends online, an admin toggles who gets the **strategy tool** (assisted)
vs who plays **blind** (cards only) — to benchmark the engine against real humans —
with **virtual chips** and two paywalls.

## ⚖️ Legal model (the line we must not cross)
- **Play-money only.** Chips are a consumable entertainment good. You may **sell**
  chip packs (IAP) — that's legal (WSOP/Zynga model).
- **HARD RULE: chips never come back out.** No cash-out, no redemption, no
  player-to-player transfer for value, no real prizes/sweepstakes. The instant
  money can exit, it's gambling (illegal to operate unlicensed — esp. SG Gambling
  Control Act 2022). Non-redeemable chips = virtual goods = not gambling.
- **NO real-money poker** (declined — unlicensed real-money operation is criminal;
  card processors ban it).
- Payments = selling **virtual goods + a strategy subscription** via Stripe (allowed).
- If commercialized broadly, get a lawyer to review social-casino rules in target
  markets + Apple/Google policy if ever wrapped native. For a friends product the
  non-cashable + IAP model is the standard safe path.

## 🔐 The load-bearing constraint: server-authoritative dealing
Single-player keeps the whole deck in the browser. **Multiplayer cannot** — if the
client knows every hand, any player opens devtools and sees the table → cheating,
and the benchmark is worthless. So: the **deck + hole cards live on the server**;
each player is sent **only their own two cards**; showdown reveals server-side.
This is non-negotiable and is why a backend is required.

## 🏗 Architecture (recommended: Firebase + Stripe)
```
Client (PWA, redesigned shell: landing → login → lobby → table)
  ├─ Firebase Auth (Google login)
  ├─ Firestore/RTDB  ← realtime table state (public info: bets, board, stacks, seats)
  └─ calls Cloud Functions for anything secret/authoritative:
        • dealHand()      – shuffles, stores deck server-side, pushes each seat ONLY its 2 cards
        • act()           – validates a legal action, advances state
        • showdown()      – reveals + awards the pot, debits/credits chip balances
        • stripeWebhook() – on successful payment, credits chips / grants strategy entitlement
Stripe (Checkout) — chip packs + "Strategy Pro" subscription. Keys are YOURS.
```
Server-held, never trusted to client: the deck, others' hole cards, **chip balances**,
**entitlements** (who's paid for the strategy tool).

### Data model (Firestore)
- `users/{uid}`: displayName, chips (server-authoritative), strategyEntitled (bool/expiry), friends[]
- `tables/{id}`: ownerUid, seats[], blinds, status, **per-seat `assisted` flag** (admin-set),
  publicState (board, pot, bets, toAct), handId
- `hands/{id}` (server-only deck) + `hands/{id}/holes/{uid}` (locked so a player reads only their own)
- `purchases/{id}`: Stripe session → chips credited / entitlement granted (idempotent via webhook)

## 💸 The two paywalls
1. **Strategy paywall** — the GTO tool (reads, recommendations, story panel) is gated
   behind a "Strategy Pro" entitlement during multiplayer. Admin can also grant/deny
   it per seat (the assisted/blind benchmark toggle). Entitlement is server-checked,
   never a client flag.
2. **Chip packs** — everyone starts with free chips; bust out → can't join a table
   until you buy a pack (or wait for a daily free top-up). Balance is server-side.

## 🎯 The benchmark (the actual point)
Admin sets each seat assisted|blind. Track per-player results (bb/100, showdown
win%, decision accuracy for assisted seats) → a leaderboard proving the tool's edge.
Reuses the existing grade/leak engine, now multi-seat + server-recorded.

## 🧱 Build order
- **Phase 0 — Local-first prototype (NO accounts/backend; I can build now).**
  A `BackendAdapter` interface + a `LocalAdapter` (BroadcastChannel across 2 tabs =
  2 players on one machine, a "host" tab as the authority). Redesigned shell
  (landing/lobby/table), the assisted/blind toggle, chip wallet UI, mock paywalls.
  Proves the entire UX + benchmark before any account exists. Firebase later is a
  drop-in `FirebaseAdapter`.
- **Phase 1 — Auth + lobby (Firebase).** Google login, create/join table, friends.
- **Phase 2 — Server-authoritative dealing (Cloud Functions).** The security core.
- **Phase 3 — Chip economy + Stripe** (packs, balances, daily top-up).
- **Phase 4 — Strategy entitlement + admin assisted/blind toggle + benchmark board.**
- **Phase 5 — UI/redesign polish, anti-abuse, rate limits.**

## 🤝 Division of labor
- **You:** create the Firebase project + the Stripe account, paste their public
  config/keys (I never enter card data or your secrets). Decide pricing.
- **Me:** all the code — client redesign, adapters, Cloud Functions, Stripe
  integration wiring, the benchmark, tests.

## First step
Build **Phase 0** (local-first prototype) so you can play the assisted-vs-blind
benchmark across two tabs and feel the whole product — then we wire Firebase +
Stripe to make it real.

---

## Phase 2 lobby design (rooms + codes) — added per feedback

The Online Lobby is **private friend rooms**, not a public free-for-all:

- **Create Room** → the `createTable` callable mints a short, human-typeable code
  (e.g. `MCE-7QK2`) which IS the table id. Returns the code to share. Host picks
  stakes tier + max buy-in (100bb cap stands). Status `waiting`.
- **Join Room** → `joinTable(code)` looks up the table, seats you, debits buy-in
  from your server-held chip balance. No code = no entry, so randoms can't join.
- **Share**: the code (and/or a deep link `?room=MCE-7QK2`) is what you text your
  friends. Optionally a QR for in-person sharing.
- **Lobby list**: shows YOUR open/active rooms + a "Join by code" field. (No public
  random list initially — friend rooms only.)

### Region / latency — deliberately NOT doing matchmaking
Poker is **turn-based** (seconds to act), so per-action latency of 100–500ms is
imperceptible. Region-based matchmaking + relay netcode is an FPS/real-time concern,
not a poker one. Decisions:
- Friend rooms (code-based): region is irrelevant — anyone joins from anywhere.
- Cloud Functions pinned to `asia-southeast1` (closest to the SG user) — the only
  region lever that helps; already set.
- A public/random matchmaker (with optional region filter) is a *later* nice-to-have,
  not a launch need. Skip until public play exists.

Gating: all of the above runs through the `createTable`/`joinTable` Cloud Functions
(server-authoritative), so it needs the **Blaze plan + functions deploy** — same gate
as networked dealing. Lobby + table ship together.
