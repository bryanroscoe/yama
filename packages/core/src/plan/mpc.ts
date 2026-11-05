// A MakePlayingCards order built from the Prints page's next order (ARCHITECTURE.md, "Printing
// with MakePlayingCards"). Images are community scans indexed by MPC Autofill (mpcfill.com) and
// named by their Google Drive file id; Yama stores none of them. The same order goes to Yama's
// Chrome extension (extension/mpc), which fills in MPC's project editor, or out as the
// `order.xml` MPC Autofill's desktop tool reads.

/** MPC's project sizes ("Up to N cards"), smallest first, as its quantity menu lists them on 5 Nov 2026. */
export const MPC_BRACKETS = [18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216, 234, 396, 504, 612] as const;

/** The largest project MPC takes. */
export const MPC_MAX = 612;

/** Card stocks MPC Autofill offers, by MPC's own names. Foil isn't offered on plastic. */
export const MPC_STOCKS = ["(S27) Smooth", "(S30) Standard Smooth", "(S33) Superior Smooth", "(M31) Linen", "(P10) Plastic"] as const;
export type MpcStock = (typeof MPC_STOCKS)[number];
export const MPC_DEFAULT_STOCK: MpcStock = "(S30) Standard Smooth";

/** One image MPC Autofill indexes: a Google Drive file id and what its index says about it. */
export interface MpcImage {
  id: string;
  /** The file's name in its source, e.g. "Sol Ring (Dom).png". */
  name: string;
  /** The community source (Drive folder) it comes from. */
  source: string;
  dpi: number | null;
  /** Bytes, when the index knows. */
  size: number | null;
  ext: string | null;
}

/** One physical card to print: its front, and its back face when it's double-faced. */
export interface MpcCard {
  card: string;
  back: string | null;
}

export interface MpcSlotImage {
  id: string;
  /** A file name for the upload: the card's name and the image's extension. */
  name: string;
  /** The card name it was found by, as MPC Autofill's order file records it. */
  query: string;
  /** 0-based positions in the project. */
  slots: number[];
}

export interface MpcOrder {
  v: 1;
  /** Saved as the project's name when the person is signed in to MPC. */
  name: string;
  stock: MpcStock;
  foil: boolean;
  /** Cards in the project. */
  quantity: number;
  /** The MPC project size that holds them. */
  bracket: number;
  fronts: MpcSlotImage[];
  /** Backs other than the common card back (double-faced cards). */
  backs: MpcSlotImage[];
  /** The common card back's image id. */
  cardback: string;
}

/** The smallest MPC project size that holds `n` cards, or null past the largest. */
export function mpcBracket(n: number): number | null {
  return MPC_BRACKETS.find((b) => b >= n) ?? null;
}

/** A Google Drive file id as MPC Autofill names images: nothing else may reach the extension. */
export function isDriveId(id: string): boolean {
  return /^[A-Za-z0-9_-]{20,80}$/.test(id);
}

/** MPC Autofill's search key for a card name: lower case, one space. */
export function mpcQuery(card: string): string {
  return card.toLowerCase().replace(/\s+/g, " ").trim();
}

const fileName = (card: string, img: MpcImage) => `${card.replace(/[\\/:*?"<>|]/g, "")}.${img.ext ?? "png"}`;

export interface MpcBuild {
  order: MpcOrder | null;
  /** Card names (fronts or back faces) with no image chosen. */
  missing: string[];
  /** Why there's no order, if there isn't one. */
  problem: string | null;
}

/**
 * The order for `cards`, one slot each in the order given. `pick` names the image for a card name
 * on a face (a back face can share its front's name, as on a reversible card). A card without one is reported as missing, and there's no order until
 * every card has an image: a project with a blank slot would print blank.
 */
export function mpcOrder(
  cards: MpcCard[],
  pick: (card: string, face: "front" | "back") => MpcImage | null,
  opts: { stock: MpcStock; foil: boolean; cardback: MpcImage | null; name: string },
): MpcBuild {
  const missing = new Set<string>();
  const fronts = new Map<string, MpcSlotImage>();
  const backs = new Map<string, MpcSlotImage>();
  const add = (into: Map<string, MpcSlotImage>, card: string, slot: number, face: "front" | "back") => {
    const img = pick(card, face);
    if (!img || !isDriveId(img.id)) {
      missing.add(card);
      return;
    }
    const at = into.get(img.id);
    if (at) at.slots.push(slot);
    else into.set(img.id, { id: img.id, name: fileName(card, img), query: mpcQuery(card), slots: [slot] });
  };
  cards.forEach((c, slot) => {
    add(fronts, c.card, slot, "front");
    if (c.back) add(backs, c.back, slot, "back");
  });
  const bracket = mpcBracket(cards.length);
  const problem = !cards.length
    ? "No cards to print."
    : bracket == null
      ? `${cards.length} cards is more than MakePlayingCards takes in one project (${MPC_MAX}).`
      : missing.size
        ? `No image chosen for ${[...missing].join(", ")}.`
        : !opts.cardback || !isDriveId(opts.cardback.id)
          ? "No card back chosen."
          : opts.foil && opts.stock === "(P10) Plastic"
            ? "MakePlayingCards doesn't print foil on plastic."
            : null;
  const order: MpcOrder | null =
    problem || bracket == null || !opts.cardback
      ? null
      : { v: 1, name: opts.name, stock: opts.stock, foil: opts.foil, quantity: cards.length, bracket, fronts: [...fronts.values()], backs: [...backs.values()], cardback: opts.cardback.id };
  return { order, missing: [...missing], problem };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The order as MPC Autofill's desktop tool reads it (`order.xml`). */
export function mpcXml(o: MpcOrder): string {
  const cards = (xs: MpcSlotImage[]) =>
    xs
      .map((c) => `        <card>\n            <id>${esc(c.id)}</id>\n            <slots>${c.slots.join(",")}</slots>\n            <name>${esc(c.name)}</name>\n            <query>${esc(c.query)}</query>\n        </card>\n`)
      .join("");
  return (
    `<order>\n    <details>\n        <quantity>${o.quantity}</quantity>\n        <bracket>${o.bracket}</bracket>\n` +
    `        <stock>${esc(o.stock)}</stock>\n        <foil>${o.foil}</foil>\n    </details>\n` +
    `    <fronts>\n${cards(o.fronts)}    </fronts>\n` +
    (o.backs.length ? `    <backs>\n${cards(o.backs)}    </backs>\n` : "") +
    `    <cardback>${esc(o.cardback)}</cardback>\n</order>\n`
  );
}
