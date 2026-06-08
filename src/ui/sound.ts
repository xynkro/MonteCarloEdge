// Web Audio sound effects — NOISE-BASED foley (no asset files, no chiptune).
// Cards = filtered broadband "flicks"; chips = resonant metallic "clinks"; the pot
// rake = a cascade of clinks. Each burst is pitch-jittered so repeats don't sound
// identical. (True studio foley would need licensed .mp3s; this gets ~90% there
// with zero downloads.)

let ctx: AudioContext | null = null;
let enabled = true;
let noiseBuf: AudioBuffer | null = null;

const PREF_KEY = "mce-sound";
try { enabled = localStorage.getItem(PREF_KEY) !== "off"; } catch { /* ignore */ }

function ac(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.5);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

// A filtered noise burst with a fast percussive envelope — the foley building block.
function burst(o: { at?: number; dur: number; type: BiquadFilterType; freq: number; q?: number; gain?: number; attack?: number }): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 0.82 + Math.random() * 0.36; // jitter so repeats vary
  const f = c.createBiquadFilter();
  f.type = o.type; f.frequency.value = o.freq; f.Q.value = o.q ?? 1;
  const g = c.createGain();
  const dur = o.dur / 1000, atk = (o.attack ?? 1.5) / 1000, peak = o.gain ?? 0.2;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(c.destination);
  src.start(t0); src.stop(t0 + dur + 0.03);
}

// A soft sine "body" used sparingly (win warmth / notification), not melody.
function tone(freq: number, durMs: number, gain = 0.06, at = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g); g.connect(c.destination);
  osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
}

const cardFlick = (at = 0, gain = 0.16) => burst({ at, dur: 90, type: "bandpass", freq: 1500 + Math.random() * 600, q: 1.1, gain });
const chipClink = (at = 0, gain = 0.16) => {
  burst({ at, dur: 70, type: "bandpass", freq: 3000 + Math.random() * 900, q: 7, gain });
  burst({ at: at + 0.004, dur: 40, type: "highpass", freq: 5200, gain: gain * 0.45 });
};
const knock = (at = 0, gain = 0.22) => burst({ at, dur: 70, type: "lowpass", freq: 240, q: 0.8, gain });

export type SoundName = "deal" | "card" | "check" | "bet" | "fold" | "win" | "lose" | "turn" | "shuffle" | "chip";

export function playSound(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case "shuffle": // riffle: a rapid accelerating run of card flicks + a soft "bridge"
    case "deal":
      for (let i = 0; i < 10; i++) cardFlick(i * (0.05 - i * 0.0028), 0.10);
      break;
    case "card": cardFlick(0, 0.18); break;
    case "check": knock(0); knock(0.12, 0.18); break;       // two knuckle raps on the felt
    case "chip":
    case "bet": // chips pushed in — a small riffle of clinks
      for (let i = 0; i < 5; i++) chipClink(i * 0.045, 0.15);
      break;
    case "fold": cardFlick(0, 0.14); cardFlick(0.07, 0.11); break; // cards tossed
    case "turn": chipClink(0, 0.16); tone(880, 90, 0.04, 0.02); break; // soft "your action"
    case "win": // raking the pot — a chip cascade + warm low body
      for (let i = 0; i < 14; i++) chipClink(i * (0.04 + Math.random() * 0.01), 0.13);
      tone(180, 320, 0.05, 0); tone(270, 300, 0.04, 0.04);
      break;
    case "lose": knock(0, 0.2); tone(150, 260, 0.05, 0.05); break; // muted thud
  }
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  if (on) playSound("chip");
}

export function isSoundEnabled(): boolean { return enabled; }
