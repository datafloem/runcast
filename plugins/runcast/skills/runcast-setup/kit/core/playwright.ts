// The Playwright config every project uses. The project's playwright.config.ts:
//
//   import project from "./recording.config.ts";
//   import { definePlaywrightConfig } from "<kit>/core/playwright.ts";
//   export default await definePlaywrightConfig(project);
import { defineConfig, type ReporterDescription } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { findCaptures, type ProjectConfig } from "./project.ts";
import { ensureDisplay } from "./xvfb.ts";

export async function definePlaywrightConfig(project: ProjectConfig) {
  // Workers and the scripts find the project through this.
  process.env.REC_PROJECT = project.dir;
  // Tests and rehearsals lay the page out at the size the video records it
  // (the screen's), taken from the newest landscape recording.
  if (
    process.env.REC_MODE !== "video" &&
    process.env.REC_PAGE_WIDTH === undefined &&
    process.env.REC_PAGE_SIZE === undefined
  ) {
    const size = recordedPageSize(project.dir);
    if (size) {
      process.env.REC_PAGE_SIZE = `${size.width}x${size.height}`;
      console.log(
        `Page size ${process.env.REC_PAGE_SIZE}, as in the newest video (REC_PAGE_WIDTH overrides it).`,
      );
    }
  }
  // Read after the project's .env.local is loaded, so REC_MODE can be set there.
  const { isTestMode, isVideoMode, pageSize, settings } = await import(
    "./mode.ts"
  );
  // Linux without a screen: Chrome and ffmpeg use an Xvfb display.
  const xvfbScale =
    isVideoMode && process.platform === "linux" ? await ensureDisplay() : null;
  // "chrome" (default) needs Google Chrome; "chromium" uses Playwright's own
  // build (e.g. Linux on ARM, where there is no Chrome).
  const channel = process.env.REC_CHANNEL ?? "chrome";

  const reporter: Array<ReporterDescription> = isTestMode
    ? [
        ["list"],
        [
          "html",
          { outputFolder: path.join(project.dir, ".report"), open: "never" },
        ],
      ]
    : [["list"]];
  const origin = new URL(project.baseURL).origin;
  const localStorage = Object.entries(project.localStorage ?? {}).map(
    ([name, value]) => ({
      name,
      value,
    }),
  );

  // One test at a time, no retries: scenarios write to a real backend, and a
  // retry would repeat those writes (and land in the same video).
  return defineConfig({
    testDir: path.join(project.dir, "scenarios"),
    outputDir: path.join(project.dir, ".results"),
    workers: 1,
    fullyParallel: false,
    retries: 0,
    timeout: 10 * 60_000,
    // Dev servers and real backends are slower than Playwright's 5 s default.
    expect: { timeout: 15_000 },
    reporter,
    use: {
      baseURL: project.baseURL,
      channel: channel === "chromium" ? undefined : channel,
      locale: project.locale ?? "en-US",
      colorScheme: project.colorScheme,
      storageState: { cookies: [], origins: [{ origin, localStorage }] },
      headless: settings.headless,
      // Video mode: null = the page fills the window, which the recorder sizes
      // to the screen. Headless modes: a fixed 16:9 viewport.
      viewport: isVideoMode ? null : pageSize,
      launchOptions: isVideoMode
        ? {
            args: [
              "--window-position=0,0",
              `--window-size=${pageSize.width},${pageSize.height + 100}`,
              // Our own Xvfb display: draw at its scale (REC_XVFB_SCALE).
              ...(xvfbScale
                ? [`--force-device-scale-factor=${xvfbScale}`]
                : []),
            ],
          }
        : {},
      // A click whose element never shows up fails here with its locator,
      // instead of waiting out the whole test timeout.
      actionTimeout: 30_000,
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
    },
  });
}

/** The page size of the newest landscape video recording, if any. */
function recordedPageSize(
  dir: string,
): { width: number; height: number } | null {
  for (const capture of findCaptures(dir)) {
    try {
      const { viewport } = JSON.parse(
        readFileSync(`${capture}/events.json`, "utf-8"),
      ) as { viewport?: { width: number; height: number } };
      if (viewport && viewport.width > viewport.height) {
        return {
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        };
      }
    } catch {
      // A capture cut short: try the next one.
    }
  }
  return null;
}
