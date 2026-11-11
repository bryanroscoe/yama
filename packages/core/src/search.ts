// Offline card search: the same subset of Scryfall syntax as server/src/cards/search.rs,
// compiled to a predicate over the compact card list the app keeps on the device.
// Keep the two in step.
//
// The device keeps each card once, with no printings, no prices and no Reserve List. So `set:`,
// `a:`, `year`, `usd` and `is:reserved` are read as the server reads them (a bad value or
// operator is the same error) and then refused with a reason (`needsConnection`), instead of
// quietly finding nothing. The orders by price and first release fall back to the name order
// (`orderUsed`), which the page says.

export interface OfflineCard {
  /** oracle_id */
  i: string;
  /** name */
  n: string;
  /** mana cost */
  m: string | null;
  /** mana value */
  v: number;
  /** type line */
  t: string;
  /** rules text */
  o: string;
  /** colors, WUBRG subset */
  c: string;
  /** color identity */
  ci: string;
  p: string | null;
  th: string | null;
  l: string | null;
  r: string | null;
  /** keywords, lowercased */
  k: string[];
  /** legality by format, only formats we search: commander, standard, modern, pauper, ... */
  f: Record<string, string>;
  /** layout */
  y: string | null;
  /** image (normal) */
  img: string | null;
  /** EDHREC rank */
  e: number | null;
  /** On the Commander Game Changers list. The server only sends it when true. */
  g?: boolean;
}

export interface SearchOptions {
  /**
   * Whether the card list carries Game Changer flags. When false, `is:gamechanger` throws
   * instead of matching nothing, because a missing flag then means unknown, not false.
   * Defaults to true.
   */
  gameChangers?: boolean;
}

export const GAME_CHANGERS_NOT_LOADED = "The Game Changer list isn't loaded yet, so is:gamechanger can't be searched.";

/** Why a search that needs printings, prices or the Reserve List can't run on the device. */
export function needsConnection(what: string): string {
  const why = what === "the Reserve List" ? "the copy on this device doesn't say which cards are on it" : "the copy on this device has each card's rules text, not its printings or prices";
  return `Searching by ${what} needs a connection: ${why}.`;
}

/** A number as the server's parser reads one: decimal digits, no hex and no spaces. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

type Pred = (c: OfflineCard) => boolean;

type Tok =
  | { k: "(" }
  | { k: ")" }
  | { k: "or" }
  | { k: "neg" }
  | { k: "term"; key: string | null; op: string; value: string; exact: boolean };

const OPS = ["<=", ">=", "!=", ":", "=", "<", ">"];

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ k: c });
      i++;
      continue;
    }
    if (c === "-" && i + 1 < s.length && !/\s/.test(s[i + 1]!)) {
      out.push({ k: "neg" });
      i++;
      continue;
    }
    const exact = c === "!";
    if (exact) i++;
    const start = i;
    while (i < s.length && /[a-zA-Z]/.test(s[i]!)) i++;
    const word = s.slice(start, i);
    const op = OPS.find((o) => s.startsWith(o, i));
    let key: string | null = null;
    let operator = ":";
    if (op && word && !exact) {
      key = word.toLowerCase();
      operator = op;
      i += op.length;
    } else {
      i = start;
    }
    let value: string;
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) throw new Error("unclosed quote");
      value = s.slice(i + 1, end);
      i = end + 1;
    } else {
      const vstart = i;
      while (i < s.length && !/\s/.test(s[i]!) && s[i] !== "(" && s[i] !== ")") i++;
      value = s.slice(vstart, i);
    }
    if (!key && !exact && value.toLowerCase() === "or") {
      out.push({ k: "or" });
      continue;
    }
    if (!key && !exact && value.toLowerCase() === "and") continue;
    if (!value && key) throw new Error(`${key}${operator} needs a value`);
    if (value) out.push({ k: "term", key, op: operator, value, exact });
  }
  return out;
}

const COLOR_NAMES: Record<string, string> = {
  white: "w", blue: "u", black: "b", red: "r", green: "g", c: "", colorless: "",
  azorius: "wu", dimir: "ub", rakdos: "br", gruul: "rg", selesnya: "gw", orzhov: "wb", izzet: "ur",
  golgari: "bg", boros: "rw", simic: "gu", bant: "gwu", esper: "wub", grixis: "ubr", jund: "brg",
  naya: "rgw", abzan: "wbg", jeskai: "urw", sultai: "bgu", mardu: "rwb", temur: "gur",
  wubrg: "wubrg", fivecolor: "wubrg", "5c": "wubrg",
};

function parseColors(v: string): string | null {
  const lower = v.toLowerCase();
  if (["m", "multicolor", "multicolored"].includes(lower)) return null;
  const named = COLOR_NAMES[lower] ?? lower;
  const bad = [...named].find((ch) => !"wubrg".includes(ch));
  if (bad) throw new Error(`unknown color '${bad}'`);
  return [..."WUBRG"].filter((ch) => named.includes(ch.toLowerCase())).join("");
}

function colorPred(get: (c: OfflineCard) => string, op: string, value: string, defaultOp: string): Pred {
  const set = parseColors(value);
  if (set === null) return (c) => get(c).length >= 2;
  const o = op === ":" ? defaultOp : op;
  const includes = (x: string) => [...set].every((ch) => x.includes(ch));
  const within = (x: string) => [...x].every((ch) => set.includes(ch));
  switch (o) {
    case ">=":
      return (c) => includes(get(c));
    case "<=":
      return (c) => within(get(c));
    case "=":
      return (c) => includes(get(c)) && within(get(c));
    case "!=":
      return (c) => !(includes(get(c)) && within(get(c)));
    case ">":
      return (c) => includes(get(c)) && get(c).length > set.length;
    case "<":
      return (c) => within(get(c)) && get(c).length < set.length;
    default:
      throw new Error(`unsupported operator ${o}`);
  }
}

function numPred(get: (c: OfflineCard) => number | null, op: string, value: string): Pred {
  const n = Number(value);
  if (!Number.isFinite(n) || value.trim() === "") throw new Error(`${value} isn't a number`);
  return (c) => {
    const x = get(c);
    if (x === null || Number.isNaN(x)) return false;
    switch (op) {
      case ":":
      case "=":
        return x === n;
      case "!=":
        return x !== n;
      case "<":
        return x < n;
      case "<=":
        return x <= n;
      case ">":
        return x > n;
      case ">=":
        return x >= n;
      default:
        return false;
    }
  };
}

const num = (s: string | null) => (s === null ? null : Number.parseFloat(s));
const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** `is:` values that are a card layout (Scryfall's `layout`), by the layout they name. */
const IS_LAYOUTS = new Map([["mdfc", "modal_dfc"], ["transform", "transform"], ["split", "split"], ["flip", "flip"], ["meld", "meld"], ["leveler", "leveler"]]);
const DFC_LAYOUTS = ["transform", "modal_dfc", "meld", "reversible_card"];
/** Keywords that let two cards share the command zone (`is:partner`), lowercased. */
const PARTNER_KEYWORDS = ["partner", "partner with", "friends forever", "choose a background", "doctor's companion"];
const anyType = (words: string[]): Pred => (c) => words.some((w) => c.t.includes(w));

function term(key: string | null, op: string, value: string, exact: boolean, opts: SearchOptions): Pred {
  if (!key) {
    if (exact) {
      const v = value.toLowerCase();
      return (c) => c.n.toLowerCase() === v || c.n.toLowerCase().split(" // ").includes(v);
    }
    return (c) => has(c.n, value);
  }
  switch (key) {
    case "o":
    case "oracle":
    case "text":
      if (value.includes("~")) {
        const parts = value.toLowerCase().split("~");
        return (c) => c.o.toLowerCase().includes(parts.join(c.n.toLowerCase()));
      }
      return (c) => has(c.o, value);
    case "t":
    case "type":
      return (c) => has(c.t, value);
    case "name":
      return (c) => has(c.n, value);
    case "kw":
    case "keyword":
      return (c) => c.k.includes(value.toLowerCase());
    case "c":
    case "color":
    case "colors":
      return colorPred((c) => c.c, op, value, ">=");
    case "id":
    case "identity":
    case "ci":
      return colorPred((c) => c.ci, op, value, "<=");
    case "mv":
    case "cmc":
    case "manavalue":
      return numPred((c) => c.v, op, value);
    case "pow":
    case "power":
      return numPred((c) => num(c.p), op, value);
    case "tou":
    case "toughness":
      return numPred((c) => num(c.th), op, value);
    case "loy":
    case "loyalty":
      return numPred((c) => num(c.l), op, value);
    case "r":
    case "rarity": {
      const map: Record<string, string> = { c: "common", u: "uncommon", r: "rare", m: "mythic", s: "special" };
      const r = map[value.toLowerCase()] ?? value.toLowerCase();
      if (!Object.values(map).includes(r)) throw new Error(`unknown rarity ${value}`);
      return (c) => c.r === r;
    }
    case "f":
    case "format":
    case "legal": {
      const f = value.toLowerCase();
      return (c) => c.f[f] === "legal" || c.f[f] === "restricted";
    }
    case "banned": {
      const f = value.toLowerCase();
      return (c) => c.f[f] === "banned";
    }
    case "is":
      switch (value.toLowerCase()) {
        case "commander":
          return (c) =>
            (c.t.includes("Legendary") && (c.t.includes("Creature") || c.t.includes("Vehicle") || c.t.includes("Spacecraft"))) ||
            has(c.o, "can be your commander");
        case "legendary":
          return (c) => c.t.includes("Legendary");
        case "permanent":
          return (c) => !c.t.includes("Instant") && !c.t.includes("Sorcery");
        case "spell":
          return (c) => !c.t.includes("Land");
        case "multicolor":
        case "multicolored":
          return (c) => c.c.length >= 2;
        case "gamechanger":
        case "gc":
          if (opts.gameChangers === false) throw new Error(GAME_CHANGERS_NOT_LOADED);
          return (c) => c.g === true;
        case "reserved":
          throw new Error(needsConnection("the Reserve List"));
        case "partner":
          return (c) => c.k.some((k) => PARTNER_KEYWORDS.includes(k));
        case "companion":
          return (c) => c.k.includes("companion");
        case "dfc":
          return (c) => DFC_LAYOUTS.includes(c.y ?? "");
        case "vanilla":
          return (c) => c.t.includes("Creature") && c.o === "";
        case "historic":
          return anyType(["Legendary", "Artifact", "Saga"]);
        // A party is made of creatures: a Wizard's staff isn't one.
        case "party": {
          const member = anyType(["Cleric", "Rogue", "Warrior", "Wizard"]);
          return (c) => c.t.includes("Creature") && member(c);
        }
        // By the type line, not the layout: a Saga that transforms is still a Saga, and an Omen
        // shares the Adventure layout without being one.
        case "saga":
          return (c) => c.t.includes("Saga");
        case "adventure":
          return (c) => (c.y ?? "") === "adventure" && c.t.includes("Adventure");
        case "outlaw":
          return anyType(["Assassin", "Mercenary", "Pirate", "Rogue", "Warlock"]);
        // A hybrid symbol is two halves that aren't Phyrexian: {W/U}, {2/W}, not {W/P}.
        case "hybrid":
          return (c) => /\{[WUBRGC2]\/[WUBRGC]/.test(c.m ?? "");
        // Phyrexian mana in the cost or in the text (Spellskite's ability).
        case "phyrexian":
          return (c) => (c.m ?? "").includes("/P}") || c.o.includes("/P}");
        default: {
          const layout = IS_LAYOUTS.get(value.toLowerCase());
          if (!layout) throw new Error(`unsupported is:${value}`);
          return (c) => (c.y ?? "") === layout;
        }
      }
    case "set":
    case "s":
    case "e":
    case "edition":
      if (op !== ":" && op !== "=") throw new Error(`${key} takes : or =, not ${op}`);
      throw new Error(needsConnection("set"));
    case "a":
    case "artist":
      if (op !== ":" && op !== "=") throw new Error(`${key} takes : or =, not ${op}`);
      throw new Error(needsConnection("artist"));
    case "year": {
      const n = Number(value);
      if (!DECIMAL.test(value) || !Number.isInteger(n) || n < 1990 || n > 2200) throw new Error(`${value} isn't a year`);
      throw new Error(needsConnection("year"));
    }
    case "usd": {
      const amount = value.replace(/^\$+/, "");
      if (!DECIMAL.test(amount) || !Number.isFinite(Number(amount))) throw new Error(`${value} isn't a price`);
      throw new Error(needsConnection("price"));
    }
    default:
      throw new Error(`unsupported keyword ${key}:`);
  }
}

export function compileSearch(query: string, opts: SearchOptions = {}): Pred {
  const toks = lex(query);
  let pos = 0;
  const peek = () => toks[pos];

  const expr = (): Pred => {
    const parts = [and()];
    while (peek()?.k === "or") {
      pos++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0]! : (c) => parts.some((p) => p(c));
  };
  const and = (): Pred => {
    const parts: Pred[] = [];
    while (peek() && peek()!.k !== "or" && peek()!.k !== ")") parts.push(unary());
    if (!parts.length) throw new Error("empty expression");
    return parts.length === 1 ? parts[0]! : (c) => parts.every((p) => p(c));
  };
  const unary = (): Pred => {
    if (peek()?.k === "neg") {
      pos++;
      const inner = atom();
      return (c) => !inner(c);
    }
    return atom();
  };
  const atom = (): Pred => {
    const t = toks[pos++];
    if (!t) throw new Error("unexpected end");
    if (t.k === "(") {
      const inner = expr();
      if (toks[pos++]?.k !== ")") throw new Error("missing ')'");
      return inner;
    }
    if (t.k === "term") return term(t.key, t.op, t.value, t.exact, opts);
    throw new Error("unexpected token");
  };

  if (!toks.length) return () => true;
  const pred = expr();
  if (pos < toks.length) throw new Error("unexpected ')'");
  return pred;
}

const EXTRA_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "vanguard", "scheme", "planar"]);

/**
 * The name a query types, for ordering: its bare words and quoted phrases joined by spaces,
 * lowercased ("sol ring t:artifact" gives "sol ring"). Words that are negated (alone or inside a
 * negated group, `-(sol ring) lotus`) or exact (`!`), and keyed terms, aren't part of it. Null
 * when the query names nothing, or can't be read.
 * The same as `name_phrase` in server/src/cards/search.rs: keep the two in step.
 */
export function namePhrase(query: string): string | null {
  let toks: Tok[];
  try {
    toks = lex(query);
  } catch {
    return null;
  }
  const words: string[] = [];
  // Whether each open group is excluded (itself negated, or inside one that is), and whether a
  // "-" is waiting for the term or group it negates.
  const groups: boolean[] = [];
  let negated = false;
  for (const t of toks) {
    const excluded = negated || (groups[groups.length - 1] ?? false);
    negated = false;
    if (t.k === "neg") negated = true;
    else if (t.k === "(") groups.push(excluded);
    else if (t.k === ")") groups.pop();
    else if (t.k === "term" && t.key === null && !t.exact && !excluded) words.push(t.value.trim().toLowerCase());
  }
  return words.join(" ") || null;
}

/**
 * Where a name stands against the typed one: 0 for exactly that name, 1 for a name that starts
 * with it, 2 for the rest (a name search matches its words anywhere in the name, so "sol ring"
 * also finds Searing Soloist). The server's `name_rank`.
 */
export function nameRank(name: string, phrase: string): 0 | 1 | 2 {
  const n = name.toLowerCase();
  return n === phrase ? 0 : n.startsWith(phrase) ? 1 : 2;
}

/**
 * The server also orders by price and by first release ("usd", "usd_asc", "released",
 * "released_asc"). The device has neither, so those fall back to the order by name.
 */
export type SearchOrder = "name" | "edhrec" | "mv" | "color" | "usd" | "usd_asc" | "released" | "released_asc";

/** The order an offline search really runs in: the name order for the ones the device can't do. */
export function orderUsed(order: string): "name" | "edhrec" | "mv" | "color" {
  return order === "edhrec" || order === "mv" || order === "color" ? order : "name";
}

export function searchOffline(
  cards: OfflineCard[],
  query: string,
  order: SearchOrder = "name",
  opts: SearchOptions = {},
): OfflineCard[] {
  const pred = compileSearch(query, opts);
  const q = query.toLowerCase();
  const extras = q.includes("t:token") || q.includes("type:token") || q.includes("t:emblem") || q.includes("include:extras");
  const hits = cards.filter((c) => (extras || !EXTRA_LAYOUTS.has(c.y ?? "")) && pred(c));
  const byName = (a: OfflineCard, b: OfflineCard) => a.n.localeCompare(b.n);
  switch (order) {
    case "mv":
      return hits.sort((a, b) => a.v - b.v || byName(a, b));
    case "edhrec":
      return hits.sort((a, b) => (a.e ?? Infinity) - (b.e ?? Infinity) || byName(a, b));
    case "color":
      return hits.sort((a, b) => a.c.length - b.c.length || a.c.localeCompare(b.c) || byName(a, b));
    default: {
      // By name; a typed name puts its exact match first, then names that start with it.
      const phrase = namePhrase(query);
      if (!phrase) return hits.sort(byName);
      return hits.sort((a, b) => nameRank(a.n, phrase) - nameRank(b.n, phrase) || byName(a, b));
    }
  }
}
