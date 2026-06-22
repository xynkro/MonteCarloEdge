# Go-live playbook — LLC → Developer accounts → Payments

The code for native payments is done and tested (`docs/REVENUECAT-SETUP.md`). What gates *turning it
on* is **account/legal setup only**, which must be done by you (it requires your legal identity,
financial details, and account creation — Claude cannot do these). This is the critical path, ordered
so nothing blocks waiting.

> Not legal/tax advice. For the LLC structure, registered agent, and operating agreement, a quick
> consult with an attorney or a service (LegalZoom / Stripe Atlas / Northwest) is worth it given this
> app is gambling-*adjacent* (even though chips are non-cashable).

## Why an LLC + Organization account (not Individual)
An **Individual** Apple account ($99, no D‑U‑N‑S, ~1 day) is the fast path, but it exposes your legal
name publicly and gives no liability shield. Because MonteCarloEdge is a real-money-IAP poker app — a
category with real liability exposure (cf. *Kater v. Churchill Downs*, WA) — the **LLC + Organization**
route is the right call. You chose this; steps below.

## Critical path (the D‑U‑N‑S number is the long pole — start it the day the LLC exists)

| # | Step | Cost | Time | Needs |
|---|------|------|------|-------|
| 1 | **Form the LLC** (home state is simplest; WY/DE only if advised). File Articles of Organization + appoint a registered agent. | ~$50–500 + agent ~$100/yr | 1–14 days | — |
| 2 | **EIN** from irs.gov (free, instant online for US). | $0 | minutes | LLC #1 |
| 3 | **Business bank account** (Mercury/Novo/your bank). | $0 | 1–3 days | #1, #2 |
| 4 | **D‑U‑N‑S number** from Dun & Bradstreet (use the FREE request, not paid). **This gates BOTH stores — request it first.** | $0 | 1–5 business days (can be ~30; Apple has an expedited lookup) | #1 (exact legal name + address) |
| 5 | **Apple Developer Program — Organization** (developer.apple.com/enroll). Needs the legal entity name **matching D‑U‑N‑S exactly**, a company website, and authority to bind the entity. | $99/yr | 1–2 days review | #1, #4 |
| 6 | **Google Play Console — Organization** (play.google.com/console). Org accounts need D‑U‑N‑S + identity verification. | $25 once | 1–3 days | #1, #4 |
| 7 | **Sign agreements + banking/tax** in App Store Connect (Paid Apps agreement, bank, W‑9) and Play Console (merchant/payments profile). | — | <1 day | #5, #6 |
| 8 | **RevenueCat account** (free), add the App Store app (upload App‑Specific Shared Secret) + Play app (service-account JSON). | $0 | <1 hour | #5, #6 |
| 9 | **Create the 9 IAP products** (ids in `REVENUECAT-SETUP.md`) in App Store Connect + Play Console + attach to RevenueCat (entitlement `edge`, one offering). Set the app **18+** rating. | — | ~1–2 hours | #7, #8 |
| 10 | **Wire the app + webhook** — paste the `appl_…`/`goog_…` keys into `RC_KEYS` (`src/mp/revenuecat.ts`); set the `REVENUECAT_WEBHOOK_AUTH` secret; `firebase deploy --only functions`; point the RC webhook at the function URL. (Full steps: `REVENUECAT-SETUP.md`.) | — | ~1 hour | #9 |
| 11 | **Sandbox test** — set `RC_ALLOW_SANDBOX=true`, buy each product, confirm grants + Restore + a refund flips `edgePass`, then remove the flag. | — | ~1–2 hours | #10 |
| 12 | **Submit for review.** | — | 1–3 days (Apple) | #11 |

**Realistic total:** ~2–4 weeks wall-clock, mostly waiting on D‑U‑N‑S + the LLC. The hands-on work is
maybe a day. **Today's single highest-leverage action: file the LLC (#1), then immediately request the
free D‑U‑N‑S (#4) — everything else queues behind those two.**

## Still TODO in code before chip sales go live (not blocking the above)
- **Washington geo-block** for the chip packs (not Edge Pass) — `Kater v. Churchill Downs` liability.
  Gate the chip-pack purchase by region before enabling them in WA. Flagged in `REVENUECAT-SETUP.md`.
- **Stripe ↔ store parity**: web sells Edge Pass via Stripe; native via RevenueCat. Chip packs are
  native-only for now (web shows "Soon"). That asymmetry is intentional and noted in the Store UI.

## Already handled (compliance table-stakes — done)
Non-cashable play-money model, 18+ age gate, the disclaimer triad, server-authoritative entitlements,
idempotent + refund-aware webhook, Restore Purchases. See the two audit reports + `MULTIPLAYER.md`.
