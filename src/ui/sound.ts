// Lightweight Web Audio sound effects — synthesized, no asset files.

let ctx: AudioContext | null = null;
let enabled = true;

const PREF_KEY = "mce-sound";
try {
  enabled = localStorage.getItem(PREF_KEY) !== "off";
} catch { /* ignore */ }

function ac(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, durMs: number, type: OscillatorType, gain = 0.08, delayMs = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delayMs / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

export type SoundName = "deal" | "card" | "check" | "bet" | "fold" | "win" | "lose" | "turn";

export function playSound(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case "deal": // quick riffle
      for (let i = 0; i < 4; i++) tone(420 + i * 30, 45, "triangle", 0.05, i * 55);
      break;
    case "card": tone(520, 50, "triangle", 0.05); break;
    case "check": tone(300, 70, "sine", 0.06); break;
    case "bet": tone(660, 90, "square", 0.05); tone(880, 70, "square", 0.04, 60); break;
    case "fold": tone(240, 130, "sine", 0.05); break;
    case "turn": tone(760, 120, "sine", 0.07); tone(1010, 120, "sine", 0.05, 90); break;
    case "win": [523, 659, 784, 1047].forEach((f, i) => tone(f, 160, "triangle", 0.07, i * 90)); break;
    case "lose": tone(330, 200, "sine", 0.06); tone(247, 260, "sine", 0.06, 140); break;
  }
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  if (on) playSound("card");
}

export function isSoundEnabled(): boolean {
  return enabled;
}
