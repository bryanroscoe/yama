// The five colors as the game prints them, used for player panels and identity pips.

export const MANA = {
  W: { name: "White", fill: "#F1E4BC", ink: "#3A3122" },
  U: { name: "Blue", fill: "#2C78C4", ink: "#F2F7FC" },
  B: { name: "Black", fill: "#4B4049", ink: "#F1EAF0" },
  R: { name: "Red", fill: "#D4472E", ink: "#FFF4F0" },
  G: { name: "Green", fill: "#2F8752", ink: "#F0FAF3" },
  C: { name: "Colorless", fill: "#A7A49A", ink: "#24231F" },
} as const;

export type ManaKey = keyof typeof MANA;

/** "UG" → ["U","G"]; "" → ["C"]. */
export function identityKeys(identity: string): ManaKey[] {
  const keys = [...identity.toUpperCase()].filter((c): c is ManaKey => "WUBRG".includes(c));
  return keys.length ? keys : ["C"];
}

/** Two-color identities name themselves after their guild, etc. Handy for deck labels. */
const NAMES: Record<string, string> = {
  WU: "Azorius", UB: "Dimir", BR: "Rakdos", RG: "Gruul", WG: "Selesnya", WB: "Orzhov", UR: "Izzet",
  BG: "Golgari", WR: "Boros", UG: "Simic", WUG: "Bant", WUB: "Esper", UBR: "Grixis", BRG: "Jund",
  WRG: "Naya", WBG: "Abzan", WUR: "Jeskai", UBG: "Sultai", WBR: "Mardu", URG: "Temur", WUBRG: "Five-color",
};

export function identityName(identity: string): string {
  const keys = identityKeys(identity);
  if (keys[0] === "C") return "Colorless";
  if (keys.length === 1) return `Mono-${MANA[keys[0]!].name.toLowerCase()}`;
  return NAMES[keys.join("")] ?? keys.join("");
}

/**
 * One fill color per player for the life counter. Each player gets a color from their own
 * identity, preferring one nobody else at the table has yet, so panels are easy to tell apart.
 * White comes last: a table of parchment panels all looks the same.
 */
export function panelFills(identities: string[]): ManaKey[] {
  const preference: ManaKey[] = ["U", "R", "G", "B", "W", "C"];
  const used = new Set<ManaKey>();
  return identities.map((id) => {
    const own = identityKeys(id).sort((a, b) => preference.indexOf(a) - preference.indexOf(b));
    const pick = own.find((k) => !used.has(k)) ?? own[0]!;
    used.add(pick);
    return pick;
  });
}
