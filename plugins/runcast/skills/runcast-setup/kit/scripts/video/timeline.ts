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
  kind:
    | "click"
    | "double-click"
    | "right-click"
    | "hover"
    | "type"
    | "drag"
    | "show";
  x: number;
  y: number;
  box?: Box;
  /** A "show": how the camera gets there (ShowTransition); default "pan". */
  transition?: string;
}

/**
 * How the camera reaches a shown element: "pan" (a camera move), "slide" (the
 * new view pushes the old one out sideways), "fade", "cube" (a cube turn) or
 * "cut" (at once).
 */
export type ShowTransition = "pan" | "slide" | "fade" | "cube" | "cut";

/** How long each show transition takes (ms); "pan" uses CameraOptions.moveMs. */
export const SHOW_TRANSITION_MS: Record<Exclude<ShowTransition, "pan">, number> =
  { slide: 600, fade: 500, cube: 900, cut: 0 };

export interface PointerSample {
  t: number;
  x: number;
  y: number;
  kind: "move" | "down" | "up";
}

export interface Size {
  width: number;
  height: number;
}

/**
 * What the camera shows at zoom 1: the largest area of the video frame's
 * shape (width / height) inside the page. The whole page when the shapes
 * match; a slice of it when they don't (a 9:16 video of a desktop page).
 */
export function baseView(viewport: Size, aspect: number): Size {
  return viewport.width / viewport.height > aspect
    ? { width: viewport.height * aspect, height: viewport.height }
    : { width: viewport.width, height: viewport.width / aspect };
}

/** Camera: zoom factor (1 = the base view) and the page point at the centre. */
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
  /** A shown element (rec.show) is framed tightly: this much room around it, at most this close. */
  showMarginPx: number;
  showMaxZoom: number;
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
  showMarginPx: 24,
  showMaxZoom: 3,
};

interface Keyframe extends Camera {
  t: number;
  /** The camera reaches this keyframe by a show transition instead of moving. */
  transition?: Exclude<ShowTransition, "pan">;
}

interface Scene {
  start: number;
  end: number;
  framing: Camera;
  transition?: ShowTransition;
}

/**
 * Turns focus events into a calm camera: actions on the same page without a
 * long pause between them form a scene; the camera frames the whole scene
 * once (all its actions in view) and holds still while it plays. Between
 * scenes it moves once — to the next framing, or back to the full page.
 * Short scenes, and scenes spread over most of the page, are not zoomed.
 *
 * When the base view is only a slice of the page (`view` smaller than
 * `viewport`), the camera follows instead: every scene is framed, a scene
 * never spans more than the slice holds, and the camera goes from scene to
 * scene without returning to the middle. After a page change with no action
 * soon after, it looks at the top of the new page.
 *
 * A "show" (rec.show) is a scene of its own: the element it names is framed
 * tightly (it fills the frame, up to showMaxZoom) until the next action or
 * page change. Its transition decides how the camera gets there: a move
 * ("pan"), or a switch the renderer draws as a slide, fade, cube or cut.
 *
 * At a cut (an off-camera step left out of the video) the camera does not
 * travel across: it jumps to the next framing there, under the renderer's
 * cross-fade, when the page changed off camera, and moves on after the cut
 * otherwise.
 */
export function buildCameraTrack(
  focus: Array<Focus>,
  viewport: Size,
  options: CameraOptions = defaultCameraOptions,
  /** Page changes: a scene never spans one, and ends soon after it. */
  navigations: Array<number> = [],
  /** What the camera shows at zoom 1 (baseView); default the whole page. */
  view: Size = viewport,
  /** Times where off-camera time was cut out. */
  cuts: Array<number> = [],
): Array<Keyframe> {
  const follow =
    view.width < viewport.width - 1 || view.height < viewport.height - 1;
  const home: Camera = {
    zoom: 1,
    cx: viewport.width / 2,
    cy: viewport.height / 2,
  };
  const frame: Framing = { viewport, view, follow, home };
  const scenes = buildScenes(
    holdShows(follow ? withPageTops(focus, frame, navigations) : focus, navigations),
    frame,
    options,
    navigations,
  );
  // Following: start where the first action is, not in the middle.
  const start = follow ? (scenes[0]?.framing ?? home) : home;
  const keyframes: Array<Keyframe> = [{ t: 0, ...start }];

  const moveTo = (
    camera: Camera,
    arriveAt: number,
    transition: ShowTransition = "pan",
  ) => {
    const last = keyframes.at(-1) ?? { t: 0, ...home };
    if (sameFraming(last, camera)) return;
    // A cut on the way: never travel across it. Hold until the cut; if the
    // page changed off camera, jump to the new framing there, otherwise
    // travel from the cut on.
    const cut = cuts.find((c) => c > last.t && c <= arriveAt + options.leadMs);
    if (cut !== undefined) {
      keyframes.push({ ...cameraOf(last), t: cut - 1 });
      const pageChanged = navigations.some((n) => Math.abs(n - cut) <= 1);
      const arrive = pageChanged
        ? cut
        : Math.max(arriveAt, cut + options.moveMs * 0.6);
      keyframes.push({ ...camera, t: arrive });
      return;
    }
    if (transition !== "pan") {
      // A switch when the shown element is there; the renderer draws it.
      const at = Math.max(arriveAt + options.leadMs, last.t + 2);
      keyframes.push({ ...cameraOf(last), t: at - 1 }, { ...camera, t: at, transition });
      return;
    }
    const arrive = Math.max(arriveAt, last.t + options.moveMs * 0.6);
    const leave = Math.max(last.t, arrive - options.moveMs);
    if (leave > last.t) keyframes.push({ ...cameraOf(last), t: leave });
    keyframes.push({ ...camera, t: arrive });
  };

  scenes.forEach((scene, i) => {
    moveTo(scene.framing, scene.start - options.leadMs, scene.transition);
    // Following: stay on the last action until the next scene.
    if (follow) return;
    const next = scenes.at(i + 1);
    // A page change right after the scene: let go soon after it.
    const navigation = navigations.find(
      (n) => n >= scene.end && n < scene.end + options.holdMs,
    );
    const planned =
      navigation !== undefined ? navigation + 250 : scene.end + options.holdMs;
    // A cut before then: hold until it, then jump (moveTo).
    const cut = cuts.find((c) => c >= scene.end && c < planned);
    const release = cut !== undefined ? cut - 1 : planned;
    // The next scene starts soon: go straight there instead of out and in again.
    if (next && next.start - options.leadMs - release < options.moveMs) return;
    const last = keyframes.at(-1) ?? { t: 0, ...home };
    if (release > last.t) keyframes.push({ ...cameraOf(last), t: release });
    moveTo(home, release + options.moveMs);
  });
  return keyframes;
}

/** The page, what the camera shows of it at zoom 1, and how it moves. */
interface Framing {
  viewport: Size;
  view: Size;
  follow: boolean;
  home: Camera;
}

/** A shown element stays in view until the next action or page change. */
function holdShows(
  focus: Array<Focus>,
  navigations: Array<number>,
): Array<Focus> {
  const sorted = [...focus].sort((a, b) => a.t - b.t);
  return sorted.map((f, i) => {
    if (f.kind !== "show") return f;
    const next = sorted
      .slice(i + 1)
      .find((other) => other.t > f.until)?.t;
    const page = navigations.find((n) => n > f.until);
    const end = Math.min(next ?? Infinity, page ?? Infinity, f.until + 60_000);
    return { ...f, until: Math.max(f.until, end - 1) };
  });
}

/** Following: after a page change with no action soon after, look at the top of the page. */
function withPageTops(
  focus: Array<Focus>,
  frame: Framing,
  navigations: Array<number>,
): Array<Focus> {
  const quietMs = 1500;
  const tops: Array<Focus> = navigations
    .filter((n) => !focus.some((f) => f.t >= n && f.t < n + quietMs))
    .map((n) => ({
      t: n + 300,
      until: n + 300,
      kind: "show" as const,
      x: frame.viewport.width / 2,
      y: frame.view.height / 2,
    }));
  return [...focus, ...tops];
}

/** Splits actions into scenes and frames each one. */
function buildScenes(
  focus: Array<Focus>,
  frame: Framing,
  options: CameraOptions,
  navigations: Array<number>,
): Array<Scene> {
  const sorted = [...focus].sort((a, b) => a.t - b.t);
  const groups: Array<Array<Focus>> = [];
  for (const f of sorted) {
    const current = groups.at(-1);
    const lastEnd = current
      ? Math.max(...current.map((c) => c.until))
      : -Infinity;
    const pageChanged = navigations.some((n) => n > lastEnd && n <= f.t);
    // Following: a scene holds only what fits in the slice at zoom 1.
    const fits =
      !frame.follow ||
      !current ||
      fitsInView([...current, f], frame.view, options.minMarginPx);
    // A shown element is a scene of its own.
    const shown = f.kind === "show" || current?.some((c) => c.kind === "show");
    if (
      current &&
      !pageChanged &&
      !shown &&
      fits &&
      f.t - lastEnd < options.sceneGapMs
    )
      current.push(f);
    else groups.push([f]);
  }

  return groups.map((group) => {
    const start = Math.min(...group.map((f) => f.t));
    const end = Math.max(...group.map((f) => f.until));
    const shown = group.find((f) => f.kind === "show" && f.box);
    const transition = isShowTransition(shown?.transition)
      ? shown.transition
      : undefined;
    if (shown) return { start, end, framing: frameShown(shown, frame, options), transition };
    if (!frame.follow && end - start < options.minSceneMs)
      return { start, end, framing: frame.home };
    return { start, end, framing: frameActions(group, frame, options) };
  });
}

/** The area a scene's actions cover: a typed-in field or shown element whole, anything else by its point. */
function actionArea(group: Array<Focus>): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const f of group) {
    const area =
      (f.kind === "type" || f.kind === "show") && f.box
        ? f.box
        : { x: f.x, y: f.y, width: 0, height: 0 };
    left = Math.min(left, area.x);
    top = Math.min(top, area.y);
    right = Math.max(right, area.x + area.width);
    bottom = Math.max(bottom, area.y + area.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function fitsInView(group: Array<Focus>, view: Size, marginPx: number): boolean {
  const area = actionArea(group);
  return (
    area.width + marginPx * 2 <= view.width &&
    area.height + marginPx * 2 <= view.height
  );
}

function isShowTransition(value: unknown): value is ShowTransition {
  return ["pan", "slide", "fade", "cube", "cut"].includes(value as string);
}

/** A shown element, tight: it fills the frame with a little room around. */
function frameShown(
  shown: Focus,
  frame: Framing,
  options: CameraOptions,
): Camera {
  const box = shown.box ?? { x: shown.x, y: shown.y, width: 0, height: 0 };
  const pad = options.showMarginPx;
  const zoom = Math.max(
    1,
    Math.min(
      options.showMaxZoom,
      frame.view.width / (box.width + pad * 2),
      frame.view.height / (box.height + pad * 2),
    ),
  );
  return clampCamera(
    { zoom, cx: box.x + box.width / 2, cy: box.y + box.height / 2 },
    frame.viewport,
    frame.view,
  );
}

/**
 * The show transition running at time t, if any: its kind, how far along
 * (0–1) and the camera it started from.
 */
export function transitionAtTime(
  track: Array<Keyframe>,
  t: number,
): { kind: Exclude<ShowTransition, "pan" | "cut">; p: number; from: Camera } | null {
  for (let i = 1; i < track.length; i++) {
    const k = track[i]!;
    if (!k.transition || k.transition === "cut") continue;
    const ms = SHOW_TRANSITION_MS[k.transition];
    if (t >= k.t && t < k.t + ms) {
      return { kind: k.transition, p: (t - k.t) / ms, from: cameraOf(track[i - 1]!) };
    }
  }
  return null;
}

/** The framing that keeps every action of a scene in view, with room around. */
function frameActions(
  group: Array<Focus>,
  frame: Framing,
  options: CameraOptions,
): Camera {
  const { x: left, y: top, width, height } = actionArea(group);
  const padX = Math.max(options.minMarginPx, width * options.margin);
  const padY = Math.max(options.minMarginPx, height * options.margin);
  const zoom = Math.min(
    options.maxZoom,
    frame.view.width / (width + padX * 2),
    frame.view.height / (height + padY * 2),
  );
  const centre = { cx: left + width / 2, cy: top + height / 2 };
  if (zoom < options.minZoom) {
    // Following: not worth zooming, but still look at it.
    return frame.follow
      ? clampCamera({ zoom: 1, ...centre }, frame.viewport, frame.view)
      : frame.home;
  }
  return clampCamera({ zoom, ...centre }, frame.viewport, frame.view);
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
  viewport: Size,
  view: Size = viewport,
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
  return clampCamera(camera, viewport, view);
}

/**
 * Actions the camera does not show when they happen: the point of each
 * focus lies outside the camera's view at its end (when the click lands or
 * the typing stops). Happens when a vertical crop cannot fit a scene, or a
 * shown element leaves the actions behind.
 */
export function actionsOutOfFrame(
  focus: Array<Focus>,
  track: Array<Keyframe>,
  viewport: Size,
  view: Size = viewport,
): Array<Focus> {
  return focus.filter((f) => {
    const camera = cameraAtTime(track, f.until, viewport, view);
    const halfW = view.width / camera.zoom / 2;
    const halfH = view.height / camera.zoom / 2;
    return (
      Math.abs(f.x - camera.cx) > halfW + 2 ||
      Math.abs(f.y - camera.cy) > halfH + 2
    );
  });
}

/** Keeps the visible area inside the page. */
export function clampCamera(
  c: Camera,
  viewport: Size,
  /** What the camera shows at zoom 1 (baseView). */
  view: Size = viewport,
): Camera {
  const zoom = Math.max(1, c.zoom);
  const halfW = view.width / zoom / 2;
  const halfH = view.height / zoom / 2;
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
