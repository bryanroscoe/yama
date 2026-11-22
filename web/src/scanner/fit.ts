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

/**
 * The part of a w × h picture that shows at digital zoom `z` in a box of `box`'s size: the middle
 * of the picture as it's laid out (fitted, or covering the box where `fit` is false, as an older
 * web view lays it out), enlarged z times around its middle and cut by the box. With the picture
 * fitted smaller than the box, zooming fills the bars, so more than the middle 1/z shows (Codex
 * review of #202). At 1× the whole frame is used, as before.
 */
export function zoomRegion(w: number, h: number, z: number, box?: { width: number; height: number } | null, fit = canFit()): { x: number; y: number; w: number; h: number } {
  if (z <= 1) return { x: 0, y: 0, w, h };
  let rw = w / z;
  let rh = h / z;
  if (box && box.width > 0 && box.height > 0 && w > 0 && h > 0) {
    // Box pixels per picture pixel, before the zoom. (A DOMRect's sizes are getters: read them.)
    const s = fit ? fitPicture({ left: 0, top: 0, width: box.width, height: box.height }, w / h).height / h : Math.max(box.width / w, box.height / h);
    rw = Math.min(w, box.width / (s * z));
    rh = Math.min(h, box.height / (s * z));
  }
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}
