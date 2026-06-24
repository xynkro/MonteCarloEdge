# UI tidy (Training · Profile · Settings) + Edge Pass gate on Live Hands

**Approved 2026-06-24.** Extends the home/landing sharp-UI language (icon system, compact rows,
less-words-more-pictures) to the three menu screens, and adds the Edge Pass paywall to the Live
Tracker. Single-file UI: `src/ui/main.ts` + `src/ui/styles.css`, morphdom render path. No engine/MP
change. Promote/sell-the-proof is parked as a separate marketing task.

## Edge Pass gate on Live Hands — FOMO-blur the recommendation

Today the Live Tracker (`renderSetup` "At a real table? Use the Live Tracker" → `S.mode="live"`,
main.ts:1162) is free. The online MCE overlay is already gated by `hasEdge()` (`S.edgePass || S.isAdmin`,
main.ts:5726) with the `if (!hasEdge()) { S.screen="store" }` pattern.

**Chosen approach (highest conversion):** let a non-entitled user set up + track the real table for
free, but **blur/lock the actual GTO recommendation** behind an "Unlock with Edge Pass" overlay — they
feel the precise value gap. Tapping the overlay → `S.screen="store"`. Mirror the existing online FOMO
pattern. Training-vs-bots stays fully free; only the *live real-table edge* is paid (matching online).
Value ladder: **Training = free · Live edge (real table OR online) = Edge Pass.**

Implementation: find where the live-mode rec card renders (`S.mode==="live"`); when `!hasEdge()`, render
the rec wrapper with a blur + lock overlay instead of the numbers. Keep the free value layer (your
win% / hand label) visible if cheap — the *GTO action* is the locked part.

## UI tidy — one screen at a time, review each in preview

1. **Profile (`renderProfile`, main.ts:6573)** — drop emoji (👤🛍📜 → `ic-profile`/`ic-store`/history
   icon); collapse the 4 stacked full-width buttons (Store / Hand history / Sign out / Back) into a
   **2-col icon-action grid**. Keep avatar chip + nickname + chip scoreboard.
2. **Training (`renderSetup`, main.ts:972)** — top bar (`← Leave` / `Session Stats` / `🔊 Sound`) →
   **icon buttons**; the two bottom CTAs → a clean **paired CTA**, Live Tracker carrying the Edge Pass
   state. Fields already 2-col — light touch.
3. **Settings (`renderSettings`, main.ts:6642)** — already row-based/clean; **icon per group head**
   (Sound / Gameplay / Account / Your data / Legal) + tighten the 5-button "Your data" danger stack.

Each: edit → preview-verify (unregister SW + clear caches per the PWA staleness rule) → show the user →
next. Deploy + SW bump after the set is approved.
