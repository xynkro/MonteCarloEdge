// Side-pot settlement. Given each seat's total contribution this hand, who is
// still in at showdown, and a hand-strength ranking, returns how many chips
// each seat is awarded. Handles uncalled bets and layered side pots correctly.
//
//   won[i] - contrib[i] = that seat's net for the hand
//   sum(won) === sum(contrib)  (chips are conserved)
//
// `strength[i]` is any comparable number where higher = better; folded players
// should be excluded via `inHand[i] === false` (their strength is ignored).
export function settlePots(
  contrib: readonly number[],
  inHand: readonly boolean[],
  strength: readonly number[],
): number[] {
  const n = contrib.length;
  const won = new Array<number>(n).fill(0);
  const rem = contrib.slice();
  const EPS = 1e-9;

  for (;;) {
    // Smallest remaining contribution among everyone who still has chips in.
    let level = Infinity;
    for (let i = 0; i < n; i++) if (rem[i]! > EPS) level = Math.min(level, rem[i]!);
    if (!isFinite(level)) break;

    // Peel one pot at this contribution level.
    let pot = 0;
    const contributors: number[] = [];
    for (let i = 0; i < n; i++) {
      if (rem[i]! > EPS) { pot += level; rem[i]! -= level; contributors.push(i); }
    }

    // Eligible winners: contributors who didn't fold.
    const eligible = contributors.filter((i) => inHand[i]);
    if (eligible.length === 0) {
      // No one contesting (all folded) — refund proportionally (degenerate case).
      for (const i of contributors) won[i]! += pot / contributors.length;
      continue;
    }
    let best = -Infinity;
    for (const i of eligible) best = Math.max(best, strength[i]!);
    const winners = eligible.filter((i) => strength[i] === best);
    for (const i of winners) won[i]! += pot / winners.length;
  }

  return won;
}

// Convenience: build a strength array where the given winner seats are best and
// everyone still in is worse. Used when the user picks the winner(s) manually
// (no exact hole cards), which is exact for heads-up and uncalled-bet returns.
export function strengthFromWinners(n: number, winners: readonly number[]): number[] {
  const s = new Array<number>(n).fill(0);
  for (const w of winners) s[w] = 1;
  return s;
}
