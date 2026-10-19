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

/** "Commander", "Deck" and "Sideboard" sections of `N Name` lines, in the order given. */
export function listText(cards: ListLine[]): string {
  const section = (title: string, board: string) => {
    const rows = cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`);
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side")].join("\n").trim();
}
