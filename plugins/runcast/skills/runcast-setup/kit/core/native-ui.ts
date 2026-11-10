// Stand-ins for controls the browser draws outside the page (a <select>'s
// list, a date picker), so a recorded tab shows them the same on every
// platform. They run in the page (locator.evaluate), so each function is
// self-contained: no imports, no helpers outside it.
//
// A stand-in lives in an open shadow root on an element marked
// [data-runcast-ui], in the top layer (a manual popover), drawn with its own
// styles (all: initial inside), and never takes the focus: rec clicks an
// entry, then sets the real value with Playwright and removes it.

/** Shows the select's options in a list under it, the current one marked. */
export function showOptions(select: Element): void {
  document.querySelectorAll("[data-runcast-ui]").forEach((old) => old.remove());
  if (!(select instanceof HTMLSelectElement)) throw new Error("not a <select>");
  const box = select.getBoundingClientRect();
  const rowHeight = 28;
  const options = [...select.options];
  const height = Math.min(options.length * rowHeight + 8, 320);
  const below = window.innerHeight - box.bottom;
  const top = below >= height + 4 || below >= box.top ? box.bottom + 2 : box.top - height - 2;

  const host = document.createElement("div");
  host.setAttribute("data-runcast-ui", "select");
  host.setAttribute("popover", "manual");
  host.style.cssText = [
    "position: fixed",
    "inset: auto",
    `left: ${Math.round(box.left)}px`,
    `top: ${Math.round(top)}px`,
    "margin: 0",
    "padding: 0",
    "border: 0",
    "background: transparent",
    "overflow: visible",
    "z-index: 2147483647",
  ].join(";");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .list { all: initial; display: block; box-sizing: border-box;
      min-width: ${Math.max(160, Math.round(box.width))}px; max-height: ${height}px; overflow: hidden;
      padding: 4px; border-radius: 8px; background: #ffffff; color: #1f2328;
      border: 1px solid rgba(0, 0, 0, 0.16); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font: 14px/1 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .option { all: initial; display: flex; align-items: center; box-sizing: border-box;
      height: ${rowHeight}px; padding: 0 10px 0 26px; border-radius: 5px; cursor: default;
      font: inherit; color: inherit; white-space: nowrap; position: relative; }
    .option[aria-selected="true"]::before { content: "✓"; position: absolute; left: 9px; }
    .option:hover { background: #2f6feb; color: #ffffff; }
    .option[aria-disabled="true"] { opacity: 0.45; }
    @media (prefers-color-scheme: dark) {
      .list { background: #2b2d31; color: #e6e6e6; border-color: rgba(255, 255, 255, 0.14); }
    }`;
  const list = document.createElement("div");
  list.className = "list";
  list.setAttribute("role", "listbox");
  for (const option of options) {
    const row = document.createElement("div");
    row.className = "option";
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "-1");
    row.setAttribute("data-label", option.label);
    row.setAttribute("aria-selected", String(option.selected));
    if (option.disabled) row.setAttribute("aria-disabled", "true");
    row.textContent = option.label;
    list.append(row);
  }
  // Clicks must not move the focus away from where the app has it.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  root.append(style, list);
  document.documentElement.append(host);
  host.showPopover?.();
}

/** Shows a month grid for a date input, opened at `value` (YYYY-MM-DD), its day marked. */
export function showMonth(input: Element, value: string): void {
  document.querySelectorAll("[data-runcast-ui]").forEach((old) => old.remove());
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`"${value}" is not a date (YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const box = input.getBoundingClientRect();
  const width = 252;
  const height = 290;
  const below = window.innerHeight - box.bottom;
  const top = below >= height + 4 || below >= box.top ? box.bottom + 2 : box.top - height - 2;
  const left = Math.max(4, Math.min(box.left, window.innerWidth - width - 4));
  const locale = document.documentElement.lang || navigator.language || "en-US";
  const weekInfo = (
    new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number } }
  ).weekInfo;
  const firstDay = (weekInfo?.firstDay ?? 1) % 7; // 0 = Sunday

  const host = document.createElement("div");
  host.setAttribute("data-runcast-ui", "date");
  host.setAttribute("popover", "manual");
  host.style.cssText = [
    "position: fixed",
    "inset: auto",
    `left: ${Math.round(left)}px`,
    `top: ${Math.round(top)}px`,
    "margin: 0",
    "padding: 0",
    "border: 0",
    "background: transparent",
    "overflow: visible",
    "z-index: 2147483647",
  ].join(";");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .panel { all: initial; display: block; box-sizing: border-box; width: ${width}px;
      padding: 10px; border-radius: 10px; background: #ffffff; color: #1f2328;
      border: 1px solid rgba(0, 0, 0, 0.16); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font: 13px/1 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .title { all: initial; display: block; font-family: inherit; font-size: 14px; font-weight: 600;
      color: inherit; padding: 4px 4px 12px; }
    .grid { all: initial; display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
      font: inherit; color: inherit; }
    .weekday { all: initial; display: flex; justify-content: center; height: 24px; align-items: center;
      font: inherit; font-size: 11px; color: inherit; opacity: 0.6; }
    .day { all: initial; display: flex; justify-content: center; align-items: center; height: 30px;
      border-radius: 6px; font: inherit; color: inherit; cursor: default; }
    .day:hover { background: rgba(47, 111, 235, 0.15); }
    .day[aria-selected="true"] { background: #2f6feb; color: #ffffff; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #2b2d31; color: #e6e6e6; border-color: rgba(255, 255, 255, 0.14); }
    }`;
  const panel = document.createElement("div");
  panel.className = "panel";
  const title = document.createElement("div");
  title.className = "title";
  title.setAttribute("data-month", `${match[1]}-${match[2]}`);
  title.textContent = new Date(year, month, 1).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.setAttribute("role", "grid");
  for (let i = 0; i < 7; i++) {
    const weekday = document.createElement("div");
    weekday.className = "weekday";
    // 2023-01-01 was a Sunday.
    weekday.textContent = new Date(2023, 0, 1 + ((firstDay + i) % 7)).toLocaleDateString(locale, {
      weekday: "narrow",
    });
    grid.append(weekday);
  }
  const lead = (new Date(year, month, 1).getDay() - firstDay + 7) % 7;
  for (let i = 0; i < lead; i++) grid.append(document.createElement("span"));
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const cell = document.createElement("div");
    cell.className = "day";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("tabindex", "-1");
    cell.setAttribute("data-day", String(d));
    cell.setAttribute("aria-selected", String(d === day));
    cell.textContent = String(d);
    grid.append(cell);
  }
  panel.addEventListener("mousedown", (event) => event.preventDefault());
  panel.append(title, grid);
  root.append(style, panel);
  document.documentElement.append(host);
  host.showPopover?.();
}

/** Removes the kit's stand-in, if one is shown. */
export function removeStandIn(): void {
  document.querySelectorAll("[data-runcast-ui]").forEach((host) => host.remove());
}
