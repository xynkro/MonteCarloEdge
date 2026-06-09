// Sound — plays REAL recorded foley samples (CC0 / public-domain, commercial-OK):
//   chip.mp3    — clay poker chips (BigSoundBank, CC0)
//   deal.mp3    — a playing card dealt to felt (Freesound el_boss, CC0)
//   shuffle.mp3 — a card shuffle/riffle (Freesound VKProduktion, CC0)
// Each is pitch/gain-jittered per play so repeats don't sound identical. Knocks and
// the win/lose body are still synthesized (no sample needed). Everything routes
// through a master gain → compressor. If a sample hasn't decoded yet, we fall back
// to the synthesized version so there's never silence.

let ctx: AudioContext | null = null;
let masterIn: GainNode | null = null;
let enabled = true;
let noiseBuf: AudioBuffer | null = null;

const PREF_KEY = "mce-sound";
try { enabled = localStorage.getItem(PREF_KEY) !== "off"; } catch { /* ignore */ }

function ac(): AudioContext | null {
  const AC = (typeof AudioContext !== "undefined" ? AudioContext
    : (typeof window !== "undefined" ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined));
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    try { (navigator as unknown as { audioSession?: { type: string } }).audioSession!.type = "playback"; } catch { /* unsupported */ }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function master(c: AudioContext): AudioNode {
  if (!masterIn || masterIn.context !== c) {
    masterIn = c.createGain();
    masterIn.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3.2; comp.attack.value = 0.003; comp.release.value = 0.14;
    masterIn.connect(comp); comp.connect(c.destination);
  }
  return masterIn;
}

// ── real samples ──
const assetURL = (p: string): string => { try { return new URL(p, document.baseURI).href; } catch { return p; } };
type SampleKey = "chip" | "deal" | "shuffle";
const SAMPLE_SRC: Record<SampleKey, string> = {
  chip: assetURL("sounds/chip.mp3"),
  deal: assetURL("sounds/deal.mp3"),
  shuffle: assetURL("sounds/shuffle.mp3"),
};
const buffers: Partial<Record<SampleKey, AudioBuffer>> = {};
const loading: Partial<Record<SampleKey, boolean>> = {};

function loadSample(c: AudioContext, key: SampleKey): void {
  if (buffers[key] || loading[key] || typeof fetch === "undefined") return;
  loading[key] = true;
  fetch(SAMPLE_SRC[key])
    .then((r) => r.arrayBuffer())
    .then((ab) => c.decodeAudioData(ab))
    .then((buf) => { buffers[key] = buf; })
    .catch(() => { /* fall back to synth */ })
    .finally(() => { loading[key] = false; });
}
function preloadSamples(): void { const c = ac(); if (!c) return; (Object.keys(SAMPLE_SRC) as SampleKey[]).forEach((k) => loadSample(c, k)); }

// Play a decoded sample with pitch + gain jitter; returns false if not ready yet.
function sample(key: SampleKey, opts: { gain?: number; rate?: number; jitter?: number; at?: number } = {}): boolean {
  const c = ac(); if (!c) return false;
  const buf = buffers[key];
  if (!buf) { loadSample(c, key); return false; }
  const t0 = c.currentTime + (opts.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  const j = opts.jitter ?? 0.06;
  src.playbackRate.value = (opts.rate ?? 1) * (1 - j + Math.random() * j * 2);
  const g = c.createGain();
  g.gain.value = opts.gain ?? 0.9;
  src.connect(g); g.connect(master(c));
  src.start(t0);
  return true;
}

// iOS unlock — first gesture resumes the context, plays a silent buffer, AND kicks
// off sample preloading.
function installAudioUnlock(): void {
  if (typeof document === "undefined") return;
  const events: (keyof DocumentEventMap)[] = ["pointerdown", "touchend", "mousedown", "keydown"];
  const onGesture = (): void => {
    const c = ac();
    if (!c) { cleanup(); return; }
    try { const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch { /* */ }
    preloadSamples();
    void c.resume().then(() => { if (c.state === "running") cleanup(); });
  };
  const cleanup = (): void => { events.forEach((e) => document.removeEventListener(e, onGesture)); };
  events.forEach((e) => document.addEventListener(e, onGesture, { passive: true }));
}
installAudioUnlock();

// ── synth fallbacks (also used for knocks / win body) ──
function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 1.0);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf; return buf;
}
function clack(at: number, freq: number, q: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c); src.playbackRate.value = 0.8 + Math.random() * 0.5;
  const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq * (0.95 + Math.random() * 0.1); f.Q.value = q;
  const g = c.createGain(); const d = durMs / 1000;
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.0007); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(f); f.connect(g); g.connect(master(c)); src.start(t0); src.stop(t0 + d + 0.02);
}
function ringTone(at: number, base: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return; const t0 = c.currentTime + at;
  [1, 1.41, 1.93].forEach((r, i) => {
    const o = c.createOscillator(); o.type = i === 0 ? "triangle" : "sine"; o.frequency.value = base * r * (0.99 + Math.random() * 0.02);
    const g = c.createGain(); const peak = gain * Math.pow(0.4, i); const d = (durMs / 1000) * (1 - i * 0.2);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.0015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(master(c)); o.start(t0); o.stop(t0 + d + 0.02);
  });
}
function swoosh(at: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return; const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c); src.playbackRate.value = 0.9 + Math.random() * 0.4;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.7; hp.frequency.setValueAtTime(800, t0); hp.frequency.exponentialRampToValueAtTime(4600, t0 + (durMs / 1000) * 0.7);
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7800;
  const g = c.createGain(); const d = durMs / 1000;
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.007); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master(c)); src.start(t0); src.stop(t0 + d + 0.03);
}
function thud(at: number, gain: number): void {
  const c = ac(); if (!c) return; const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c);
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 300; f.Q.value = 0.9;
  const g = c.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  src.connect(f); f.connect(g); g.connect(master(c)); src.start(t0); src.stop(t0 + 0.12);
  const o = c.createOscillator(); o.type = "sine"; o.frequency.value = 88;
  const g2 = c.createGain(); g2.gain.setValueAtTime(0, t0); g2.gain.linearRampToValueAtTime(gain * 0.55, t0 + 0.004); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
  o.connect(g2); g2.connect(master(c)); o.start(t0); o.stop(t0 + 0.15);
}
function tone(freq: number, durMs: number, gain = 0.05, at = 0): void {
  const c = ac(); if (!c) return; const t0 = c.currentTime + at;
  const osc = c.createOscillator(); const g = c.createGain(); osc.type = "sine"; osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g); g.connect(master(c)); osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
}
const synthChip = (at = 0, gain = 0.2): void => { clack(at, 2300 + Math.random() * 700, 1.6, 30, gain); ringTone(at + 0.001, 3000 + Math.random() * 900, 80, gain * 0.4); };
const synthCard = (at = 0, gain = 0.18): void => { swoosh(at, 95, gain * 0.9); clack(at + 0.072, 1300, 0.9, 20, gain * 0.28); };

// Sample-with-synth-fallback helpers.
const chipHit = (gain: number, rate = 1, at = 0): void => { if (!sample("chip", { gain, rate, jitter: 0.1, at })) synthChip(at, gain); };
const cardHit = (gain: number, rate = 1, at = 0): void => { if (!sample("deal", { gain, rate, jitter: 0.07, at })) synthCard(at, gain); };

export type SoundName = "deal" | "card" | "check" | "bet" | "fold" | "win" | "lose" | "turn" | "shuffle" | "chip";

export function playSound(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case "shuffle": if (!sample("shuffle", { gain: 0.85 })) { for (let i = 0; i < 14; i++) swoosh(i * 0.024, 32, 0.07); } break;
    case "deal": for (let i = 0; i < 4; i++) cardHit(0.5, 0.98 + i * 0.015, i * 0.13); break; // cards out around the table
    case "card": cardHit(0.85, 0.97 + Math.random() * 0.08); break;
    case "fold": cardHit(0.5, 1.12); break; // quick toss
    case "chip": case "bet": for (let i = 0; i < 3; i++) chipHit(0.7 - i * 0.14, 0.92 + Math.random() * 0.14, i * 0.06); break; // chips in
    case "turn": chipHit(0.5, 1.05); tone(740, 120, 0.03, 0.03); break;
    case "win": for (let i = 0; i < 4; i++) chipHit(0.7 - i * 0.1, 0.9 + Math.random() * 0.2, i * 0.09); tone(170, 340, 0.05, 0.05); tone(255, 320, 0.035, 0.09); break; // rake the pot
    case "check": thud(0, 0.22); thud(0.13, 0.17); break; // two knuckle raps
    case "lose": thud(0, 0.22); tone(135, 280, 0.05, 0.05); break;
  }
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  if (on) { preloadSamples(); playSound("chip"); }
}

export function isSoundEnabled(): boolean { return enabled; }
