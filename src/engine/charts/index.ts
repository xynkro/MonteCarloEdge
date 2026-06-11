import { Range } from "../range.js";
import { RFI as HU_RFI, BB_DEFENSE as HU_BB_DEF } from "./preflop-hu.js";
import { RFI as SIX_RFI, BB_DEFENSE as SIX_BB_DEF } from "./preflop-6max.js";
import { RFI as NINE_RFI, BB_DEFENSE as NINE_BB_DEF } from "./preflop-9max.js";

const POSITION_NAMES: Record<number, readonly string[]> = {
  2: ["BTN", "BB"],
  3: ["BTN", "SB", "BB"],
  4: ["CO", "BTN", "SB", "BB"],
  5: ["MP", "CO", "BTN", "SB", "BB"],
  6: ["UTG", "MP", "CO", "BTN", "SB", "BB"],
  7: ["UTG", "MP", "HJ", "CO", "BTN", "SB", "BB"],
  8: ["UTG", "UTG1", "MP", "HJ", "CO", "BTN", "SB", "BB"],
  9: ["UTG", "UTG1", "UTG2", "MP", "HJ", "CO", "BTN", "SB", "BB"],
  10: ["UTG", "UTG1", "UTG2", "MP", "MP1", "HJ", "CO", "BTN", "SB", "BB"],
  // 11/12-max aren't a real solved poker format (live tables cap at 10). The extra early
  // seats (UTG3/UTG4) alias to UTG — the tightest range — which is directionally correct.
  11: ["UTG", "UTG1", "UTG2", "UTG3", "MP", "MP1", "HJ", "CO", "BTN", "SB", "BB"],
  12: ["UTG", "UTG1", "UTG2", "UTG3", "UTG4", "MP", "MP1", "HJ", "CO", "BTN", "SB", "BB"],
};

const POSITION_ALIASES: Record<string, string> = {
  MP1: "HJ",
  UTG3: "UTG2",
  UTG4: "UTG2",
};

function pickChart(tableSize: number) {
  if (tableSize === 2) return { rfi: HU_RFI, bbDef: HU_BB_DEF };
  if (tableSize <= 6) return { rfi: SIX_RFI, bbDef: SIX_BB_DEF };
  return { rfi: NINE_RFI, bbDef: NINE_BB_DEF };
}

function resolvePosition(chart: Record<string, string>, position: string): string | undefined {
  if (chart[position] !== undefined) return position;
  const alias = POSITION_ALIASES[position];
  if (alias && chart[alias] !== undefined) return alias;
  return undefined;
}

const cache = new Map<string, Range>();
function cached(key: string, str: string): Range {
  let r = cache.get(key);
  if (!r) {
    r = Range.parse(str);
    cache.set(key, r);
  }
  return r;
}

export function getPositions(tableSize: number): readonly string[] {
  const p = POSITION_NAMES[tableSize];
  if (!p) throw new Error(`Unsupported table size: ${tableSize}`);
  return p;
}

// Position label for each SEAT given where the dealer button sits, so labels
// rotate with the button (BTN at `dealerSeat`, SB next, etc.). When
// `dealerSeat` is the canonical BTN index (tableSize-3) this equals getPositions.
export function positionsForButton(tableSize: number, dealerSeat: number): string[] {
  const canon = POSITION_NAMES[tableSize];
  if (!canon) throw new Error(`Unsupported table size: ${tableSize}`);
  const n = canon.length;
  const btnIdx = canon.indexOf("BTN");
  const ds = ((dealerSeat % n) + n) % n;
  const out = new Array<string>(n);
  for (let s = 0; s < n; s++) out[s] = canon[(((s - ds + btnIdx) % n) + n) % n]!;
  return out;
}

export function getRfiRange(tableSize: number, position: string): Range {
  const { rfi } = pickChart(tableSize);
  const resolved = resolvePosition(rfi, position);
  if (!resolved) throw new Error(`No RFI range for ${position} at ${tableSize}-max`);
  return cached(`rfi:${tableSize}:${position}`, rfi[resolved]!);
}

export function getBbDefenseRange(
  tableSize: number,
  openerPosition: string,
): Range {
  const { bbDef } = pickChart(tableSize);
  const resolved = resolvePosition(bbDef, openerPosition);
  if (!resolved)
    throw new Error(
      `No BB defense range vs ${openerPosition} at ${tableSize}-max`,
    );
  return cached(`bbdef:${tableSize}:${openerPosition}`, bbDef[resolved]!);
}
