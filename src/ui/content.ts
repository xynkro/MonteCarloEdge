// Static copy for the Legal and How-it-works screens. Kept out of main.ts so the
// long-form text doesn't bloat the render module. Rendered generically as
// {heading, body(HTML)} sections.
//
// NOTE TO DEVELOPER: the Legal text below is a careful, plain-English STARTING
// TEMPLATE — it is NOT legal advice. Before taking real payments or promoting the
// app publicly, have a Singapore-qualified lawyer review it (esp. Gambling Control
// Act 2022 classification, Stripe refund/withdrawal terms, PDPA/GDPR data-rights,
// age verification, and whether to incorporate a Pte Ltd to cap personal liability).

export interface Section { heading: string; body: string }

export const LEGAL_UPDATED = "8 June 2026";
export const CONTACT_EMAIL = "the.disruptive.comp@gmail.com";

export const LEGAL_INTRO =
  `MonteCarloEdge is a free poker training and social play app. The chips are pretend — there is no real money in here, you cannot cash anything out, and this is not gambling. Read the 30-second summary, then the full terms. By using the app you agree to all of it. Last updated: ${LEGAL_UPDATED}. Operated by Caspar, a solo independent developer based in Singapore. Questions: ${CONTACT_EMAIL}.`;

export const LEGAL_SECTIONS: Section[] = [
  {
    heading: "The 30-second version",
    body: `<ul>
      <li><strong>Chips are play-money only.</strong> They have no cash value. You can never cash them out, withdraw, redeem, or trade them for anything of value. Ever.</li>
      <li><strong>This is not gambling.</strong> No real-money bets, no payouts, no prizes — a trainer and a social game.</li>
      <li><strong>You must be 18+</strong> (or the age of majority where you live, if higher).</li>
      <li><strong>The MCE recommendations are for practice and fun.</strong> They are not a promise you'll win, and not financial or gambling advice.</li>
      <li><strong>It's free, runs in your browser, and we don't sell your data.</strong> Your profile lives on your device, plus in Firebase if you sign in with Google. You can wipe it any time.</li>
    </ul>`,
  },
  {
    heading: "1. Play-money only — chips have NO cash value",
    body: `<p>The chips in MonteCarloEdge are play-money only: they have no monetary value and can never be cashed out, withdrawn, redeemed, sold, or transferred for money or anything of value — whether you received them free or bought them in a chip pack — and the app offers no real-money wagering and no opportunity to win money or anything of value. It is not gambling.</p>
    <ul>
      <li>Free chips (daily chips, starting balance, bonuses) and any chips you might buy in a chip pack are <strong>the same thing</strong>: a non-redeemable in-app counter. If chip-pack purchases launch, buying one is buying a licence to use more in-app chips — like a free-to-play title (WSOP-style social poker). It is <strong>never a deposit, never a stake, and never entitles you to a payout or withdrawal</strong>.</li>
      <li>Chips you "win" at a table are a number going up in a game. They have no value and create no claim against the developer or anyone else.</li>
      <li>We may adjust, reset, or remove chip balances to fix bugs, stop abuse, or balance the game.</li>
      <li>You may <strong>not sell, buy, gift, or trade chips or your account</strong> for money or anything of value, on or off the app — doing so is grounds for an immediate ban.</li>
    </ul>
    <p>If you're ever offered a way to convert chips into money or value, that is <strong>not us, not authorised, and against these terms</strong> — don't use it, and please report it.</p>`,
  },
  {
    heading: "2. Not gambling · Age requirement",
    body: `<p>MonteCarloEdge is <strong>not a gambling product</strong>. There is no real-money wagering, no opportunity to win money or anything of value, and no real prize. The "No-Limit Hold'em" you play here is a simulation for skill practice and social play.</p>
    <p>Because of the theme, you must be <strong>18 or older</strong> (or older where your local age of majority is higher). By using the app you confirm you meet that requirement.</p>
    <p>You agree never to use MonteCarloEdge to conduct, facilitate, or simulate real-money gambling or any arrangement where chips, results, or access are exchanged for money or value. The app is designed and intended never to become gambling. Singapore prohibits unlicensed gambling under the Gambling Control Act 2022; turning this app into a gambling mechanism breaches these terms and may be a criminal offence.</p>`,
  },
  {
    heading: "3. Educational / entertainment only",
    body: `<p>The training mode, the fold/call/raise recommendations, win-percentage readouts, board "reads", and every other strategy output exist <strong>for practice and entertainment</strong>.</p>
    <ul>
      <li>They are <strong>not a guarantee</strong> you'll win any hand, session, or real-world game.</li>
      <li>They are <strong>not financial, investment, or gambling advice</strong>.</li>
      <li>Poker involves chance and incomplete information. Equity numbers and the engine's recommendations (including tuned heuristics) can be simplified, wrong, or buggy. Treat them as a study aid, not gospel.</li>
    </ul>
    <p>What you do with this knowledge in the real world is your decision and your responsibility.</p>`,
  },
  {
    heading: `4. "As is" · No warranty · Limitation of liability`,
    body: `<p>MonteCarloEdge is provided <strong>free, "as is" and "as available", with no warranties of any kind</strong>, express or implied. To the maximum extent permitted by law we disclaim all implied warranties (merchantability, fitness for a purpose, accuracy, non-infringement). We don't promise the app is uninterrupted, error-free, secure, or that its calculations are correct.</p>
    <p>To the maximum extent permitted by law, the developer will <strong>not be liable</strong> for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, profits, chips, opportunity, or goodwill arising from your use of (or inability to use) the app.</p>
    <p>Where liability can't be excluded, our <strong>total aggregate liability is capped at the greater of (a) what you actually paid for chip packs in the 3 months before the claim, or (b) USD 20</strong>. As the app is free and chips have no value, in practice this is effectively zero. Nothing here excludes liability that cannot lawfully be excluded, including your mandatory consumer rights.</p>`,
  },
  {
    heading: "5. Acceptable use",
    body: `<p>Use MonteCarloEdge like a decent human. You agree <strong>not</strong> to:</p>
    <ul>
      <li>Cheat, exploit bugs, or manipulate chips, results, presence, or other players' experience;</li>
      <li>Reverse-engineer, decompile, scrape, or extract the engine, charts, or source beyond what the law expressly permits;</li>
      <li>Use bots, scripts, or automated play;</li>
      <li>Attack, overload, or interfere with the app or its infrastructure;</li>
      <li>Impersonate others, harass players, or upload abusive, illegal, or infringing nicknames/content;</li>
      <li>Use the app to facilitate real-money gambling or to trade chips for value.</li>
    </ul>
    <p>We may suspend access — and reset chips — for anyone who breaks these rules.</p>`,
  },
  {
    heading: "6. Accounts, data & privacy",
    body: `<p>We keep your footprint small: <strong>no ads, and we do not sell your data</strong>.</p>
    <p><strong>On your device (localStorage):</strong> your profile (nickname, avatar), chip balance, daily-chip timestamp, session stats, and hand history. This stays in your browser unless you sign in.</p>
    <p><strong>If you sign in with Google (optional):</strong> we use <strong>Firebase Authentication</strong> to identify you and <strong>Cloud Firestore</strong> to store online presence (that you're online + your display name) and, when networked tables ship, multiplayer state. We store the minimum needed.</p>
    <p><strong>Third parties:</strong> <strong>Google / Firebase</strong> (sign-in, presence, multiplayer), <strong>Stripe</strong> (if chip-pack purchases launch — your card goes to Stripe, never to us), hosted as static files on <strong>GitHub Pages</strong>. Each operates under its own terms and privacy policy.</p>
    <p><strong>Your control:</strong> clearing local data is instant from Settings → Your Data (or by clearing browser storage). Data synced to your Google account is deleted on request — email ${CONTACT_EMAIL} with the Google account you used. If you're in the EU/UK and exercising GDPR rights (access, erasure, portability, etc.), say so and we'll honour applicable rights.</p>`,
  },
  {
    heading: "7. Intellectual property",
    body: `<p>MonteCarloEdge — its name, design, "Monte Carlo Midnight" look, code, the MCE Engine, charts, and copy — belongs to the developer and is protected by IP law. You get a <strong>personal, non-exclusive, non-transferable, revocable licence</strong> to use the app for its intended purpose. You may not copy, resell, rebrand, or build a competing product from it. Poker is public domain; this implementation is not.</p>`,
  },
  {
    heading: "8. Changes to these terms",
    body: `<p>The app is actively developed by one person, so these terms will evolve. We may update them at any time. Material changes update the <strong>"Last updated"</strong> date (currently ${LEGAL_UPDATED}) and may be flagged in-app. Continuing to use the app after an update means you accept it. The core promise — <strong>play-money only, never gambling</strong> — is a commitment, not something we'll quietly change.</p>`,
  },
  {
    heading: "9. Governing law",
    body: `<p>These terms are governed by the <strong>laws of Singapore</strong>. The <strong>courts of Singapore</strong> have jurisdiction over disputes, subject to any mandatory consumer-protection rights you have where you live.</p>`,
  },
  {
    heading: "10. Contact",
    body: `<p>MonteCarloEdge is a free hobby project by Caspar, based in Singapore. App: <a href="https://xynkro.github.io/MonteCarloEdge/">xynkro.github.io/MonteCarloEdge</a>.</p>
    <p>Questions, data-deletion requests, bug reports, or "someone's trying to turn chips into money" reports: <strong>${CONTACT_EMAIL}</strong>.</p>
    <p style="opacity:.7;margin-top:10px">Play the math. Own the table. Keep it play-money.</p>`,
  },
];

export const EXPLAINER_INTRO =
  `The Monte Carlo Edge sits beside you — it simulates the spot, reads the player, and calls the most profitable line, every hand. Play the player. Own the table.`;

// "Coined": the Monte Carlo Edge methodology — an exploitative, opponent-aware
// approach grounded in what the MCE Engine actually does (every claim verified at
// the code level; it never overclaims solver-grade depth).
export const EXPLAINER_SECTIONS: Section[] = [
  {
    heading: "The one idea: play the player, not the population",
    body: `<p>Most poker tools teach you <strong>GTO</strong> (Game Theory Optimal) — a balanced equilibrium you memorize from charts so no one can exploit you, whoever they are. That's a strategy built to <strong>not lose</strong> against a perfect player.</p>
    <p>The <strong>Monte Carlo Edge</strong> plays the opposite game. It simulates the exact spot you're in, reads the exact opponent across the table, and recommends the most profitable line against <em>them</em>. GTO says "don't lose." MCE says "<strong>win the most from the player in front of you</strong>." That's the Edge.</p>`,
  },
  {
    heading: "① Simulated, not memorized",
    body: `<p>Your win % comes from a <strong>Monte Carlo simulation</strong> of your exact hand against the hands opponents would <em>actually</em> play this way — not a number looked up from a chart, and not an average over millions of spots that aren't yours.</p>
    <p>These equities aren't guesses: they're validated against an <strong>exhaustive 1,712,304-board enumeration</strong>, so the core number you're trusting is ground-truth correct. Beat the pot odds and a call or raise prints.</p>`,
  },
  {
    heading: "② Equity you win, not just equity you hold",
    body: `<p>Holding 55% of the pot at showdown isn't the same as <em>banking</em> 55% — you still have to navigate streets to collect it, and that's harder out of position.</p>
    <p>The engine shows your <strong>raw equity</strong> (your share if the hand checks down) next to your <strong>realized equity</strong> (what you can realistically capture, discounted by position and street). Out of position, raw equity gets a haircut preflop through the turn; on the river there are no more streets to be outplayed, so the two numbers meet. Watching that gap is the fastest way to learn why position is worth so much.</p>`,
  },
  {
    heading: "③ Reads the player, not the population",
    body: `<p>The engine quietly profiles every opponent — how often they enter pots (VPIP), raise (PFR), continuation-bet, and fold to a c-bet — and after about <strong>eight hands</strong> it starts bending its recommendation toward that player's actual tendencies. Early on the read is provisional; the more hands it sees, the sharper it gets.</p>
    <p>This is the exact thing a static chart can't do — and it's where real money comes from: the <strong>leaks of the specific human in the seat</strong>.</p>`,
  },
  {
    heading: "④ Every call shows its work",
    body: `<p>No black box. Every recommendation is stamped with where it came from, so you know how hard to lean on it:</p>
    <ul>
      <li><strong>SOLVER</strong> — a live CFR solve (river heads-up spots, ~0.4s).</li>
      <li><strong>NASH</strong> — matches published push/fold equilibrium charts preflop.</li>
      <li><strong>CHART</strong> — a known reference line.</li>
      <li><strong>HEURISTIC</strong> — a tuned judgment call.</li>
    </ul>
    <p>Honest by design: postflop street play is heuristic, and the engine <em>labels</em> it that way rather than dressing it up as a solve. Trust a "solver" or "Nash" tag heavily; apply your own judgment to a "heuristic" one. A tool that tells you when it's only guessing can't be caught lying.</p>`,
  },
  {
    heading: "Where MCE is rock-solid — and where it isn't",
    body: `<p><strong>Rock-solid:</strong> the equity math (validated to ground truth), preflop push/fold (matches Nash), and river heads-up solves (real CFR).</p>
    <p><strong>Honest limits we won't hide:</strong> postflop multi-street play is tuned heuristics, <em>not</em> solved frequencies — so MCE is a decision <strong>coach with a solver spine</strong>, not a PioSolver- or GTO-Wizard-grade solver, and it doesn't claim to be. There's no rake model yet, and some draw odds are approximations. Exploiting an opponent also means deviating from balance, so a strong, observant player can in principle counter-exploit you — the honest cost of playing to win the most instead of playing not to lose.</p>`,
  },
  {
    heading: "⑤ Learn by playing: the Leak Report",
    body: `<p>Every Train-mode decision is logged and compared to the MCE line. The <strong>Leak Report</strong> (in Stats) groups your decisions by situation, scores your accuracy, and surfaces your <strong>biggest leaks</strong> — tagged by whether the reference was a solve or a heuristic, so you study the right things. Play a handful of hands to unlock it; it sharpens as you log more.</p>`,
  },
  {
    heading: "The chip economy (play-money only)",
    body: `<p>Chips here are <strong>play-money — full stop</strong>. You start with a stack, top up with <strong>free daily chips</strong>, and (soon) optionally grab <strong>chip packs</strong> for a bigger bankroll to mess around with.</p>
    <p>To be completely clear: <strong>chips have no cash value</strong> and are never cashable, withdrawable, redeemable, or transferable. A chip pack buys non-redeemable in-app chips and nothing else — exactly like free-to-play WSOP. There is no real-money wagering anywhere in MonteCarloEdge. This is a training-and-fun app, not gambling.</p>`,
  },
  {
    heading: "Quick start (3 steps)",
    body: `<p><strong>1. Tap Train.</strong> Set your table and deal in — playing in seconds.</p>
    <p><strong>2. Read before you act.</strong> Glance at the recommendation, your raw &amp; realized equity, the source tag, and the board read — then make your own call and see if you matched the engine.</p>
    <p><strong>3. Check your Leak Report.</strong> After a few hands, open Stats → Leak Report to see where you leak and what to drill.</p>
    <p>Install it to your home screen (it's a full offline app) and you've got <strong>the Monte Carlo Edge in your pocket</strong>. Play the player. Own the table.</p>`,
  },
];
