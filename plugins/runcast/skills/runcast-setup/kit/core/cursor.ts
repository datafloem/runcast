/** A point on the page, in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
