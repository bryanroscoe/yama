// Small text helpers for the online board.

/** Engine prompts arrive in Title Case ("Discard To Hand Size: Sol Ring"); show the kind in
 * sentence case and leave the card name after the colon alone. Single capitals (X) stay. */
export function promptText(prompt: string): string {
  const cut = prompt.indexOf(": ");
  const kind = cut < 0 ? prompt : prompt.slice(0, cut);
  const rest = cut < 0 ? "" : prompt.slice(cut);
  const words = kind.split(" ").map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w));
  return words.join(" ") + rest;
}

/** A card's name for a small name bar: legendary names up to the comma ("Éowyn"). */
export const shortName = (name: string) => name.split(", ")[0]!;
