import { type Street } from "./game-state.js";

export function geometricSize(
  pot: number,
  stack: number,
  streetsLeft: number,
): number {
  if (streetsLeft <= 0 || pot <= 0 || stack <= 0) return 0;
  const ratio = (pot + stack) / pot;
  const bet = pot * (Math.pow(ratio, 1 / streetsLeft) - 1);
  // Clamp to [pot/3, stack] — NOT to pot. Geometric sizing is frequently larger
  // than pot (an overbet) when stacks are deep relative to the pot; the old
  // min(pot, …) cap silently killed every overbet the math called for.
  return Math.round(Math.min(stack, Math.max(pot / 3, bet)));
}

export function recommendSize(
  pot: number,
  stack: number,
  street: Street,
): number {
  const spr = stack / pot;
  if (spr < 1) return stack;

  const streets: Record<Street, number> = {
    preflop: 3,
    flop: 2,
    turn: 1,
    river: 0,
  };
  const n = streets[street];
  if (n === 0) return Math.round(Math.min(stack, pot * 0.67));
  return geometricSize(pot, stack, n);
}

export function openRaiseSize(bb: number, limpers = 0): number {
  return Math.round(bb * (2.5 + limpers));
}

export function threeBetSize(raiseTo: number, inPosition: boolean): number {
  return Math.round(raiseTo * (inPosition ? 3 : 3.5));
}

export function fourBetSize(threeBetTo: number): number {
  return Math.round(threeBetTo * 2.25);
}

export function minRaise(currentBet: number, bb: number): number {
  return Math.max(currentBet * 2, bb * 2);
}
