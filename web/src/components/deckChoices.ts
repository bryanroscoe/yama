/**
 * Whether a seat's choices (its deck's lists, its commanders) fit on one short row of pills on a
 * phone; otherwise they're a dropdown (Bryan, 4 Nov 2026: wrapped pills looked terrible).
 */
export function fitsSegmented(options: { label: string }[]): boolean {
  return options.length <= 3 && options.reduce((n, o) => n + o.label.length, 0) <= 24;
}
