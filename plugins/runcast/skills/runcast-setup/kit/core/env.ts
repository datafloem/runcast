import path from "node:path";

/**
 * Fails the test with a clear message when settings are missing. A skip would
 * only show as "skipped" while the browser opens and closes for no reason.
 */
export function requireEnv(...names: Array<string>): void {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  const file = path.relative(
    process.cwd(),
    path.join(process.env.REC_PROJECT ?? "tests/recording", ".env.local"),
  );
  throw new Error(
    `Missing settings: ${missing.join(", ")}. Add them to ${file} (examples in .env.example).`,
  );
}
