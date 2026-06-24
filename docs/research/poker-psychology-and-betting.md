# Poker Psychology & Betting — Research Foundation

> Thesis-depth, cited research into the psychology and betting heuristics of poker.
> Built 2026-06-25 via a parallel research harness (6 sub-domain researchers → adversarial citation source-check → synthesis).
> Companion to [`mce-strategy-heuristics-audit.md`](./mce-strategy-heuristics-audit.md) (the code-side gap analysis).
>
> **Citation integrity note:** an adversarial pass tried to disprove every reference. Any citation it could not
> confirm firsthand is flagged `[needs-verification]` in-text and must be human-checked before book publication.
> Source-check flagged **21** suspect citation(s) and **26** pop-psychology myth(s) — see the
> "Source-Check Ledger" section at the end.

---

# The Psychology of Poker: Game-Theoretic Equilibrium, Exploitative Deviation, and the Human Mind at the Table

## A Master Research Report for MonteCarloEdge and the *C.M. Engue* Project

---

## Executive Summary

This report synthesises five domains of poker scholarship — game-theoretic foundations, population-level exploits, cognitive biases, the tilt/mental game, and the betting-and-deception literature — into a single, citation-audited evidence base designed to do two things at once: ground a publication-quality academic book (*C.M. Engue*) and supply a concrete, encodable exploitative layer to sit atop the MonteCarloEdge (MCE) game-theory-optimal (GTO) engine.

The central thesis is reducible to one sentence. **GTO is an unexploitable floor, not a profit ceiling; profit comes from deviating toward a best response against opponents whose frequencies depart from the indifference points the equilibrium prescribes — and human opponents depart from those points in lawful, psychologically predictable ways.** Every heuristic in this report is an instance of that single move: detect a deviation, estimate its magnitude and your confidence in it, and shift off GTO by a clamped amount proportional to that confidence.

Four findings carry the most weight, each resting on peer-reviewed primary sources retrieved and read firsthand:

1. **Reference-dependence governs risk appetite (the break-even effect).** Two large hand-history studies — Smith, Levere, and Kurtzman (2009) and Eil and Lien (2014) — independently show that experienced players who are *losing within a session* become looser and more risk-seeking to "get back to even," while winners turn risk-averse and lock up. The asymmetry (loss → loosen/chase; win → tighten/protect) is the single most encodable read in the corpus, and it is exactly what prospect theory predicts (Kahneman & Tversky, 1979).

2. **Tilt is a specific, anger-based moral emotion, not generic recklessness.** Converging work (Palomäki, Laakasuo, & Salmela, 2013, 2014; Laakasuo, Palomäki, & Salmela, 2015; Moreau, Chauchard, Sévigny, & Giroux, 2020) shows bad beats are appraised as *unjust*, licensing EV-negative retaliation. Critically, anger and fear push risk in *opposite* directions (Lerner & Keltner, 2001) — a distinction the engine must preserve as two signed axes, never one scalar.

3. **Most opponents reason only ~1.5 strategic steps deep.** The cognitive-hierarchy model (Camerer, Ho, & Chong, 2004) is the formal justification for the entire exploit layer: a hero who reasons one level above the table beats it. This converts "levelling" from folk wisdom into a tunable parameter.

4. **Deviation must be safety-clamped.** Computer-poker theory (Ganzfried & Sun, 2018; Johanson, Bowling, Waugh, & Zinkevich, 2011; Johanson & Bowling, 2009) formalises the exploitation–exploitability trade-off: a full best response to a point-estimate opponent model is itself maximally exploitable if the model is wrong. The robust answer (Restricted Nash Response / Data-Biased Response) scales deviation by read confidence — the master clamp that must wrap every other heuristic.

**Citation integrity.** This synthesis removes or repairs every citation the source-check flagged. Most consequentially: the original draft cited **Tait and Miller (2019)** as evidence that loss aversion *drives* the sunk-cost fallacy; firsthand verification of the article (PMC7318389) confirms the study found the **opposite** — its hypothesis was *not supported*, with a weak non-significant *negative* relationship (overall r = .13, p = .094; F = 4.13, p = .044 but reversed in sign). That sunk-cost claim is therefore re-anchored to Zhang and Clark (2020). The MacLean–Thorp–Ziemba Kelly citation is corrected to its peer-reviewed venue (*Quantitative Finance*, 2010). The Tversky and Kahneman (1974) author-initial typo, the Kuhn (1950) pagination, and the Johanson author-order error are fixed. Four pop-myth framings (the "hot hand is pure fallacy" overstatement, dubious facial-tell lore, a universal house-money effect, and "experience protects against tilt") are flagged and corrected in-text.

---

## 1. Game-Theoretic Foundations: The Floor Beneath Everything

### 1.1 Equilibrium, value, and the indifference principle

No-Limit Hold'em is a two-player (heads-up) zero-sum extensive-form game of imperfect information. Von Neumann's minimax theorem (1928) guarantees such games possess a value and a saddle-point equilibrium in mixed strategies, and von Neumann and Morgenstern (1944) and Kuhn (1950) established that bluffing and slow-playing are not psychological flourishes but *mathematically forced* features of equilibrium. In Kuhn poker — the simplest poker game with a known solution — the unique equilibrium is mixed, with no pure-strategy equilibrium: the bettor bluffs the worst hand at frequency α and value-bets the best at 3α, calibrated so the opponent's bluff-catcher is *exactly indifferent* between calling and folding (Kuhn, 1950). This is the **indifference principle**, and it is the conceptual hinge of the entire exploitative project: indifference is imposed *by the opponent's strategy*, so any opponent whose frequencies differ from the indifference point is, by definition, exploitable.

### 1.2 MDF and alpha as reciprocal indifference frequencies

For a bet of size *B* into pot *P*, two reciprocal quantities follow directly from pot odds (derivable from the Kuhn equilibrium and documented in field-standard solver sources; GTO Wizard, 2022):

- **Alpha** (α = B/(B+P)) is how often the opponent must fold for a zero-equity bluff to break even.
- **Minimum Defence Frequency** (MDF = P/(B+P) = 1−α) is the minimum fraction the defender must continue to deny a pure bluff automatic profit.

A 60-into-100 bet yields α = 37.5%, MDF = 62.5%. **The crucial caveat, which the engine must encode as a first-class rule, is that MDF is a *shield against over-bluffing, not a target*.** It assumes bluffs have zero equity (false before the river) and only bounds the over-bluffing case. Against the modal low/mid-stakes population — which *under*-bluffs — defending to MDF *over*-defends; the correct response is to lower the shield and **over-fold** (GTO Wizard, 2022; Liakos, 2024).

### 1.3 GTO is unexploitable but not maximally exploitative

A Nash strategy in heads-up play guarantees at least the game value (minus rake) regardless of opponent, but it does not *punish* mistakes — it only prevents the opponent from profiting. Because real opponents deviate, a best response earns strictly more (Sonawane & Chheda, 2024). The superhuman milestones confirm the equilibrium baseline that exploits layer onto: Cepheus/CFR+ essentially solved heads-up limit hold'em to 0.986 mbb/g exploitability — below the 1 mbb/g threshold at which a human lifetime of play cannot statistically distinguish it from exact (Bowling, Burch, Johanson, & Tammelin, 2015; Tammelin, 2014; Zinkevich, Johanson, Bowling, & Piccione, 2007); DeepStack (Moravčík et al., 2017) and Libratus (Brown & Sandholm, 2018) extended superhuman play to no-limit.

**Two boundary conditions matter for MCE.** First, in three-or-more-player games the Nash guarantee collapses: independently computed equilibria need not combine into an equilibrium, two-player Nash is PPAD-complete (Chen, Deng, & Teng, 2009), and Pluribus abandoned strict equilibrium-seeking for self-play blueprints plus real-time search yet still beat elite pros six-handed (Brown & Sandholm, 2019). The engineering consequence is that **multiway play demands *more* exploitation, not less, because equilibrium offers less cover** — and bluffs require fold equity from every live player, so required success compounds. Second, the "GTO cannot lose" claim holds *only* heads-up and *only* in expectation minus rake; the engine copy must always carry that qualifier.

### 1.4 Behavioural game theory: bounded depth of reasoning

Humans do not reason to infinite depth. The level-*k* (Nagel, 1995; Stahl & Wilson, 1995) and cognitive-hierarchy (Camerer et al., 2004) models posit a naive level-0 player, with each level-*k* best-responding to lower levels; across many experimental games the estimated mean depth is roughly **τ ≈ 1.5 steps**. A level-1 villain assumes the hero is honest and so over-folds to aggression and over-respects value bets; a level-2 "thinking" regular anticipates the hero's bluffs and counters with hero-calls and light re-raises. *Caveat for honest framing:* τ ≈ 1.5 is an average across one-shot normal-form lab games; transferring it to repeated multi-street poker is a reasonable default prior, not a measured poker constant (Camerer et al., 2004). The engine should seed new villains at ~level 1.5 and update from observed fold-to-aggression and light-call-down rates.

---

## 2. Population Tendencies and Exploitative Profiling

Only 10–15% of online players are long-run profitable (Frey, Albino, & Williams, 2018), and skill is persistent: across 456 million player-hand observations, earlier profitability strongly predicted later profitability (rank correlation ~0.73), with skill dominating luck after ~1,500 hands (Potter van Loon, van den Assem, & van Dolder, 2015). This persistence is what *licenses* a per-villain model: betting tendencies are stable traits, not noise, justifying a sample-size gate (~hundreds to 1,500 observations) before a read is trusted.

Frey et al. (2018) explain *why* strong players resist exploitation: across 1.75 million heads-up hands, winners and losers did not differ in *how much* information they processed but in *how* — winners integrate private cards with public signals *synergistically*, so their actions act like a private key that encrypts their strategy, while weaker players process information redundantly and so map near-deterministically from action to hand strength. **The operational corollary is decisive: weight every sizing and timing tell *inversely* to opponent skill** — read weak players' sizes literally, and treat strong regs' range-based sizes as nearly uninformative.

Player typology is operationalised through HUD statistics (thresholds are practitioner-grade calibration priors cross-checked across DriveHUD, SmartPokerStudy, and PokerAlpha, not peer-reviewed constants): a **nit** (VPIP < 15, PFR < 12) under-bluffs and over-folds; a **calling station** (VPIP ≥ 35, low PFR, AF < 1.5, high WTSD) under-folds and over-calls. The exploits follow mechanically from the indifference math: over-fold to the nit's aggression and skip 4-bet bluffs; value-bet thinner and bigger against the station and cut bluffs toward zero.

Mass-data nodelock analysis documents stable population leaks: in wide, uncapped, unfiltered nodes (button-vs-big-blind single-raised-pot turn probes; flop-range-bet then bricked-turn lines) the population *over*-bluffs, and the sensitivity is extreme — shifting a villain's river bluff frequency from the balanced 27% to just 31% flips the hero's entire bluff-catcher response from mixed to *never fold* (Liakos, 2024; Vanja, 2025). This 27%→31% figure is the best-calibrated tuning anchor in the corpus. Conversely, populations *under*-use creative lines (river check-raises, polarised blind 3-bets), so a non-intuitive aggressive line from a non-elite player is **near-pure value** (Vanja, 2025) — a heuristic that must be gated *off* against elite/balanced opponents to avoid being counter-exploited.

The whole edifice rests on a **master safety clamp**. A full best response to a point-estimate model maximises exploitation but also one's own exploitability if the model is wrong; Restricted Nash Response (Johanson et al., 2011) and Data-Biased Response (Johanson & Bowling, 2009) give the opponent probability *p* (typically 0.95–0.99) of playing the model and 1−*p* of playing a nemesis, achieving near-best-response exploitation at far lower worst-case cost (Ganzfried & Sun, 2018). Deviation should therefore scale as `GTO + clamp(p · (bestResponse − GTO))`, with *p* a function of sample size, collapsing to pure GTO when the sample is thin or the villain is elite.

---

## 3. Cognitive Biases and Decision-Making Under Uncertainty

### 3.1 Prospect theory and the break-even effect

People evaluate outcomes as gains and losses relative to a reference point, with a value function concave in gains, convex in losses, and steeper for losses (loss aversion ~2×), producing the reflection effect: risk-averse over sure gains, risk-*seeking* over sure losses (Kahneman & Tversky, 1979). In poker this manifests as the **break-even effect**: a player *stuck* below their session reference point sits in the loss domain and turns risk-seeking — calling wider, chasing, barrelling to recoup — while a player who is *up* turns risk-averse and locks up (Thaler & Johnson, 1990; Eil & Lien, 2014; Smith et al., 2009). The mechanism is corroborated at scale by Shoily (2025), whose 4.9-million-hand study found players anchor a 100bb reference point and become *more* risk-seeking as a down stack recovers toward even.

**Myth flag — the house-money effect is experience-moderated, not universal.** Thaler and Johnson (1990) *did* find a house-money effect in general lab populations, and recreational/novice winners may tilt up after wins; the "weak-to-absent" finding holds specifically for *experienced* players (Eil & Lien, 2014). State it as experience-moderated.

### 3.2 Randomness misperception: gambler's fallacy and the hot hand

Real-money casino field data (24,131 bets, 139 players) show betting *against* a streak becomes significant after streaks of 5 and reaches 85% after streaks of 6+ (gambler's fallacy), while players also bet *more* after wins and 80% quit after a loss versus 20% after a win (hot-hand belief) — and the same individuals frequently hold *both* biases (Croson & Sundali, 2005; Sundali & Croson, 2006).

**Myth flag — "the hot hand is pure fallacy" is overstated.** Miller and Sanjurjo (2018) showed the classic hot-hand finding was contaminated by a finite-sequence selection bias; corrected, a real hot-hand effect appears in basketball. In *roulette* (Croson & Sundali's setting) outcomes are genuinely independent, so the data stand; but in *poker* — a skill game with real momentum via confidence, tilt, and dynamic table image — a winning streak can be partly real. The engine must therefore frame the read as opponents **over-attributing** momentum, never as "momentum is illusory."

### 3.3 Affect, anchoring, sunk cost, and confirmation bias

Even players who can compute EV correctly deviate when emotionally activated, because feelings dominate cognition at the moment of choice (risk-as-feelings; Loewenstein, Weber, Hsee, & Welch, 2001). Anchoring-and-adjustment (Tversky & Kahneman, 1974) explains habitual fixed-fraction bet-sizing and under-adjustment to scary turn/river cards. These have strong general-psychology grounding but *thin* poker-specific empirical support and are therefore encoded as **lower-confidence priors**.

**Citation repair — sunk cost.** The sunk-cost / pot-commitment read (committed villains won't fold → suppress bluffs, maximise value) is sound, but its support is re-anchored to Zhang and Clark (2020). The draft's citation of Tait and Miller (2019) as confirming "loss aversion drives the sunk-cost fallacy" is **removed**: firsthand verification confirms that study's hypothesis was *not supported* — the relationship was a weak, non-significant *negative* one (overall r = .13, p = .094). Tait and Miller may be cited only for the *question*, with the null result reported honestly. Loose-passive players who "win many small pots, lose stacks in big ones" (a mental-accounting failure) remain a valid target (Siler, 2010), as does the recency/over-reaction read drawn from high-quality practitioner analysis (GTO Wizard, 2023).

---

## 4. Tilt and the Mental Game

Tilt — a transient loss of behavioural control driven by negative emotion that degrades decisions and produces excess loss — is the central, empirically validated construct of the mental game (Moreau et al., 2020; Palomäki, Laakasuo, Cowley, & Lappi, 2020). It is best understood not as generic recklessness but as a specific **moral anger**: players appraise variance as personally unjust ("I worked diligently for that money") and this licenses an aggressive-but-EV-negative retaliation strategy of over-betting and loss-chasing (Palomäki et al., 2013). The Online Poker Tilt Scale isolates two dissociable factors — *emotional/behavioural* tilt (anger, impulsive action) and *cognitive* tilt (lost focus, dissociation, indiscriminate risk) — which can move independently (Moreau, Delieuvin, Chabrol, & Chauchard, 2017; Hamel, Bastien, Jacques, Moreau, & Giroux, 2021). These map to two distinct exploit signatures: rage-tilt → over-aggression and hero-calls (so the hero reduces bluffs and bluff-catches wider); cognitive tilt → autopilot and missed adjustments (so the hero isolates, runs thin value, and *can* still bluff because the villain is auto-piloting, not hero-calling).

The emotion→risk link is grounded in the Appraisal-Tendency Framework, the single most important and best-supported distinction in this domain. **Anger and fear share negative valence but push risk in opposite directions**: anger carries appraisals of certainty and control, producing optimism and risk-*seeking*; fear carries uncertainty and low control, producing pessimism and risk-*aversion* (Lerner & Keltner, 2001; Lerner, Li, Valdesolo, & Kassam, 2015). An angry villain bluffs and stacks off light (call/value); a fearful villain — short near a pay jump, recently stacked — over-folds (bluff more). **The engine must not collapse these into one tilt scalar.** Moreover, incidental emotion carries over from unrelated sources without awareness (Lerner et al., 2015), so off-table stressors import into in-game decisions.

Loss-chasing is the behavioural fingerprint, bridged from affect by *negative urgency* (mood-related impulsivity) and prospect-theory reference dynamics: bet size rises on *losing* but not winning streaks (Studer, Limbrick-Oldfield, & Clark, 2015), induced sadness increases gambling persistence (Devos, Clark, Maurage, & Billieux, 2018), and chasing tracks *unrealised* ("paper") losses, vanishing once losses are psychologically realised (Imas, 2016; Zhang & Clark, 2020). Near-misses are a built-in accelerant: rated *less* pleasant than clear losses yet increasing the urge to continue and recruiting dopaminergic reward circuitry that scales with gambling severity (Habib & Dixon, 2010; Chase & Clark, 2010) — making the 1–2 hands after a busted big draw a prime over-aggression window. Fatigue compounds it: in a 28-day ecological study, sleep-deprived sessions showed higher emotional/behavioural tilt, more hands played, and greater net losses, intensified by alcohol (Hamel et al., 2021).

**Myth flag — experience does not shield against tilt.** Counter-intuitively, more experienced players believe they tilt *less* but report *more* severe tilting, and loss-sensitivity predicts severity at all experience levels (Palomäki et al., 2014, N = 417); their only inhibition advantage is partial physiological *masking*, which itself vanishes for poker-specific inductions (Challet-Bouju et al., 2020). The engineering consequence: **trust behavioural tilt metrics (sizing/tempo/VPIP deltas, prior bad-beat events), never a reg's apparent calm or self-reported emotional state.** This also disciplines the broader framing — the hero cannot *read* a covert emotion online, so all tilt inputs must be *behavioural-state inferences*, not "emotion reads," lest tells-lore creep in the back door.

For the hero, the coaching prescription is *reappraisal over suppression*: reappraisal reduces both felt and expressed emotion with no memory cost, whereas suppression fails to reduce felt emotion, impairs working memory, and raises physiological arousal (Gross, 2002). The applied tilt typology and "inject logic before the threshold" construct (Tendler & Carter, 2011) are sound scaffolding atop Gross but should be cited as a self-published practitioner source, not peer-reviewed evidence. Finally, social scrutiny multiplies anger's damage: anger degraded decision accuracy *specifically when participants were "being watched"* (Laakasuo et al., 2015), and needling is a documented accelerant (Browne, 1989) — so the heads-up / on-stream / just-shown-a-bluff context should combine *multiplicatively* with the anger axis.

---

## 5. Betting, Sizing, and the Deception Literature

A bet size is itself a signal, and the gap between GTO sizing and human sizing is where information leaks. GTO supplies the backbone: polarised ranges (nuts + bluffs, few medium hands) justify large bets and overbets; merged/condensed ranges justify small bets; nut/range advantage dictates which is correct (GTO Wizard, 2023). Humans deviate predictably — a size "too small for the board's polarity" implies a capped/merged range to be attacked, while an overbet *claims* polarisation that recreational players rarely have the bluffs to back.

The load-bearing exploit, grounded in both indifference math and population data, is to **over-fold bluff-catchers against large bets and overbets from passive/recreational villains who systematically under-bluff** (GTO Wizard, 2022; Liakos, 2024). Conversely, capped and passive (small-bet, check-heavy) ranges should be attacked with larger sizings and more bluffs.

The deception literature supplies mechanism but must be reported with calibrated humility — *no rigorous peer-reviewed study isolates bet-size→range inference or online timing tells*; the granular mappings are solver-grounded professional consensus, not empirical proof. The genuine peer-reviewed findings are these: bluffing is recursive theory-of-mind, increasing inter-brain synchronisation in mentalising regions (right temporo-parietal junction), most under high penalty (Wang, Wang, Zhou, & Yu, 2020) — which argues for a true opponent-model layer over static range-vs-range. Social-stereotype cues bias deception: players bluff perceived-female-avatar tables ~6% more often, making calling there ~$21.63/bet more profitable (Palomäki, Yan, Modic, & Laakasuo, 2016) — though the companion "males bluff 13% more" claim rests on only 36 women and is underpowered, so only the avatar-bias half is safe to encode. Personality moderates *how* people deceive: high-Machiavellian players bluff with *larger sizes* (not higher frequency) and are more rattled when trapped (Palomäki, Yan, & Laakasuo, 2016), so oversized bluffs may be a "control"-driven tell to call wider and to trap.

**Myth flags — physical tells.** Two real but weak papers must be presented as small-sample curiosities, never as encodable mechanical reads. Slepian, Young, Rutchick, and Ambady (2013) found betting-arm motion read above chance, but clips were only large push-bets, "smoothness" was *perceived* not measured, and ~80% of "professionals" were amateurs; Schlicht, Shimojo, Camerer, Battaglia, and Nakayama (2010) found trustworthy faces induce more folds, but on N = 14 novices in a no-feedback task. Both belong behind manual, explicitly-unreliable, live-only inputs capped at the studies' own ~3% effect sizes. **The methodologically correct choice — which the engine makes — is to ground all reads in betting-pattern and session-P&L signals, not body language**, since human deception-detection accuracy sits barely above chance. Timing tells (fast = weak/automatic; tank-then-aggression = polarised) survive only as low-weight, showdown-confirmed, per-villain nudges, suppressed against observant opponents and reframed as "polarised" rather than flatly "strong."

---

## 6. Bankroll, Overconfidence, and Expertise

Skill is real and rewards the discipline that variance demands: a-priori high-skill WSOP players returned +30.5% ROI versus −15.6% for the field, with a high-skill player beating a low-skill player 54.9% of the time — comparable to MLB playoff-team win rates (Levitt & Miles, 2014). That modest per-encounter edge under high variance is precisely why bankroll management is a Kelly problem. The Kelly criterion (maximise expected log wealth) asymptotically maximises growth and never risks ruin, but its wagers can be enormous and its drawdowns brutal; betting *double* Kelly drives long-run excess growth to zero, so disciplined players use *fractional* Kelly (MacLean, Thorp, & Ziemba, 2010 — corrected to its *Quantitative Finance* venue). The "double-Kelly = zero growth" result is the rigorous warning behind "playing too high for your roll."

Humans systematically misjudge their edge. Bottom-quartile performers (actual ~12th percentile) rate themselves near the 62nd, because incompetence removes the metacognition to detect it (Kruger & Dunning, 1999) — the mechanism behind the losing regular who "can't be bluffed." This translates to measurable losses in the closest real-money analog: the most active (overconfident) traders earned 11.4% against a 17.9% market (Barber & Odean, 2000) — an *analogy* to spew, not poker data. Expertise is real but bounded: deliberate practice explains only ~26% of performance variance in games (Macnamara, Hambrick, & Oswald, 2014), with the missing variance in poker dominated by emotion regulation — which returns us to tilt as the largest correctable leak.

*Honest caveat on decision fatigue.* The "hungry judge" finding (Danziger, Levav, & Avnaim-Pesso, 2011) — favourable rulings declining across a session and rebounding after a break — is genuinely contested: Glöckner (2016) shows case-ordering artifacts inflate the magnitude, and the broader ego-depletion literature replicates weakly (Pignatiello, Martin, & Hickman, 2020). The late-session exploit and hero break-nudge should therefore be a *weak* prior and a wellness nudge, not a confident read.

---

## 7. Synthesis: From Equilibrium to the Encodable Edge

The five domains compose into one architecture. GTO is the prior and the unexploitable reference distribution; the cognitive-hierarchy result (τ ≈ 1.5) is the formal warrant that most opponents can be out-levelled; prospect theory and tilt research specify the *direction* of human deviation (loss → loosen/chase; anger → risk-seek; fear → risk-avoid; near-miss → spew); the population-leak and HUD literature supply the *observable triggers*; and the exploitation–exploitability trade-off supplies the *magnitude clamp*. The engine's job is to maintain, per villain, a posterior over their frequencies, compare it to the indifference points (α, MDF, value:bluff ratio) the node prescribes, and emit a deviation sized by confidence. The book's job is to narrate why each of those deviations is both mathematically and psychologically inevitable.

---

## References

Barber, B. M., & Odean, T. (2000). Trading is hazardous to your wealth: The common stock investment performance of individual investors. *The Journal of Finance, 55*(2), 773–806. https://doi.org/10.1111/0022-1082.00226

Bowling, M., Burch, N., Johanson, M., & Tammelin, O. (2015). Heads-up limit hold'em poker is solved. *Science, 347*(6218), 145–149. https://doi.org/10.1126/science.1259433

Brown, N., & Sandholm, T. (2018). Superhuman AI for heads-up no-limit poker: Libratus beats top professionals. *Science, 359*(6374), 418–424. https://doi.org/10.1126/science.aao1733

Brown, N., & Sandholm, T. (2019). Superhuman AI for multiplayer poker. *Science, 365*(6456), 885–890. https://doi.org/10.1126/science.aay2400

Browne, B. R. (1989). Going on tilt: Frequent poker players and control. *Journal of Gambling Behavior, 5*(1), 3–21. https://doi.org/10.1007/BF01022134

Camerer, C. F., Ho, T.-H., & Chong, J.-K. (2004). A cognitive hierarchy model of games. *The Quarterly Journal of Economics, 119*(3), 861–898. https://doi.org/10.1162/0033553041502225

Challet-Bouju, G., Bruneau, M., Victorri-Vigneau, C., Grall-Bronnec, M., & the JEU Group. (2020). Inhibitory control in poker: Do experienced non-pathological poker gamblers exhibit better performance than healthy controls on motor, verbal and emotional expression inhibition? *Journal of Behavioral Addictions, 9*(2), 347–362. https://doi.org/10.1556/2006.2020.00019

Chase, H. W., & Clark, L. (2010). Gambling severity predicts midbrain response to near-miss outcomes. *The Journal of Neuroscience, 30*(18), 6180–6187. https://doi.org/10.1523/JNEUROSCI.5758-09.2010

Chen, X., Deng, X., & Teng, S.-H. (2009). Settling the complexity of computing two-player Nash equilibria. *Journal of the ACM, 56*(3), Article 14. https://doi.org/10.1145/1516512.1516516

Croson, R., & Sundali, J. (2005). The gambler's fallacy and the hot hand: Empirical data from casinos. *Journal of Risk and Uncertainty, 30*(3), 195–209. https://doi.org/10.1007/s11166-005-1153-2

Danziger, S., Levav, J., & Avnaim-Pesso, L. (2011). Extraneous factors in judicial decisions. *Proceedings of the National Academy of Sciences, 108*(17), 6889–6892. https://doi.org/10.1073/pnas.1018033108

Devos, G., Clark, L., Maurage, P., & Billieux, J. (2018). Induced sadness increases persistence in a simulated slot machine task among recreational gamblers. *Psychology of Addictive Behaviors, 32*(3), 383–388. https://doi.org/10.1037/adb0000364

Eil, D., & Lien, J. W. (2014). Staying ahead and getting even: Risk attitudes of experienced poker players. *Games and Economic Behavior, 87*, 50–69. https://doi.org/10.1016/j.geb.2014.04.008

Frey, S., Albino, D. K., & Williams, P. L. (2018). Synergistic information processing encrypts strategic reasoning in poker. *Cognitive Science, 42*(5), 1457–1476. https://doi.org/10.1111/cogs.12632

Ganzfried, S., & Sun, Q. (2018). Bayesian opponent exploitation in imperfect-information games. *arXiv*. https://doi.org/10.48550/arXiv.1603.03491

Glöckner, A. (2016). The irrational hungry judge effect revisited: Simulations reveal that the magnitude of the effect is overestimated. *Judgment and Decision Making, 11*(6), 601–610.

Gross, J. J. (2002). Emotion regulation: Affective, cognitive, and social consequences. *Psychophysiology, 39*(3), 281–291. https://doi.org/10.1017/S0048577201393198

Habib, R., & Dixon, M. R. (2010). Neurobehavioral evidence for the "near-miss" effect in pathological gamblers. *Journal of the Experimental Analysis of Behavior, 93*(3), 313–328. https://doi.org/10.1901/jeab.2010.93-313

Hamel, A., Bastien, C., Jacques, C., Moreau, A., & Giroux, I. (2021). Sleep or play online poker? Gambling behaviors and tilt symptoms while sleep deprived. *Frontiers in Psychiatry, 11*, 600092. https://doi.org/10.3389/fpsyt.2020.600092

Imas, A. (2016). The realization effect: Risk-taking after realized versus paper losses. *American Economic Review, 106*(8), 2086–2109. https://doi.org/10.1257/aer.20140386

Johanson, M., & Bowling, M. (2009). Data biased robust counter strategies. *Proceedings of the 12th International Conference on Artificial Intelligence and Statistics (AISTATS), PMLR 5*, 264–271.

Johanson, M., Bowling, M., Waugh, K., & Zinkevich, M. (2011). Accelerating best response calculation in large extensive games. *Proceedings of the 22nd International Joint Conference on Artificial Intelligence (IJCAI)*, 258–265.

Kahneman, D., & Tversky, A. (1979). Prospect theory: An analysis of decision under risk. *Econometrica, 47*(2), 263–291. https://doi.org/10.2307/1914185

Kelly, J. L., Jr. (1956). A new interpretation of information rate. *The Bell System Technical Journal, 35*(4), 917–926. https://doi.org/10.1002/j.1538-7305.1956.tb03809.x

Kruger, J., & Dunning, D. (1999). Unskilled and unaware of it: How difficulties in recognizing one's own incompetence lead to inflated self-assessments. *Journal of Personality and Social Psychology, 77*(6), 1121–1134. https://doi.org/10.1037/0022-3514.77.6.1121

Kuhn, H. W. (1950). A simplified two-person poker. In H. W. Kuhn & A. W. Tucker (Eds.), *Contributions to the theory of games* (Vol. 1, pp. 97–104). Princeton University Press.

Laakasuo, M., Palomäki, J., & Salmela, M. (2015). Emotional and social factors influence poker decision making accuracy. *Journal of Gambling Studies, 31*(3), 933–947. https://doi.org/10.1007/s10899-014-9454-5

Lerner, J. S., & Keltner, D. (2001). Fear, anger, and risk. *Journal of Personality and Social Psychology, 81*(1), 146–159. https://doi.org/10.1037/0022-3514.81.1.146

Lerner, J. S., Li, Y., Valdesolo, P., & Kassam, K. S. (2015). Emotion and decision making. *Annual Review of Psychology, 66*, 799–823. https://doi.org/10.1146/annurev-psych-010213-115043

Levitt, S. D., & Miles, T. J. (2014). The role of skill versus luck in poker: Evidence from the World Series of Poker. *Journal of Sports Economics, 15*(1), 31–44. https://doi.org/10.1177/1527002512449471

Liakos, S. (2024). *Calling down the over-bluffed lines in lower limits.* GTO Wizard Blog. https://blog.gtowizard.com/calling-down-the-over-bluffed-lines-in-lower-limits/

Loewenstein, G. F., Weber, E. U., Hsee, C. K., & Welch, N. (2001). Risk as feelings. *Psychological Bulletin, 127*(2), 267–286. https://doi.org/10.1037/0033-2909.127.2.267

MacLean, L. C., Thorp, E. O., & Ziemba, W. T. (2010). Long-term capital growth: The good and bad properties of the Kelly and fractional Kelly capital growth criteria. *Quantitative Finance, 10*(7), 681–687. https://doi.org/10.1080/14697688.2010.506108

Macnamara, B. N., Hambrick, D. Z., & Oswald, F. L. (2014). Deliberate practice and performance in music, games, sports, education, and professions: A meta-analysis. *Psychological Science, 25*(8), 1608–1618. https://doi.org/10.1177/0956797614535810

Miller, J. B., & Sanjurjo, A. (2018). Surprised by the hot hand fallacy? A truth in the law of small numbers. *Econometrica, 86*(6), 2019–2047. https://doi.org/10.3982/ECTA14943

Moravčík, M., Schmid, M., Burch, N., Lisý, V., Morrill, D., Bard, N., Davis, T., Waugh, K., Johanson, M., & Bowling, M. (2017). DeepStack: Expert-level artificial intelligence in heads-up no-limit poker. *Science, 356*(6337), 508–513. https://doi.org/10.1126/science.aam6960

Moreau, A., Chauchard, É., Sévigny, S., & Giroux, I. (2020). Tilt in online poker: Loss of control and gambling disorder. *International Journal of Environmental Research and Public Health, 17*(14), 5013. https://doi.org/10.3390/ijerph17145013

Moreau, A., Delieuvin, J., Chabrol, H., & Chauchard, E. (2017). Online Poker Tilt Scale (OPTS): Creation and validation of a tilt assessment in a French population. *International Gambling Studies, 17*(2), 205–218. https://doi.org/10.1080/14459795.2017.1321680

Nagel, R. (1995). Unraveling in guessing games: An experimental study. *The American Economic Review, 85*(5), 1313–1326.

Palomäki, J., Laakasuo, M., Cowley, B. U., & Lappi, O. (2020). Poker as a domain of expertise. *Journal of Expertise, 3*(2), 66–87.

Palomäki, J., Laakasuo, M., & Salmela, M. (2013). "This is just so unfair!": A qualitative analysis of loss-induced emotions and tilting in on-line poker. *International Gambling Studies, 13*(2), 255–270. https://doi.org/10.1080/14459795.2013.780631

Palomäki, J., Laakasuo, M., & Salmela, M. (2014). Losing more by losing it: Poker experience, sensitivity to losses and tilting severity. *Journal of Gambling Studies, 30*(1), 187–200. https://doi.org/10.1007/s10899-012-9339-4

Palomäki, J., Yan, J., & Laakasuo, M. (2016). Machiavelli as a poker mate — A naturalistic behavioural study on strategic deception. *Personality and Individual Differences, 98*, 266–271. https://doi.org/10.1016/j.paid.2016.03.089

Palomäki, J., Yan, J., Modic, D., & Laakasuo, M. (2016). "To bluff like a man or fold like a girl?" — Gender biased deceptive behavior in online poker. *PLOS ONE, 11*(7), e0157838. https://doi.org/10.1371/journal.pone.0157838

Pignatiello, G. A., Martin, R. J., & Hickman, R. L., Jr. (2020). Decision fatigue: A conceptual analysis. *Journal of Health Psychology, 25*(1), 123–135. https://doi.org/10.1177/1359105318763510

Potter van Loon, R. J. D., van den Assem, M. J., & van Dolder, D. (2015). Beyond chance? The persistence of performance in online poker. *PLOS ONE, 10*(3), e0115479. https://doi.org/10.1371/journal.pone.0115479

Schlicht, E. J., Shimojo, S., Camerer, C. F., Battaglia, P., & Nakayama, K. (2010). Human wagering behavior depends on opponents' faces. *PLOS ONE, 5*(7), e11663. https://doi.org/10.1371/journal.pone.0011663

Shoily, F. (2025). *The economics of uncertainty: Prospect theory in practice at the poker table* [Senior thesis, Princeton University]. https://theses-dissertations.princeton.edu/handle/88435/dsp01td96k5958

Siler, K. (2010). Social and psychological challenges of poker. *Journal of Gambling Studies, 26*(3), 401–420. https://doi.org/10.1007/s10899-009-9168-2

Slepian, M. L., Young, S. G., Rutchick, A. M., & Ambady, N. (2013). Quality of professional players' poker hands is perceived accurately from arm motions. *Psychological Science, 24*(11), 2335–2338. https://doi.org/10.1177/0956797613487384

Smith, G., Levere, M., & Kurtzman, R. (2009). Poker player behavior after big wins and big losses. *Management Science, 55*(9), 1547–1555. https://doi.org/10.1287/mnsc.1090.1044

Sonawane, P., & Chheda, A. (2024). *A survey on game theory optimal poker* (arXiv:2401.06168). arXiv. https://arxiv.org/abs/2401.06168

Stahl, D. O., & Wilson, P. W. (1995). On players' models of other players: Theory and experimental evidence. *Games and Economic Behavior, 10*(1), 218–254. https://doi.org/10.1006/game.1995.1031

Studer, B., Limbrick-Oldfield, E. H., & Clark, L. (2015). "Put your money where your mouth is!": Effects of streaks on confidence and betting in a binary choice task. *Journal of Behavioral Decision Making, 28*(3), 239–249. https://doi.org/10.1002/bdm.1844

Sundali, J., & Croson, R. (2006). Biases in casino betting: The hot hand and the gambler's fallacy. *Judgment and Decision Making, 1*(1), 1–12.

Tait, V., & Miller, H. L., Jr. (2019). Loss aversion as a potential factor in the sunk-cost fallacy. *International Journal of Psychological Research, 12*(2), 8–16. https://doi.org/10.21500/20112084.3951 [Cited only for the *question*; the study's hypothesis was *not supported* — see §3.3.]

Tammelin, O. (2014). *Solving large imperfect information games using CFR+* (arXiv:1407.5042). arXiv. https://arxiv.org/abs/1407.5042

Tendler, J., & Carter, B. (2011). *The mental game of poker: Proven strategies for improving tilt control, confidence, motivation, coping with variance, and more.* Jared Tendler LLC. [Self-published practitioner source.]

Thaler, R. H., & Johnson, E. J. (1990). Gambling with the house money and trying to break even: The effects of prior outcomes on risky choice. *Management Science, 36*(6), 643–660. https://doi.org/10.1287/mnsc.36.6.643

Tversky, A., & Kahneman, D. (1974). Judgment under uncertainty: Heuristics and biases. *Science, 185*(4157), 1124–1131. https://doi.org/10.1126/science.185.4157.1124

Tversky, A., & Kahneman, D. (1986). Rational choice and the framing of decisions. *The Journal of Business, 59*(4, Pt. 2), S251–S278. https://doi.org/10.1086/296365

von Neumann, J. (1928). Zur Theorie der Gesellschaftsspiele. *Mathematische Annalen, 100*(1), 295–320. https://doi.org/10.1007/BF01448847

von Neumann, J., & Morgenstern, O. (1944). *Theory of games and economic behavior.* Princeton University Press.

Vanja. (2025). *The 3 biggest leaks killing your winrate.* GTO Wizard Blog. https://blog.gtowizard.com/the_3_biggest_leaks_killing_your_winrate/

Wang, Z., Wang, Y., Zhou, X., & Yu, R. (2020). Interpersonal brain synchronization under bluffing in strategic games. *Social Cognitive and Affective Neuroscience, 15*(12), 1315–1324. https://doi.org/10.1093/scan/nsaa154

Zhang, K., & Clark, L. (2020). Loss-chasing in gambling behaviour: Neurocognitive and behavioural economic perspectives. *Current Opinion in Behavioral Sciences, 31*, 1–7. https://doi.org/10.1016/j.cobeha.2019.10.006

Zinkevich, M., Johanson, M., Bowling, M., & Piccione, C. (2007). Regret minimization in games with incomplete information. In *Advances in Neural Information Processing Systems 20 (NIPS 2007)* (pp. 1729–1736). Curran Associates.

*Practitioner / grey-literature sources (cited as professional consensus, not peer-reviewed evidence): GTO Wizard. (2022). MDF & Alpha; GTO Wizard. (2023). The mechanics of c-bet sizing; Punish the unstudied: Capped ranges & bluffing imbalances. DriveHUD (2022); SmartPokerStudy (2024); PokerAlpha (2026) — HUD-stat thresholds and player typology. BlackRain79 (2014); BetMGM (2023); HighStakesDB (2025); Reading Poker Tells (Z. Elwood, 2015/2021) — timing/sizing tells and tell criticism.*

---

## Engine Heuristics Table — directly encodable

| Trigger | Read | Exploit (GTO deviation) | Encode hint | Evidence strength |
|---|---|---|---|---|
| Villain stuck below session reference point (negative sessionPnL), deep in session / recent rebuy | Break-even effect: loss domain → risk-seeking, looser ranges, chasing, barrels to recoup | Value-bet thinner + bigger; cut bluffs (won't fold); widen calls vs their now-weak betting range | `lossDomainScore = clamp((ref−stack)/ref)` scaled by sessionDuration + rebuy flag; shift villain range looser/bluffier; bias hero EV to thin value, suppress bluffs | **High** (Eil & Lien 2014; Smith et al. 2009; Shoily 2025) |
| Villain significantly UP / just booked a big win (experienced reg) | Stay-ahead asymmetry: winners turn risk-averse, play scared, protect profit | Bluff more / apply pressure (they over-fold); value-bet thinner cautiously | `gainDomainScore` branch raises villain fold-to-bet prior; +hero bluff freq; flag 'protect-mode'. **Caveat: recreational winners may instead tilt up (house-money)** | **High** (experienced); Med (recreational) (Eil & Lien 2014; Thaler & Johnson 1990) |
| Villain bad beat / multi-hand losing streak (was favorite & lost; N consecutive lost pots) | Moral-anger tilt: injustice appraisal → EV-negative retaliation, degraded EV math | Trap & bluff-catch wider; cut fancy bluffs (anger → hero-calls); let them barrel into nutted range | `tiltScore` from showdown-favorite-losses + needle/chat events; raise villain aggression/bluff prior, lower fold-to-aggression; decay over hands | **High** (Palomäki et al. 2013, 2014; Laakasuo et al. 2015) |
| Angry villain (post-beat, needled, shown a bluff) vs Fearful villain (just stacked, short near pay jump, folding repeatedly) | ATF: anger → risk-SEEKING (optimism+control); fear → risk-AVERSE (uncertainty+low control) — OPPOSITE signs | Anger → call/value wider, don't bluff into. Fear → bluff more, thin-value less | Keep TWO signed axes, never one scalar: `angerScore` raises villain bluff/stack-off; `fearScore` raises villain fold-to-bet → +hero bluff/semibluff | **High** (Lerner & Keltner 2001; Lerner et al. 2015) |
| Salient near-miss last hand (busted big draw on river, lost a flip, drawing-live cooler) | Near-miss accelerant: less pleasant than a loss yet boosts urge + reward circuitry → next-hand spew | Treat next 1–2 hands as high-aggression window; call down lighter, expect tilt-stab | `lastHandNearMiss` flag → short-lived (1–2 hand) `nearMissBoost` on tiltScore, widen villain bluff estimate for that window only | **High** (Habib & Dixon 2010; Chase & Clark 2010) |
| Escalating tempo + sizing + VPIP above villain baseline while stuck | Loss-chasing via negative urgency + unrealized-loss reference point | Let them barrel into strong hands; trap/induce, size up for value; pot-control hero marginals | Rolling baselines (latency, bet bb, VPIP); `chaseFlag = latency↓ + sizing↑ + VPIP↑ & sessionPnL<0` → +hero value size, −hero bluff | **High** (Zhang & Clark 2020; Studer et al. 2015; Imas 2016) |
| Passive/recreational villain makes pot-size bet or overbet on river (low observed bluff freq) | Under-bluffed polarized range: bluffs below α; indifference broken toward folding | OVER-FOLD bluff-catchers below MDF; continue only with hands that beat value | `riverBluffDeficit = max(0, α − observedBluffFreq)`; when bet ≥ ~0.9 pot & passiveScore high, raise hero bluff-catch threshold; gate by sample ≥ N | **High** (indifference math; Liakos 2024; GTO Wizard 2022) |
| Villain in WIDE/uncapped/unfiltered node (BTNvBB SRP turn probe; flop-range-bet→bricked-turn) | Population over-bluffs (too equity-driven, fast-plays draws, slow-plays value) | Call down LIGHTER than MDF; convert indifferent bluff-catchers to pure calls; call brick rivers | Tag `node.wide && unfiltered`; lower hero fold threshold below MDF by confidence-scaled δ; calibrate with **27%→31% bluff-freq flip** | **High** (Liakos 2024; Vanja 2025) |
| Non-intuitive aggressive line (river/dry-board check-raise, three large bets) from NON-elite | Non-experts almost never construct these as bluffs → near-pure value | Over-fold / fold marginal value & bluff-catchers to these lines | `lineIntuitiveness` score; if villain≠elite & low → collapse hero continue range to strong value. **GATE OFF vs elite/balanced** | **High** (Vanja 2025; population under-bluffing) |
| Calling station (VPIP≥35, AF<1.5, high WTSD, low Won$SD) | Under-folds, over-calls, looks you up light | Value-bet thinner + bigger; widen value 3-bets; bluffs → ~0; give credit to rare aggression | `profile=station`; reduce hero bluff combos to ~0, raise value-bet sizing tier, extend thin-value to 2nd/3rd pair | **High** (DriveHUD/SmartPokerStudy thresholds + indifference logic) |
| Nit/rock (VPIP<15, PFR<12, sample ≥ ~50) | Value-skewed everywhere; under-bluffs, over-folds | Widen steals/small pressure vs blinds; over-fold to ALL significant aggression; skip 4-bet bluffs | `profile=nit`; vs their aggression push hero continue below MDF (over-fold); vs their fold-prone nodes widen hero bluff/steal | **High** (PokerAlpha thresholds; Vanja 2025) |
| Strong studied reg (balanced showdowns, range-based sizing) — any size | Synergistic/encrypted processing: size decorrelated from strength | Do NOT read size literally; revert toward GTO defense frequencies | `skillEstimate`; scale weight of ALL sizing/timing tells by `(1 − skillEstimate)` → ~0 for elite | **High** (Frey et al. 2018) |
| Capped line (flats then checks a street they'd bet strong; can hold no nutted combos) | Capped/condensed range can't raise for value → structurally vulnerable | Attack with overbets + multi-street barrels regardless of hero holding; +bluff freq | `rangeCapFlag` from action sequence; unlock overbet bucket, raise hero bluff combos above GTO mix, size by cap severity | **High** (polarization theory; Sonawane & Chheda 2024) |
| Level-0/1 villain (calls good hands, folds bad, no balancing, ignores hero representation) | Shallow depth (~τ 1.5): doesn't model hero's range; over-folds to aggression, over-respects value | Play one level higher: +bluff freq, polarize sizing, thin-value unnecessary; drop balance (wasted) | `levelEstimate` from fold-to-aggression + light-calldown; default new villains ~1.5; level≤1 → switch mixed GTO to max-exploit | **High** (Camerer et al. 2004) — prior, not measured poker constant |
| Multiway pot (3+ active players) | Nash guarantee collapses; bluff needs fold equity from ALL → required success compounds; ranges tighter | Sharply reduce bluff freq; tighten value; weight per-opponent reads more | `bluffWeight` decreasing in liveOpponents; switch engine to exploit-weighted mode when activePlayers>2 | **High** (Brown & Sandholm 2019; Chen et al. 2009) |
| Fatigue/late-hour/long-session/alcohol flagged (hero or villain) | Fatigue tilt: more hands, worse net losses, weaker regulation | Villain: value-bet wider. HERO: coaching stop-now nudge (PRIMARY use) | Track sessionDuration, wallClockHour, manual alcohol toggle → surface hero break nudge + nudge villain range looser | **High** (villain side); coaching-layer output (Hamel et al. 2021) |
| Hero suffers bad beat / cooler / downswing | Hero at risk of moral-anger tilt; suppression impairs working memory; felt calm unreliable | Coaching: deliver REAPPRAISAL ('EV correct, that's variance'), NOT suppression ('calm down'); offer stop-loss | On hero adverse-variance event surface reappraisal microcopy; `accumulatedTilt` counter escalates nudge; gated by no-gambling guardrails | **High** (Gross 2002; Tendler & Carter 2011 scaffold) |
| Heads-up / on-stream / just-shown-a-bluff / needled ('being watched') | Social scrutiny multiplies anger's damage to decision accuracy | Widen calls/value vs recently-exposed villain; HERO: disengage from chat | `scrutinyFlag` combined MULTIPLICATIVELY with angerScore (interaction > either alone) | **High** (Laakasuo et al. 2015; Browne 1989) |
| Overconfident over-trader (aggression/VPIP ≫ showdown win-rate; shows down weak) | Dunning-Kruger + over-trading analog: activity uncorrelated with edge | Call down lighter, value-bet thinner+bigger, stop bluffing (they don't fold) | `overconfidenceIndex = aggression/VPIP ÷ showdownWinRate`; high → −hero bluff EV, raise bluff-catch threshold above MDF | **Med-High** (Kruger & Dunning 1999; Barber & Odean 2000 analog) |
| Hero choosing stake/bankroll risk per session | Bankroll = Kelly problem; full Kelly drawdowns intolerable; double-Kelly → zero growth | Recommend FRACTIONAL Kelly (k≈0.25–0.5); hard-warn against over-staking | Bankroll module: input win-rate + variance → f*; recommend k·f*; flag stakes implying >1× Kelly; pure-math layer | **High** (MacLean, Thorp & Ziemba 2010) |
| Master clamp: low sample OR villain flagged elite | Point-estimate exploitation = high self-exploitability; regs counter-exploit | Revert toward GTO; apply only small robust (RNR/DBR-style) deviations | `deviation = GTO + clamp(p·(BR−GTO))`, p∝sampleSize (RNR/DBR p~0.9–0.99); p→0 when elite or n<minSample — WRAPS ALL ABOVE | **High** (Ganzfried & Sun 2018; Johanson et al. 2011) |
| Anchored fixed sizer (board-independent size, e.g. always ½ pot) | Anchoring-and-adjustment: habitual fraction, under-adjusts to board | Treat fixed size as uninformative; treat DEVIATIONS from it as reliable polarity tells | Per-villain sizing histogram by street/texture; flag low-variance sizers; weight size deviations heavily | **Low-Med prior** (Tversky & Kahneman 1974; thin poker-specific) |
| Recent salient result (just hero-called you; just got stacked bluffing) | Recency / results-oriented over-reaction to tiny sample | If snap-called → +value, −bluff short-term; if stacked them bluffing → +hero bluff next few hands | Short-window (last 1–5 hands) reactivity model over long-run baseline; fast-decay delta | **Low-Med prior** (GTO Wizard 2023; recency theory) |

---

## Top Actions for the MCEdge Engine

1. MASTER CLAMP FIRST (wraps everything): deviation = GTO + clamp(p·(bestResponse − GTO)), with p scaling on per-villain sample size and forced to 0 (pure GTO) when the villain is flagged elite or n < minSample. Without this clamp, every other heuristic below makes the engine self-exploitable. Ground: Ganzfried & Sun 2018; Johanson et al. 2011.
2. SESSION-P&L BREAK-EVEN MODEL: maintain per-villain sessionPnL vs a session-start reference; when stuck (loss domain), shift their range looser/bluffier and bias hero toward thin-value + bigger sizing while suppressing bluffs. Highest-confidence, highest-frequency read in the corpus (Eil & Lien 2014; Smith et al. 2009).
3. OVER-FOLD BLUFF-CATCHERS vs large bets/overbets from passive/recreational under-bluffers (riverBluffDeficit = max(0, α − observedBluffFreq)); put the MDF shield DOWN against value-heavy populations. The dominant low/mid-stakes EV source (GTO Wizard 2022; Liakos 2024).
4. TWO-AXIS TILT, NOT ONE SCALAR: implement separate signed angerScore (→ villain risk-seeking → hero calls/value, no bluffing into) and fearScore (→ villain risk-averse → hero bluffs more, thin-values less). Collapsing them inverts the exploit half the time (Lerner & Keltner 2001).
5. BAD-BEAT / NEAR-MISS TILT WINDOW: detect showdown-favorite losses, losing streaks, and busted-big-draw near-misses; raise a decaying tiltScore that for the next 1–2 hands widens the villain's bluff/aggression estimate and switches hero to trap/bluff-catch mode (Palomäki et al. 2014; Habib & Dixon 2010).
6. SKILL-WEIGHTED TELLS: scale the information weight of ALL sizing and timing tells by (1 − skillEstimate) so the engine reads weak players' sizes literally and treats strong regs' range-based sizes as ~uninformative (Frey et al. 2018).
7. CAPPED-RANGE ATTACK + NON-INTUITIVE-AGGRESSION=VALUE: flag lines that exclude the top of range (overbet/barrel them) and lines that are near-pure value when taken by non-elite players (over-fold), with the latter GATED OFF against elite/balanced opponents (Vanja 2025).
8. LEVELLING ESTIMATE seeded at ~1.5: branch max-exploit (polarize, +bluff, drop balance) vs level-0/1 villains and revert to balanced GTO vs level-2 thinkers; treat as a default prior, not a measured poker constant (Camerer et al. 2004).

---

## Book Outline — "The Secret Edge" (C.M. Engue)

## *C.M. Engue*: The Mind and Mathematics of the Poker Table — Chapter Outline

**Front matter.** Preface (the GTO-vs-human thesis in one page); note on citation integrity and the distinction between peer-reviewed evidence, solver-grounded professional consensus, and flagged practitioner sources.

### Part I — The Floor: Game-Theoretic Foundations
- **Ch. 1 — Why Poker Has a Solution.** Von Neumann's minimax theorem; zero-sum imperfect-information games; the game value and the dealer's edge (von Neumann 1928; von Neumann & Morgenstern 1944).
- **Ch. 2 — The Indifference Principle.** Kuhn poker; why bluffing and slow-playing are mathematically *forced*; the value-to-bluff ratio (Kuhn 1950).
- **Ch. 3 — MDF, Alpha, and the Shield That Is Not a Target.** Reciprocal indifference frequencies; the critical caveat that against under-bluffing populations you *over-fold* below MDF (GTO Wizard 2022; Liakos 2024).
- **Ch. 4 — How Machines Solved Poker.** CFR/CFR+, Cepheus, DeepStack, Libratus, Pluribus; what "essentially solved" means; the multiplayer Nash breakdown (Bowling et al. 2015; Brown & Sandholm 2018, 2019; Chen et al. 2009).

### Part II — The Gap: Why Humans Deviate
- **Ch. 5 — Bounded Reasoning.** Level-*k* and cognitive hierarchy; τ ≈ 1.5; out-levelling the table (Nagel 1995; Camerer et al. 2004).
- **Ch. 6 — Reference Points and the Break-Even Effect.** Prospect theory; loss → loosen/chase, win → lock up; the experience-moderated house-money caveat (Kahneman & Tversky 1979; Eil & Lien 2014; Smith et al. 2009; Shoily 2025).
- **Ch. 7 — Misreading Randomness.** Gambler's fallacy and the hot hand; the Miller–Sanjurjo correction and why poker momentum is *partly real* (Croson & Sundali 2005; Miller & Sanjurjo 2018).
- **Ch. 8 — Anchors, Sunk Costs, and Confirmation.** Lower-confidence biases; honest treatment of the Tait & Miller null on loss-aversion-as-sunk-cost-driver (Tversky & Kahneman 1974; Zhang & Clark 2020).

### Part III — The Storm: Tilt and the Mental Game
- **Ch. 9 — Tilt as Moral Anger.** The injustice appraisal; the two-factor (emotional vs cognitive) structure (Palomäki et al. 2013; Moreau et al. 2017, 2020).
- **Ch. 10 — Anger Is Not Fear.** The Appraisal-Tendency Framework; opposite-signed risk shifts; why one tilt scalar is wrong (Lerner & Keltner 2001).
- **Ch. 11 — The Accelerants.** Near-misses, loss-chasing/negative urgency, fatigue, alcohol, social scrutiny (Habib & Dixon 2010; Studer et al. 2015; Hamel et al. 2021; Laakasuo et al. 2015).
- **Ch. 12 — Mastering Your Own Mind.** Reappraisal over suppression; the expertise paradox (regs tilt *more*); bankroll as Kelly survival (Gross 2002; Palomäki et al. 2014; MacLean et al. 2010).

### Part IV — The Edge: Reading and Exploiting
- **Ch. 13 — Sizing as Signal.** Polarized vs merged vs capped ranges; encryption and why you read weak players, not strong regs (Frey et al. 2018; GTO Wizard 2023).
- **Ch. 14 — Tells, Real and Mythical.** What the deception literature actually supports; debunking facial-tell lore; the avatar-bias finding (Slepian et al. 2013; Schlicht et al. 2010; Palomäki, Yan, Modic, & Laakasuo 2016; Wang et al. 2020).
- **Ch. 15 — Profiling the Population.** HUD archetypes; nodelock leaks; the 27%→31% sensitivity; non-intuitive aggression = value (DriveHUD 2022; Liakos 2024; Vanja 2025).
- **Ch. 16 — Overconfidence and Skill.** Dunning-Kruger at the table; skill persistence; bounded deliberate practice (Kruger & Dunning 1999; Potter van Loon et al. 2015; Macnamara et al. 2014).

### Part V — The Synthesis
- **Ch. 17 — The Deviation Engine.** Detect → estimate magnitude → clamp by confidence; the exploitation–exploitability trade-off as the unifying law (Ganzfried & Sun 2018; Johanson et al. 2011).
- **Ch. 18 — Open Problems.** Where the evidence is thin; what poker psychology still needs to measure.
- **Appendix A** — Heuristic reference table (engine-facing). **Appendix B** — Source-quality ledger (peer-reviewed vs solver-consensus vs practitioner). **Appendix C** — Glossary.

---

## Open Questions (evidence thin — deeper/primary-source research needed)

- No rigorous peer-reviewed study isolates bet-SIZE→range inference or online TIMING tells specifically. The granular sizing/timing mappings rest on solver-grounded professional consensus (GTO Wizard, BlackRain79, HighStakesDB); the peer-reviewed papers supply only mechanism (encryption, implicit bias, motor/face leakage). A dedicated empirical study of human sizing-to-strength correlation by skill tier is the single biggest evidence gap.
- Decision-fatigue magnitude is genuinely uncertain. The hungry-judge effect (Danziger et al. 2011) is contested by case-ordering artifacts (Glöckner 2016) and the broader ego-depletion literature replicates weakly. The late-session villain exploit and hero break-nudge should remain a WEAK prior / wellness nudge until poker-specific session-quality-over-time data exist.
- The hot-hand question in poker specifically is unresolved post-Miller-Sanjurjo (2018). Roulette data (Croson & Sundali) confirm the gambler's fallacy under true independence, but poker has genuine momentum channels (confidence, tilt, dynamic image). How much of a 'heater' is real edge vs misperception in a skill game has not been measured — the engine currently treats it as 'over-attributed,' which is defensible but unquantified.
- Live physical-tell validity remains thin and small-sample. Slepian et al. (2013, arm motion) and Schlicht et al. (2010, N=14 facial trust) are the only credible findings and both have serious methodological limits; effect sizes (~3%) and live-only applicability mean these should never be inferred, only entered manually behind an explicit low-confidence flag. No replication at scale exists.
- Several gender/personality deception sub-claims are underpowered. The 'males bluff 13% more than females' finding rests on only 36 women (Palomäki, Yan, Modic, & Laakasuo 2016); only the avatar-bias half ($21.63/bet) is safe to encode. Machiavellian sizing effects (Palomäki, Yan, & Laakasuo 2016) need replication before being weighted heavily.
- Tilt-detection from behavioral proxies alone is unvalidated end-to-end. The constructs (negative urgency, two-factor tilt, near-miss spew) are well-evidenced individually, but no study confirms that sizing/tempo/VPIP deltas reliably RECOVER an opponent's tilt state in live online play. The inference chain from observable behavior to exploitable state is assumed, not measured.
- τ ≈ 1.5 reasoning depth is an average across one-shot normal-form lab games (Camerer et al. 2004), not measured in repeated multi-street poker. Whether poker villains' effective levelling depth matches, exceeds, or falls below this — and how it shifts across streets and stakes — is an open empirical question affecting how aggressively the engine should out-level.
- Minor bibliographic items still warranting a final librarian/Zotero pass before book print: exact page ranges for Palomäki et al. (2020, Journal of Expertise) and Browne (1989); confirmation that Kelly (1956) and Ericsson et al. (1993) pagination match the originals (cited but not retrieved firsthand). None are load-bearing for the engine.

---

## Source-Check Ledger (citation integrity)

Per sub-domain verdict from the adversarial citation pass. **Resolve every suspect citation before the book ships.**

### biases-decisions — Cognitive biases & decision-making under uncertainty in poker (prospect theory, loss aversion, framing, sunk cost/escalation, gambler's fallacy & hot hand, anchoring, recency, confirmation bias, certainty effect, risk-as-feelings)
- **Verdict:** mostly-solid-with-fixes (16 citations checked)
- **Suspect citations:**
  - ⚠️ Tait, V. (2019) — sunk-cost/loss-aversion: NOT fabricated (paper is real: Tait, V., & Miller, H. L., Jr. (2019). Loss aversion as a potential factor in the sunk-cost fallacy. International Journal of Psychological Research, 12(2), 8-16. https://doi.org/10.21500/20112084.3951), BUT MISATTRIBUTED FINDING. The engine cites it as evidence that 'loss aversion is a documented driver of the sunk-cost fallacy.' The paper found the OPPOSITE: its hypothesis 2 (greater loss aversion predicts greater sunk-cost fallacy) was NOT supported — loss aversion showed a weak NEGATIVE, non-significant relation to the SCF. Co-author is Harold L. Miller Jr. (the '[co-author(s)]' placeholder resolves). FIX: cite for the QUESTION of whether loss aversion drives SCF, and report the null/negative result honestly; do not cite as confirming the mechanism. Better primary support for pot/session sunk-cost in gambling is Zhang & Clark (2020), which is solid.
  - ⚠️ Tversky, A., & Kahneman, A. (1974) — the in-text author is correct but the formatted APA reference contains a TYPO: Kahneman's initial is given as 'A.' It must be 'D.' (Daniel Kahneman). Correct: Tversky, A., & Kahneman, D. (1974). Judgment under uncertainty: Heuristics and biases. Science, 185(4157), 1124-1131. https://doi.org/10.1126/science.185.4157.1124. Paper itself fully confirmed; only the initial is wrong — a publication-blocking copyedit error.
  - ⚠️ Wei, X., Palomäki, J., Yan, J., & Robinson, P. (tilt synthesis) — confirmed REAL and the [needs-verification] venue/year now resolved: it is a 2016 ACM conference paper, 'The Science and Detection of Tilting,' Proceedings of the 2016 ACM International Conference on Multimedia Retrieval (ICMR '16), https://doi.org/10.1145/2911996.2912019. NOT a journal article — must be cited as conference proceedings, not as a generic 'tilt synthesis.' Authors confirmed: Xingjie Wei, Jussi Palomäki, Jeff Yan, Peter Robinson. Note: this is a facial-emotion tilt-DETECTION computing paper; it does not by itself establish 'moral anger → ineffective retaliation' (that claim is better sourced to Palomäki et al. 2013/2014), so do not over-lean on it for the behavioral retaliation claim.
  - ⚠️ Palomäki, J., Laakasuo, M., Cowley, B. U., & Lappi, O. (2020) — REAL and retrievable (Journal of Expertise, 3(2), March 2020, open access at journalofexpertise.org); only the exact page range remains [needs-verification]. Low risk — it is a secondary/review source, not load-bearing.
- **Pop-myth flags:**
  - 🚩 HOT HAND AS PURE 'FALLACY' IS OVERSTATED / CONTESTED. The overview and the gambler's-fallacy/hot-hand concepts label the hot hand flatly as a fallacy (illusion of control), the classic Gilovich-Tversky-Vallone (1985) framing. Post-2018, Miller & Sanjurjo showed the original 'hot-hand fallacy' finding was contaminated by a finite-sequence selection bias; correcting it reveals a REAL hot-hand effect in basketball data. Nuance the book/engine must preserve: in ROULETTE (Croson & Sundali's setting) outcomes are truly independent, so 'hot-hand betting' there is genuinely irrational and that data stands; but the blanket statement 'the hot hand is a fallacy' is no longer safe, and in POKER (a skill game with genuine momentum via confidence, tilt, and dynamic table image) a winning streak can be partly real. Reframe the heuristic as 'opponents OVER-attribute momentum,' not 'momentum is illusory.'
  - 🚩 DUBIOUS PHYSICAL/FACIAL 'TELLS' LORE — correctly AVOIDED by the engine, flagged so it stays avoided. Popular claims like '78% of players show detectable tells' and '62% show consistent microexpressions when bluffing' circulate on poker-marketing sites with no peer-reviewed source and should never enter the book. The only credible empirical tell finding is narrow (Slepian et al., Tufts 2013: arm/hand motion is read more reliably than the face). The engine's reliance on BETTING-PATTERN and SESSION-P&L reads rather than body-language tells is the methodologically correct choice; do not add facial-tell heuristics.
  - 🚩 HOUSE-MONEY EFFECT IS NOT UNIVERSALLY ABSENT — keep the asymmetry claim CALIBRATED. The engine's strong claim that the house-money effect is 'weak-to-absent' is well-supported FOR EXPERIENCED poker players (Eil & Lien 2014; Smith et al. 2009 show post-loss loosening as the dominant effect), but Thaler & Johnson (1990) DID find a house-money effect in general lab populations, and recreational/novice gamblers can show it. State it as experience-moderated ('experienced winners stay-ahead; recreational winners may tilt up'), not as an absolute.
  - 🚩 'EXPERIENCE PROTECTS AGAINST TILT' would be a myth — but the engine did NOT claim it; verified it stated the counter-intuitive correct finding. Palomäki et al. (2014) found more experienced players reported MORE severe tilting (while believing they tilt less). Confirmed accurate; flagged only to lock it against being 'corrected' to the intuitive-but-wrong direction during book editing.

### tilt-mental-game (Tilt, emotion & the mental game: emotional regulation, physiological arousal/affect on risk-taking, variance tolerance, ego/identity threat, the tilt + Tendler-style frameworks, fatigue & decision quality, near-miss effects)
- **Verdict:** solid (20 citations checked)
- Suspect citations: none
- **Pop-myth flags:**
  - 🚩 No pop-myth claims found in the engine-facing content. The bundle correctly AVOIDS physical-tells lore (no 'players who look at their chips are weak' type claims) and AVOIDS treating the hot-hand as real — it cites Studer et al. (2015) explicitly as evidence of an ERRONEOUS belief about randomness (hot-hand fallacy) driving loss-chasing, which is the correct, evidence-based framing.
  - 🚩 MINOR OVERSTATEMENT TO SOFTEN (not a myth, a precision issue): the 'villain emotional state is a readable, exploitable variable' framing risks importing tells-lore through the back door in PRACTICE. The lab evidence (Lerner & Keltner 2001; Laakasuo 2015) shows emotion shifts the risk function, but a hero cannot reliably READ an opponent's covert emotion online; the engine should infer tilt from BEHAVIORAL proxies (sizing/tempo/VPIP deltas, session length, prior bad-beat events) — which the encodeHints already do — not from putative emotional 'reads'. Keep the heuristics, but label the input as behavioral-state inference, not emotion-reading.
  - 🚩 MINOR: 'experts are better at masking the tells' (expertise heuristic) is only partially supported — Challet-Bouju (2020) found the physiological-masking advantage VANISHED for poker-specific emotional inductions, so even the masking edge is weak in-game. The bundle states this caveat correctly; just ensure the engine copy does not overclaim that regs reliably hide tilt.
  - 🚩 MINOR UNVERIFIED NUMERIC (not a myth): the Laakasuo et al. (2015) '459-participant' figure was not surfaced in retrieval; the core interaction (anger reduces accuracy only when 'being watched' by a pair of moving eyes) IS confirmed verbatim from PubMed, so the heuristic stands; verify the exact N before print.

### bet-sizing-tells (betting & sizing psychology + timing/physical/online tells → bet-size→range mappings)
- **Verdict:** mostly-solid-with-fixes (14 citations checked)
- **Suspect citations:**
  - ⚠️ NONE are fabricated — all 14 references were independently confirmed to exist and be correctly attributed. Corrections to metadata only: (1) Slepian, Young, Rutchick, & Ambady (2013) — the [needs-verification] flag should be REMOVED. Volume/issue/pages 24(11), 2335–2338 confirmed from the publisher-formatted Columbia PDF header ('Psychological Science 24(11) 2335–2338 © The Author(s) 2013') and DOI 10.1177/0956797613487384 confirmed via PubMed 24030212. Citation is fully correct. Minor: Slepian was at Tufts/Stanford-affiliated, not 'Stanford' per se — Ambady was the Stanford author; do not call it 'the Stanford study' in formal text.
  - ⚠️ BetMGM (2024) — YEAR IS WRONG. Actual publication date is July 15, 2023, not 2024. Change to BetMGM (2023). The [needs-verification] flag was correct to raise it; resolve it to 2023.
  - ⚠️ HighStakesDB (n.d.) — date IS retrievable: published October 29, 2025. Replace (n.d.) with (2025). URL and content (small bet on dry flop = capped range; overbet river = polarization) confirmed accurate.
  - ⚠️ Reading Poker Tells criticism page (2021) — correct (Zachary Elwood, Feb 15 2021, repost of a 2015 Bluff-magazine piece). Spell the author 'Zachary Elwood', not 'Z. Elwood', and note it is a re-post of a 2015 article so a (2015/2021) dual date is more honest.
  - ⚠️ GTO Wizard (2023b/2023c) — both URLs are LIVE and titles correct ('Punish the Unstudied: Capped Ranges & Bluffing Imbalances' and 'The Five Imbalances of Exploitative Poker'). Exact publication DATES still not surfaced on the article pages, so the year '2023' remains an estimate — keep a soft [date-approximate] note but the sources are real, not invented. A sibling article 'Punish the Unstudied: Preflop Mistakes & Sizing Tells' also exists and is directly on-topic for this sub-domain (worth adding).
- **Pop-myth flags:**
  - 🚩 'Smooth/confident betting-arm motion reveals a strong hand' (Slepian 2013) is presented too confidently as a usable read. The FINDINGS already hedge it, but the criticisms are stronger than stated: clips were ONLY large push-bets; 'smoothness' was participant-PERCEIVED, never objectively measured (so the 'tell' is unfalsifiable as worded); ~80% of the 'professionals' were WSOP amateurs, not pros; and hand 'quality' used real-time equity vs the actual opponent hand, not what the bettor believed they had (a QQ that is 2% to win got labeled 'weak'). Treat as suggestive, live-only, low-confidence — NOT an encodable mechanical tell. The engine heuristic that maps arm-motion to a value/bluff tilt should ship behind a manual, explicitly-flagged-unreliable input, never as an inferred signal.
  - 🚩 Schlicht et al. (2010) 'trustworthy faces induce more folds' is real but rests on N=14 NOVICES (12 played <10 hrs/year) in a no-feedback one-shot task. The authors themselves state they CANNOT distinguish rational Bayesian inference from irrational loss-aversion, and that trustworthiness co-varies with other facial traits — so the causal 'a trustworthy poker face is the best poker face' framing is overstated relative to the evidence. Keep the ~3% error magnitude and ROI 6.8% context (both confirmed verbatim) but present as a small-sample lab curiosity, not an established edge.
  - 🚩 Palomäki et al. (2016) gender finding: the headline '$22/bet' is REAL and confirmed ($21.63). BUT the 'males bluff 13% more than females' sub-claim rests on only 36 women in an N=502 sample that was 435 male — badly underpowered for a sex comparison. Report the avatar-bias result (the load-bearing one for the engine) with confidence; flag the male-vs-female-bluffer claim as low-power and not safe to encode.
  - 🚩 Generic 'timing tells' (fast=weak, tank=strong) are practitioner consensus, NOT peer-reviewed — the FINDINGS correctly say so. Pop-myth risk to call out explicitly in the book: this is the LEAST reliable channel, is reversible against observant opponents ('Hollywood' fake tanks, deliberate snaps), and is heavily polluted online by multitabling/auto-buttons/latency. BlackRain79's own phrasing is 'long tank = strong hand OR a bluff' (i.e. polarized), which is more accurate than the FINDINGS' flatter 'tank-then-bet skews strong'; tighten the heuristic to 'tank-then-aggression skews POLARIZED, lean value on static boards.'
  - 🚩 No rigorous peer-reviewed study isolates bet-SIZE→range inference or online TIMING tells specifically — confirmed gap. The book must NOT cite the GTO-solver/practitioner sources as empirical proof; they are professional consensus grounded in solver output. The peer-reviewed papers supply MECHANISM (encryption, implicit bias, motor/face leakage, skill persistence), not direct evidence for the granular sizing mappings.

### population-exploits — population tendencies, exploitative player-type profiling, HUD-stat thresholds, and GTO-vs-exploit deviation theory (MDF/alpha) for NLHE
- **Verdict:** solid (17 citations checked)
- **Suspect citations:**
  - ⚠️ NONE are fabricated or misattributed — all 17 references were confirmed to exist with correct authors/years/venues. Minor accuracy notes only: (1) Chen & Ankenman (2006) 'The Mathematics of Poker' (ConJelCo) was NOT retrieved directly, but it is verifiably real — it appears as reference [1] inside the Li (2018) MIT paper I read firsthand ('Bill Chen and Jerrod Ankenman, The mathematics of poker, ConJelCo'). The bundle's [needs-verification] flag can be DOWNGRADED to 'corroborated-indirectly'. (2) The bundle flagged Johanson, Zinkevich & Bowling (2007) and Johanson & Bowling (2009) as [needs-verification] — BOTH are now confirmed firsthand: 'Computing Robust Counter-Strategies' (NeurIPS 2007, proceedings hash 6e7b33...) and 'Data Biased Robust Counter Strategies' (AISTATS 2009, PMLR v5, pp.264-271). The 2007 RNR attribution is independently corroborated inside Ganzfried & Sun's text ('the restricted Nash response has been demonstrated... [Johanson et al., 2007]'). These flags can be LIFTED. (3) Ganzfried & Sun: co-author is Qingyun Sun (bundle's 'Q. Sun' is fine); paper also appeared in EC'17/IEEE form, but arXiv 1603.03491 is correct. (4) PokerAlpha lists SIX types (Nit, Calling Station, Solid Regular, LAG, Maniac, Elite Regular) — it has NO standalone 'TAG' type, and gives NO explicit VPIP/PFR numbers for the calling station; the bundle's station thresholds (VPIP 35%+, low AF) come from SmartPokerStudy/DriveHUD, so the citationKeys slightly over-credit PokerAlpha for those numbers. (5) Shoily thesis real URI is /handle/88435/dsp01td96k5958 (the bundle's /handle/88435/ path is correct; the /handle/...handle URL the bundle listed resolves).
- **Pop-myth flags:**
  - 🚩 No genuine pop-psychology myths are asserted in the bundle — this is a notable strength. The bundle deliberately AVOIDS physical-'tells' lore (Caro-style eye/hand/chip tells), which has no peer-reviewed validity; all its 'reads' are behavioral/betting-pattern signals (sizing, line, frequencies) derived from solver and mass-data analysis, which is the defensible form. RECOMMENDATION: in the C.M. Engue book, explicitly state this distinction so readers do not import physical-tell mysticism — physical tells are NOT what the engine uses.
  - 🚩 The 'non-intuitive aggression = value' heuristic, while well-supported by Vanja (2025) and the population-under-bluffing data, risks being OVERSTATED into a hard rule. The evidence says non-elite players UNDER-construct creative bluffs; it does not say zero. The bundle correctly gates this OFF vs elite/balanced opponents (heuristic #4 encodeHint) — keep that gate; do not let it harden into 'a check-raise is ALWAYS the nuts'.
  - 🚩 The session/tilt heuristic (#7) leans on Shoily (2025), which DOES support 'down-money players become more risk-seeking as their stack regrows' (verified verbatim from the abstract). BUT inferring live tilt/'stuck' state from observed play is noisy; the bundle already labels it a 'soft, low-weight prior' — this caveat is correct and should be preserved. Do NOT let it become deterministic 'he just lost a pot, therefore he's spewing.'
  - 🚩 Borderline myth AVOIDED: the bundle does NOT invoke the gambler's-fallacy/hot-hand 'due for a card' framing anywhere — good. If the book adds session-psychology chapters, flag that the classic 'hot hand' in poker is largely a misconception and keep variance framing rigorous.

### gto-theory
- **Verdict:** mostly-solid-with-fixes (18 citations checked)
- **Suspect citations:**
  - ⚠️ Kuhn (1950) — REAL and correctly attributed (Princeton UP, Contributions to the Theory of Games, Vol. 1), but the page range '97-103' is slightly off: authoritative catalogs (De Gruyter/Princeton) give pp. 97-104, and the volume year is cited as both 1950 and 1951 across sources. Not fabricated; needs a minor metadata correction to pp. 97-104 and a note that 1950/1951 both appear in the literature.
  - ⚠️ Johanson, Waugh, Bowling, & Zinkevich (2011) — REAL (IJCAI-2011, pp. 258-265, confirmed on the authors' own pages), but the AUTHOR ORDER in the reference list is wrong. The published byline is Johanson, Bowling, Waugh, Zinkevich (not Johanson, Waugh, Bowling, Zinkevich). Fix the order; the [needs-verification] flag can otherwise be dropped.
  - ⚠️ von Neumann (1928) — REAL and correctly attributed (Mathematische Annalen 100, DOI 10.1007/BF01448847). The '295-320' page range is corroborated by the Christie's offprint record and Springer; the [needs-verification] flag can be dropped. No issue beyond that the engine confirmed it via aggregators rather than the German original.
  - ⚠️ Chen, Deng, & Teng (2009) — REAL and exactly correct (JACM 56(3), Article 14, DOI 10.1145/1516512.1516516, PPAD-completeness). The [needs-verification] flag is unwarranted and should be removed.
  - ⚠️ Stahl & Wilson (1995) — REAL and exactly correct (Games and Economic Behavior 10(1), 218-254, DOI 10.1006/game.1995.1031). The [needs-verification] flag should be removed.
  - ⚠️ Chen & Ankenman (2006) The Mathematics of Poker — REAL (ConJelCo, ISBN 9781886070257). The [needs-verification] flag was conservative; the book exists. It was not retrieved firsthand, so the indifference/clairvoyance toy-game CLAIMS attributed to it rest on practitioner secondary sources, not the primary text — keep that caveat, drop the existence doubt.
  - ⚠️ Bowling et al. (2017) CACM reprint — REAL (CACM 60(11), 81-88, DOI 10.1145/3131284), but the primary CACM URL returned HTTP 403 on re-fetch this session; the 0.986 mbb/g, <1 mbb/g lifetime threshold, and ~88 mbb/g dealer figures were re-confirmed via Wikipedia + Science abstract + UAlberta mirror instead. The specific in-paper counts (3.16e17 states, 3.19e14 info sets, 87.7-89.7 mbb/g dealer bounds) were NOT independently re-verified this pass; they are consistent with the literature but rely on the engine's earlier firsthand read.
- **Pop-myth flags:**
  - 🚩 Physical 'tells' lore — NOT present as an engine heuristic, which is the correct and defensible choice. Independent literature (Levine; ~53-54% accuracy in ~300 deception-detection studies, barely above chance) shows human reading of microexpressions/body-language is near-worthless. The engine grounds ALL reads in OBSERVABLE BETTING FREQUENCIES (bluff rate vs alpha, fold-to-bet, sizing-to-range-shape), not body language. Flagging this as a thing to KEEP avoiding, not a myth the engine commits.
  - 🚩 Level-k 'average ~1.5 reasoning steps' — VERIFIED in the QJE 2004 abstract (Camerer-Ho-Chong: 'an average of 1.5 steps fits data from many games'), so it is correctly stated. CAVEAT (mild overstatement risk): 1.5 is an across-many-experimental-games average from one-shot normal-form lab games; transferring it as a literal prior for repeated multi-street poker villains is a modeling assumption, not an established poker finding. Present it as a reasonable default prior, not an empirically measured poker depth.
  - 🚩 'GTO guarantees you cannot lose' — technically true ONLY heads-up and only in expectation minus rake; the engine states this correctly. Worth a guardrail note that the multiplayer heuristic already (correctly) flags the Nash guarantee collapses with 3+ players, so the two are internally consistent. No myth, but the 'cannot lose' phrasing should always carry the heads-up + minus-rake qualifier to avoid overstatement.
  - 🚩 Hot-hand / streak misconceptions — NOT invoked by the engine anywhere (no tilt/streak/momentum heuristic). Good: the engine avoids the hot-hand fallacy entirely. No correction needed; noted as a myth the engine correctly steers clear of.

### gambling-risk-psych — Behavioral economics of risk and gambling psychology applied to skill poker (bankroll/Kelly intuition, risk of ruin, overconfidence & Dunning-Kruger, deliberate practice/expertise, decision fatigue, and the deception/bluffing & theory-of-mind literature)
- **Verdict:** mostly-solid-with-fixes (16 citations checked)
- **Suspect citations:**
  - ⚠️ MacLean, Thorp & Ziemba (2010) — NOT fabricated, but MIS-ATTRIBUTED. The JSON cites it as a chapter 'In The Kelly capital growth investment criterion: Theory and practice. World Scientific.' The actual primary published source is a peer-reviewed journal article: MacLean, L. C., Thorp, E. O., & Ziemba, W. T. (2010). Long-term capital growth: The good and bad properties of the Kelly and fractional Kelly capital growth criteria. Quantitative Finance, 10(7), 681-687. https://doi.org/10.1080/14697688.2010.506108 . The Berkeley 'Good_Bad_Kelly.pdf' the researcher read is a working-paper version of that article (also reprinted in the World Scientific anthology, so the chapter form exists too). FIX: cite the Quantitative Finance article as the primary venue; the truncated title and missing DOI/volume should be corrected. The double-Kelly-zero-growth and fractional-Kelly findings drawn from it are accurate.
  - ⚠️ Levitt & Miles (2011) — citation is REAL and correctly attributed; the JSON's flag that published pagination 'needs-verification' is now RESOLVED: published as Levitt, S. D., & Miles, T. J. (2014). The role of skill versus luck in poker: Evidence from the World Series of Poker. Journal of Sports Economics, 15(1), 31-44 (NBER WP 17023, 2011). Not suspect — flag cleared.
  - ⚠️ Wang, Wang, Zhou & Yu (2020) — REAL; DOI flagged 'needs-verification' in JSON. Record confirmed: Social Cognitive and Affective Neuroscience, 15(12), 1315-1324, Dec 2020 (PubMed 33186465). DOI 10.1093/scan/nsaa154 is consistent with the SCAN/Oxford record. Not suspect — attribution sound.
  - ⚠️ Palomäki, Laakasuo, Cowley & Lappi (2020) — REAL (Journal of Expertise 3(2), 2020). Two minor issues: (a) the JSON's keyConcepts citationKey 'Palomäki, Laakasuo & Cowley (2020)' DROPS the fourth author Lappi (the full apaReferences entry lists all four correctly); (b) the page range (apaReferences says 66-87) could NOT be independently confirmed from the journal's HTML TOC and remains genuinely [needs-verification].
- **Pop-myth flags:**
  - 🚩 Decision fatigue / 'hungry judge' (Danziger et al., 2011) is the weakest empirical leg and the JSON's own heuristic over-leans on it for the 'late-session villain takes lazy default lines' exploit. The JSON does responsibly cite Glöckner (2016) and hedge 'magnitude uncertain,' but the broader ego-depletion literature (the mechanism invoked) failed the large multi-lab replication (Hagger et al., 2016 RRR) — so the CAUSAL story ('cognitive resources deplete') is shakier than the hedge implies. Keep the heuristic only as a weak prior, not a confident read.
  - 🚩 'Tells' lore: the JSON correctly EXCLUDED the 'Reading Poker Tells' blog as non-authoritative and makes NO physical-tell claims — good. Flagging proactively that any future engine layer asserting reliable live physical tells (eye movements, chip-handling, breathing) would be pop-psychology; the peer-reviewed signal is behavioral/statistical (bet-sizing, timing, frequencies), which is what the JSON actually encodes.
  - 🚩 Hot-hand: the JSON wisely makes NO hot-hand claim. Flagging the inverse trap for completeness — the casual 'hot hand is a debunked fallacy' line is itself now OUTDATED. Miller & Sanjurjo (2018) showed Gilovich-Vallone-Tversky (1985) used a test with a small-sample selection bias; after correction there is significant evidence of streak shooting. An engine should NOT hard-code 'streaks are pure illusion.' Tilt (which the JSON does use) is a separate, well-evidenced construct and is handled correctly.
  - 🚩 Dunning-Kruger magnitude: the JSON narrative says bottom-quartile performers (12th percentile actual) rated themselves '~62nd-68th'/'58th-68th'. The canonical Study-1 figure is ~62nd percentile; the wider 58-68 band is study-dependent. Not a myth, but the precise percentile should be stated per-study, and note the live methodological debate (Krueger & Mueller 2002; better-than-average + regression-to-mean artifacts) that the JSON does not mention — the EFFECT (incompetent overrate themselves) is robust; the pure-metacognition MECHANISM is contested.
  - 🚩 Overconfidence→over-trading (Barber & Odean): the 11.4% vs 17.9% gap is real and correctly reported, but it is an ANALOGY to poker, not poker data. The JSON labels it 'trading analog,' which is honest; just ensure the book/engine never presents it as a direct poker measurement.

