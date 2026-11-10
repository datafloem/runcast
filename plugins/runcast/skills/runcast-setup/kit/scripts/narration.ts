// Voice-over tools for a scenario's narration file (scenarios/<name>.narration.json).
//
//   node <recording folder>/.kit/cli.ts narration plan <scenario>       fit report: step lengths vs. narration
//   node <recording folder>/.kit/cli.ts narration measure <scenario>    lengths of audio files you made yourself
//   node <recording folder>/.kit/cli.ts narration generate <scenario>   make the audio with ElevenLabs
//   node <recording folder>/.kit/cli.ts narration script <scenario>     one text to paste into ElevenLabs
//   node <recording folder>/.kit/cli.ts narration split <scenario>      cut that one audio file into segments
//
// <scenario> is the start of a file name in scenarios/ ("demo", "login").
// Runs with plain Node (type stripping), outside Playwright.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  audioDirFor,
  audioFileName,
  estimateMs,
  loadNarration,
  saveNarration,
  segmentLength,
  textHash,
  wordCount,
  type NarrationScript,
} from "../core/narration.ts";
import { findCaptures, kitCommand, loadProject } from "../core/project.ts";
import { naturalMap, stepStartMs, type Span } from "./video/timemap.ts";
import { clipEndMs } from "./video/voice-edges.ts";

// Also loads the project's .env.local (ElevenLabs key and voice).
const PROJECT_DIR = (await loadProject()).dir;
const KIT_CMD = kitCommand(PROJECT_DIR);
const RECORDING_DIR = PROJECT_DIR;

const [command, name, ...flags] = process.argv.slice(2);
const usage = `Usage: ${KIT_CMD} narration <plan|measure|generate|script|split> <scenario> [--force] [--only=<step>]`;

if (!command || !name) fail(usage);
const specFile = findSpec(name);
const script = loadNarration(specFile);
if (!script) {
  fail(
    `${path.basename(specFile)} has no narration file: ${path.relative(process.cwd(), specFile.replace(/\.spec\.ts$/, ".narration.json"))}`,
  );
}

const only = flags
  .find((f) => f.startsWith("--only="))
  ?.slice("--only=".length);
const force = flags.includes("--force");

/** A step this much longer than its voice is flagged (the render flags it too). */
const LONG_SILENCE_MS = 5000;

/** Pause between segments in the one-take text; longer than any in-sentence pause. */
const SPLIT_BREAK_S = 1.5;
const FULL_TEXT = "full-text.txt";
const FULL_AUDIO = ["full.mp3", "full.m4a", "full.wav", "full.aiff"];

switch (command) {
  case "plan":
    plan(script);
    break;
  case "measure":
    measure(script);
    reportRate(script);
    break;
  case "generate":
    await generate(script);
    reportRate(script);
    break;
  case "script":
    writeFullText(script);
    break;
  case "split":
    split(script);
    reportRate(script);
    break;
  default:
    fail(usage);
}

// --- script / split ---------------------------------------------------------
//
// For voices the API cannot use (e.g. library voices on a free plan): the
// whole narration is made in one go in the ElevenLabs web app, with a pause
// between segments, then cut back into one file per segment at the pauses
// that end each segment's last sentence. One take also keeps the tone even across segments.

/** Writes narration/<scenario>/full-text.txt: the segments joined with break tags. */
function writeFullText(script: NarrationScript): void {
  const dir = audioDirFor(specFile);
  mkdirSync(dir, { recursive: true });
  const text = script.segments
    .map((segment) => segment.text)
    .join(`\n\n<break time="${SPLIT_BREAK_S}s" />\n\n`);
  const file = path.join(dir, FULL_TEXT);
  writeFileSync(file, `${text}\n`);
  console.log(
    `${path.relative(process.cwd(), file)} (${text.length} characters)`,
  );
  console.log(
    `ElevenLabs > Text to Speech: generate it in one take with ${script.voice.modelId}, ` +
      `save the download in the same folder as full.mp3, then: ${KIT_CMD} narration split ${name}`,
  );
}

/**
 * Cuts narration/<scenario>/full.* into NN-<step>.m4a at the pauses that
 * match the segments' sentence ends (alignSentences), then measures them. Uses ffmpeg.
 */
function split(script: NarrationScript): void {
  const dir = audioDirFor(specFile);
  const input = FULL_AUDIO.map((f) => path.join(dir, f)).find((f) =>
    existsSync(f),
  );
  if (!input)
    fail(`No single-take audio: ${path.relative(process.cwd(), dir)}/full.mp3`);

  const rate = 44100;
  const tmp = path.join(dir, ".split");
  mkdirSync(tmp, { recursive: true });
  const decoded = path.join(tmp, "full.wav");
  // Mono 16-bit PCM at `rate`, for the pause detection below.
  ffmpeg([
    "-i",
    input,
    "-ac",
    "1",
    "-ar",
    String(rate),
    "-c:a",
    "pcm_s16le",
    decoded,
  ]);
  const pcm = wavSamples(readFileSync(decoded));

  // Loudness per 10 ms frame; "silent" is 40 dB under the loudest frame.
  const frame = rate / 100;
  const levels: Array<number> = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
    levels.push(Math.sqrt(sum / frame));
  }
  const floor = Math.max(...levels) * 0.01;
  const loud = levels.map((level) => level > floor);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) fail("The audio file is silent.");

  // Pauses between speech (200 ms or longer). ElevenLabs does not always keep
  // the break tags, so segment ends are not simply the longest pauses.
  const runs: Array<{ start: number; end: number }> = [];
  for (let i = first; i <= last; i++) {
    if (loud[i]) continue;
    const start = i;
    while (i <= last && !loud[i]) i++;
    if (i - start >= 20) runs.push({ start, end: i });
  }
  const segmentEnds = alignSentences(script, runs, first, last + 1);
  const cuts = segmentEnds.map((r) => runs[r]);
  const shortest = Math.min(...cuts.map((c) => c.end - c.start)) * 10;

  // Each piece keeps 80 ms of quiet around its speech.
  const pad = 8;
  const bounds = script.segments.map((_, i) => ({
    start: Math.max(0, (i === 0 ? first : cuts[i - 1].end) - pad),
    end: Math.min(
      levels.length,
      (i === cuts.length ? last + 1 : cuts[i].start) + pad,
    ),
  }));
  script.segments.forEach((segment, i) => {
    const base = audioFileName(i, segment.step, "").slice(0, -1);
    // An older file of the same segment would win in `measure`.
    for (const ext of ["mp3", "wav", "aiff"]) {
      const stale = path.join(dir, `${base}.${ext}`);
      if (existsSync(stale)) unlinkSync(stale);
    }
    const piece = path.join(tmp, `${base}.wav`);
    const { start, end } = bounds[i];
    writeFileSync(
      piece,
      wavFile(pcm.subarray(start * frame, end * frame), rate),
    );
    ffmpeg([
      "-i",
      piece,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      path.join(dir, `${base}.m4a`),
    ]);
  });
  rmSync(tmp, { recursive: true, force: true });
  console.log(
    `${path.basename(input)} → ${script.segments.length} segments (shortest pause ${shortest} ms)`,
  );
  measure(script);

  // A piece far from its text's expected length means a cut in the wrong place.
  const odd = script.segments.filter((segment) => {
    const ratio =
      (segment.durationMs ?? 0) /
      estimateMs(segment.text, script.wordsPerMinute);
    return ratio < 0.5 || ratio > 2;
  });
  if (odd.length) {
    console.warn(
      `Warning: segments whose length does not match their text (may be cut in the wrong place): ${odd.map((s) => s.step).join(", ")}`,
    );
  }
}

/**
 * Finds where each segment ends in the one-take audio. Every sentence must end
 * at a pause, and sentences take time in proportion to their length; picks the
 * pauses (one per sentence boundary, in order) that fit those lengths best,
 * preferring longer pauses. Returns, per segment boundary, the index of its run.
 */
function alignSentences(
  script: NarrationScript,
  runs: Array<{ start: number; end: number }>,
  from: number,
  to: number,
): Array<number> {
  const sentences = script.segments.flatMap((segment, owner) =>
    segment.text
      .replace(/<break[^>]*>/g, "")
      .trim()
      .split(/(?<=[.!?])\s+/)
      .map((text) => ({ owner, weight: text.length + 8 })),
  );
  const cutsNeeded = sentences.length - 1;
  if (runs.length < cutsNeeded) {
    fail(
      `${sentences.length} sentences need at least ${cutsNeeded} pauses; the audio has ${runs.length}. ` +
        "Does the audio contain the whole text?",
    );
  }
  const total = sentences.reduce((sum, s) => sum + s.weight, 0);
  const expected = sentences.map((s) => (s.weight / total) * (to - from));
  const fit = (length: number, k: number) =>
    Math.log(length / expected[k]) ** 2;
  const bonus = (r: number) =>
    0.3 * Math.log((runs[r].end - runs[r].start) / 20);

  // cost[k][j]: best cost when the k-th sentence ends at pause j.
  const cost = Array.from({ length: cutsNeeded }, () =>
    runs.map(() => Infinity),
  );
  const prev = Array.from({ length: cutsNeeded }, () => runs.map(() => -1));
  runs.forEach((run, j) => {
    if (run.start > from) cost[0][j] = fit(run.start - from, 0) - bonus(j);
  });
  for (let k = 1; k < cutsNeeded; k++) {
    for (let j = k; j < runs.length; j++) {
      for (let p = k - 1; p < j; p++) {
        if (cost[k - 1][p] === Infinity) continue;
        const c =
          cost[k - 1][p] + fit(runs[j].start - runs[p].end, k) - bonus(j);
        if (c < cost[k][j]) {
          cost[k][j] = c;
          prev[k][j] = p;
        }
      }
    }
  }
  let best = Infinity;
  let end = -1;
  runs.forEach((run, j) => {
    const c = cost[cutsNeeded - 1][j] + fit(to - run.end, cutsNeeded);
    if (to > run.end && c < best) {
      best = c;
      end = j;
    }
  });
  const sentenceEnds: Array<number> = [];
  for (let k = cutsNeeded - 1; k >= 0; k--) {
    sentenceEnds.unshift(end);
    end = prev[k][end];
  }
  // A segment ends where its last sentence ends.
  return sentenceEnds.filter(
    (_, k) => sentences[k + 1].owner !== sentences[k].owner,
  );
}

/** 16-bit mono PCM samples of a WAV file (the first "data" chunk). */
function wavSamples(buffer: Buffer): Int16Array {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const data = buffer.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(
        data.buffer.slice(
          data.byteOffset,
          data.byteOffset + (data.length & ~1),
        ),
      );
    }
    offset += 8 + size + (size & 1);
  }
  fail("The WAV file has no audio data.");
}

/** A 16-bit mono WAV file. */
function wavFile(samples: Int16Array, rate: number): Buffer {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([
    header,
    Buffer.from(samples.buffer, samples.byteOffset, bytes),
  ]);
}

// --- plan -------------------------------------------------------------------

/**
 * Compares each segment with how long its step takes on its own (from the
 * newest video capture, else the newest rehearsal) and with its word budget
 * at the speaking rate.
 */
function plan(script: NarrationScript): void {
  const lastRun = lastStepTimes(path.basename(specFile, ".spec.ts"));
  console.log(
    lastRun
      ? `Step times: ${path.relative(process.cwd(), lastRun.file)}`
      : "No step times yet: record a video " +
          `(${KIT_CMD} video ${name}) or run a rehearsal (${KIT_CMD} rehearsal ${name}).`,
  );
  console.log("");
  const rows = script.segments.map((segment, i) => {
    const { ms, measured } = segmentLength(segment, script);
    const natural = lastRun?.byId.get(segment.step);
    const budgetWords = natural
      ? Math.floor(((natural - script.gapMs) / 60_000) * script.wordsPerMinute)
      : undefined;
    let fit = "—";
    if (segment.step === "intro" || segment.step === "outro") {
      fit = "over its card; the card stretches to the audio";
    } else if (natural !== undefined) {
      const diff = ms + script.gapMs - natural;
      fit =
        diff > 0
          ? `step held ${(diff / 1000).toFixed(1)} s longer`
          : -diff > LONG_SILENCE_MS
            ? `${(-diff / 1000).toFixed(1)} s silence: long silence, lengthen the text to the budget or trim the step`
            : `${(-diff / 1000).toFixed(1)} s silence`;
    }
    return [
      String(i + 1),
      segment.step,
      natural !== undefined ? `${(natural / 1000).toFixed(1)} s` : "—",
      `${(ms / 1000).toFixed(1)} s ${measured ? "(audio)" : "(estimate)"}`,
      `${wordCount(segment.text)}${budgetWords !== undefined ? ` / ${budgetWords}` : ""}`,
      fit,
    ];
  });
  printTable(
    ["#", "Step", "Step on its own", "Narration", "Words / budget", "Result"],
    rows,
  );
  const total = script.segments.reduce(
    (sum, s) => sum + segmentLength(s, script).ms + script.gapMs,
    0,
  );
  console.log(
    `\nShortest video with narration: ~${(total / 1000).toFixed(0)} s`,
  );
}

/**
 * Step id -> the step's own length (ms). From the newest video capture of
 * this scenario (.captures/<scenario>/), at the pace the video plays it (its
 * time map without narration); else (no video, or one from before the time
 * map) from the newest rehearsal's steps.json.
 */
function lastStepTimes(
  scenario: string,
): { file: string; byId: Map<string, number> } | null {
  const runsIn = (dirs: Array<string>) =>
    dirs
      .filter((dir) => existsSync(path.join(dir, "steps.json")))
      .map((dir) => ({
        dir,
        steps: JSON.parse(
          readFileSync(path.join(dir, "steps.json"), "utf-8"),
        ) as StepsFile,
        mtime: statSync(path.join(dir, "steps.json")).mtimeMs,
      }))
      .filter(({ steps }) => steps.scenario === scenario)
      .sort((a, b) => b.mtime - a.mtime);

  const video = runsIn(
    findCaptures(RECORDING_DIR).map((capture) => path.dirname(capture)),
  ).at(0);
  if (video) {
    const file = path.join(video.dir, "capture", "events.json");
    const capture = JSON.parse(readFileSync(file, "utf-8")) as CaptureTimes;
    const map = naturalMap(
      capture.spans ?? [],
      capture.durationMs,
      capture.cuts,
    );
    const marks = video.steps.steps;
    const byId = new Map<string, number>();
    marks.forEach((mark, i) => {
      // Older captures timed steps to their narration: not their own length.
      if (!mark.id || mark.narration) return;
      const next = marks[i + 1];
      const end = next ? map.toOut(stepStartMs(next)) : map.outMs;
      byId.set(mark.id, Math.round(end - map.toOut(stepStartMs(mark))));
    });
    // A video from before the time map (steps timed to their narration)
    // gives no lengths: the rehearsal's are better than none.
    if (byId.size > 0) return { file, byId };
  }

  const results = path.join(RECORDING_DIR, ".results");
  const newest = existsSync(results)
    ? runsIn(readdirSync(results).map((dir) => path.join(results, dir))).at(0)
    : undefined;
  if (!newest) return null;
  const byId = new Map<string, number>();
  for (const mark of newest.steps.steps) {
    // A step timed to a narration ran padded: not its own length.
    if (mark.id && mark.durationMs !== undefined && !mark.narration) {
      byId.set(mark.id, mark.durationMs);
    }
  }
  return { file: path.join(newest.dir, "steps.json"), byId };
}

interface StepsFile {
  scenario: string;
  steps: Array<{
    id?: string;
    seconds: number;
    startMs?: number;
    durationMs?: number;
    narration?: unknown;
  }>;
}

interface CaptureTimes {
  durationMs: number;
  spans?: Array<Span>;
  cuts?: Array<{ at: number; ms: number }>;
}

// --- measure ----------------------------------------------------------------

/** Reads the length of each segment's audio file and stores it. */
function measure(script: NarrationScript): void {
  const dir = audioDirFor(specFile);
  script.segments.forEach((segment, i) => {
    if (only && segment.step !== only) return;
    const base = audioFileName(i, segment.step, "").slice(0, -1);
    const file = ["mp3", "wav", "m4a", "aiff"]
      .map((ext) => path.join(dir, `${base}.${ext}`))
      .find((candidate) => existsSync(candidate));
    if (!file) {
      console.log(
        `${segment.step}: no audio file (${path.relative(process.cwd(), path.join(dir, base))}.mp3)`,
      );
      return;
    }
    segment.durationMs = playedMs(file, audioLengthMs(file));
    segment.audio = path.relative(RECORDING_DIR, file);
    segment.audioTextHash = textHash(segment.text);
    console.log(`${segment.step}: ${(segment.durationMs / 1000).toFixed(2)} s`);
  });
  saveNarration(specFile, script);
}

/** Runs ffmpeg quietly, overwriting the output. */
/**
 * The voice's real speaking rate, from the segments that have audio for their
 * current text. Estimates (plan, word budgets) use wordsPerMinute, so suggest
 * it when the two differ: voices and languages vary a lot.
 */
function reportRate(script: NarrationScript): void {
  let words = 0;
  let ms = 0;
  for (const segment of script.segments) {
    const length = segmentLength(segment, script);
    if (!length.measured) continue;
    words += wordCount(segment.text);
    ms += length.ms;
  }
  if (words === 0 || ms === 0) return;
  const rate = Math.round(words / (ms / 60_000));
  const off = Math.abs(rate - script.wordsPerMinute) / script.wordsPerMinute;
  console.log(
    off > 0.1
      ? `\nSpeaking rate: ~${rate} words/min measured; the file says ${script.wordsPerMinute}. ` +
          `Set "wordsPerMinute": ${rate} in ${path.basename(specFile, ".spec.ts")}.narration.json for better estimates.`
      : `\nSpeaking rate: ~${rate} words/min (matches wordsPerMinute).`,
  );
}

function ffmpeg(args: Array<string>): void {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    fail(`ffmpeg failed (is it installed?): ${stderr || String(error)}`);
  }
}

/**
 * How much of a clip the render plays: up to a stray start of the next
 * text at its end (voice-edges.ts), else all of it. Needs ffmpeg; without
 * it, the whole length.
 */
function playedMs(file: string, lengthMs: number): number {
  try {
    return Math.min(lengthMs, clipEndMs(file));
  } catch {
    return lengthMs;
  }
}

/** Audio length via afinfo (macOS) or ffprobe. */
function audioLengthMs(file: string): number {
  try {
    const out = execFileSync("afinfo", [file], { encoding: "utf-8" });
    const match = /estimated duration: ([\d.]+) sec/.exec(out);
    if (match) return Math.round(Number(match[1]) * 1000);
  } catch {
    // not macOS: try ffprobe
  }
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        file,
      ],
      { encoding: "utf-8" },
    );
    return Math.round(Number(out.trim()) * 1000);
  } catch {
    fail(
      `Could not read the audio length of ${file}. Needs afinfo (macOS) or ffprobe.`,
    );
  }
}

// --- generate ---------------------------------------------------------------

/**
 * Makes each segment's audio with ElevenLabs (with-timestamps, so the length
 * is known exactly), passing the neighbouring segments as context so the
 * voice flows across clips. Skips segments whose text has not changed.
 */
async function generate(script: NarrationScript): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? script.voice.voiceId;
  if (!apiKey)
    fail(
      `ELEVENLABS_API_KEY is not set: add it to ${path.relative(process.cwd(), path.join(PROJECT_DIR, ".env.local"))}.`,
    );
  if (!voiceId)
    fail(
      "No voice chosen: set ELEVENLABS_VOICE_ID or voice.voiceId in the narration file.",
    );

  const dir = audioDirFor(specFile);
  mkdirSync(dir, { recursive: true });

  for (const [i, segment] of script.segments.entries()) {
    if (only && segment.step !== only) continue;
    const file = path.join(dir, audioFileName(i, segment.step));
    const hash = textHash(segment.text);
    if (!force && segment.audioTextHash === hash && existsSync(file)) {
      console.log(`${segment.step}: unchanged, skipped`);
      continue;
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: segment.text,
          model_id: script.voice.modelId,
          previous_text: script.segments[i - 1]?.text ?? null,
          next_text: script.segments[i + 1]?.text ?? null,
          voice_settings: {
            speed: script.voice.speed ?? 1,
            ...(script.voice.stability !== undefined && {
              stability: script.voice.stability,
            }),
            ...(script.voice.similarityBoost !== undefined && {
              similarity_boost: script.voice.similarityBoost,
            }),
          },
        }),
      },
    );
    if (!response.ok)
      fail(
        `${segment.step}: ElevenLabs ${response.status} ${await response.text()}`,
      );

    const result = (await response.json()) as {
      audio_base64: string;
      alignment: { character_end_times_seconds: Array<number> } | null;
    };
    writeFileSync(file, Buffer.from(result.audio_base64, "base64"));

    let durationMs: number;
    try {
      durationMs = playedMs(file, audioLengthMs(file));
    } catch {
      const ends = result.alignment?.character_end_times_seconds ?? [];
      durationMs = Math.round((ends.at(-1) ?? 0) * 1000);
    }
    segment.durationMs = durationMs;
    segment.audio = path.relative(RECORDING_DIR, file);
    segment.audioTextHash = hash;
    saveNarration(specFile, script); // after each clip, so a failure keeps what was made
    const estimate = estimateMs(segment.text, script.wordsPerMinute);
    console.log(
      `${segment.step}: ${(durationMs / 1000).toFixed(2)} s (estimate ${(estimate / 1000).toFixed(1)} s) -> ${path.relative(process.cwd(), file)}`,
    );
  }
}

// --- helpers ----------------------------------------------------------------

function findSpec(prefix: string): string {
  const dir = path.join(RECORDING_DIR, "scenarios");
  const matches = readdirSync(dir).filter(
    (f) => f.endsWith(".spec.ts") && f.startsWith(prefix),
  );
  if (matches.length !== 1) {
    const all = readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    fail(
      `"${prefix}" ${matches.length === 0 ? "matches no scenario" : "matches several scenarios"}. Scenarios: ${all.join(", ")}`,
    );
  }
  return path.join(dir, matches.join(""));
}

function printTable(header: Array<string>, rows: Array<Array<string>>): void {
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const line = (cells: Array<string>) =>
    cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((row) => console.log(line(row)));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
