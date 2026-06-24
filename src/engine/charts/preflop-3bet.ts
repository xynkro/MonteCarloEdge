// Blind-battle 3-bet / 4-bet ranges (GTO-approximate, study reference).
// v1 covers the most-studied preflop tree: the BIG BLIND 3-bets a single opener,
// and the OPENER responds (4-bet / call / fold). Keyed by the OPENER's position;
// shared across 6/9-max (the blind battle is near-identical for the same relative
// seat). Same poker-notation as RFI / BB_DEFENSE so Range.parse works — note the
// parser only allows dash ranges for PAIRS ("QQ-99"); suited/offsuit runs are listed.
//
// Sensible approximations of solver output — directionally correct for study, not
// claimed exact. Coverage is expandable to non-BB 3-bettors later.

// BB's 3-bet range facing an open from `opener`. Polarised: value (big pairs, AK/AQ)
// + suited bluffs (wheel aces, suited connectors). Widens as the opener gets later.
export const BB_3BET: Record<string, string> = {
  UTG: "QQ+,AKs,AKo,A5s,A4s",
  MP:  "JJ+,AQs+,AKo,A5s,A4s,KQs",
  HJ:  "JJ+,AQs+,AKo,A5s,A4s,A3s,KJs+",
  CO:  "TT+,AJs+,AQo+,A2s,A3s,A4s,A5s,KJs+,QJs,JTs,T9s",
  BTN: "99+,ATs+,AJo+,A2s,A3s,A4s,A5s,KTs+,QTs+,JTs,T9s,98s,K9s,76s",
  SB:  "TT+,ATs+,AJo+,A2s,A3s,A4s,A5s,KTs+,QTs+,JTs,T9s,98s",
};

// The opener's 4-bet range when the BB 3-bets. Value-heavy + a couple of A5s/A4s bluffs.
export const OPENER_4BET: Record<string, string> = {
  UTG: "KK+,AKs,A5s",
  MP:  "KK+,AKs,AKo,A5s",
  HJ:  "QQ+,AKs,AKo,A5s,A4s",
  CO:  "QQ+,AKs,AKo,A5s,A4s",
  BTN: "QQ+,AKs,AKo,AQs,A5s,A4s",
  SB:  "QQ+,AKs,AKo,A5s,A4s",
};

// The opener's flat-call range vs the BB 3-bet (strong enough to continue, not to
// 4-bet). Everything else in the opener's RFI range folds.
export const OPENER_CALL_VS_3BET: Record<string, string> = {
  UTG: "QQ-99,AQs,AJs,ATs,KQs,KJs,QJs,JTs,AKo,AQo",
  MP:  "JJ-88,AQs,AJs,ATs,KQs,KJs,QJs,JTs,T9s,AQo,KQo",
  HJ:  "JJ-77,AQs,AJs,ATs,A9s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,AQo,KQo",
  CO:  "TT-66,AJs,ATs,A9s,A8s,KJs,KTs,K9s,QTs+,JTs,J9s,T9s,98s,87s,AJo,KQo",
  BTN: "TT-55,ATs,A9s,A8s,KTs,K9s,QTs+,J9s+,T8s+,97s+,87s,76s,AJo,KQo,QJo",
  SB:  "JJ-66,AQs,AJs,ATs,KJs,KTs,QJs,QTs,JTs,T9s,98s,AQo,KQo",
};
