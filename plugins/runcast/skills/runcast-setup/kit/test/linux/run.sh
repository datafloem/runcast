#!/usr/bin/env bash
# Runs inside the container (see Dockerfile). Every step must pass.
# APP_DIR / PLUGIN_DIR / OUT let it run outside the container too (e.g. macOS).
set -euo pipefail
cd "${APP_DIR:-/app}"
PLUGIN="${PLUGIN_DIR:-/plugin}"
KIT="$PLUGIN/skills/runcast-setup/kit"
TEST="$KIT/test/linux"
OUT="${OUT:-/out}"
mkdir -p "$OUT"

step() { echo; echo "=== $*"; }

step "Sample app on :4173"
node "$TEST/serve.ts" "$TEST/site" 4173 &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1

step "Set up a fresh project with the kit's CLI"
node "$KIT/cli.ts" setup --dir tests/recording --name "Sample App" --base-url http://localhost:4173
REC="node tests/recording/.kit/cli.ts"
printf 'APP_USERNAME=demo\nAPP_PASSWORD=demo-password\n' > tests/recording/.env.local
cp "$TEST/selftest.spec.ts.tmpl" tests/recording/scenarios/selftest.spec.ts
cp "$TEST/selftest.narration.json" tests/recording/scenarios/

step "Narration: synthetic single take, split with ffmpeg"
# Three tones (stand-ins for speech), 1.5 s of silence between them.
mkdir -p tests/recording/narration/selftest
ffmpeg -v error -y \
  -f lavfi -i "sine=frequency=330:duration=2.2" \
  -f lavfi -i "anullsrc=r=44100:cl=mono:d=1.5" \
  -f lavfi -i "sine=frequency=440:duration=2.6" \
  -f lavfi -i "anullsrc=r=44100:cl=mono:d=1.5" \
  -f lavfi -i "sine=frequency=550:duration=1.8" \
  -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1" \
  tests/recording/narration/selftest/full.wav
$REC narration split selftest
ls tests/recording/narration/selftest

step "Test mode (headless)"
$REC test

step "Video mode (Linux: Xvfb + x11grab; macOS: screen capture)"
$REC video selftest

step "Check the video"
VIDEO=tests/recording/videos/selftest.mp4
ffprobe -v error -show_entries stream=codec_type,width,height,duration -of compact "$VIDEO"
ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$VIDEO" | grep -q audio
for t in 1 4 8; do ffmpeg -v error -y -ss "$t" -i "$VIDEO" -frames:v 1 "$OUT/frame-$t.png"; done

cp -r tests/recording/videos "$OUT/"
cp -r tests/recording/.results "$OUT/results"
echo; echo "Linux self-test passed. Output in $OUT"
