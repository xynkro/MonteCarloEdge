import { type ActionType } from "./game-state.js";
import { type Recommendation } from "./decision.js";

// ── Decision grading (coaching feedback) ──
// Grade a hero decision against the recommendation. Frequency-aware when the
// recommendation carries a solved MIX (the chosen action's frequency in the
// equilibrium decides the grade — a 30%-frequency GTO line is NOT a mistake);
// otherwise a match check against the (honestly labeled) heuristic/chart/Nash.

export interface Grade {
  label: string;
  cls: "g-ok" | "g-mix" | "g-bad";
  score: number; // 1 = on-strategy, 0.6 = rare-but-legit mix, 0 = mistake
  bucket: "gto" | "mixed" | "off";
}

export const SRC_WORD: Record<string, string> = {
  solver: "MCE",
  nash: "Nash",
  chart: "chart",
  heuristic: "strategy",
};

// How much of a solved mix does the chosen action represent? For bet/raise the
// SIZE is part of the strategy, so match the nearest solved size within 50%.
export function mixFreqOf(
  mix: { action: ActionType; amount: number; freq: number }[],
  action: ActionType,
  amount: number,
): number {
  if (action === "bet" || action === "raise") {
    let best = 0;
    for (const m of mix) {
      if (m.action !== "bet" && m.action !== "raise") continue;
      const tol = Math.max(1, m.amount) * 0.5;
      if (Math.abs(m.amount - amount) <= tol) best = Math.max(best, m.freq);
    }
    return best;
  }
  return mix.filter((m) => m.action === action).reduce((s, m) => s + m.freq, 0);
}

export function gradeDecision(d: {
  chosen: ActionType;
  chosenAmt: number;
  rec: Recommendation;
}): Grade {
  const rec = d.rec;
  if (rec.mix && rec.mix.length > 0) {
    const f = mixFreqOf(rec.mix, d.chosen, d.chosenAmt);
    const pct = Math.round(f * 100);
    if (f >= 0.15) return { label: `✓ GTO line · ${pct}%`, cls: "g-ok", score: 1, bucket: "gto" };
    if (f >= 0.02) return { label: `≈ rare GTO mix · ${pct}%`, cls: "g-mix", score: 0.6, bucket: "mixed" };
    return { label: `✗ off-tree · ~${pct}%`, cls: "g-bad", score: 0, bucket: "off" };
  }
  const src = SRC_WORD[rec.source ?? "heuristic"] ?? "strategy";
  if (d.chosen === rec.action) return { label: `✓ matches ${src}`, cls: "g-ok", score: 1, bucket: "gto" };
  return { label: `✗ off ${src}`, cls: "g-bad", score: 0, bucket: "off" };
}
