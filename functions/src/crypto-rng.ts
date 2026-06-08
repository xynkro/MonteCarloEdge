import { randomInt } from "node:crypto";
import type { Rng } from "../../src/engine/rng.js";

// A cryptographically-secure Rng for server-side dealing. mp-engine's shuffle()
// draws an index per swap as `Math.floor(rng() * (i+1))`, so every swap pulls an
// INDEPENDENT, unpredictable value from the OS CSPRNG — there is no seedable
// 32-bit state a watcher could brute-force from observed showdown cards.
// (mulberry32/rng.ts stays trainer-only; functions never seed a PRNG.)
export const cryptoRng: Rng = () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;
