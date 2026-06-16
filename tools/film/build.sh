#!/bin/bash
# Render the MonteCarlo Edge welcome film end-to-end from scene.html.
#
#   ./build.sh            # full render → welcome.mp4
#   ./build.sh probe      # just the key frames into ./probe/ to eyeball
#
# Requires: node + `npm i puppeteer-core`, a local Chrome, and ffmpeg with libx264.
# (If your default ffmpeg lacks libx264, set FF, e.g.
#   FF=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg ./build.sh )
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
FF="${FF:-ffmpeg}"
MODE="${1:-full}"

if [ "$MODE" = "probe" ]; then
  node "$DIR/cap.js" probe
  exit 0
fi

# 1) render 792 deterministic frames (30fps × 26.4s)
node "$DIR/cap.js" full

# 2) encode frames + mux the approved Mark voiceover + score → 1280×720 H.264
"$FF" -y -framerate 30 -i "$DIR/frames/f%04d.png" -i "$DIR/audio/mix3.m4a" \
  -vf "scale=1280:720:flags=lanczos,format=yuv420p" \
  -map 0:v -map 1:a -t 26.4 \
  -c:v libx264 -crf 19 -preset slow -profile:v high -movflags +faststart \
  -c:a aac -b:a 160k "$DIR/welcome.mp4"

# 3) poster (the product-hero equity frame)
"$FF" -y -ss 8.6 -i "$DIR/welcome.mp4" -frames:v 1 -q:v 3 "$DIR/welcome.jpg"

echo "built $DIR/welcome.mp4 (+ welcome.jpg)"
echo "ship: cp welcome.mp4 welcome.jpg ../../public/textures/  &&  bump public/sw.js CACHE  &&  vite build + firebase deploy --only hosting"
