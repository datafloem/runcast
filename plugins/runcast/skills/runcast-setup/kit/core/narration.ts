// Voice-over for a scenario: one text segment per step, spoken by a TTS model
// (ElevenLabs), mixed into the video at the time its step starts.
//
// Kept free of other lib/ imports: scripts/narration.ts runs this file directly
// with Node (type stripping), outside Playwright.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface NarrationSegment {
  /** The step id it is spoken over (see the scenario's steps). */
  step: string;
  /** What the voice says. Plain sentences; see the skill for the writing rules. */
  text: string;
  /** Real length of the audio, filled by `node tests/recording/.kit/cli.ts narration measure|generate`. */
  durationMs?: number | null;
  /** Audio file, relative to the recording folder. */
  audio?: string | null;
  /** Hash of the text the audio was made from: a changed text needs new audio. */
  audioTextHash?: string | null;
}

export interface NarrationScript {
  /** ISO 639-1, e.g. "tr". */
  language: string;
  /** Speaking rate used to estimate lengths before audio exists. */
  wordsPerMinute: number;
  /** Silence after each segment before the next step may start. */
  gapMs: number;
  voice: {
    provider: "elevenlabs";
    /** ElevenLabs voice id; ELEVENLABS_VOICE_ID overrides it. */
    voiceId?: string;
    modelId: string;
    /** 0.7–1.2, default 1.0. Change wordsPerMinute with it. */
    speed?: number;
    stability?: number;
    similarityBoost?: number;
  };
  segments: Array<NarrationSegment>;
}

/** The recording folder a scenario belongs to: scenarios/<name>.spec.ts -> its parent. */
export function projectDirOf(specFile: string): string {
  return path.resolve(path.dirname(specFile), "..");
}

/** scenarios/demo.spec.ts -> scenarios/demo.narration.json */
export function narrationPathFor(specFile: string): string {
  return specFile.replace(/\.spec\.ts$/, ".narration.json");
}

/** Where a scenario's audio files go: <recording folder>/narration/<scenario>/ */
export function audioDirFor(specFile: string): string {
  return path.join(
    projectDirOf(specFile),
    "narration",
    path.basename(specFile, ".spec.ts"),
  );
}

/** 01-login.mp3: numbered like the steps, so the folder reads in order. */
export function audioFileName(
  index: number,
  step: string,
  ext = "mp3",
): string {
  return `${String(index + 1).padStart(2, "0")}-${step}.${ext}`;
}

export function loadNarration(specFile: string): NarrationScript | null {
  const file = narrationPathFor(specFile);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as NarrationScript;
}

export function saveNarration(specFile: string, script: NarrationScript): void {
  writeFileSync(
    narrationPathFor(specFile),
    `${JSON.stringify(script, null, 2)}\n`,
  );
}

export function textHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** Words, without markup such as <break time="1s" />. */
export function wordCount(text: string): number {
  return text
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Length from the speaking rate, plus any <break time="…s" /> tags. */
export function estimateMs(text: string, wordsPerMinute: number): number {
  const speech = (wordCount(text) / wordsPerMinute) * 60_000;
  const breaks = [...text.matchAll(/<break\s+time="([\d.]+)s"\s*\/>/g)].reduce(
    (sum, match) => sum + Number(match[1]) * 1000,
    0,
  );
  return Math.round(speech + breaks);
}

/** The measured length when audio exists for the current text, else the estimate. */
export function segmentLength(
  segment: NarrationSegment,
  script: NarrationScript,
): { ms: number; measured: boolean } {
  const measured =
    typeof segment.durationMs === "number" &&
    segment.audioTextHash === textHash(segment.text);
  return measured
    ? { ms: segment.durationMs ?? 0, measured: true }
    : { ms: estimateMs(segment.text, script.wordsPerMinute), measured: false };
}

/**
 * What each narrated step needs when rendering: how long the step must last
 * (the segment's measured length, else its estimate, plus the gap) and the
 * audio to mix in (only when it was made from the current text). Title-card
 * segments ("intro", "outro") are left out.
 */
export function stepVoices(
  script: NarrationScript,
): Map<string, { ms: number; audio: string | null }> {
  const voices = new Map<string, { ms: number; audio: string | null }>();
  for (const segment of script.segments) {
    if (segment.step === "intro" || segment.step === "outro") continue;
    const { ms, measured } = segmentLength(segment, script);
    voices.set(segment.step, {
      ms: ms + script.gapMs,
      audio: measured ? (segment.audio ?? null) : null,
    });
  }
  return voices;
}
