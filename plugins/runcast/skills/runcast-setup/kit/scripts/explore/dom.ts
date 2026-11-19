// explore: what a page's DOM says about its controls, links, headings, test
// hooks and brand. `extractDom` runs inside the page (page.evaluate), so it
// is self-contained: no imports, no outside variables. It never reads a
// control's value; text inside displayed data comes back as "…".
import type { Brand, Control, Landmark } from "./types.ts";

export interface DomLink {
  name: string;
  /** Absolute URL. */
  href: string;
  landmark: Landmark;
  download: boolean;
  /** Inside displayed data (a table cell, a data row, a repeated list item). */
  data: boolean;
  /** Sends another method or asks to confirm (Rails, Turbo): an action. */
  method: boolean;
}

export interface DomResult {
  headings: Array<{ text: string; level: number }>;
  controls: Array<Control>;
  links: Array<DomLink>;
  hooks: Array<string>;
  brand: Brand;
}

export function extractDom(): DomResult {
  const HIDDEN = "…";
  const HOOKS = ["data-testid", "data-test", "data-cy", "data-qa"];
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const textOf = (el: Element) => clean(el.textContent);

  /** Label text without the controls inside it (a textarea's text is its value). */
  const labelText = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll("input, select, textarea, button").forEach((c) => c.remove());
    return textOf(copy);
  };

  const repeatedItem = (el: Element) => {
    const li = el.closest("li");
    if (!li || !li.closest("main") || !li.parentElement) return false;
    const items = [...li.parentElement.children].filter((c) => c.tagName === "LI");
    if (items.length <= 3) return false;
    const shape = (n: Element) => [...n.children].map((c) => c.tagName).join(",");
    return items.every((item) => shape(item) === shape(items[0]!));
  };
  const isData = (el: Element) =>
    !!el.closest('td, dd, tbody tr, [role="cell"], [role="gridcell"]') || repeatedItem(el);

  const landmarkOf = (el: Element): Landmark => {
    if (el.closest('nav, [role="navigation"]')) return "nav";
    if (el.closest('header, [role="banner"]')) return "header";
    if (el.closest('aside, [role="complementary"]')) return "aside";
    if (el.closest('footer, [role="contentinfo"]')) return "footer";
    if (el.closest('main, [role="main"]')) return "main";
    return "other";
  };

  const byIds = (ids: string) =>
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((e): e is HTMLElement => !!e)
      .map(labelText)
      .join(" ")
      .trim();

  const labelsOf = (el: Element) => {
    const labels = (el as HTMLInputElement).labels;
    return labels ? [...labels].map(labelText).join(" ").trim() : "";
  };

  const nameOf = (el: Element, role: string): string => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = byIds(by);
      if (t) return t;
    }
    const labels = labelsOf(el);
    if (labels) return labels;
    if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type))
      return clean(el.value) || el.type;
    if (role === "button" || role === "link") {
      const t = textOf(el);
      if (t) return t;
      const img = el.querySelector("img[alt]");
      if (img) return clean(img.getAttribute("alt"));
    }
    return clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title"));
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0]!;
    if (el instanceof HTMLSelectElement) return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (el instanceof HTMLTextAreaElement) return "textbox";
    if (el instanceof HTMLButtonElement) return "button";
    if (el instanceof HTMLInputElement) {
      const map: Record<string, string> = {
        hidden: "",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        number: "spinbutton",
        search: "searchbox",
        submit: "button",
        button: "button",
        reset: "button",
        image: "button",
        file: "button",
        color: "button",
      };
      const role = map[el.type] ?? "textbox";
      return role || null;
    }
    return null;
  };

  const hooksOf = (el: Element) => {
    const found: Record<string, string> = {};
    for (const h of HOOKS) {
      const v = el.getAttribute(h);
      if (v !== null) found[h] = v;
    }
    return Object.keys(found).length ? found : undefined;
  };

  const formName = (el: Element) => {
    const form = el.closest("form");
    if (!form) return undefined;
    const aria = clean(form.getAttribute("aria-label"));
    if (aria) return aria;
    const by = form.getAttribute("aria-labelledby");
    return (by && byIds(by)) || undefined;
  };

  const controls: Array<Control> = [];
  const selector =
    'input, select, textarea, button, [role="button"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="searchbox"], [role="slider"], [role="spinbutton"]';
  for (const el of document.querySelectorAll(selector)) {
    const role = roleOf(el);
    if (!role) continue;
    const data = isData(el);
    const name = nameOf(el, role);
    const control: Control = { role, name: data && name ? HIDDEN : name };
    const label = labelsOf(el);
    if (label && label !== name) control.label = data ? HIDDEN : label;
    const attr = (a: string) => el.getAttribute(a) ?? undefined;
    if (attr("name")) control.nameAttr = attr("name");
    if (el.id) control.id = el.id;
    if (el instanceof HTMLInputElement) control.type = el.type;
    if (el.hasAttribute("required") || el.getAttribute("aria-required") === "true")
      control.required = true;
    const maxLength = Number(attr("maxlength"));
    if (maxLength > 0) control.maxLength = maxLength;
    for (const a of ["min", "max", "pattern", "placeholder"] as const) {
      const v = attr(a);
      if (v !== undefined) control[a] = data ? HIDDEN : v;
    }
    if (el instanceof HTMLSelectElement)
      control.options = [...el.options].map((o) => (data ? HIDDEN : textOf(o)));
    const hooks = hooksOf(el);
    if (hooks) control.hooks = hooks;
    const form = formName(el);
    if (form) control.form = form;
    controls.push(control);
  }

  const links: Array<DomLink> = [...document.querySelectorAll("a[href]")].map((el) => {
    const a = el as HTMLAnchorElement;
    return {
      name: nameOf(a, "link"),
      href: a.href,
      landmark: landmarkOf(a),
      download: a.hasAttribute("download"),
      data: isData(a),
      method: ["data-method", "data-turbo-method", "data-confirm", "data-turbo-confirm"].some(
        (attr) => a.hasAttribute(attr),
      ),
    };
  });

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map(
    (el) => {
      const level = /^H(\d)$/.exec(el.tagName)?.[1] ?? el.getAttribute("aria-level") ?? "2";
      return { text: isData(el) ? HIDDEN : textOf(el), level: Number(level) };
    },
  );

  const hooks = [
    ...new Set(
      // Hooks inside displayed data name records (customer-row-17).
      [...document.querySelectorAll(HOOKS.map((h) => `[${h}]`).join(","))]
        .filter((el) => !isData(el))
        .flatMap((el) => HOOKS.map((h) => el.getAttribute(h)).filter((v): v is string => v !== null)),
    ),
  ];

  // Brand.
  const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\()/i;
  const rootStyle = getComputedStyle(document.documentElement);
  const cssColors: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // another origin's stylesheet
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule) || !/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText))
        continue;
      for (const prop of rule.style) {
        if (!prop.startsWith("--")) continue;
        const value = rootStyle.getPropertyValue(prop).trim();
        if (COLOUR.test(value)) cssColors[prop] = value;
      }
    }
  }
  const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? undefined;
  const icons = [
    ...[...document.querySelectorAll('link[rel~="icon"]')].map((l) => (l as HTMLLinkElement).href),
    ...[...document.querySelectorAll('meta[property="og:image"]')].map((m) =>
      new URL(m.getAttribute("content") ?? "", location.href).href,
    ),
  ];
  const logos = [...document.querySelectorAll("img")]
    .filter(
      (img) =>
        img.closest('header, [role="banner"]') ||
        /logo/i.test(`${img.alt} ${img.className} ${img.id} ${img.getAttribute("src")}`),
    )
    .map((img) => img.currentSrc || img.src);
  const saturation = (rgb: string) => {
    const [r = 0, g = 0, b = 0] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  let buttonColor: string | undefined;
  let best = -1;
  for (const el of document.querySelectorAll(
    'button, [role="button"], input[type="submit"], input[type="button"], a',
  )) {
    const style = getComputedStyle(el);
    const bg = style.backgroundColor;
    if (!bg || bg === "transparent" || /rgba\(.*,\s*0\)$/.test(bg)) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.visibility === "hidden") continue;
    const score = box.width * box.height * (saturation(bg) > 30 ? 10 : 1);
    if (score > best) {
      best = score;
      buttonColor = bg;
    }
  }

  return {
    headings,
    controls,
    links,
    hooks,
    brand: { themeColor, cssColors, buttonColor, icons, logos },
  };
}
