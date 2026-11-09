export interface PickerAnchor { left: number; top: number; bottom: number; width: number }
export interface PickerBounds { top: number; bottom: number }

/** Fit a scrollable list beside its field, above it when the space below is too short. */
export function pickerPlacement(anchor: PickerAnchor, viewport: { width: number; height: number }, clip?: PickerBounds) {
  const margin = 16, gap = 4;
  const top = Math.max(margin, clip?.top ?? margin);
  const bottom = Math.min(viewport.height - margin, clip?.bottom ?? viewport.height - margin);
  const width = Math.max(0, Math.min(Math.max(anchor.width, 400), viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  const below = Math.max(0, bottom - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - top);
  const preferred = Math.min(352, viewport.height / 2);
  const opensAbove = below < preferred && above > below;
  return { width, left: left - anchor.left, opensAbove, maxHeight: Math.min(preferred, opensAbove ? above : below) };
}
