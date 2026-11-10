// Shows a downloaded file on the stage tab (rec.download with { open }):
// core/stage/file.html, with the file's content handed over by the kit.
import type { Page } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** How much of a text file is shown (the window shows far less). */
const TEXT_LIMIT = 200_000;

const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};
const TABLES = new Set(["csv", "tsv"]);
const TEXTS = new Set(["txt", "text", "md", "log", "json", "xml", "yaml", "yml", "html", "htm", "ics", "vcf"]);

/** Opens the file viewer on `page` and shows `file` in it. */
export async function showFile(page: Page, file: string): Promise<void> {
  const name = path.basename(file);
  const size = statSync(file).size;
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  let kind: "table" | "text" | "image" | "pdf" | "other" = "other";
  let content: string | undefined;
  if (TABLES.has(ext)) {
    kind = "table";
    content = readFileSync(file, "utf-8").slice(0, TEXT_LIMIT);
  } else if (TEXTS.has(ext)) {
    kind = "text";
    content = readFileSync(file, "utf-8").slice(0, TEXT_LIMIT);
    if (ext === "json") {
      try {
        content = JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // Not valid JSON (or cut short): shown as it is.
      }
    }
  } else if (IMAGES[ext]) {
    kind = "image";
    content = `data:${IMAGES[ext]};base64,${readFileSync(file).toString("base64")}`;
  } else if (ext === "pdf") {
    kind = "pdf";
    // Without the viewer's toolbar and page list: the page itself.
    content = `data:application/pdf;base64,${readFileSync(file).toString("base64")}#toolbar=0&navpanes=0&view=FitH`;
  }
  await page.goto(pathToFileURL(path.join(import.meta.dirname, "stage", "file.html")).href);
  await page.evaluate(
    (spec) =>
      (window as unknown as { runcastShowFile(s: typeof spec): Promise<void> | void }).runcastShowFile(spec),
    { name, size, kind, content },
  );
}
