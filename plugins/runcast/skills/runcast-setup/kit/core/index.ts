// The kit's public API for a project's helpers, steps and scenarios. Projects
// import it through their own `kit.ts`, the one file that knows where the kit is.
export { sleep, type Point } from "./cursor.ts";
// Playwright types for helpers, so a project needs no Playwright of its own.
export type { BrowserContext, Locator, Page } from "@playwright/test";
export { requireEnv } from "./env.ts";
export { VIDEO_FORMATS, type VideoFormat } from "./format.ts";
export {
  isTestMode,
  isVideoMode,
  mode,
  pageSize,
  settings,
  type Mode,
} from "./mode.ts";
export {
  defineProject,
  loadProjectEnv,
  type ProjectConfig,
} from "./project.ts";
export {
  expect,
  spot,
  test,
  type Recorder,
  type Spot,
  type Target,
  type Ui,
} from "./recorder.ts";
export { scene, sceneProblems } from "./scene.ts";
// The stage's cursor, which rec.onStage hands to its callback.
export type { VirtualMouse } from "./virtual-mouse.ts";
export type { PermissionDecision, PermissionsOption } from "./permissions.ts";
export {
  hold,
  scenario,
  type ScenarioDefinition,
  type ShowTransition,
  type StepShow,
  type Step,
  type StepContext,
  type StepOptions,
  type StepTransition,
  type VideoCard,
} from "./scenario.ts";
