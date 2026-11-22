// How the camera's picture fits its box (Bryan, 22 Nov 2026: "when the little drawer is up a little
// bit from the bottom you can't see the full card either"). The picture covers the box, as before,
// cutting what overflows, but never more than MIN_SHOWN of its height is cut away: a box much wider
// than the picture, as the camera left above a raised sheet is, shows the picture smaller, with dark
// bars at the sides, rather than cutting off the top and bottom of a held card while the scanner
// goes on reading the whole frame. A card held to the guide (the middle of the picture, under
// closer.ts's TOO_BIG of its height) is then always seen whole. Everything drawn over the picture
// (the outline, the guide, the app's own preview) follows the same fit.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A phone's camera held upright, until the camera says otherwise. */
export const DEFAULT_ASPECT = 9 / 16;
/** The least share of the picture's height that shows (the rest is cut evenly top and bottom). */
export const MIN_SHOWN = 0.85;

/**
 * Whether this browser can lay the picture out so (container query units, Chrome 105 on): older
 * web views keep the cover fit, and the app's preview is placed the same way (nativeCamera.ts).
 */
export function canFit(): boolean {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("height: 1cqh");
  } catch {
    return false;
  }
}

/** The picture's place in `box` for a picture `aspect` (width over height) wide: centred, see above. */
export function fitPicture(box: Box, aspect: number): Box {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : DEFAULT_ASPECT;
  const height = Math.min(Math.max(box.height, box.width / a), box.height / MIN_SHOWN);
  const width = height * a;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** The part of a w × h picture that shows in a box of `view`'s size, in the box's pixels. */
export function visibleView(view: { width: number; height: number }, w: number, h: number): { width: number; height: number } {
  if (!(view.width > 0 && view.height > 0 && w > 0 && h > 0)) return view;
  // (A DOMRect's sizes are getters on its prototype: spread, it would give none.)
  const r = fitPicture({ left: 0, top: 0, width: view.width, height: view.height }, w / h);
  return { width: Math.min(view.width, r.width), height: Math.min(view.height, r.height) };
}
