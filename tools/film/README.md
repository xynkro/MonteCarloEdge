# Welcome film pipeline

The Apple-style intro film at `public/textures/welcome.mp4` (the home "▶ Watch the film"
button + the new-user landing) is **not** edited in a video app — it's a deterministic
web motion scene, rendered frame-by-frame and muxed with the voiceover. That means every
change re-renders from code in one command; no manual re-editing.

## Files
- `scene.html` — the entire film. A pure `window.render(t)` sets every element's
  transform / opacity / blur for any timestamp `t` (hand-rolled expo/back easing — no
  GSAP, no `requestAnimationFrame`, so it's frame-perfect and seekable). Kinetic SF-Pro
  typography + a recreated MCEdge product-hero table (equity counting up, the gold
  `RAISE 3.5×` GTO pill, math bars) over a dark cinematic backdrop with grain + bokeh.
- `cap.js` — headless-Chrome renderer (puppeteer-core). Seeks `render(t)` to each frame
  time and screenshots. `node cap.js probe` = key frames to eyeball; `node cap.js full`
  = all 792 frames (30fps × 26.4s) → `frames/`.
- `build.sh` — runs the full render, then ffmpeg-encodes + muxes the audio → `welcome.mp4`.
- `audio/mix3.m4a` — the final muxed voiceover + score (Mark, ~10% sped up) that the film
  is timed to. `audio/vo10.wav` — the voiceover **alone** (used for re-timing, below).

## Render
```bash
cd tools/film
npm i puppeteer-core            # one-time; uses your system Chrome
./build.sh                      # → welcome.mp4 (+ welcome.jpg poster)
# ship:
cp welcome.mp4 welcome.jpg ../../public/textures/
# then bump public/sw.js CACHE, `BUILD=1 npx vite build`, firebase deploy --only hosting
```
If your default ffmpeg lacks libx264: `FF=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg ./build.sh`.

## Editing the cut
All timing + copy lives in `scene.html`:
- `TEXT[]` — the full-screen kinetic type beats `{s: start, o: out, sz, g: gold?, lines}`.
- `LOWER[]` — the product-act lower captions ("LIVE · IN YOUR HAND", "PROVES ITS MATH").
- the product table (board cards, equity count target `73.4`, the `RAISE 3.5×` pill text)
  and the outro wordmark are inline in the markup; the per-beat motion is in `render(t)`.

## Re-timing to the voiceover (important)
The beats must land **on the spoken word**. The back half once drifted up to ~3s late.
To realign after any VO change, transcribe the VO with word timestamps and match each
scene `t` to when the word is actually said:
```bash
whisper audio/vo10.wav --model base --language en --word_timestamps True --output_format json
# then read the segment start times and edit the s:/o: values in scene.html to match.
```
The current VO script + onsets (for reference):
`0.0` Every hand, someone has the edge · `2.7` Now, it's you · `4.0` MonteCarlo Edge reads
the table like a solver · `7.3` your equity, the pot odds, your opponent's range · `10.6`
live in your hand · `12.1` Train against an engine that proves its own math · `15.4` Then
take it online · `17.1` No charts to memorize, no guessing · `19.7` Just the edge at every
table · `22.3` MonteCarlo Edge, play the player, own the table.
