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
      <li><strong>The GTO advice is for practice and fun.</strong> It is not a promise you'll win, and it is not financial or gambling advice.</li>
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
      <li>Poker involves chance and incomplete information. Equity numbers and "GTO" approximations can be simplified, wrong, or buggy. Treat them as a study aid, not gospel.</li>
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
    body: `<p>MonteCarloEdge — its name, design, "Monte Carlo Midnight" look, code, the GTO engine, charts, and copy — belongs to the developer and is protected by IP law. You get a <strong>personal, non-exclusive, non-transferable, revocable licence</strong> to use the app for its intended purpose. You may not copy, resell, rebrand, or build a competing product from it. Poker is public domain; this implementation is not.</p>`,
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
  `A GTO engine sits beside you, calls the math on every spot, and tells you why. Play the math. Own the table.`;

export const EXPLAINER_SECTIONS: Section[] = [
  {
    heading: "The 4 modes",
    body: `<p><strong>🎯 Train</strong> — Solo practice vs a GTO decision engine. On every street it recommends <strong>fold / call / raise</strong> (with a size), shows your <strong>win %</strong>, and gives a board <strong>read</strong>. Make your call, then see if you matched it.</p>
    <p><strong>🌐 Play Online</strong> — Sign in with Google to set your presence and see who's online. Networked tables are coming; for now it's the lobby + your online profile.</p>
    <p><strong>👥 Pass &amp; Play (the benchmark)</strong> — Hot-seat poker on one device. Some seats are <strong>assisted</strong> (they get the tool) and some play <strong>blind</strong>. Deal a few orbits and watch the assisted seats pull ahead — the cleanest demonstration that the math helps.</p>
    <p><strong>👤 Profile / Chips</strong> — Your nickname, avatar, and a <strong>play-money chip wallet</strong>, plus your session stats and hand history.</p>`,
  },
  {
    heading: "How to read the Trainer",
    body: `<p><strong>The recommendation (Fold / Call / Raise)</strong> — the engine's best play for your exact hand, position, and the action. When a spot is a mix, it shows frequencies — great poker isn't always one fixed answer.</p>
    <p><strong>The win %</strong> — your real chance of winning right now, from a Monte Carlo simulation against the hands opponents would <em>actually</em> play this way (not every random holding). Beat the pot odds and a call/raise prints.</p>
    <p><strong>The board read</strong> — a plain-English scouting report:</p>
    <ul>
      <li><strong>Beats you</strong> — made hands already ahead of you.</li>
      <li><strong>Drawing</strong> — draws live to overtake you next card.</li>
      <li><strong>Villain reps</strong> — what their betting <em>represents</em> on this board, a rough <strong>~X% bluffs</strong> read, and a lean (<em>call lighter / be careful / raise-bluff spot</em>) — read from texture + player type, never by peeking at cards.</li>
      <li><strong>Rep → bet</strong> — the story <em>you</em> can tell, and the bet size that tells it credibly.</li>
    </ul>`,
  },
  {
    heading: `What "GTO" means (in one paragraph)`,
    body: `<p>GTO = Game Theory Optimal — the mathematically balanced way to play that no opponent can exploit, whatever they do. The unbeatable baseline: bet strong hands and a balanced share of bluffs, at sizes and frequencies that hide which is which. You won't (and shouldn't) always play pure GTO at a live table — exploiting weak players makes more — but knowing the GTO line tells you exactly how far off you are, and in which direction. That's the yardstick the trainer grades you against.</p>`,
  },
  {
    heading: "The Leak Report",
    body: `<p>Every Train-mode decision is logged and compared to the engine's. The <strong>Leak Report</strong> (in Stats) groups your decisions by situation, shows your accuracy in each, and surfaces your <strong>biggest leaks</strong> — the spots where you stray furthest from optimal. Play a handful of hands to unlock it; it sharpens as you log more. The fastest way to find the exact part of your game bleeding chips, then fix it.</p>`,
  },
  {
    heading: "The chip economy (play-money only)",
    body: `<p>Chips here are <strong>play-money — full stop</strong>. You start with a stack, top up with <strong>free daily chips</strong>, and (soon) optionally grab <strong>chip packs</strong> for a bigger bankroll to mess around with.</p>
    <p>To be completely clear: <strong>chips have no cash value</strong> and are never cashable, withdrawable, redeemable, or transferable. A chip pack buys non-redeemable in-app chips and nothing else — exactly like free-to-play WSOP. There is no real-money wagering anywhere in MonteCarloEdge. This is a training-and-fun app, not gambling.</p>`,
  },
  {
    heading: "Quick start (3 steps)",
    body: `<p><strong>1. Tap Train.</strong> Set your table and deal in — playing in seconds.</p>
    <p><strong>2. Read before you act.</strong> Glance at the recommendation, your win %, and the board read — then make your own call and see if you matched the engine.</p>
    <p><strong>3. Check your Leak Report.</strong> After a few hands, open Stats → Leak Report to see where you leak and what to drill.</p>
    <p>Install it to your home screen (it's a full offline app) and you've got a GTO coach in your pocket.</p>`,
  },
];
