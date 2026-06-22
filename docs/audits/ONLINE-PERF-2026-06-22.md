# Online / multiplayer performance — emulator findings (2026-06-22)

Driven against the Firebase emulator suite (`npm run emu`) via the in-app `__MCE_DEV` helpers:
created a room, added 2 bots, dealt, acted through a full hand incl. an all-in showdown + bust/rebuy.

## Verdict: functionally sound; the "lag" is **cold-start**, not the steady state.

Everything worked end-to-end — room create, add-bot, deal, act, street advance, all-in runout,
showdown ("Bot 2 won with aces full of jacks"), bust → top-up prompt. **No stuck spinner, no desync,
no hang.** The earlier "every round is laggy / keeps spinning" is explained by function cold-starts.

## Measured latencies (emulator, local — prod adds region RTT on top)

| Call | First (cold) | Subsequent (warm) |
|------|-------------:|------------------:|
| `createTable` | **1124 ms** | — |
| `addBot` | **995 ms** | **17 ms** |
| `dealHand` | **730 ms** | — |
| full action round (`act` → bots resolve → next street) | **1364 ms** | **485 ms** |

Warm steady-state (~485 ms/round, 17 ms/add-bot) is fine. The pain is the **first invocation of each
function**, and it recurs whenever an instance scales to zero — which a *social* poker game triggers
constantly (players chat/idle > the keep-warm window between actions, so the next action is cold again).
That is exactly the "every round is laggy" symptom.

## Root cause (confirmed in code)

- `functions/src/index.ts:32` — `setGlobalOptions({ region, maxInstances: 10, memory: "1GiB" })` with
  **no `minInstances`** (the line-31 comment defers it: *"that's an always-on bill, pending owner OK"*).
- Each `onCall` is a separate Cloud Run service with its own instance pool, so the client's existing
  `listPublicRooms` warm-up (`netRefreshPublic`, prefetched on Home) does **not** warm `act` /
  `startHand` / `createTable`. There is no cross-function warming.

## Recommendation (owner decision — it costs money)

**Enable `minInstances: 1` on the two functions that fire repeatedly during play: `act` and
`startHand`.** That removes the per-action and per-hand cold-start — the lag a player actually feels
mid-game — for the cost of ~2 always-warm 1GiB instances (a few $/mo each; negligible once there's any
revenue, and the single biggest online-UX win available). Leave the once-per-session functions
(`createTable`/`joinTable`) cold — their cold-start is a one-time hit at table entry, not "every round".

How (per-function override, since these are individual `onCall`s):
```ts
export const act = onCall({ minInstances: 1 }, async (req) => { … });
export const startHand = onCall({ minInstances: 1 }, async (req) => { … });
```
Deploy gotcha still applies: a `firebase deploy --only functions:act,functions:startHand` will fail
while `REVENUECAT_WEBHOOK_AUTH` is unset unless `revenuecat.js` is temporarily excluded (see prior notes).

### Secondary (only if cold-start time itself needs cutting, not just hidden)
Audit the functions bundle for heavy top-level imports (CFR solver / gto charts) that load on every
cold start even when a given handler doesn't need them; lazy-`import()` them inside the handlers that
do. Lower priority than `minInstances` and needs careful measurement — don't do it blind.

## What was NOT changed
No `minInstances` was set (ongoing cost = owner's call) and no optimistic-UI rewrite was attempted
(server-authoritative model; risky). This doc is the actionable output.
