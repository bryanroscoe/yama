// Parse what OCR read from a card's bottom-left collector line.
//
// Printed formats we handle (examples read from real Scryfall scans):
//   2023 on:  "C 0214"      over "MOM • EN  [brush] Ryan Valle"
//   2015-22:  "030/280 U"   over "M19 • EN  [brush] Yongjae Choi"
//   showcase: "290   M"     over "DMU • EN"
//   2003-14:  "™ & © 2012 Wizards of the Coast 59/274" (number only, no set code)
// OCR mangles the bullet into "*", "+", "-", "«", "e" and so on, and confuses 0/O, 1/I/L, 5/S, 8/B.

export interface CollectorRead {
  /** Set code candidates, best first, already checked against the catalog when one is given. */
  sets: string[];
  /** Collector number candidates, best first ("214", not "0214"). */
  numbers: string[];
  lang: string;
  /** True when a language token ("EN", "DE", ...) anchored the set code. */
  anchored: boolean;
  /** Set codes read exactly as printed (no lookalike substitution needed). */
  exactSets: string[];
  /** What OCR read where the set code goes, lowercased, whether or not it is a real set. */
  rawSets: string[];
  /** Numbers in the printed format ("0214", "030/280"), as opposed to a stray digit. */
  strongNumbers: string[];
}

/** Language codes as printed on cards, mapped to Scryfall's codes. */
const LANGS: Record<string, string> = {
  EN: "en",
  DE: "de",
  FR: "fr",
  IT: "it",
  ES: "es",
  SP: "es",
  PT: "pt",
  JP: "ja",
  JA: "ja",
  KO: "ko",
  KR: "ko",
  RU: "ru",
  CS: "zhs",
  ZHS: "zhs",
  CT: "zht",
  ZHT: "zht",
  PH: "ph",
};

/** Characters OCR mixes up, in both directions. */
const LOOKALIKE: Record<string, string[]> = {
  "0": ["O", "D", "Q"],
  O: ["0", "D", "Q"],
  D: ["O", "0"],
  Q: ["O", "0"],
  "1": ["I", "L", "T"],
  I: ["1", "L", "T"],
  L: ["1", "I"],
  T: ["1", "I"],
  "5": ["S"],
  S: ["5"],
  "8": ["B"],
  B: ["8"],
  "2": ["Z"],
  Z: ["2"],
  "6": ["G"],
  G: ["6"],
  "4": ["A"],
  A: ["4"],
  "7": ["T"],
  U: ["V"],
  V: ["U"],
};

const DIGIT_FIX: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", "|": "1", "!": "1", S: "5", B: "8", Z: "2", G: "6", A: "4" };

/** Spelling variants of a set code within `maxSwaps` lookalike substitutions, original first. */
export function setVariants(raw: string, maxSwaps = 2): string[] {
  const up = raw.toUpperCase();
  const out = new Set<string>([up]);
  let frontier = [up];
  for (let swap = 0; swap < maxSwaps; swap += 1) {
    const next: string[] = [];
    for (const s of frontier) {
      for (let i = 0; i < s.length; i += 1) {
        for (const alt of LOOKALIKE[s[i]!] ?? []) {
          const v = s.slice(0, i) + alt + s.slice(i + 1);
          if (!out.has(v)) {
            out.add(v);
            next.push(v);
          }
        }
      }
    }
    frontier = next;
  }
  return [...out].map((s) => s.toLowerCase());
}

/** "0214" -> "214"; keeps letter suffixes and stars ("107p", "1F★"). */
export function normaliseNumber(n: string): string {
  const m = /^0*(\d+)(.*)$/.exec(n);
  if (!m) return n;
  return (m[1] === "" ? "0" : m[1]!) + m[2]!.toLowerCase();
}

function numberCandidates(text: string): { n: string; score: number }[] {
  const found: { n: string; score: number }[] = [];
  // Treat lookalike letters as digits when they sit inside a digit run ("O2I4" -> "0214").
  const tokens = text.toUpperCase().split(/[^0-9A-Z|!/★*]+/).filter(Boolean);
  for (const tok of tokens) {
    // "030/280" -> "030"; a lone total is still a guess.
    const [head, total] = tok.split("/");
    if (!head) continue;
    const digitish = [...head].filter((c) => /[0-9]/.test(c) || c in DIGIT_FIX).length;
    const realDigits = [...head].filter((c) => /[0-9]/.test(c)).length;
    if (realDigits === 0 || digitish < head.length - 1) continue;
    let fixed = "";
    for (let i = 0; i < head.length; i += 1) {
      const c = head[i]!;
      if (/[0-9]/.test(c)) fixed += c;
      else if (i === head.length - 1 && /[A-Z★*]/.test(c) && !(c in DIGIT_FIX)) fixed += c === "*" ? "★" : c; // suffix
      else fixed += DIGIT_FIX[c] ?? "";
    }
    const digits = fixed.replace(/\D/g, "");
    if (digits.length < 1 || digits.length > 4) continue;
    // Years from the copyright line are not collector numbers.
    if (/^(19|20)\d\d$/.test(digits) && !total && head.length === 4 && !head.startsWith("0")) continue;
    let score = 0;
    if (total) score += 2; // "030/280"
    if (head.length === 4 && head.startsWith("0")) score += 2; // "0214"
    if (realDigits === head.length) score += 1;
    found.push({ n: normaliseNumber(fixed), score });
  }
  found.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return found.filter((f) => !seen.has(f.n) && (seen.add(f.n), true));
}

/**
 * Pull the set code, collector number and language out of the OCR text of the collector line.
 * `hasSet` (from the catalog) filters set-code guesses to real sets.
 */
export function parseCollector(text: string, hasSet?: (code: string) => boolean): CollectorRead {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sets: string[] = [];
  const exactSets: string[] = [];
  const rawSets: string[] = [];
  let lang = "en";
  let anchored = false;
  const setLines = new Set<number>();

  const addSet = (raw: string) => {
    const cleaned = raw.replace(/[^0-9A-Za-z]/g, "");
    if (cleaned.length < 2 || cleaned.length > 5) return false;
    if (!rawSets.includes(cleaned.toLowerCase())) rawSets.push(cleaned.toLowerCase());
    let added = false;
    for (const v of setVariants(cleaned)) {
      if (hasSet ? hasSet(v) : /[a-z]/.test(v) && v === cleaned.toLowerCase()) {
        if (!sets.includes(v)) sets.push(v);
        if (v === cleaned.toLowerCase() && !exactSets.includes(v)) exactSets.push(v);
        added = true;
      }
    }
    return added;
  };

  // Pass 1: a set code right before a language code: "MOM • EN", "M19*EN", "DMU - EN".
  lines.forEach((line, i) => {
    const toks = line.toUpperCase().split(/[^0-9A-Z]+/).filter(Boolean);
    for (let t = 1; t < toks.length; t += 1) {
      const code = LANGS[toks[t]!];
      if (!code) continue;
      if (addSet(toks[t - 1]!)) {
        lang = code;
        anchored = true;
        setLines.add(i);
      }
    }
    // The bullet is sometimes read as a letter and glued on: "MOMeEN", "M19EEN".
    for (const tok of toks) {
      const m = /^([0-9A-Z]{3,5}?)[EO•]?(EN|DE|FR|IT|ES|PT|JP|JA|KO|RU)$/.exec(tok);
      if (m && addSet(m[1]!)) {
        lang = LANGS[m[2]!] ?? lang;
        anchored = true;
        setLines.add(i);
      }
    }
  });

  // Pass 2: no language anchor; take the first plausible token of each line.
  if (sets.length === 0) {
    lines.forEach((line, i) => {
      const toks = line.toUpperCase().split(/[^0-9A-Z]+/).filter((t) => t.length >= 3 && t.length <= 5 && /[A-Z]/.test(t));
      for (const tok of toks.slice(0, 2)) if (addSet(tok)) setLines.add(i);
    });
  }

  // The number is on the line above the set code; the artist's name follows the set code.
  const firstSetLine = setLines.size ? Math.min(...setLines) : lines.length;
  const above = lines.slice(0, firstSetLine).join("\n");
  const rest = lines.filter((_, i) => i > firstSetLine).join("\n");
  let found = numberCandidates(above);
  if (found.length === 0) found = numberCandidates(rest || text).map((f) => ({ ...f, score: f.score - 3 }));
  return {
    sets,
    numbers: found.map((f) => f.n),
    lang,
    anchored,
    exactSets,
    rawSets,
    strongNumbers: found.filter((f) => f.score >= 2).map((f) => f.n),
  };
}

/** Lowercase letters and digits only, single spaces. Used for name matching. */
export function normaliseName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
