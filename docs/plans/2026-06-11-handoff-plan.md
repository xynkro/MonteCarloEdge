# MCE Handoff Plan — Audit Fixes + Lobby/MP Features (2026-06-11)

> **For Claude (Sonnet / Opus 4.6):** Execute task-by-task with superpowers:executing-plans.
> You have ZERO context beyond this doc + the repo. Read this header fully before touching code.
> Companion doc: `docs/plans/2026-06-11-audit-findings.md` = the 26 confirmed bugs (A1–A26) with
> evidence + suggested fixes. This plan sequences them and adds the feature work.

**Goal:** Fix all confirmed audit bugs (1 critical first), ship the user's lobby/multiplayer UX
batch, keep every engine gate green.

---

## 0. Context & hard rules (read once, obey always)

- **Project:** `/Users/xynkro/MonteCarloEdge` — vanilla TS + Vite PWA, Firebase (Auth/Firestore/
  Functions asia-southeast1/Hosting). Live: https://montecarloedge.web.app . Repo `xynkro/MonteCarloEdge`, branch `main`.
- **ALWAYS `cd /Users/xynkro/MonteCarloEdge` first** in every shell (cwd drift breaks the build
  with a cryptic rolldown `[Getter/Setter]` error).
- **Build:** `BUILD=1 npx vite build` (exit 0 = good). **Functions build:** `cd functions && npm run build`.
- **Deploy hosting:** bump the SW cache version FIRST — `public/sw.js` `const CACHE = "mce-vNN"` → NN+1
  — then `firebase deploy --only hosting --project montecarloedge`.
  **Deploy functions:** `firebase deploy --only functions --project montecarloedge` (or name specific
  callables `functions:act,functions:startHand,...`).
- **Gates (must stay green; run after ANY change under `src/engine` or `src/mp`):**
  - `npm run validate:all` (3 engine layers — equity vs exact enumeration, ranges, decisions)
  - `npx tsx stress.ts` (15,000-hand chip-conservation stress; expects `VIOLATIONS=0`)
  - Targeted vitest only: `npx vitest run src/engine/__tests__/<file>` — **never bare `npx vitest run`** (~5 min).
- **Emulator harness (the ONLY way to test networked MP):** `npm run emu` in background; dev server
  via launch config `mce-dev` (port 5188); open `http://localhost:5188/?emu=1`; in console
  `window.__MCE_DEV.signIn('caspar')`, `window.__MCE_DEV.go('mp-setup')`, `.S` = state. After editing
  `functions/src`, rebuild (`cd functions && npm run build`) so the emulator picks it up.
  2-client flows: sign a 2nd user in a 2nd tab (`signIn('bob')`).
- **Engine purity rule (DO NOT regress):** the pure engine (`src/engine/*`, esp. `game-state.ts`,
  `sizing.ts`) stays FRACTIONAL — the single-player trainer runs it bb-normalised (bb:1, sb:0.5).
  Integer chip rounding happens ONLY at the MP boundary: `actSeat` in `src/mp/mp-engine.ts`
  (`Math.round(action.amount)`). Never add `Math.round` inside GameState/sizing.
- **One render path:** all UI is `src/ui/main.ts` (~4,800-line monolith) + `src/ui/styles.css`,
  morphdom re-render via `render()`. Net table reuses trainer primitives. Match existing style.
- **Security — absolute:**
  - NEVER read/print/commit `~/Downloads/montecarloedge-firebase-adminsdk-*.json`.
  - NEVER handle Stripe secret values (`sk_…`, `whsec_…`) — the founder types them into the
    `firebase functions:secrets:set` hidden prompt himself. Price IDs (`price_…`) are OK.
  - No real-money mechanics; chips are never cashable.
- **Git ritual:** after each shipped chunk: detailed commit + push to main (standing rule), end
  commit body with `Co-Authored-By:` Claude line.

**Already shipped this week (do NOT redo):** chip-conservation fix rounded at MP boundary (v66);
honest Proof Page at `/proof.html` + home-footer link (v67); join-first Play Online entry + dash-free
code + compact lobby pills (`c5397a0`); auto-deal/any-player-can-start (`a20ab76`); per-player Edge
Pass entitlement; 12-max tables; FOMO badge/upsell; share-win canvas cards; turn clock.

---

## 1. P0 — Hotfixes (do in this exact order, deploy as you go)

### Task 1.1 — Repo hygiene (5 min)
`firestore-debug.log` got committed in `a20ab76` and keeps dirtying the tree.
- `git rm --cached firestore-debug.log`, add `firestore-debug.log` + `*-debug.log` to `.gitignore`, commit.

### Task 1.2 — A1 CRITICAL: `joinTable` mid-hand brick + baseline clobber
**File:** `functions/src/index.ts` (joinTable ~204–227; compare `addBot` ~240 which has the guard).
Any user joining during a live hand bricks the table FOREVER (baseline overwritten with literal `0`
→ the hand-settling act always throws "chip conservation broken" → players' chips locked).
- **Step 1:** In `joinTable`, before seating: `if (t.status === "in_hand") throw new HttpsError("failed-precondition", "Hand in progress — try again in a moment.");`
- **Step 2:** Audit EVERY `persist(...)` call site in `functions/src/index.ts` for a hard-coded `0`
  baseline (joinTable line ~224, addBot ~244, leaveTable ~310). Change `persist` so callers pass the
  baseline loaded from the state doc (`loadState`), preserving it verbatim whenever `settled=false`
  and status is not in_hand-transitioning. Simplest correct shape: `loadState` returns `{t, version, baseline}`;
  every non-deal persist passes that `baseline` through.
- **Step 3:** Rebuild functions; emulator repro: 2 humans + 1 bot, start a hand, have a 3rd user
  `joinTable` mid-hand → expect clean `failed-precondition` error, hand continues, settles, next
  hand deals. Then run `node repro-river.mjs` (existing 2-human callable repro) to confirm no regression.
- **Step 4:** Deploy functions. Commit: `fix(critical): joinTable in-hand guard + preserve conservation baseline through persist`.

### Task 1.3 — Betting-legality cluster (A3, A4, A6, A9) — fix together, one validation pass
These four are one subsystem: raise legality. Read each entry in the findings doc first.
- **A3** `src/engine/game-state.ts:192` — after a FULL raise, a later short all-in must NOT cancel a
  player's raise rights. Track, per seat, the `currentBet` they last faced/acted at; allow raise if a
  full raise has occurred since their last action. (TDA rules; see evidence for the exact repro.)
- **A9** `game-state.ts` — sub-BB all-in opening bet must not set `_lastRaiseSize` below 1bb; clamp
  min-raise math so the next raise minimum stays ≥ the last FULL raise increment (or bb).
- **A4** server validation (`src/mp/mp-engine.ts` actSeat + how functions `act` passes types) — a
  raise mislabeled as `bet` slips past min-raise validation (1-chip over-raise). Validate by the
  ACTUAL situation (currentBet > 0 ⇒ treat as raise) rather than trusting the client's `type`.
- **A6** client `src/ui/main.ts` (net bet slider / All-in button) — when raising is illegal (short
  all-in facing them), the All-in button must send `{type:"call"}`-equivalent legal action (all-in
  call), not `raise`. Mirror legalActions: if `raise` not in legal set and slider is at all-in, send call.
- **Validation:** new vitest cases in `src/engine/__tests__/` reproducing A3 + A9 exactly (from the
  findings evidence), then `npm run validate:all` + `npx tsx stress.ts` + emulator hand with a short
  all-in. Commit + deploy functions+hosting (SW bump).

### Task 1.4 — A14 turn-timer one-liner (visible WSOP-timer bug)
`src/ui/main.ts` (~line 3832): `Math.max(0, Math.min(45, deadline - Date.now()) / 1000)` caps
MILLISECONDS at 45 then divides — the seat timer bar is always ~0. Fix to
`Math.max(0, Math.min(45, (deadline - Date.now()) / 1000))`. Visual-check in emulator. Ship with 1.3's deploy.

### Task 1.5 — A2 HIGH: `describeHand` "Top Pair Top Kicker" on whiffed paired boards
`src/engine/made-hand.ts:332` — in the PAIR branch, verify a HOLE card equals `pairedRank`; if the
pair is board-only, label `"<Rank> High"` (board pair) instead. Add vitest: `AhQc` on `KhKc5d` →
NOT "Top Pair…". Run made-hand tests + validate:all.

### Task 1.6 — A5 HIGH: `icmEquityExact` zero-stack players
`src/engine/icm.ts` — busted-but-prize-locked players (zero stack in an ICM spot) must receive their
locked payout, not $0. Follow the findings fix; add a vitest with a 0-stack seat. validate:all.

---

## 2. P1 — Audit mediums (batch, one commit each or grouped)

Work through findings doc entries, in this order (user-visible first):
- **A13** `src/ui/main.ts` netAct — the 6s "sending…" safety timer is cleared on resolve such that a
  hung snapshot can leave the lock stuck; ensure the safety can actually fire (clear only after
  state-refresh, or leave the timeout running until snapshot arrival).
- **A11** `src/mp/firebase-adapter.ts` — add error observers to every `onSnapshot` (set `S.net.err`,
  attempt resubscribe with backoff) so a dropped stream doesn't freeze the table silently.
- **A7 / A8** `src/engine/board-texture.ts` / nut-label — outs counting + straight-flush height
  corrections per findings. Vitest each.
- **A10** `src/engine/charts/index.ts` — make 11/12-max RFI monotonic by position (UTG3/UTG4 must
  open ⊇ earlier positions' tightness ordering). Vitest: range sizes non-decreasing by position index.
- **A12** dev-emu wiring race — set `_emuWired` before publishing `_app` (dev-only; low risk).

## 3. P2 — Audit lows (single "audit-lows" commit is fine)

A15–A26 per findings doc. Highlights: A21 `beforeunload` listener leak; A22 legacy `chips` field
readers; A25 revoke MCE rec on entitlement loss (next hand is acceptable); A26 share-win card
credits full pot to every split-pot winner (compute the winner's actual share). Skip any that turn
out stale after the P0/P1 refactors — note skips in the commit body.

---

## 4. Feature batch — lobby + multiplayer UX (user's notes, 2026-06-11 morning)

Verbatim user intent, sequenced. All client work is `src/ui/main.ts` + `styles.css` unless stated.
Verify each in the emulator (2 tabs) before commit.

### Task 4.1 — Lobby polish (new notes 1, 2-partial, 5)
- Room code display smaller (`.lc-code` font-size down ~40%; keep tap-to-copy).
- Make Leave button bigger/more obvious in the lobby top bar.
- **Sort live players above bots** in the lobby pills (client sort: humans first, then bots) AND
  server-side seat order on join while `waiting`: if a human joins and any bot occupies a lower seat
  index, swap the human into the first bot seat (same transaction, only when status=waiting).

### Task 4.2 — In-lobby settings cog (new note 2)
Gear icon in lobby top bar → bottom sheet:
- **Per-player:** MCE Strategy toggle (entitled users; updates seat.assisted via a new tiny callable
  `setSeatPrefs({code, assisted})`), MCE style picker (see Task 4.6 — wire the same field).
- **Owner-only:** room privacy toggle (Task 4.3), (optional) kick bot.
- Buy-in top-up belongs to the rebuy flow (Task 4.5) — link to it from the sheet.

### Task 4.3 — Private/public rooms + public games list (new note 4)
- `createTable` gains `isPublic: boolean` (UI toggle on the create form, default ON per user intent
  "if someone doesn't make the room private it should show up").
- New callable `listPublicRooms()` → up to ~20 rooms `{code, name, stakes, occupied, max, status}`
  where `isPublic && status=="waiting" && open seats`. (Callable avoids Firestore rules/index work.)
- Play Online screen: "Online games" section under the join card listing public rooms (tap = join);
  manual ↻ refresh, fetch on screen open — no live listener.
- Owner can flip privacy from the settings cog (`setRoomPrefs({code, isPublic})`).

### Task 4.4 — Spectators (new note 3 = old note 12)
- `joinTable({code, spectate:true})`: adds `{uid,name}` to a `spectators` array on the state doc —
  no seat, no debit; `leaveTable` removes. `publicState` already goes to all room subscribers; add
  `spectators` to the projection.
- Lobby + table header: `👁 N watching` + names in the lobby roster area as dim pills.
- Spectator's client: read-only table (no action bar, no hand docs — they simply never get dealt);
  "Take a seat" CTA when a seat is open + status=waiting → calls normal `joinTable` (seated) then rebuy/buy-in flow.
- Join screen: after entering a code, offer "Join · Spectate" as two buttons.

### Task 4.5 — Rebuy / top-up + bust rejoin (old notes 8, 9, 13)
- New callable `rebuy({code, amount})`: allowed when seated AND (chips==0 OR status=="waiting");
  `20*bb ≤ chips+amount ≤ tier.max`; debits the room's currency wallet; writes seat.chips += amount.
  Conservation: only while NOT in_hand, and bump the stored `baseline` by `amount` in the same
  transaction (CRITICAL — see Task 1.2; add a line to `emu-economy.mjs` asserting wallet+table total
  is conserved across a rebuy).
- Client: on bust (hand_over, my chips 0) show a sheet: numpad-style amount chooser (default =
  previous buy-in, free entry within bounds — NOT locked to 10bb), "Rebuy" → callable; insufficient
  wallet → "Not enough chips" → Store button (S.screen="store"). "Leave table" as the alt action.
- Bust+left players rejoin via the normal join code path (verify seat freed on leave; fix if not).

### Task 4.6 — MCE strategy style + short-stack push/fold (old note 4)
- **Style:** seat gets `recStyle: "balanced"|"tag"|"lag"` (set from the lobby cog / Play Online MCE
  block). Server `recommendForSeat` (src/mp/mp-engine.ts) maps style → hero `OpponentProfile`
  (`TAG`, `LAG`, balanced = default TAG-ish) when calling `recommend`.
- **Short-stack:** in `recommendForSeat`, preflop with effective stack ≤ 10bb → use the existing
  push/fold solver (`src/engine/gto/pushfold-chart.ts` / `pushfold.ts`): verdict PUSH → rec
  `{type:"raise", amount: all-in}` labeled "ALL-IN (push/fold, Nbb)"; FOLD → fold. The MCE card copy
  should say it's short-stack push/fold mode. Vitest: 8bb BTN A5s → push; 8bb UTG 72o → fold.

### Task 4.7 — Pot + last-action clarity (old notes 10, 11)
- Replace the pot chip-emoji label with **`POT: 1,240`** (bold, gold) and move the pot pill to sit
  directly above the hero pill (less dead felt). CSS-first; keep one render path.
- `publicState` gains `lastAction: {seat, type, amount}` (set in `actSeat`, cleared on street
  advance); client shows a 1.2s floating callout at the actor's seat: "RAISE 120" / "CALL" / "FOLD".

### Task 4.8 — Lobby text chat (old note 6; voice is OUT of scope — WebRTC infra, parked)
- Callable `sendChat({code, text})` (seated players + spectators; ≤120 chars; 1 msg/2s server-side
  check on `lastChatMs`) writing to `tables/{code}/chat/{autoId}` `{uid,name,text,ts}`; client
  subscribes to last 30 (orderBy ts desc limit 30), renders a drawer in lobby + table (💬 toggle),
  quick presets ("gl", "nh", "hurry up 🐌", "wp"). Firestore rules: chat subcollection read by
  anyone with the doc, writes ONLY via the callable (no direct client writes).

---

## 5. Stripe go-live runbook (founder-gated — agent NEVER touches secret values)

Blocked on founder. When he says go:
1. Founder rotates the leaked TEST secret key (Dashboard → Developers → API keys → Roll) — the old
   one was pasted into chat once.
2. Founder (TEST mode, https://dashboard.stripe.com/test/apikeys): `firebase functions:secrets:set STRIPE_SECRET`
   → paste `sk_test_…` into the hidden prompt. Same for `STRIPE_WEBHOOK_SECRET` (`whsec_…` from a
   TEST-mode webhook endpoint pointing at the deployed `stripeWebhook` URL, events:
   `checkout.session.completed`, `customer.subscription.created/updated/deleted`).
3. `EDGE_PASS_PRICE` is already set (`price_1Tgg0LBMv3ssM25NR2KbURi2`) — verify it's a TEST-mode price; if it's
   live-mode, founder creates the $8.99/mo price in test mode and the agent re-sets this secret (price IDs OK to handle).
4. Agent: `firebase deploy --only functions:createCheckoutSession,functions:createBillingPortal,functions:stripeWebhook --project montecarloedge`,
   then verify: store → Edge Pass → expect redirect to a Stripe-hosted TEST checkout (no INTERNAL error in functions logs).
5. Pricing already decided: Edge Pass $8.99/mo, $69.99/yr, Founder's Lifetime $129 (first 1,000).
   Premium chip pack tiers need founder confirmation before building the store SKUs.

---

## 6. Parked (do NOT build without the founder asking)
Voice chat (WebRTC), 3D table, bot turn-speed rework, proof-page live bb/100 (needs real-player
volume; the sim numbers are inflated and were deliberately NOT shipped), premium-chip pack tiers,
removal of the redundant `ext-firestore-stripe-payments` extension.

## Execution protocol (every task)
1. Implement (match existing code style; no drive-by refactors).
2. Validate: the task's listed checks + `BUILD=1 npx vite build` + (if engine/mp touched)
   `npm run validate:all` + `npx tsx stress.ts`.
3. Deploy what changed (SW bump for hosting; functions for server).
4. Commit (detailed why + how verified) + push.
5. If something is ambiguous, prefer the smallest change that satisfies the user note verbatim.
