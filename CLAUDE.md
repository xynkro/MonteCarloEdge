# MonteCarloEdge

A No-Limit Hold'em GTO poker PWA: a single-player trainer (validated CFR/Monte-Carlo engine with live recommendation overlay + leak report) plus a free-to-play online multiplayer mode with play-money chips and a Stripe "Edge Pass" paywall. Stack is **vanilla TypeScript + Vite** (NO React/framework) — the UI is one ~4,800-line `src/ui/main.ts` monolith that re-renders via **morphdom** diffing. Backend is **Firebase: Auth + Firestore + Cloud Functions** (region `asia-southeast1`) — there is no RTDB and no raw websocket layer despite "realtime". The engine (`src/engine/*`) is pure and heavily test-gated; treat it as load-bearing and never regress its gates.

## Hard rules — never break these
- **Engine purity:** `src/engine/*` (esp. `game-state.ts`, `sizing.ts`) stays FRACTIONAL/bb-normalised (bb:1, sb:0.5). Integer chip rounding happens ONLY at the MP boundary — `actSeat` in `src/mp/mp-engine.ts` via `Math.round`. Never add `Math.round` inside GameState/sizing.
- **One render path:** all UI lives in `src/ui/main.ts` + `src/ui/styles.css`, re-rendered by morphdom `render()`. The multiplayer net table REUSES the trainer's table primitives (`.stage > .table-wrap > .poker-table`) — never build a second/parallel render path.
- **No real-money gambling:** chips are non-cashable play-money (no cash-out, redemption, P2P value transfer, or prizes). Payments via Stripe sell virtual goods + the "Edge Pass" subscription only.
- **Secrets:** never read/print/commit the `montecarloedge-firebase-adminsdk-*.json` service key or any Stripe `sk_…`/`whsec_…` (owner sets those via `firebase functions:secrets:set` himself). The web `firebaseConfig` apiKey in `src/mp/firebase.ts` IS public by design — Firestore rules + Auth enforce security, not secrecy.
- **Server-authoritative dealing:** deck + hole cards + chip balances + entitlements live server-side (Cloud Functions / Admin SDK are the sole writers). Clients read only public projections + their own hand. Never trust the client with secret state.

## How we work here
- **Always `cd /Users/xynkro/MonteCarloEdge` first** in every shell — cwd drift breaks the build with a cryptic rolldown `[Getter/Setter]` error.
- **Build:** `npm run build` (vite). **Functions:** `cd functions && npm run build` (tsc). **Dev:** `npm run dev` (vite, port 5173).
- **Test/gates** (run after ANY change under `src/engine` or `src/mp`): `npm run validate:all` (equity vs exact enumeration + ranges + decisions), targeted `npx vitest run src/engine/__tests__/<file>` — never bare `npx vitest run` (~5 min). For MP chip safety: `npx tsx stress.ts` (expects `VIOLATIONS=0`).
- **Networked MP testing** is ONLY possible via emulators: `npm run emu` (auth/firestore/functions), open `?emu=1` on localhost; rebuild `functions` after editing `functions/src`.
- **Native apps (iOS/Android, branch `feat/native-capacitor`):** Capacitor 8 wraps the `dist` build (`ios/`, `android/`). Build+run: `npm run cap:ios` / `npm run cap:android` (build → sync → open the native IDE). Capacitor 8 uses **Swift Package Manager, NOT CocoaPods**. **Gotcha (bit twice):** `xcodebuild`/`xcrun simctl`/the xcodebuild-MCP fail with "tool requires Xcode … is a command line tools instance" until you run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` once. Native plugins live in `src/native.ts`, lazy-imported and gated on `window.Capacitor?.isNativePlatform()` so the web bundle never carries them; the service worker also skips registration on native. Regenerate icons/splash: `npx @capacitor/assets generate` from `assets/` (source `icon-1024.png`).
- **Done means:** gates green, and for hosting deploys the SW cache version is bumped (`public/sw.js` `const CACHE = "mce-vNN"` → NN+1) so clients don't serve stale assets.

## Architecture — only what isn't obvious from the code
- `src/engine/` — pure poker brain (evaluator, equity, ranges, CFR solver `gto/`, decision, sizing). Shared by trainer AND server bots (`villainDecision`).
- `src/mp/` — multiplayer: `firebase.ts` lazy-loads the SDK (dynamic import) so the single-player bundle stays small; `mp-engine.ts` wraps the pure engine at the chip boundary.
- `functions/src/index.ts` — server-authoritative callables (`createTable`, `joinTable`, `startHand`, `act`, `rebuy`, admin/economy ops); `act` chains bot turns server-side. `functions/src/stripe.ts` — Checkout + `stripeWebhook` (idempotent chip/entitlement grants). `functions/src/passkey.ts` — Face ID / WebAuthn passkey auth (`@simplewebauthn/server`; register stores the pubkey in `passkeys/{credId}`, authenticate verifies the assertion → `createCustomToken` → client `signInWithCustomToken`; survives iOS-PWA token eviction).
- **New-user landing** (`renderLanding`, `S.screen="landing"`) shows the welcome film + CTAs to first-time visitors only (gated `mce-intro-seen` + no prior `mce-age-ok`). The film itself is a code-rendered web motion scene — source + render pipeline in `tools/film/` (not a video editor; re-renders from `scene.html`).
- **Firestore schema** is documented in `MULTIPLAYER.md`: `users/{uid}` (chips, strategyEntitled), `tables/{id}` (publicState + per-seat assisted flag), `hands/.../holes/{uid}` (locked private), `purchases/`. Rules in `firestore.rules` — Functions are the sole writer; clients write only `name` + presence.
- **Two deploy targets, same `base: "./"` build:** GitHub Actions (`.github/workflows/deploy.yml`) auto-deploys to GitHub Pages on push to `main`; Firebase Hosting at `montecarloedge.web.app` is the canonical prod domain (the only one where Google sign-in works). OAuth uses `montecarloedge.firebaseapp.com` as authDomain (web.app's redirect URI is unregistered).

## Anti-patterns — things that have gone wrong here
- Don't write `publicState` fields as `undefined` — Firestore rejects the doc (e.g. the `seat.recStyle` bug, v70). Omit or null instead.
- Don't add a second render/table component for multiplayer; reuse trainer primitives or you fork the UI.
- Don't run the full vitest suite blindly; it's ~5 min — run the targeted file.
- **Don't rely on `setGlobalOptions({region})` for functions defined in modules pulled into `index.ts` via `export * from "./x.js"`** (`stripe.ts`, `passkey.ts`): those modules evaluate BEFORE `index.ts`'s top-level `setGlobalOptions` runs, so they silently deploy to the DEFAULT `us-central1` while the client (`firebase-adapter.ts` `callFn`) calls `asia-southeast1` → 404. Set `{ region: "asia-southeast1" }` explicitly in each such `onCall(...)`. Moving a LIVE function's region needs `firebase functions:delete <fn> --region us-central1 --force` then redeploy (Firebase won't move it in-place). (`stripeWebhook` stays us-central1 — its URL is registered in Stripe.)

## When unsure
- Read `docs/plans/2026-06-11-handoff-plan.md` (build/deploy/gate rituals + hard rules) and `MULTIPLAYER.md` (legal model + Firestore schema) first.
- Default to the server-authoritative / non-cashable / engine-pure choice; ask only if a change genuinely forces a chip-cashout, a second render path, or touching secrets.
