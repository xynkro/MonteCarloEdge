// Regret-matching information-set store, shared by all CFR solvers.
//
// Each information set keeps a running regret sum and strategy sum over its
// actions. getStrategy() returns the current regret-matched strategy; after
// convergence, average() is the Nash-equilibrium strategy.

export class InfoSets {
  private regret = new Map<string, Float64Array>();
  private strat = new Map<string, Float64Array>();

  private ensure(key: string, n: number): void {
    if (!this.regret.has(key)) {
      this.regret.set(key, new Float64Array(n));
      this.strat.set(key, new Float64Array(n));
    }
  }

  // Current strategy from positive-regret matching.
  getStrategy(key: string, n: number): Float64Array {
    this.ensure(key, n);
    const r = this.regret.get(key)!;
    const out = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = r[i]! > 0 ? r[i]! : 0;
      out[i] = v;
      sum += v;
    }
    if (sum > 0) for (let i = 0; i < n; i++) out[i] = out[i]! / sum;
    else for (let i = 0; i < n; i++) out[i] = 1 / n;
    return out;
  }

  addRegret(key: string, action: number, value: number): void {
    const r = this.regret.get(key);
    if (r) r[action]! += value;
  }

  // Accumulate the average strategy, weighted by the player's reach probability.
  addStrategy(key: string, strat: Float64Array, weight: number): void {
    const s = this.strat.get(key);
    if (!s) return;
    for (let i = 0; i < strat.length; i++) s[i]! += weight * strat[i]!;
  }

  // Normalized average strategy (the converged equilibrium strategy).
  average(key: string): number[] | null {
    const s = this.strat.get(key);
    if (!s) return null;
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s[i]!;
    const out = new Array<number>(s.length);
    if (sum > 0) for (let i = 0; i < s.length; i++) out[i] = s[i]! / sum;
    else for (let i = 0; i < s.length; i++) out[i] = 1 / s.length;
    return out;
  }

  has(key: string): boolean {
    return this.strat.has(key);
  }

  get size(): number {
    return this.strat.size;
  }
}
