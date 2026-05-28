// Card representation: integer 0-51.
//   rank = card >> 2  (0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A)
//   suit = card & 3   (0=c, 1=d, 2=h, 3=s)

export type Card = number;

export const RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUIT_CHARS = ["c", "d", "h", "s"] as const;

export const NUM_CARDS = 52;

export function rankOf(card: Card): number {
  return card >> 2;
}

export function suitOf(card: Card): number {
  return card & 3;
}

export function makeCard(rank: number, suit: number): Card {
  return (rank << 2) | suit;
}

export function cardToString(card: Card): string {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

export function parseCard(s: string): Card {
  if (s.length !== 2) throw new Error(`Invalid card: ${s}`);
  const r = RANK_CHARS.indexOf(s[0]!.toUpperCase() as typeof RANK_CHARS[number]);
  const u = SUIT_CHARS.indexOf(s[1]!.toLowerCase() as typeof SUIT_CHARS[number]);
  if (r < 0 || u < 0) throw new Error(`Invalid card: ${s}`);
  return makeCard(r, u);
}

export function parseHand(s: string): Card[] {
  // "AsKs" or "As Ks" or "As,Ks"
  const clean = s.replace(/[\s,]/g, "");
  if (clean.length % 2 !== 0) throw new Error(`Invalid hand: ${s}`);
  const out: Card[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseCard(clean.slice(i, i + 2)));
  }
  return out;
}

export function handToString(cards: Card[]): string {
  return cards.map(cardToString).join("");
}

export function newDeck(): Card[] {
  const d: Card[] = new Array(NUM_CARDS);
  for (let i = 0; i < NUM_CARDS; i++) d[i] = i;
  return d;
}
