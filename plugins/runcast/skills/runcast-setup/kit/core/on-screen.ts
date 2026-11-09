// Whether an element can be shown and used where rec is about to point at it.
// Runs in the page (locator.evaluate), so it is one self-contained function:
// no imports, no helpers outside it.

/**
 * What stops the element being shown at (x, y) (viewport CSS pixels), or
 * null: the point is outside the visible page, another element covers it
 * (a toast, a dialog, a sticky header), or the element or one of its
 * ancestors is still animating in. Endless animations (spinners) do not
 * count. Elements inside iframes are not checked.
 */
export function screenProblem(
  element: Element,
  point: { x: number; y: number },
): string | null {
  if (window !== window.top) return null;
  const name = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList]
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join("");
    return `${el.tagName.toLowerCase()}${id}${classes}`;
  };

  const { x, y } = point;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    return `it is outside the visible page (at ${Math.round(x)}, ${Math.round(y)} in a ${window.innerWidth}x${window.innerHeight} page)`;
  }

  // The topmost element at the point, through open shadow roots.
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  const isLabelOf =
    top instanceof HTMLLabelElement &&
    (top.control === element || top.contains(element));
  if (
    top &&
    top !== element &&
    !element.contains(top) &&
    !top.contains(element) &&
    !isLabelOf
  ) {
    return `it is covered by ${name(top)}`;
  }

  // Animations that will end (a fade, a slide) on it or around it.
  for (let el: Element | null = element; el; el = el.parentElement) {
    for (const animation of el.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (
        animation.playState === "running" &&
        typeof end === "number" &&
        Number.isFinite(end)
      ) {
        return `it is still animating (${name(el)})`;
      }
    }
  }
  return null;
}
