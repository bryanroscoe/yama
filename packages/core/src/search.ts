// Offline card search: the same subset of Scryfall syntax as server/src/cards/search.rs,
// compiled to a predicate over the compact card list the app keeps on the device.
// Keep the two in step.

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
}

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

function term(key: string | null, op: string, value: string, exact: boolean): Pred {
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
        default:
          throw new Error(`unsupported is:${value}`);
      }
    default:
      throw new Error(`unsupported keyword ${key}:`);
  }
}

export function compileSearch(query: string): Pred {
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
    if (t.k === "term") return term(t.key, t.op, t.value, t.exact);
    throw new Error("unexpected token");
  };

  if (!toks.length) return () => true;
  const pred = expr();
  if (pos < toks.length) throw new Error("unexpected ')'");
  return pred;
}

const EXTRA_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "vanguard", "scheme", "planar"]);

export function searchOffline(cards: OfflineCard[], query: string, order: "name" | "edhrec" | "mv" | "color" = "name"): OfflineCard[] {
  const pred = compileSearch(query);
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
    default:
      return hits.sort(byName);
  }
}
