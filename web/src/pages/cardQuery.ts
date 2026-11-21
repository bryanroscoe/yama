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
const IS: Record<string, string> = {
  commander: "Can be your commander", gamechanger: "Game Changers", gc: "Game Changers", legendary: "Legendary", reserved: "On the Reserve List",
  partner: "Partners or pairs with a Background", companion: "Can be a companion", dfc: "Double-faced", mdfc: "Modal double-faced", transform: "Transforms",
  vanilla: "No rules text", hybrid: "Hybrid mana", phyrexian: "Phyrexian mana",
};
/** "year>=2020" → "Printed in 2020 or later". */
const YEAR: Record<string, (y: string) => string> = {
  ":": (y) => `Printed in ${y}`, "=": (y) => `Printed in ${y}`, ">=": (y) => `Printed in ${y} or later`, ">": (y) => `Printed after ${y}`,
  "<=": (y) => `Printed in ${y} or earlier`, "<": (y) => `Printed before ${y}`, "!=": (y) => `Printed in a year other than ${y}`,
};

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
    } else if (["a", "artist"].includes(key)) {
      label = `Art by ${value}`;
    } else if (key === "year") {
      label = (YEAR[op] ?? YEAR[":"]!)(value);
    } else if (key === "usd") {
      // The amount as typed, not reformatted: it is the search's own number.
      const word = COMPARE[op] ?? op;
      label = `Price ${word ? `${word} ` : ""}${value.startsWith("$") ? value : `$${value}`}`;
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


// ── names for the search box ───────────────────────────────────────────────

/**
 * The card name being typed, for suggestions: the whole box when it is plain words, at least two
 * characters. Null once it holds search syntax (a keyed term, a quote, a group, an exclusion):
 * names aren't suggested into the middle of a search.
 */
export function nameBeingTyped(draft: string): string | null {
  const t = draft.trim();
  if (t.length < 2 || /[:<>=()"!]/.test(t) || /(^|\s)-\S/.test(t)) return null;
  return t;
}

/**
 * The search for a suggested name: the name itself where the search reads it as plain words, in
 * quotes where it wouldn't ("Circle of Protection: Red" has a colon, "Trick or Treat" an "or").
 * The few names with a quote mark in them lose their punctuation instead.
 */
export function nameQuery(name: string): string {
  const words = name.split(/\s+/);
  const plain = /^[\p{L}\p{N} ,'.\-/]+$/u.test(name) && !words.some((w) => w.startsWith("-") || /^(or|and)$/i.test(w));
  if (plain) return name;
  return name.includes('"') ? name.replace(/["()]/g, "").replace(/:/g, "") : `"${name}"`;
}

/** The search that finds just the card of this name: `!"Name"`. A name with a quote mark in it can't be quoted, so it is searched as words. */
export function exactNameQuery(name: string): string {
  return name.includes('"') ? nameQuery(name) : `!"${name}"`;
}

/** The card of exactly this name among some hits (any case); failing that, the only hit. */
export function cardNamed<T extends { name: string }>(cards: T[], name: string): T | undefined {
  return cards.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? (cards.length === 1 ? cards[0] : undefined);
}

/** Whether names fetched for one typed term are the ones to offer for what the box holds now. */
export function suggestionsFor(typed: string | null, fetchedFor: string): boolean {
  return typed !== null && typed.toLowerCase() === fetchedFor.toLowerCase();
}

/** The suggestion Up or Down moves to, wrapping; -1 is the box itself (nothing chosen). */
export function moveSuggestion(active: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  const next = active + step;
  return next >= count ? -1 : next < -1 ? count - 1 : next;
}

// ── when a search finds nothing, or can't be read ──────────────────────────

/** A name as compared for "Did you mean": lower case, no accents, punctuation as spaces. */
const plainName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * How many slips turn `a` into `b`: a letter added, dropped or changed, or two neighbours swapped
 * ("fier" for "fire" is one). More than `max` comes back as `max + 1`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2]! + 1);
      next.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    before = row;
    row = next;
  }
  return Math.min(row[b.length]!, max + 1);
}

/**
 * The card names closest to a misspelled one ("lightnig bolt" → "Lightning Bolt"), nearest first,
 * at most `limit`: names within a letter for every four typed (at least one). A two-faced card
 * counts by its whole name and by each face. Names equally near keep the order they came in.
 */
export function didYouMean(typed: string, names: Iterable<string>, limit = 3): string[] {
  const want = plainName(typed);
  if (want.length < 3) return [];
  const max = Math.max(1, Math.floor(want.length / 4));
  const near: { name: string; d: number }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    let d = editDistance(want, plainName(name), max);
    // A face sorts a touch behind a whole name as near: "Lightning Bolt" before "Emeritus of Conflict // Lightning Bolt".
    if (name.includes(" // ")) for (const face of name.split(" // ")) d = Math.min(d, editDistance(want, plainName(face), max) + 0.5);
    if (d <= max + 0.5) near.push({ name, d });
  }
  // Array sort is stable: names equally near stay in the order given (most played first, from the server).
  return near.sort((a, b) => a.d - b.d).slice(0, limit).map((n) => n.name);
}

/** The words of a name worth looking up on their own to find what was meant: the longest two of four letters or more. */
export function wordsToLookUp(typed: string): string[] {
  return [...new Set(plainName(typed).split(" ").filter((w) => w.length >= 4))].sort((a, b) => b.length - a.length).slice(0, 2);
}

/** ", like mv<=3" for a term left without its value ("mv<="), where there is a plain example. */
function exampleFor(term: string): string {
  const key = term.replace(/[^a-z]/gi, "").toLowerCase();
  const value = NUMBERS[key] ? "3" : ["t", "type"].includes(key) ? "dragon" : ["o", "oracle"].includes(key) ? "draw" : ["id", "ci", "identity", "commander", "c", "color", "colour"].includes(key) ? "wu" : key === "usd" ? "5" : key === "year" ? "2020" : null;
  return value ? `, like ${term}${value}` : "";
}

const SEARCH_ERRORS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^unclosed quote$/, () => 'A quote mark isn\'t closed. Add the closing " after the words.'],
  [/^(\S+) needs a value$/, (m) => `${m[1]} needs something after it${exampleFor(m[1]!)}.`],
  [/^unsupported keyword (\S+):$/, (m) => `Yama's search doesn't have "${m[1]}:".`],
  [/^unsupported is:(.+)$/, (m) => `Yama's search doesn't have is:${m[1]}.`],
  [/^unsupported operator (.+)$/, (m) => `${m[1]} can't be used with a color there. Use :, =, <= or >=.`],
  [/^(\S+) takes : or =, not (.+)$/, (m) => `${m[1]} works with : or =, not ${m[2]}.`],
  [/^unknown color '(.+)'$/, (m) => `"${m[1]}" isn't a color. Use the letters w, u, b, r, g and c.`],
  [/^unknown rarity (.+)$/, (m) => `"${m[1]}" isn't a rarity. Use common, uncommon, rare or mythic.`],
  [/^(.+) isn't a year$/, (m) => `"${m[1]}" isn't a year. Try year>=2020.`],
  [/^(.+) isn't a price$/, (m) => `"${m[1]}" isn't a price. Try usd<5.`],
  [/^(.+) isn't a number$/, (m) => `"${m[1]}" isn't a number. Try mv<=3.`],
  [/^missing '\)'$/, () => "A ( isn't closed. Add the closing )."],
  [/^unexpected '\)'$/, () => "There's a ) with no ( before it."],
  [/^empty expression$/, () => 'Something is missing: an empty ( ), or an "or" with nothing on one side.'],
  [/^unexpected (token|end)$/, () => "The search ends or breaks off where Yama expected more."],
  [/^a search can be at most (\d+) characters$/, (m) => `A search can be at most ${m[1]} characters.`],
];

/**
 * A search the grammar couldn't read, as a sentence: the server's and the device's parser both
 * answer in a few fixed lower-case words ("mv<= needs a value", "unclosed quote"). Null for a
 * message that isn't one of theirs (it may already be a sentence, or not about the query at all).
 */
export function searchErrorWords(message: string): string | null {
  for (const [pattern, words] of SEARCH_ERRORS) {
    const m = message.match(pattern);
    if (m) return words(m);
  }
  return null;
}
