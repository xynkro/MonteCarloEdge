// Web Audio foley — synthesized to sound like REAL felt-table play, not chiptune.
//   chips  = a sharp contact "clack" + a faint inharmonic ceramic ring (clay-chip clink)
//   cards  = a filtered-noise friction "swoosh" with a rising highpass (card on felt)
//   shuffle= a fast riffle of swooshes;  pot rake = a settling cascade of chip clinks
//   knocks = low felt thuds.  Everything runs through a master compressor so it sounds
// "produced" (glued, no harsh clipping) rather than a stack of raw beeps.

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
    // iOS 16.4+: route through the "playback" session so audio plays even when the
    // hardware ring/silent switch is on. Harmless / ignored on other browsers.
    try { (navigator as unknown as { audioSession?: { type: string } }).audioSession!.type = "playback"; } catch { /* unsupported */ }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Master chain: everything → gain → soft compressor → speakers (glue + headroom).
function master(c: AudioContext): AudioNode {
  if (!masterIn || (masterIn.context !== c)) {
    masterIn = c.createGain();
    masterIn.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3.2; comp.attack.value = 0.003; comp.release.value = 0.14;
    masterIn.connect(comp); comp.connect(c.destination);
  }
  return masterIn;
}

// iOS/Safari only START audio inside a user gesture. Install a one-time unlock on
// the first tap/click anywhere: create + resume the context and play a silent buffer
// (the canonical iOS unlock). Without it the context stays suspended → total silence.
function installAudioUnlock(): void {
  if (typeof document === "undefined") return;
  const events: (keyof DocumentEventMap)[] = ["pointerdown", "touchend", "mousedown", "keydown"];
  const onGesture = (): void => {
    const c = ac();
    if (!c) { cleanup(); return; }
    try {
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch { /* ignore */ }
    void c.resume().then(() => { if (c.state === "running") cleanup(); });
  };
  const cleanup = (): void => { events.forEach((e) => document.removeEventListener(e, onGesture)); };
  events.forEach((e) => document.addEventListener(e, onGesture, { passive: true }));
}
installAudioUnlock();

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 1.0);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

// ── foley primitives ──

// Sharp filtered-noise transient — the hard CONTACT of a chip / card landing.
function clack(at: number, freq: number, q: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c);
  src.playbackRate.value = 0.8 + Math.random() * 0.5;
  const f = c.createBiquadFilter();
  f.type = "bandpass"; f.frequency.value = freq * (0.95 + Math.random() * 0.1); f.Q.value = q;
  const g = c.createGain();
  const d = durMs / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.0007); // near-instant attack = a crisp click
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(f); f.connect(g); g.connect(master(c));
  src.start(t0); src.stop(t0 + d + 0.02);
}

// Inharmonic decaying partials — the faint ceramic/clay RING that gives a chip its
// "tink" (inharmonic ratios + fast decay = chip, not a musical note).
function ringTone(at: number, base: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const ratios = [1, 1.41, 1.93];
  ratios.forEach((r, i) => {
    const o = c.createOscillator();
    o.type = i === 0 ? "triangle" : "sine";
    o.frequency.value = base * r * (0.99 + Math.random() * 0.02);
    const g = c.createGain();
    const peak = gain * Math.pow(0.4, i);
    const d = (durMs / 1000) * (1 - i * 0.2);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(master(c));
    o.start(t0); o.stop(t0 + d + 0.02);
  });
}

// Card friction "swoosh" — noise with a rising highpass + gentle lowpass (a card
// sliding across felt: "ffft"), soft attack so it isn't a click.
function swoosh(at: number, durMs: number, gain: number): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c);
  src.playbackRate.value = 0.9 + Math.random() * 0.4;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.7;
  hp.frequency.setValueAtTime(800, t0);
  hp.frequency.exponentialRampToValueAtTime(4600, t0 + (durMs / 1000) * 0.7);
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7800;
  const g = c.createGain();
  const d = durMs / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.007);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master(c));
  src.start(t0); src.stop(t0 + d + 0.03);
}

// Low felt thud — a knuckle rap (check) or a muted loss.
function thud(at: number, gain: number): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const src = c.createBufferSource(); src.buffer = noise(c);
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 300; f.Q.value = 0.9;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  src.connect(f); f.connect(g); g.connect(master(c));
  src.start(t0); src.stop(t0 + 0.12);
  const o = c.createOscillator(); o.type = "sine"; o.frequency.value = 88;
  const g2 = c.createGain();
  g2.gain.setValueAtTime(0, t0); g2.gain.linearRampToValueAtTime(gain * 0.55, t0 + 0.004);
  g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
  o.connect(g2); g2.connect(master(c)); o.start(t0); o.stop(t0 + 0.15);
}

// Warm sine body — used sparingly under wins/notifications, never melody.
function tone(freq: number, durMs: number, gain = 0.05, at = 0): void {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine"; osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g); g.connect(master(c));
  osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
}

// ── composed sounds ──
const chip = (at = 0, gain = 0.2): void => {
  clack(at, 2300 + Math.random() * 700, 1.6, 30, gain);       // contact
  ringTone(at + 0.001, 3000 + Math.random() * 900, 80, gain * 0.4); // ceramic ring
};
const card = (at = 0, gain = 0.18): void => {
  swoosh(at, 95 + Math.random() * 30, gain * 0.9);            // friction across felt
  clack(at + 0.072, 1300, 0.9, 20, gain * 0.28);             // soft landing
};

export type SoundName = "deal" | "card" | "check" | "bet" | "fold" | "win" | "lose" | "turn" | "shuffle" | "chip";

export function playSound(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case "shuffle": // riffle bridge — a fast run of card swooshes
      for (let i = 0; i < 16; i++) swoosh(i * 0.022, 32, 0.07);
      break;
    case "deal": // dealing cards out — several quick flicks
      for (let i = 0; i < 6; i++) card(i * 0.085, 0.15);
      break;
    case "card": card(0, 0.2); break;
    case "check": thud(0, 0.22); thud(0.13, 0.17); break; // two knuckle raps
    case "chip":
    case "bet": // chips dropped / pushed in — a clatter that accelerates then settles
      for (let i = 0; i < 6; i++) chip(i * (0.05 - i * 0.004) + Math.random() * 0.008, 0.17 - i * 0.012);
      break;
    case "fold": card(0, 0.16); card(0.06, 0.12); break; // two cards tossed
    case "turn": chip(0, 0.15); tone(740, 120, 0.03, 0.03); break; // your action
    case "win": // raking the pot — a long settling chip cascade + warm low body
      for (let i = 0; i < 16; i++) chip(i * (0.038 + Math.random() * 0.012), Math.max(0.06, 0.16 - i * 0.005));
      tone(170, 340, 0.05, 0.02); tone(255, 320, 0.035, 0.06);
      break;
    case "lose": thud(0, 0.22); tone(135, 280, 0.05, 0.05); break; // muted thud
  }
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  if (on) playSound("chip");
}

export function isSoundEnabled(): boolean { return enabled; }
