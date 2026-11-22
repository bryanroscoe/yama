// How the camera's picture fits its box (Bryan, 22 Nov 2026: "when the little drawer is up a little
// bit from the bottom you can't see the full card either"). The picture always shows its whole
// height, centred: a box narrower than the picture cuts its sides (as a cover fit would), and a box
// wider than it, as the camera left above a raised sheet is, shows dark bars at the sides rather
// than cutting the top and bottom. A held card is taller than it is wide, so a cover fit there cut
// it off top and bottom while the scanner went on reading the whole frame. Everything drawn over
// the picture (the outline, the guide, the app's own preview) follows the same fit.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A phone's camera held upright, until the camera says otherwise. */
export const DEFAULT_ASPECT = 9 / 16;

/** The picture's place in `box` for a picture `aspect` (width over height) wide: its full height, centred. */
export function fitHeight(box: Box, aspect: number): Box {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : DEFAULT_ASPECT;
  const width = box.height * a;
  return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
}

/** The part of a w × h picture that shows in a box of `view`'s size, fitted by `fitHeight`. */
export function visibleView(view: { width: number; height: number }, w: number, h: number): { width: number; height: number } {
  if (!(view.width > 0 && view.height > 0 && w > 0 && h > 0)) return view;
  return { width: Math.min(view.width, (view.height * w) / h), height: view.height };
}
