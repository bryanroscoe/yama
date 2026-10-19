// The search box's query as removable chips: "id<=wur t:creature o:create" reads as "Fits white,
// blue, red", "Creature" and 'Says "create"'. Only plain lists of terms are split up; a query with
// "or" or parentheses is left whole, since taking one term out would change what the rest means.

export interface QueryChip {
  /** The term as typed, which removing the chip takes out of the query. */
  raw: string;
  label: string;
}

const COLORS: Record<string, string> = { w: "white", u: "blue", b: "black", r: "red", g: "green", c: "colorless" };
const COMPARE: Record<string, string> = { "<=": "at most", ">=": "at least", "<": "under", ">": "over", "=": "", ":": "" };
const NUMBERS: Record<string, string> = { mv: "Mana value", cmc: "Mana value", manavalue: "Mana value", pow: "Power", power: "Power", tou: "Toughness", toughness: "Toughness", loy: "Loyalty", loyalty: "Loyalty" };
const IS: Record<string, string> = { commander: "Can be your commander", gamechanger: "Game Changers", gc: "Game Changers", legendary: "Legendary" };

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1");

/** "wur" → "white, blue, red"; anything else (a guild name, "colorless") as typed. */
function colorWords(v: string): string {
  const letters = v.toLowerCase();
  if (/^[wubrgc]+$/.test(letters)) return [...letters].map((l) => COLORS[l]!).join(", ");
  return v;
}

/** Split on spaces outside quotes. */
export function terms(q: string): string[] {
  return q.match(/-?[^\s"]*"[^"]*"|\S+/g) ?? [];
}

function describe(term: string): string {
  const not = term.startsWith("-");
  const t = not ? term.slice(1) : term;
  const m = t.match(/^([a-z]+)(<=|>=|!=|<|>|=|:)(.+)$/i);
  let label: string;
  if (!m) {
    label = `Named "${unquote(t)}"`;
  } else {
    const key = m[1]!.toLowerCase();
    const op = m[2]!;
    const value = unquote(m[3]!);
    if (["id", "ci", "identity", "commander"].includes(key)) {
      label = op === "<=" || op === ":" ? `Fits ${colorWords(value)}` : op === ">=" ? `Includes ${colorWords(value)}` : `Exactly ${colorWords(value)}`;
    } else if (["c", "color", "colour"].includes(key)) {
      label = op === "<=" ? `At most ${colorWords(value)}` : op === ">=" || op === ":" ? `Includes ${colorWords(value)}` : `Exactly ${colorWords(value)}`;
    } else if (["t", "type"].includes(key)) {
      label = cap(value);
    } else if (["o", "oracle"].includes(key)) {
      label = `Says "${value}"`;
    } else if (["kw", "keyword"].includes(key)) {
      label = `Has ${value.toLowerCase()}`;
    } else if (NUMBERS[key]) {
      const word = COMPARE[op] ?? op;
      label = `${NUMBERS[key]} ${word ? `${word} ` : ""}${value}`;
    } else if (key === "is") {
      label = IS[value.toLowerCase()] ?? cap(value);
    } else if (["f", "format", "legal"].includes(key)) {
      label = `Legal in ${cap(value)}`;
    } else if (["r", "rarity"].includes(key)) {
      label = `${cap(value)} rarity`;
    } else if (["s", "set", "e", "edition"].includes(key)) {
      label = `From ${value.toUpperCase()}`;
    } else {
      label = t;
    }
  }
  return not ? `Not ${label[0]!.toLowerCase()}${label.slice(1)}` : label;
}

/** The chips for a query, or none when the query can't be split safely. */
export function queryChips(q: string): QueryChip[] {
  const parts = terms(q.trim());
  if (parts.length === 0) return [];
  if (/[()]/.test(q) || parts.some((p) => p.toLowerCase() === "or")) return [];
  return parts.map((raw) => ({ raw, label: describe(raw) }));
}

/** The query with one term taken out. */
export function withoutTerm(q: string, raw: string): string {
  const parts = terms(q.trim());
  const i = parts.indexOf(raw);
  if (i >= 0) parts.splice(i, 1);
  return parts.join(" ");
}

