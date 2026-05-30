import { describe, it, expect } from "vitest";
import { InfoSets } from "../gto/regret.js";
import { cfr, type CfrGame } from "../gto/cfr.js";
import { kuhnGame, kuhnDeals, type KuhnState } from "../gto/kuhn.js";

function train(iterations: number): InfoSets {
  const info = new InfoSets();
  const deals = kuhnDeals();
  for (let it = 0; it < iterations; it++) {
    for (const d of deals) cfr(kuhnGame, info, d, 1, 1);
  }
  return info;
}

// Expected value to player 0 under the averaged (equilibrium) strategies.
function evalP0<S>(game: CfrGame<S>, info: InfoSets, s: S): number {
  if (game.isTerminal(s)) return game.utilityP0(s);
  const key = game.infoKey(s);
  const acts = game.actions(s);
  const avg = info.average(key) ?? acts.map(() => 1 / acts.length);
  let v = 0;
  for (let i = 0; i < acts.length; i++) v += avg[i]! * evalP0(game, info, game.next(s, acts[i]!));
  return v;
}

function gameValue(info: InfoSets): number {
  const deals = kuhnDeals();
  let v = 0;
  for (const d of deals) v += evalP0(kuhnGame, info, d);
  return v / deals.length;
}

describe("CFR on Kuhn poker (known equilibrium)", () => {
  const info = train(20000);

  it("converges to the game value of -1/18 for player 0", () => {
    const v = gameValue(info);
    expect(v).toBeGreaterThan(-1 / 18 - 0.012);
    expect(v).toBeLessThan(-1 / 18 + 0.012);
  });

  it("player 0 never bluffs the Queen first-in", () => {
    // key "1:" => card Q (1), empty history; actions [check, bet]
    const avg = info.average("1:")!;
    expect(avg[1]!).toBeLessThan(0.05); // bet prob ~0
  });

  it("player 1 calls a bet with the Queen about 1/3 of the time", () => {
    // key "1:b" => card Q facing a bet; actions [fold, call]
    const avg = info.average("1:b")!;
    expect(avg[1]!).toBeGreaterThan(0.22);
    expect(avg[1]!).toBeLessThan(0.45);
  });

  it("player 1 always calls a bet with the King and folds the Jack", () => {
    const k = info.average("2:b")!; // King facing bet
    const j = info.average("0:b")!; // Jack facing bet
    expect(k[1]!).toBeGreaterThan(0.95); // call King
    expect(j[1]!).toBeLessThan(0.05); // fold Jack
  });

  it("player 0 value-bets the King ~3x its Jack bluff frequency", () => {
    const kBet = info.average("2:")![1]!; // King bet freq
    const jBet = info.average("0:")![1]!; // Jack (bluff) bet freq
    // Equilibrium: bet(K) = 3 * bet(J), with bet(J) in [0, 1/3].
    expect(jBet).toBeGreaterThan(0.0);
    expect(kBet).toBeGreaterThan(jBet);
    if (jBet > 0.02) {
      expect(kBet / jBet).toBeGreaterThan(2.0);
      expect(kBet / jBet).toBeLessThan(4.0);
    }
  });
});
