// The video's clock against the recording's. Recording runs fast (viewer
// pauses and cursor travel are not spent in real time) and logs spans: what
// each stretch was and how long it should last in the video. A time map lays
// those out on the video's clock, then fits each step to its narration.
//
// Three clocks:
// - rec:  the capture clock of events.json and steps.json (off-camera time
//         left out);
// - file: the screen recording's own time (off-camera time included);
// - out:  the video (title cards not included).
//
// Pure functions, no kit imports: plain Node runs this file.

export type SpanKind = "move" | "aim" | "hold" | "type" | "cut" | "dialog";

/** A logged stretch of the recording (core/capture-log.ts). */
export interface Span {
  from: number;
  to: number;
  kind: SpanKind;
  /** How long it lasts in the video. */
  outMs: number;
  /** "cut" only: screen-file time left out (an off-camera step). */
  skipMs?: number;
}

/**
 * - wait: app time between spans, 1:1 unless shortened;
 * - freeze: one frame held (recFrom === recTo);
 * - dialog: a held frame the renderer draws a browser dialog over;
 * - cut: no video time (an off-camera step, or the middle of a long wait).
 */
export type SegmentKind = SpanKind | "wait" | "freeze";

/** Which captured tab a stretch of video shows (tab capture: the app or the stage). */
export type Source = "app" | "stage";
export type SourceTransition = "fade" | "slide" | "cube" | "cut" | "lift";

/** From `t` (capture clock) on the video shows `source`, reached by `transition` (core/capture-log.ts). */
export interface SourceSwitch {
  t: number;
  source: Source;
  transition: SourceTransition;
}

export interface Segment {
  kind: SegmentKind;
  recFrom: number;
  recTo: number;
  fileFrom: number;
  fileTo: number;
  outFrom: number;
  outTo: number;
  /** The tab it shows (its own file and file clock). */
  source: Source;
  /** How the video got to this source (used where the source changes). */
  via?: SourceTransition;
}

export interface TimeMap {
  segments: Array<Segment>;
  /** Length of the video (cards not included). */
  outMs: number;
  /** Screen-file time to show at video time `outMs`. */
  toRec(outMs: number): number;
  /** Video time of an event at capture-clock time `recMs` (a freeze point maps to its end). */
  toOut(recMs: number): number;
  /** Video times of the cuts, where the renderer cross-fades. */
  cutsOut: Array<number>;
  /** The tab shown at video time `outMs`. */
  sourceAt(outMs: number): Source;
  /** Where the video changes tab, and how. */
  switchesOut: Array<{ at: number; from: Source; to: Source; transition: SourceTransition }>;
}

/** The map that plays every span at its natural length and app waits 1:1. */
export function naturalMap(
  spans: Array<Span>,
  durationMs: number,
  legacyCuts: Array<{ at: number; ms: number }> = [],
  switches: Array<SourceSwitch> = [],
): TimeMap {
  const all: Array<Span> = [
    ...spans,
    ...legacyCuts.map((cut) => ({
      from: cut.at,
      to: cut.at,
      kind: "cut" as const,
      outMs: 0,
      skipMs: cut.ms,
    })),
  ].sort(
    // A cut at the same time as a span's start comes before it.
    (a, b) => a.from - b.from || cutFirst(a) - cutFirst(b),
  );

  const segments: Array<Segment> = [];
  let skipped = 0;
  const push = (
    kind: SegmentKind,
    recFrom: number,
    recTo: number,
    outLength: number,
    skipMs = 0,
  ) => {
    segments.push({
      kind,
      recFrom,
      recTo,
      fileFrom: recFrom + skipped,
      fileTo: recTo + skipped + skipMs,
      outFrom: 0,
      outTo: outLength,
      source: "app",
    });
    skipped += skipMs;
  };

  let cursor = 0;
  for (const span of all) {
    const from = Math.max(span.from, cursor);
    if (from > cursor) push("wait", cursor, from, from - cursor);
    if (span.kind === "cut") {
      push("cut", from, from, 0, span.skipMs ?? 0);
      cursor = from;
      continue;
    }
    if (span.kind === "dialog") {
      // The page waits for the answer: its frame is held while the dialog shows.
      push("dialog", from, from, Math.max(0, span.outMs));
      cursor = from;
      continue;
    }
    const to = Math.max(span.to, from);
    if (span.kind === "hold" || span.kind === "aim") {
      // Its head plays at real speed (an animation finishing); the rest is held.
      if (to > from) push(span.kind, from, to, to - from);
      const held = span.outMs - (to - from);
      if (held > 0) push("freeze", to, to, held);
    } else if (to > from) {
      push(span.kind, from, to, Math.max(0, span.outMs));
    }
    cursor = to;
  }
  if (durationMs > cursor) push("wait", cursor, durationMs, durationMs - cursor);
  return mapFromSegments(withSources(segments, switches));
}

/**
 * Splits segments at the source switches and tags each with its tab. A held
 * frame exactly at a switch still shows the tab before it.
 */
function withSources(segments: Array<Segment>, switches: Array<SourceSwitch>): Array<Segment> {
  if (switches.length === 0) return segments;
  const sorted = [...switches].sort((a, b) => a.t - b.t);
  const split = splitAt(segments, sorted.map((s) => s.t));
  const switchAt = (t: number, strict: boolean) => {
    let found: SourceSwitch | undefined;
    for (const s of sorted) if (strict ? s.t < t : s.t <= t) found = s;
    return found;
  };
  return split.map((segment) => {
    const at =
      segment.recTo > segment.recFrom
        ? switchAt((segment.recFrom + segment.recTo) / 2, false)
        : switchAt(segment.recFrom, true);
    return at ? { ...segment, source: at.source, via: at.transition } : segment;
  });
}

/**
 * Lays segments out on the video clock in order, each keeping its own video
 * length (outTo - outFrom); rec and file times are kept.
 */
export function mapFromSegments(input: Array<Segment>): TimeMap {
  let out = 0;
  const segments = input.map((segment) => {
    const length = Math.max(0, segment.outTo - segment.outFrom);
    const placed = { ...segment, outFrom: out, outTo: out + length };
    out += length;
    return placed;
  });
  const outMs = out;

  /** The last segment whose `key` start is at or before t. */
  const lastFrom = (key: "outFrom" | "recFrom", t: number) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]![key] <= t) return segments[i];
    }
    return segments[0];
  };

  const switchesOut: TimeMap["switchesOut"] = [];
  for (let i = 1; i < segments.length; i++) {
    const before = segments[i - 1]!;
    const after = segments[i]!;
    if (after.source !== before.source) {
      switchesOut.push({
        at: after.outFrom,
        from: before.source,
        to: after.source,
        transition: after.via ?? "cut",
      });
    }
  }

  return {
    segments,
    outMs,
    switchesOut,
    sourceAt(t) {
      return lastFrom("outFrom", t)?.source ?? "app";
    },
    cutsOut: segments.filter((s) => s.kind === "cut").map((s) => s.outFrom),
    toRec(t) {
      const s = lastFrom("outFrom", t);
      if (!s) return t;
      const length = s.outTo - s.outFrom;
      if (length <= 0) return s.fileTo;
      const p = Math.min(1, Math.max(0, (t - s.outFrom) / length));
      return s.fileFrom + p * (s.fileTo - s.fileFrom);
    },
    toOut(t) {
      const s = lastFrom("recFrom", t);
      if (!s) return t;
      const length = s.recTo - s.recFrom;
      if (length <= 0) return s.outTo;
      const p = Math.min(1, Math.max(0, (t - s.recFrom) / length));
      return s.outFrom + p * (s.outTo - s.outFrom);
    },
  };
}

/** How a step was fitted to its narration (the render report). */
export interface StepFit {
  index: number;
  id?: string;
  /** The step's length on the natural map. */
  naturalMs: number;
  /** What the step must last (audio + gap); null without a segment. */
  voiceMs: number | null;
  /** Held frame added at the step's end. */
  freezeMs: number;
  /** Taken out of app waits. */
  shortenedMs: number;
  /** Left after the voice ends. */
  silenceMs: number;
}

/** Every shortened wait keeps at least this much video. */
const MIN_WAIT_MS = 600;
/** Faster than this, a wait's middle is cut instead (fast-forward looks jittery). */
const MAX_SPEEDUP = 4;
/** A step start this close to an off-camera cut starts at the cut (0.1 s rounding plus marking delay). */
const CUT_SNAP_MS = 120;

/**
 * Fits each step to its narration, in order. A voice longer than its step
 * holds the step's last frame; a step longer than its voice loses time from
 * its app waits (when `compressWaits`), never from spans.
 */
export function fitNarration(
  map: TimeMap,
  steps: Array<{ id?: string; startMs: number }>,
  /** Step id -> what the step must last (audio + gap). */
  voices: Map<string, number>,
  options: {
    compressWaits: boolean;
    /** false: a shortened wait loses its middle, never plays faster (app audio). Default true. */
    speedUpWaits?: boolean;
  },
): { map: TimeMap; report: Array<StepFit> } {
  // A step after an off-camera step is marked a moment after the cut, and
  // steps.json rounds it to 0.1 s: it starts at the cut.
  const offCameraCuts = map.segments
    .filter((s) => s.kind === "cut" && s.recFrom === s.recTo)
    .map((s) => s.recFrom);
  const starts = steps.map((step) => {
    const cut = offCameraCuts.find(
      (at) => Math.abs(at - step.startMs) <= CUT_SNAP_MS,
    );
    return cut ?? step.startMs;
  });
  const segments = splitAt(map.segments, starts);

  // Segments grouped by the step they belong to (-1: before the first step).
  const groups = new Map<number, Array<Segment>>();
  const order: Array<number> = [];
  for (const segment of segments) {
    const owner = ownerOf(segment, starts);
    if (!groups.has(owner)) {
      groups.set(owner, []);
      order.push(owner);
    }
    groups.get(owner)!.push(segment);
  }

  const report: Array<StepFit> = steps.map((step, index) => {
    const group = groups.get(index) ?? [];
    const naturalMs = group.reduce((sum, s) => sum + outLength(s), 0);
    const voice = step.id === undefined ? undefined : voices.get(step.id);
    const fit: StepFit = {
      index,
      ...(step.id === undefined ? {} : { id: step.id }),
      naturalMs,
      voiceMs: voice ?? null,
      freezeMs: 0,
      shortenedMs: 0,
      silenceMs: 0,
    };
    if (voice === undefined) return fit;

    if (voice > naturalMs) {
      const last = group.at(-1);
      const at = last?.recTo ?? starts[index]!;
      const file = last?.fileTo ?? at;
      group.push({
        kind: "freeze",
        recFrom: at,
        recTo: at,
        fileFrom: file,
        fileTo: file,
        outFrom: 0,
        outTo: voice - naturalMs,
        source: last?.source ?? "app",
        ...(last?.via ? { via: last.via } : {}),
      });
      fit.freezeMs = voice - naturalMs;
      return fit;
    }

    let excess = naturalMs - voice;
    if (options.compressWaits) {
      const waits = group
        .filter((s) => s.kind === "wait")
        .sort((a, b) => outLength(b) - outLength(a));
      for (const wait of waits) {
        if (excess <= 0) break;
        const length = outLength(wait);
        const cut = Math.min(excess, length - MIN_WAIT_MS);
        if (cut <= 0) continue;
        const replacement = shorten(
          wait,
          length - cut,
          options.speedUpWaits === false ? 1 : MAX_SPEEDUP,
        );
        group.splice(group.indexOf(wait), 1, ...replacement);
        excess -= cut;
        fit.shortenedMs += cut;
      }
    }
    fit.silenceMs = excess;
    return fit;
  });

  return {
    map: mapFromSegments(order.flatMap((owner) => groups.get(owner)!)),
    report,
  };
}

/** A wait shown in `target` ms: sped up, or its middle cut when that would be faster than `maxSpeedup`. */
function shorten(wait: Segment, target: number, maxSpeedup: number): Array<Segment> {
  const recLength = wait.recTo - wait.recFrom;
  if (recLength / target <= maxSpeedup) {
    return [{ ...wait, outFrom: 0, outTo: target }];
  }
  const half = target / 2;
  const fileAt = (rec: number) => wait.fileFrom + (rec - wait.recFrom);
  const headEnd = wait.recFrom + half;
  const tailStart = wait.recTo - half;
  return [
    { ...wait, recTo: headEnd, fileTo: fileAt(headEnd), outFrom: 0, outTo: half },
    {
      ...wait,
      kind: "cut",
      recFrom: headEnd,
      recTo: tailStart,
      fileFrom: fileAt(headEnd),
      fileTo: fileAt(tailStart),
      outFrom: 0,
      outTo: 0,
    },
    { ...wait, recFrom: tailStart, fileFrom: fileAt(tailStart), outFrom: 0, outTo: half },
  ];
}

/** Splits segments that run across a step start, proportionally. */
function splitAt(segments: Array<Segment>, starts: Array<number>): Array<Segment> {
  let result = segments.map((s) => ({ ...s }));
  for (const at of starts) {
    result = result.flatMap((s) => {
      if (!(s.recFrom < at && at < s.recTo)) return [s];
      const p = (at - s.recFrom) / (s.recTo - s.recFrom);
      const file = s.fileFrom + p * (s.fileTo - s.fileFrom);
      const length = outLength(s);
      return [
        { ...s, recTo: at, fileTo: file, outFrom: 0, outTo: length * p },
        { ...s, recFrom: at, fileFrom: file, outFrom: 0, outTo: length * (1 - p) },
      ];
    });
  }
  return result;
}

/**
 * The step a segment belongs to. A freeze at a step start ends the step
 * before (it was that step's hold); a cut there belongs to the next one.
 */
function ownerOf(segment: Segment, starts: Array<number>): number {
  const lastAtOrBefore = (t: number, strict: boolean) => {
    for (let i = starts.length - 1; i >= 0; i--) {
      if (strict ? starts[i]! < t : starts[i]! <= t) return i;
    }
    return -1;
  };
  if (segment.recTo > segment.recFrom) {
    return lastAtOrBefore((segment.recFrom + segment.recTo) / 2, false);
  }
  if (segment.kind === "freeze" || segment.kind === "dialog") {
    const before = lastAtOrBefore(segment.recFrom, true);
    return before >= 0 ? before : lastAtOrBefore(segment.recFrom, false);
  }
  return lastAtOrBefore(segment.recFrom, false);
}

/** A stretch of the recording's sound placed in the video (app audio). */
export interface AudioPiece {
  /** Screen-file time it plays from and to. */
  fileFrom: number;
  fileTo: number;
  /** Where it starts in the video. */
  outFrom: number;
  /** Faded in / out (100 ms) because silence or a cut is next to it. */
  fadeIn: boolean;
  fadeOut: boolean;
}

/** Shorter than this, a stretch is left out of the sound. */
const MIN_AUDIO_MS = 1;

/**
 * The app's sound along the video: only segments shown at real speed play
 * (sound cannot be stretched); held frames, stretched spans and sped-up
 * waits are silent. Pieces that follow on in both the file and the video
 * join into one; every edge next to silence or a cut fades.
 */
export function audioPlan(map: TimeMap): Array<AudioPiece> {
  const pieces: Array<AudioPiece> = [];
  for (const segment of map.segments) {
    const out = outLength(segment);
    const file = segment.fileTo - segment.fileFrom;
    // The stage tab has no sound.
    if (segment.source !== "app") continue;
    if (out < MIN_AUDIO_MS || Math.abs(file - out) > 1) continue;
    const last = pieces.at(-1);
    if (
      last &&
      Math.abs(last.fileTo - segment.fileFrom) <= 1 &&
      Math.abs(last.outFrom + (last.fileTo - last.fileFrom) - segment.outFrom) <= 1
    ) {
      last.fileTo = segment.fileTo;
      continue;
    }
    pieces.push({
      fileFrom: segment.fileFrom,
      fileTo: segment.fileTo,
      outFrom: segment.outFrom,
      fadeIn: segment.outFrom > 0,
      fadeOut: true,
    });
  }
  const last = pieces.at(-1);
  if (last && last.outFrom + (last.fileTo - last.fileFrom) >= map.outMs - 1) {
    last.fadeOut = false;
  }
  return pieces;
}

function outLength(segment: Segment): number {
  return segment.outTo - segment.outFrom;
}

function cutFirst(span: Span): number {
  return span.kind === "cut" ? 0 : 1;
}

/** Moves a capture's logged events from the capture clock to the video's. */
export function retimeCapture<
  P extends { t: number },
  F extends { t: number; until: number },
>(
  map: TimeMap,
  events: { pointer: Array<P>; focus: Array<F>; navigations: Array<number> },
): { pointer: Array<P>; focus: Array<F>; navigations: Array<number> } {
  return {
    pointer: events.pointer.map((p) => ({ ...p, t: map.toOut(p.t) })),
    focus: events.focus.map((f) => ({
      ...f,
      t: map.toOut(f.t),
      until: map.toOut(f.until),
    })),
    navigations: events.navigations.map((t) => map.toOut(t)),
  };
}
