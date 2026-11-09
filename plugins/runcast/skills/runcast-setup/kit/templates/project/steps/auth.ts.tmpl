import { login as loginHelper, openLogin } from "../helpers/index.ts";
import type { Step, StepOptions } from "../kit.ts";

/**
 * Signs in with APP_USERNAME / APP_PASSWORD (or the given account). As the
 * first step it also opens the login page before the recording starts.
 */
export function login(
  options: StepOptions & { username?: string; password?: string } = {},
): Step {
  return {
    id: options.id ?? "login",
    title: options.title ?? "Login",
    note: options.note,
    transition: options.transition,
    show: options.show,
    offCamera: options.offCamera,
    entry: (ctx) => openLogin(ctx),
    run: (ctx) =>
      loginHelper(
        ctx,
        options.username ?? process.env.APP_USERNAME ?? "",
        options.password ?? process.env.APP_PASSWORD ?? "",
      ),
  };
}
