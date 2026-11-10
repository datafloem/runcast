import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stepVoices,
  textHash,
  type NarrationScript,
} from "../core/narration.ts";

const script = (audioTextHash: string): NarrationScript => ({
  language: "en",
  wordsPerMinute: 120,
  gapMs: 400,
  voice: { provider: "elevenlabs", modelId: "eleven_multilingual_v2" },
  segments: [
    { step: "intro", text: "Welcome", audio: "i.mp3", durationMs: 500, audioTextHash: textHash("Welcome") },
    { step: "a", text: "one two", audio: "x.mp3", durationMs: 900, audioTextHash },
  ],
});

test("stepVoices uses estimates for length but no audio", () => {
  const stale = stepVoices(script("stale"));
  assert.deepEqual(stale.get("a"), { ms: 1400, audio: null });
  const fresh = stepVoices(script(textHash("one two")));
  assert.deepEqual(fresh.get("a"), { ms: 1300, audio: "x.mp3" });
  assert.equal(fresh.has("intro"), false);
});
