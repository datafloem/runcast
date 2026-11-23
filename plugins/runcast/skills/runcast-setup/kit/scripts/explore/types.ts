// What explore records about a page. Never a field value, a storage value or
// a cookie value; displayed data is written as "…" (see redact.ts).
import type { SkipReason } from "./urls.ts";

export interface Control {
  role: string;
  /** Accessible name. */
  name: string;
  /** Text of an associated <label>, when it differs from the name. */
  label?: string;
  /** The `name` attribute. */
  nameAttr?: string;
  id?: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
  placeholder?: string;
  /** Option labels of a <select> (the app's choices, not records). */
  options?: Array<string>;
  /** Test hook attributes (data-testid, data-test, data-cy, data-qa). */
  hooks?: Record<string, string>;
  /** Accessible name of the enclosing form. */
  form?: string;
}

export type Landmark = "nav" | "header" | "main" | "aside" | "footer" | "other";

export interface Link {
  /** Accessible name, "…" for a link inside displayed data. */
  name: string;
  /** Page key of the target. */
  key: string;
  /** Absolute URL of the target, for the crawl. */
  url: string;
  landmark: Landmark;
}

export interface SkippedLink {
  name: string;
  href: string;
  reason: SkipReason;
}

export interface Brand {
  themeColor?: string;
  /** :root custom properties whose value is a colour. */
  cssColors: Record<string, string>;
  /** Background colour of the most prominent button. */
  buttonColor?: string;
  /** Favicon and og:image URLs. */
  icons: Array<string>;
  /** Likely logo images. */
  logos: Array<string>;
}

export interface FrameInfo {
  origin: string;
  sameOrigin: boolean;
  aria?: string;
  controls?: Array<Control>;
}

export interface RedactionCounts {
  cells: number;
  rows: number;
  items: number;
  values: number;
}

export interface MobileCheck {
  viewportMeta: string | null;
  /** The page is wider than a 540 px viewport. */
  overflow: boolean;
}

export interface PageSnapshot {
  key: string;
  url: string;
  finalUrl: string;
  title: string;
  status: number | null;
  /** The page settled within the waiting caps. */
  settled: boolean;
  /** The page is a sign-in page (another origin, or a password field). */
  signIn: boolean;
  headings: Array<string>;
  /** Redacted accessibility tree (written to aria.yml, not page.json). */
  aria: string;
  controls: Array<Control>;
  links: Array<Link>;
  skipped: Array<SkippedLink>;
  hooks: Array<string>;
  storage: { local: Array<string>; session: Array<string>; cookies: Array<string> };
  brand: Brand;
  frames: Array<FrameInfo>;
  redacted: RedactionCounts;
  mobile?: MobileCheck;
}
