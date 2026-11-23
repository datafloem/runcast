// explore: keeps the app's own words in an aria snapshot (headings, labels,
// buttons, menus, column headers) and hides what users typed or the app
// lists from its records (control values, table cells, data rows, repeated
// list items, definitions). Works on Playwright's aria snapshot YAML.
import type { RedactionCounts } from "./types.ts";

interface Node {
  indent: string;
  /** "/url" and other property lines start with "/". */
  role: string;
  name?: string;
  attrs: string;
  inline?: string;
  /** The line ends with ":" (it has children) or carries inline text. */
  colon: boolean;
  raw: string;
  children: Array<Node>;
  /** Lines that are not nodes (continuations), kept with the node. */
  extra: Array<string>;
}

const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const HEADER_ROLES = new Set(["columnheader", "rowheader"]);
const HIDDEN = "…";

const LINE = /^(\s*)- (.*)$/;
const NODE =
  /^([A-Za-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(?:(:)(?: (.*))?)?$/;

function parse(yaml: string): Array<Node> {
  const roots: Array<Node> = [];
  const stack: Array<Node> = [];
  for (const raw of yaml.split("\n")) {
    const line = LINE.exec(raw);
    if (!line) {
      stack.at(-1)?.extra.push(raw);
      if (!stack.length) roots.push(rawNode(raw));
      continue;
    }
    const [, indent = "", body = ""] = line;
    const match = body.startsWith("/") ? null : NODE.exec(body);
    const node: Node = match
      ? {
          indent,
          role: match[1]!,
          name: match[2],
          attrs: match[3] ?? "",
          colon: match[4] === ":",
          inline: match[5],
          raw,
          children: [],
          extra: [],
        }
      : { indent, role: body.split(":")[0]!, attrs: "", colon: true, raw, children: [], extra: [] };
    while (stack.length && stack.at(-1)!.indent.length >= indent.length) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

function rawNode(raw: string): Node {
  return { indent: "", role: "", attrs: "", colon: false, raw, children: [], extra: [] };
}

function isProperty(node: Node): boolean {
  return node.role.startsWith("/");
}

/** More than three list items, at least three quarters of them the same shape: records. */
function repeatedList(node: Node): boolean {
  const items = node.children.filter((c) => c.role === "listitem");
  if (items.length <= 3) return false;
  const shapes = new Map<string, number>();
  for (const n of items) {
    const shape = `${n.inline !== undefined}|${n.children.map((c) => c.role).join(",")}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  return Math.max(...shapes.values()) >= items.length * 0.75;
}

/** Menus and page chrome: their lists are the app's, not records. */
const CHROME = new Set(["navigation", "banner", "contentinfo", "complementary", "menu", "menubar", "tablist"]);

/** States that are values: what is checked, pressed or chosen. */
const STATE = / \[(checked|pressed)(=[^\]]*)?\]/g;

function hasRole(nodes: Array<Node>, role: string): boolean {
  return nodes.some((n) => n.role === role || hasRole(n.children, role));
}

/** recordPage: a page showing one record (its key has ":id"): its level-1 heading is the record's name. */
export function redactAria(yaml: string, opts: { recordPage?: boolean } = {}): {
  text: string;
  counts: RedactionCounts;
} {
  const counts: RedactionCounts = { cells: 0, rows: 0, items: 0, values: 0 };
  const out: Array<string> = [];

  const line = (node: Node, hide: boolean, attrsChanged: boolean): string => {
    let inline = node.inline;
    if (inline !== undefined && VALUE_ROLES.has(node.role)) {
      counts.values++;
      inline = undefined;
      if (!node.children.length) {
        return `${node.indent}- ${node.role}${node.name ? ` ${node.name}` : ""}${node.attrs}`;
      }
    } else if (!hide && !attrsChanged && inline === node.inline) {
      return node.raw;
    }
    const name = node.name === undefined ? "" : hide ? ` "${HIDDEN}"` : ` ${node.name}`;
    const text = inline === undefined ? (node.colon && node.children.length ? ":" : "") : `: ${hide ? HIDDEN : inline}`;
    return `${node.indent}- ${node.role}${name}${node.attrs}${text}`;
  };

  const emit = (node: Node, ctx: { hide: boolean; inMain: boolean; parent?: Node }) => {
    if (!node.role && !node.indent && !node.children.length) {
      out.push(node.raw);
      return;
    }
    if (isProperty(node)) {
      if (!ctx.hide) {
        out.push(node.raw);
        node.extra.forEach((e) => out.push(e));
      }
      return;
    }
    let hide = ctx.hide;
    if (!hide) {
      if (node.role === "row") {
        const header = node.children.length > 0 && node.children.every((c) => HEADER_ROLES.has(c.role));
        if (!header) {
          hide = true;
          counts.rows++;
        }
      } else if (node.role === "cell" || node.role === "gridcell" || node.role === "definition") {
        hide = true;
        counts.cells++;
      } else if (opts.recordPage && node.role === "heading" && node.attrs.includes("[level=1]")) {
        hide = true;
      } else if (node.role === "option" && ctx.parent?.role === "listbox") {
        hide = true;
        counts.items++;
      }
    } else if (node.role === "cell" || node.role === "gridcell") {
      counts.cells++;
    }
    let attrs = node.attrs.replace(STATE, "");
    if (node.role === "option") attrs = attrs.replace(" [selected]", "");
    if (attrs !== node.attrs) counts.values++;
    out.push(line({ ...node, attrs }, hide, attrs !== node.attrs));
    if (!hide) node.extra.forEach((e) => out.push(e));
    const inMain = CHROME.has(node.role) ? false : ctx.inMain || node.role === "main";
    const hideItems = !hide && inMain && node.role === "list" && repeatedList(node);
    for (const child of node.children) {
      // A control's content is its value (typed text, a rich text body);
      // a <select>'s options are the app's choices and stay.
      const keep = isProperty(child) || (node.role === "combobox" && child.role === "option");
      if (VALUE_ROLES.has(node.role) && !keep) {
        counts.values++;
        continue;
      }
      const hideChild = hide || (hideItems && child.role === "listitem");
      if (hideItems && child.role === "listitem") counts.items++;
      emit(child, { hide: hideChild, inMain, parent: node });
    }
  };

  const roots = parse(yaml);
  // Without a main landmark, everything outside the page's chrome counts as main.
  const noMain = !hasRole(roots, "main");
  for (const root of roots) emit(root, { hide: false, inMain: noMain });
  return { text: out.join("\n"), counts };
}
