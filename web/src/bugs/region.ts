// What a bug report says about the part of the screen someone pointed at (BugReport.tsx): the
// box, the words and controls inside it, and where it sits in the page. Words only: no
// screenshot, so no card images or other people's pictures are copied (server/src/bug_reports.rs).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region extends Box {
  /** The words inside the box, in page order, at most TEXT_MAX characters. */
  text: string;
  /** Buttons, links and fields inside the box, by name. */
  controls: string[];
  /** Pictures inside the box, by their alt text (card names). */
  images: string[];
  /** Where it is: the element that holds it all and its ancestors, "main.page › ul.cards". */
  path: string;
}

export const TEXT_MAX = 1500;
const LIST_MAX = 20;
const NAME_MAX = 80;

/** The box from two corners, in either order. */
export function boxFrom(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) };
}

export function overlaps(a: Box, r: { left: number; top: number; right: number; bottom: number }): boolean {
  return r.right > a.x && r.left < a.x + a.w && r.bottom > a.y && r.top < a.y + a.h && r.right > r.left && r.bottom > r.top;
}

/** Whitespace folded and the text cut at `max` characters, with an ellipsis when cut. */
export function squeeze(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "main.page", "button#save", "section.deck-cards": an element's tag, id and first two classes. */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id && !/^:|\d{3,}/.test(el.id) ? `#${el.id}` : "";
  const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
  return `${tag}${id}${classes}`;
}

/** The element and up to five ancestors under body, outermost first. */
export function pathOf(el: Element | null): string {
  const parts: string[] = [];
  for (let at = el; at && at !== document.body && at !== document.documentElement && parts.length < 6; at = at.parentElement) parts.unshift(describe(at));
  return parts.join(" › ");
}

/** The deepest element that holds all of `els`. */
export function commonAncestor(els: Element[]): Element | null {
  if (!els.length) return null;
  let anc: Element | null = els[0]!;
  for (const el of els.slice(1)) {
    while (anc && !anc.contains(el)) anc = anc.parentElement;
  }
  return anc;
}

/**
 * The elements under a point, skipping `skip` (the picker drawn over everything). A dialog makes
 * the page under it inert, and the browser leaves inert elements out of hit testing: the hit test
 * lifts that for the moment it takes (nothing renders or runs in between) and puts it back.
 */
export function elementsAt(x: number, y: number, skip: Element | null): Element[] {
  if (typeof document.elementsFromPoint !== "function") return [];
  const inert = [...document.querySelectorAll<HTMLElement>("[inert]")];
  const pe = skip instanceof HTMLElement ? skip.style.pointerEvents : "";
  try {
    for (const el of inert) el.inert = false;
    if (skip instanceof HTMLElement) skip.style.pointerEvents = "none";
    return document.elementsFromPoint(x, y).filter((el) => !skip?.contains(el) && el !== document.documentElement && el !== document.body);
  } finally {
    for (const el of inert) el.inert = true;
    if (skip instanceof HTMLElement) skip.style.pointerEvents = pe;
  }
}

/** The topmost element under a point. */
export function elementAt(x: number, y: number, skip: Element | null): Element | null {
  return elementsAt(x, y, skip)[0] ?? null;
}

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLInputElement).placeholder || el.textContent || "";
  return squeeze(label, NAME_MAX);
}

/** What `box` covers on screen. `skip` is the picker, left out of everything. */
export function readRegion(box: Box, skip: Element | null): Region {
  // The topmost element at a grid of points across the box, and what holds them all.
  const hits = new Set<Element>();
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const el = elementAt(box.x + (box.w * i) / steps, box.y + (box.h * j) / steps, skip);
      if (el) hits.add(el);
    }
  }
  const anchor = commonAncestor([...hits]);
  const region: Region = { ...box, text: "", controls: [], images: [], path: pathOf(anchor) };
  if (!anchor) return region;

  // The words whose lines show inside the box, and the controls and pictures that overlap it.
  const words: string[] = [];
  let length = 0;
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node && length < TEXT_MAX; node = walker.nextNode()) {
    const value = node.nodeValue?.trim();
    if (!value || skip?.contains(node)) continue;
    range.selectNodeContents(node);
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (rect && !overlaps(box, rect)) continue;
    words.push(value);
    length += value.length + 1;
  }
  region.text = squeeze(words.join(" "), TEXT_MAX);
  const seen = new Set<string>();
  for (const el of anchor.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], [role=link]")) {
    if (region.controls.length >= LIST_MAX) break;
    if (!overlaps(box, el.getBoundingClientRect())) continue;
    const name = `${el.tagName.toLowerCase()}${(el as HTMLInputElement).type && el.tagName === "INPUT" ? `[${(el as HTMLInputElement).type}]` : ""}: ${nameOf(el) || "(no name)"}`;
    if (!seen.has(name)) region.controls.push(name), seen.add(name);
  }
  for (const img of anchor.querySelectorAll("img[alt]")) {
    if (region.images.length >= LIST_MAX) break;
    const alt = squeeze(img.getAttribute("alt") ?? "", NAME_MAX);
    if (alt && overlaps(box, img.getBoundingClientRect()) && !region.images.includes(alt)) region.images.push(alt);
  }
  return region;
}
