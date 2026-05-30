import { type CfrGame } from "./cfr.js";

// Kuhn poker — the canonical CFR test game. 3 cards (J<Q<K), each player antes
// 1, one betting round with a fixed bet size of 1. Its Nash equilibrium is
// known analytically, so it validates the CFR engine.
//
// History letters: c = check/call-spot check, b = bet, then responses.
//   ""      P1 to act
//   "b"     P1 bet, P2 to act (fold/call)
//   "c"     P1 check, P2 to act (check/bet)
//   "cb"    P1 check, P2 bet, P1 to act (fold/call)
// Terminal: "bc","bf","cc","cbc","cbf".

export interface KuhnState {
  deal: readonly [number, number]; // [p0card, p1card]
  history: string;
}

const TERMINALS = new Set(["bc", "bf", "cc", "cbc", "cbf"]);

export const kuhnGame: CfrGame<KuhnState> = {
  isTerminal(s) {
    return TERMINALS.has(s.history);
  },

  utilityP0(s) {
    const { deal, history } = s;
    const p0win = deal[0] > deal[1] ? 1 : -1;
    switch (history) {
      case "bf": return 1; // P1 bet, P2 folded
      case "cbf": return -1; // P1 checked, P2 bet, P1 folded
      case "cc": return p0win; // both checked, showdown for the antes
      case "bc": return 2 * p0win; // bet-call showdown
      case "cbc": return 2 * p0win; // check-bet-call showdown
      default: return 0;
    }
  },

  player(s) {
    // Number of actions so far determines who acts.
    return (s.history.length % 2) as 0 | 1;
  },

  infoKey(s) {
    const card = s.deal[s.history.length % 2];
    return `${card}:${s.history}`;
  },

  actions(s) {
    // Facing a bet ("b" or "cb") => fold/call; otherwise check/bet.
    const facingBet = s.history.endsWith("b");
    return facingBet ? ["f", "c"] : ["c", "b"];
  },

  next(s, action) {
    return { deal: s.deal, history: s.history + action };
  },
};

// All 6 distinct deals, each equally likely.
export function kuhnDeals(): KuhnState[] {
  const out: KuhnState[] = [];
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++)
      if (a !== b) out.push({ deal: [a, b], history: "" });
  return out;
}
