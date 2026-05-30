import { InfoSets } from "./regret.js";

// A 2-player zero-sum extensive-form game with no internal chance nodes.
// (Chance — e.g. the deal — is handled by the driver, which enumerates or
// samples deals and calls cfr on each resulting chance-free subtree.)
export interface CfrGame<S> {
  isTerminal(s: S): boolean;
  // Utility from player 0's perspective at a terminal state.
  utilityP0(s: S): number;
  player(s: S): 0 | 1;
  infoKey(s: S): string;
  actions(s: S): readonly string[];
  next(s: S, action: string): S;
}

// Vanilla CFR traversal. Returns the expected utility for player 0.
// pi0 / pi1 are the players' reach probabilities to this node.
export function cfr<S>(
  game: CfrGame<S>,
  info: InfoSets,
  s: S,
  pi0: number,
  pi1: number,
): number {
  if (game.isTerminal(s)) return game.utilityP0(s);

  const pl = game.player(s);
  const key = game.infoKey(s);
  const acts = game.actions(s);
  const n = acts.length;
  const strat = info.getStrategy(key, n);

  const childUtil = new Float64Array(n);
  let nodeU0 = 0;
  for (let i = 0; i < n; i++) {
    const ns = game.next(s, acts[i]!);
    const u = pl === 0
      ? cfr(game, info, ns, pi0 * strat[i]!, pi1)
      : cfr(game, info, ns, pi0, pi1 * strat[i]!);
    childUtil[i] = u;
    nodeU0 += strat[i]! * u;
  }

  // Regret update from the acting player's perspective.
  const cfReach = pl === 0 ? pi1 : pi0;
  const ownReach = pl === 0 ? pi0 : pi1;
  const node = pl === 0 ? nodeU0 : -nodeU0;
  for (let i = 0; i < n; i++) {
    const val = pl === 0 ? childUtil[i]! : -childUtil[i]!;
    info.addRegret(key, i, cfReach * (val - node));
  }
  info.addStrategy(key, strat, ownReach);

  return nodeU0;
}
