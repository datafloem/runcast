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

# Checks the newest video of selftest and keeps it and three frames as <label>.
check_video() {
  local label="$1"
  local VIDEO=tests/recording/videos/selftest.mp4
  ffprobe -v error -show_entries stream=codec_type,width,height,duration -of compact "$VIDEO"
  ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$VIDEO" | grep -q audio
  # The recording logged its spans and the render reported the narration fit.
  node -e 'const e=require(process.argv[1]); if(!e.spans?.length) throw new Error("no spans in events.json")' "$PWD/tests/recording/.captures/selftest/capture/events.json"
  test -s tests/recording/.captures/selftest/render-report.json
  mkdir -p "$OUT/$label"
  cp "$VIDEO" "$OUT/$label/"
  for t in 1 4 8; do ffmpeg -v error -y -ss "$t" -i "$VIDEO" -frames:v 1 "$OUT/$label/frame-$t.png"; done
}

step "Video mode, screen capture (Linux: Xvfb + x11grab; macOS: screen capture)"
REC_CAPTURE=screen $REC video selftest
step "Check the screen-capture video"
check_video screen

step "Video mode, tab capture (headless Chrome, no display needed)"
REC_CAPTURE=tab $REC video selftest
step "Check the tab-capture video"
check_video tab
# The tab is recorded at REC_SCALE (2): 2880x1620 for the 1440x810 page.
node -e 'const e=require(process.argv[1]); if(e.video.width!==2880||e.video.height!==1620) throw new Error(`tab capture is ${e.video.width}x${e.video.height}`)' "$PWD/tests/recording/.captures/selftest/capture/events.json"

cp -r tests/recording/videos "$OUT/"
cp -r tests/recording/.results "$OUT/results"
cp -r tests/recording/.captures "$OUT/captures"
echo; echo "Linux self-test passed. Output in $OUT"
