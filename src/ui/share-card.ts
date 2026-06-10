// Branded "I won" share card — the viral engine. Renders a polished PNG on a canvas and
// shares it (Web Share API on mobile) or downloads it (desktop). Every share carries the
// MCE brand + the app URL, so each one doubles as a free ad. No deps — pure canvas.

export interface WinCard {
  amount: number;                          // chips won (the pot scooped)
  sym: string;                             // "🪙" play / "💎" premium
  cards?: { t: string; red: boolean }[];   // hero cards: display text + red flag
  tag?: string;                            // small accent line, e.g. a hand label
}

const W = 1080, H = 1080;
const URL_TEXT = "montecarloedge.web.app";

/** Build the branded win canvas (also exported so it can be previewed/tested). */
export function buildWinCanvas(c: WinCard): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (ctx) drawWinCard(ctx, c);
  return canvas;
}

/** Generate the card and share it (mobile) or download it (desktop). Returns whether the
 *  native share sheet was used. */
export async function shareWin(c: WinCard): Promise<{ shared: boolean }> {
  const canvas = buildWinCanvas(c);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png", 0.95));
  if (!blob) return { shared: false };
  const file = new File([blob], "mce-win.png", { type: "image/png" });
  const text = "Crushed the table with MCE Strategy ⚡ Play the math → " + URL_TEXT;
  try {
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (typeof nav.canShare === "function" && nav.canShare({ files: [file] }) && typeof navigator.share === "function") {
      await navigator.share({ files: [file], title: "I won on MonteCarloEdge", text });
      return { shared: true };
    }
  } catch { /* user cancelled or unsupported → fall through to download */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "mce-win.png";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { shared: false };
}

function drawWinCard(ctx: CanvasRenderingContext2D, c: WinCard): void {
  // backdrop
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0a0e13"); bg.addColorStop(1, "#0f1a16");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // felt glow behind the number
  const glow = ctx.createRadialGradient(W / 2, H * 0.44, 60, W / 2, H * 0.44, 640);
  glow.addColorStop(0, "rgba(31,157,107,0.32)"); glow.addColorStop(1, "rgba(31,157,107,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // gold frame
  ctx.strokeStyle = "rgba(245,196,81,0.5)"; ctx.lineWidth = 6;
  roundRect(ctx, 38, 38, W - 76, H - 76, 38); ctx.stroke();

  ctx.textAlign = "center";
  // wordmark
  ctx.fillStyle = "#f5c451";
  ctx.font = "800 48px 'Bricolage Grotesque', system-ui, sans-serif";
  ctx.fillText("⚡ MONTECARLO EDGE", W / 2, 158);
  // "I just won"
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "700 40px system-ui, sans-serif";
  ctx.fillText("I JUST WON", W / 2, 372);
  // big amount
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 210px system-ui, sans-serif";
  ctx.fillText("+" + fmt(c.amount), W / 2, 576);
  // chip label / tag
  ctx.fillStyle = "#3fd6c4";
  ctx.font = "700 42px system-ui, sans-serif";
  ctx.fillText(c.tag ? c.tag : `${c.sym} chips`, W / 2, 654);
  // hero cards
  if (c.cards && c.cards.length) drawHand(ctx, c.cards, W / 2, 690);
  // footer
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "800 46px system-ui, sans-serif";
  ctx.fillText(URL_TEXT, W / 2, H - 138);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "600 36px system-ui, sans-serif";
  ctx.fillText("Play the math. Own the table.", W / 2, H - 82);
}

function drawHand(ctx: CanvasRenderingContext2D, cards: { t: string; red: boolean }[], cx: number, cy: number): void {
  const cw = 140, ch = 196, gap = 22;
  const total = cards.length * cw + (cards.length - 1) * gap;
  let x = cx - total / 2;
  for (const card of cards) {
    roundRect(ctx, x, cy, cw, ch, 18);
    ctx.fillStyle = "#fdfdfd"; ctx.fill();
    ctx.fillStyle = card.red ? "#d23b4e" : "#15202b";
    ctx.font = "800 78px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(card.t, x + cw / 2, cy + ch / 2 + 28);
    x += cw + gap;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(Math.round(n));
}
