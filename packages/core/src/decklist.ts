// Deck list helpers shared by the Decks pages and the planner: type groups and list text.

/** Type groups in display order. The first matching test wins, so an artifact creature is a creature. */
export const GROUPS: [string, (t: string) => boolean][] = [
  ["Creatures", (t) => t.includes("Creature")],
  ["Planeswalkers", (t) => t.includes("Planeswalker")],
  ["Instants", (t) => t.includes("Instant")],
  ["Sorceries", (t) => t.includes("Sorcery")],
  ["Artifacts", (t) => t.includes("Artifact")],
  ["Enchantments", (t) => t.includes("Enchantment")],
  ["Battles", (t) => t.includes("Battle")],
  ["Lands", (t) => t.includes("Land")],
];

/** Every group a list can show, in order. */
export const GROUP_ORDER: string[] = ["Commander", ...GROUPS.map(([g]) => g), "Other", "Sideboard"];

/**
 * The group a card shows under. Lands that are also creatures (Dryad Arbor) read as lands; the
 * front face decides for double-faced cards. An unknown type (a card Yama doesn't know yet) is "Other".
 */
export function groupOf(board: string, typeLine: string | null | undefined): string {
  if (board === "commander") return "Commander";
  if (board === "side") return "Sideboard";
  const t = (typeLine ?? "").split(" // ")[0]!;
  if (t.includes("Land")) return "Lands";
  return GROUPS.find(([, test]) => test(t))?.[0] ?? "Other";
}

export interface ListLine {
  qty: number;
  name: string;
  board: string;
}

/** Import-name normalization matching server/src/decks.rs::parse_list. No card lookup. */
export function parseDeckList(text: string): ListLine[] {
  const out: ListLine[] = [];
  let board = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.replace(/^(?:\/\/)+/, "").replace(/^#+/, "").trim().replace(/:+$/, "").toLowerCase().split(/[ (]/)[0];
    if (["commander", "commanders"].includes(header ?? "")) { board = "commander"; continue; }
    if (["deck", "main", "mainboard", "maindeck", "creatures", "lands", "spells"].includes(header ?? "")) { board = "main"; continue; }
    if (["sideboard", "side", "maybeboard", "considering"].includes(header ?? "")) { board = "side"; continue; }
    if (line.startsWith("//") || line.startsWith("#")) continue;
    const match = line.match(/^([+-]?\d+)[xX]* (.*)$/);
    const qty = match ? Number(match[1]) : 1;
    const name = (match?.[2] ?? line).split(" (")[0]!.split(" *")[0]!.split(" #")[0]!.trim();
    if (name && Number.isSafeInteger(qty) && qty > 0) out.push({ qty, name, board });
  }
  return out;
}

/** "Commander", "Deck" and "Sideboard" sections of `N Name` lines, in the order given. */
export function listText(cards: ListLine[]): string {
  const section = (title: string, board: string) => {
    const rows = cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`);
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side")].join("\n").trim();
}
