// Scenes added at render time (steps.scene): before the time map is built,
// each placeholder in a take gets its scene's current length and beats, so
// a changed or swapped scene needs no new take. Pure, no kit imports: plain
// Node runs this file.

export interface PlaceholderLog {
  t: number;
  name: string;
  duration: number;
  beats: Array<{ id: string; at: number }>;
  in: string;
  out: string;
  hash: string;
  /** The scene step's id and title (its beats are steps "<id>.<beat id>"). */
  step?: string;
  title?: string;
}

/** A scene as its own capture has it now. */
export interface SceneNow {
  duration: number;
  beats: Array<{ id: string; at: number }>;
  /** Where the scene starts on its capture's clock. */
  startMs: number;
}

interface Timed {
  t: number;
}
interface TakeEvents {
  durationMs: number;
  pointer: Array<Timed>;
  focus: Array<{ t: number; until: number }>;
  navigations?: Array<number>;
  spans?: Array<{ from: number; to: number; kind: string; outMs: number; scene?: string; fileFrom?: number }>;
  dialogs?: Array<Timed>;
  downloads?: Array<Timed>;
  sources?: Array<Timed>;
  carries?: Array<{ from: number; to: number }>;
  scenes?: Array<PlaceholderLog>;
}
interface StepMark {
  id?: string;
  seconds: number;
  startMs?: number;
  title: string;
}

/**
 * The take with every placeholder at its scene's current length: times after
 * a scene move by the difference, its beat marks are rebuilt from the
 * current beats, and its span plays from the scene capture's start. Scenes
 * missing from `now` keep what was logged.
 */
export function applyScenes<C extends TakeEvents, S extends StepMark>(
  capture: C,
  steps: Array<S>,
  now: Map<string, SceneNow>,
): { capture: C; steps: Array<S> } {
  let events = structuredClone(capture);
  let marks = steps.map((s) => ({ ...s }));
  const placeholders = [...(events.scenes ?? [])].sort((a, b) => a.t - b.t);
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = (events.scenes ?? []).find(
      (p) => p.name === placeholders[i]!.name && p.t === placeholders[i]!.t,
    ) ?? placeholders[i]!;
    const scene = now.get(placeholder.name);
    if (!scene) continue;
    const start = placeholder.t;
    const oldEnd = start + placeholder.duration;
    const delta = scene.duration - placeholder.duration;
    const later = (t: number) => (t >= oldEnd ? t + delta : t);

    events = {
      ...events,
      durationMs: events.durationMs + delta,
      pointer: events.pointer.map((p) => ({ ...p, t: later(p.t) })),
      focus: events.focus.map((f) => ({ ...f, t: later(f.t), until: later(f.until) })),
      navigations: events.navigations?.map(later),
      dialogs: events.dialogs?.map((d) => ({ ...d, t: later(d.t) })),
      downloads: events.downloads?.map((d) => ({ ...d, t: later(d.t) })),
      sources: events.sources?.map((s) => ({ ...s, t: later(s.t) })),
      carries: events.carries?.map((c) => ({ ...c, from: later(c.from), to: later(c.to) })),
      spans: events.spans?.map((s) =>
        s.kind === "scene" && s.from === start && s.scene === placeholder.name
          ? { ...s, to: start + scene.duration, outMs: scene.duration, fileFrom: scene.startMs }
          : { ...s, from: later(s.from), to: later(s.to) },
      ),
      scenes: events.scenes?.map((p) =>
        p === placeholder
          ? { ...p, duration: scene.duration, beats: scene.beats }
          : { ...p, t: later(p.t) },
      ),
    };
    // Its beats as the scene has them now; every later step moves.
    const prefix = placeholder.step ? `${placeholder.step}.` : null;
    const isBeat = (m: S) =>
      prefix !== null && (m.id ?? "").startsWith(prefix) && (m.startMs ?? m.seconds * 1000) >= start - 1 &&
      (m.startMs ?? m.seconds * 1000) < oldEnd;
    const kept = marks.filter((m) => !isBeat(m));
    const template = marks.find(isBeat);
    const beats = prefix
      ? scene.beats.map((beat) => {
          const ms = start + beat.at;
          return {
            ...(template ?? ({} as S)),
            id: `${prefix}${beat.id}`,
            title: `${placeholder.title ?? placeholder.step} › ${beat.id}`,
            startMs: ms,
            seconds: Math.round(ms / 100) / 10,
          } as S;
        })
      : [];
    marks = [
      ...kept.map((m) => {
        const ms = m.startMs ?? m.seconds * 1000;
        if (ms < oldEnd) return m;
        return { ...m, startMs: ms + delta, seconds: Math.round((ms + delta) / 100) / 10 };
      }),
      ...beats,
    ].sort((a, b) => (a.startMs ?? a.seconds * 1000) - (b.startMs ?? b.seconds * 1000));
  }
  return { capture: events, steps: marks };
}
