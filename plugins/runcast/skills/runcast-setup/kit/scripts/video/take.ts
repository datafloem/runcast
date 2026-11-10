// What `video` does after recording (scripts/video/run.ts). Pure, no kit
// imports: plain Node runs this file.

/**
 * After a take: "check" (default) draws each step's last frame and prints
 * the narration fit, in seconds, so a take that needs redoing costs no
 * render; "full" renders the whole video right away (`--render`,
 * `--render=full` or REC_RENDER=full; `--render=check` wins over the
 * setting). The kit's own flag is taken out of the Playwright arguments.
 */
export function takeOptions(
  argv: Array<string>,
  env: Record<string, string | undefined>,
): { render: "check" | "full"; args: Array<string> } {
  let render: "check" | "full" = env.REC_RENDER === "full" ? "full" : "check";
  const args: Array<string> = [];
  for (const arg of argv) {
    if (arg === "--render" || arg === "--render=full") render = "full";
    else if (arg === "--render=check") render = "check";
    else args.push(arg);
  }
  return { render, args };
}
