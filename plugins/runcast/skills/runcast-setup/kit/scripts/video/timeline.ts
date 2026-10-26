// Pure timing maths for the renderer: where the camera looks and where the
// cursor is at any moment, from a capture's events (lib/video-capture.ts).
// No I/O here, so it is easy to test and to tune.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Focus {
  t: number;
  until: number;
  kind: "click" | "double-click" | "right-click" | "hover" | "type" | "drag";
  x: number;
  y: number;
  box?: Box;
}

export interface PointerSample {
  t: number;
  x: number;
  y: number;
  kind: "move" | "down" | "up";
}

/** Camera: zoom factor (1 = whole page) and the page point at the centre. */
export interface Camera {
  zoom: number;
  cx: number;
  cy: number;
}

export interface CameraOptions {
  /** Never closer than this. */
  maxZoom: number;
  /** A framing that would zoom less than this stays at the full page. */
  minZoom: number;
  /** Room around a scene's actions, as a share of their extent (and at least minMarginPx). */
  margin: number;
  minMarginPx: number;
  /** A quiet spell this long ends a scene (a page change always does). */
  sceneGapMs: number;
  /** Scenes shorter than this are not worth a camera move. */
  minSceneMs: number;
  /** The camera arrives this long before a scene's first action. */
  leadMs: number;
  /** It stays this long after the scene's last action. */
  holdMs: number;
  /** Duration of each camera move. */
  moveMs: number;
}

export const defaultCameraOptions: CameraOptions = {
  maxZoom: 1.5,
  minZoom: 1.15,
  margin: 0.35,
  minMarginPx: 140,
  sceneGapMs: 3500,
  minSceneMs: 2000,
  leadMs: 300,
  holdMs: 1200,
  moveMs: 1000,
};

interface Keyframe extends Camera {
  t: number;
}

interface Scene {
  start: number;
  end: number;
  framing: Camera;
}

/**
 * Turns focus events into a calm camera: actions on the same page without a
 * long pause between them form a scene; the camera frames the whole scene
 * once (all its actions in view) and holds still while it plays. Between
 * scenes it moves once — to the next framing, or back to the full page.
 * Short scenes, and scenes spread over most of the page, are not zoomed.
 */
export function buildCameraTrack(
  focus: Array<Focus>,
  viewport: { width: number; height: number },
  options: CameraOptions = defaultCameraOptions,
  /** Page changes: a scene never spans one, and ends soon after it. */
  navigations: Array<number> = [],
): Array<Keyframe> {
  const home: Camera = {
    zoom: 1,
    cx: viewport.width / 2,
    cy: viewport.height / 2,
  };
  const scenes = buildScenes(focus, viewport, options, navigations, home);
  const keyframes: Array<Keyframe> = [{ t: 0, ...home }];

  const moveTo = (camera: Camera, arriveAt: number) => {
    const last = keyframes.at(-1) ?? { t: 0, ...home };
    if (sameFraming(last, camera)) return;
    const arrive = Math.max(arriveAt, last.t + options.moveMs * 0.6);
    const leave = Math.max(last.t, arrive - options.moveMs);
    if (leave > last.t) keyframes.push({ ...cameraOf(last), t: leave });
    keyframes.push({ ...camera, t: arrive });
  };

  scenes.forEach((scene, i) => {
    moveTo(scene.framing, scene.start - options.leadMs);
    const next = scenes.at(i + 1);
    // A page change right after the scene: let go soon after it.
    const navigation = navigations.find(
      (n) => n >= scene.end && n < scene.end + options.holdMs,
    );
    const release =
      navigation !== undefined ? navigation + 250 : scene.end + options.holdMs;
    // The next scene starts soon: go straight there instead of out and in again.
    if (next && next.start - options.leadMs - release < options.moveMs) return;
    const last = keyframes.at(-1) ?? { t: 0, ...home };
    if (release > last.t) keyframes.push({ ...cameraOf(last), t: release });
    moveTo(home, release + options.moveMs);
  });
  return keyframes;
}

/** Splits actions into scenes and frames each one. */
function buildScenes(
  focus: Array<Focus>,
  viewport: { width: number; height: number },
  options: CameraOptions,
  navigations: Array<number>,
  home: Camera,
): Array<Scene> {
  const sorted = [...focus].sort((a, b) => a.t - b.t);
  const groups: Array<Array<Focus>> = [];
  for (const f of sorted) {
    const current = groups.at(-1);
    const lastEnd = current
      ? Math.max(...current.map((c) => c.until))
      : -Infinity;
    const pageChanged = navigations.some((n) => n > lastEnd && n <= f.t);
    if (current && !pageChanged && f.t - lastEnd < options.sceneGapMs)
      current.push(f);
    else groups.push([f]);
  }

  return groups.map((group) => {
    const start = Math.min(...group.map((f) => f.t));
    const end = Math.max(...group.map((f) => f.until));
    if (end - start < options.minSceneMs) return { start, end, framing: home };
    return {
      start,
      end,
      framing: frameActions(group, viewport, options, home),
    };
  });
}

/** The framing that keeps every action of a scene in view, with room around. */
function frameActions(
  group: Array<Focus>,
  viewport: { width: number; height: number },
  options: CameraOptions,
  home: Camera,
): Camera {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const f of group) {
    // A typed-in field counts whole; anything else by the point acted on.
    const area =
      f.kind === "type" && f.box
        ? f.box
        : { x: f.x, y: f.y, width: 0, height: 0 };
    left = Math.min(left, area.x);
    top = Math.min(top, area.y);
    right = Math.max(right, area.x + area.width);
    bottom = Math.max(bottom, area.y + area.height);
  }
  const width = right - left;
  const height = bottom - top;
  const padX = Math.max(options.minMarginPx, width * options.margin);
  const padY = Math.max(options.minMarginPx, height * options.margin);
  const zoom = Math.min(
    options.maxZoom,
    viewport.width / (width + padX * 2),
    viewport.height / (height + padY * 2),
  );
  if (zoom < options.minZoom) return home;
  return clampCamera(
    { zoom, cx: left + width / 2, cy: top + height / 2 },
    viewport,
  );
}

function cameraOf(k: Camera): Camera {
  return { zoom: k.zoom, cx: k.cx, cy: k.cy };
}

function sameFraming(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.zoom - b.zoom) < 0.02 &&
    Math.abs(a.cx - b.cx) < 4 &&
    Math.abs(a.cy - b.cy) < 4
  );
}

/** The camera at time t, eased between keyframes and kept inside the page. */
export function cameraAtTime(
  track: Array<Keyframe>,
  t: number,
  viewport: { width: number; height: number },
): Camera {
  const next = track.findIndex((k) => k.t > t);
  let camera: Camera;
  if (next === -1) camera = track.at(-1) ?? { zoom: 1, cx: 0, cy: 0 };
  else if (next === 0) camera = track[0] ?? { zoom: 1, cx: 0, cy: 0 };
  else {
    const a = track[next - 1];
    const b = track[next];
    const p = easeInOutCubic((t - a.t) / Math.max(1, b.t - a.t));
    camera = {
      zoom: lerp(a.zoom, b.zoom, p),
      cx: lerp(a.cx, b.cx, p),
      cy: lerp(a.cy, b.cy, p),
    };
  }
  return clampCamera(camera, viewport);
}

/** Keeps the visible area inside the page. */
export function clampCamera(
  c: Camera,
  viewport: { width: number; height: number },
): Camera {
  const zoom = Math.max(1, c.zoom);
  const halfW = viewport.width / zoom / 2;
  const halfH = viewport.height / zoom / 2;
  return {
    zoom,
    cx: Math.min(viewport.width - halfW, Math.max(halfW, c.cx)),
    cy: Math.min(viewport.height - halfH, Math.max(halfH, c.cy)),
  };
}

/** Cursor position at time t (page pixels), linear between logged samples. */
export function cursorAtTime(
  samples: Array<PointerSample>,
  t: number,
): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  const next = samples.findIndex((s) => s.t > t);
  if (next === -1) return samples.at(-1) ?? null;
  if (next === 0) return samples[0] ?? null;
  const a = samples[next - 1];
  const b = samples[next];
  const p = (t - a.t) / Math.max(1, b.t - a.t);
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) };
}

/** Clicks still visible at time t: their age in ms, for the ripple. */
export function clicksAtTime(
  samples: Array<PointerSample>,
  t: number,
  durationMs = 500,
): Array<{ x: number; y: number; age: number }> {
  return samples
    .filter((s) => s.kind === "down" && t >= s.t && t - s.t < durationMs)
    .map((s) => ({ x: s.x, y: s.y, age: t - s.t }));
}

/**
 * The caption on screen at time t: a step's note, from shortly after the step
 * starts until just before the next one, fading in and out. Null when none.
 */
export function captionAtTime(
  steps: Array<{ seconds: number; note?: string }>,
  t: number,
  endMs: number,
  fadeMs = 300,
): { text: string; alpha: number } | null {
  for (const [i, step] of steps.entries()) {
    if (!step.note) continue;
    const from = step.seconds * 1000 + 200;
    const next = steps.at(i + 1);
    const to = (next ? next.seconds * 1000 : endMs) - 150;
    if (to - from < 800 || t < from || t > to) continue;
    const alpha = Math.min(1, (t - from) / fadeMs, (to - t) / fadeMs);
    return { text: step.note, alpha: Math.max(0, alpha) };
  }
  return null;
}

/** Index of the last frame shown at or before t. */
export function frameIndexAt(frames: Array<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((frames[mid]?.t ?? Infinity) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function easeInOutCubic(x: number): number {
  const p = Math.min(1, Math.max(0, x));
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}
