import { useState, type ReactNode } from "react";

/**
 * Mana and other card symbols ({2}, {G/U}, {T}, {W/P}) drawn as the symbols themselves.
 * The symbol art is Wizards'; we don't ship it. Each one loads from Scryfall's symbol
 * server at runtime, like card images, and falls back to its text if that fails.
 */

const SYMBOL = /\{([^{}\s]{1,12})\}/g;
/** Codes Scryfall serves: numbers, letters, hybrids and Phyrexian with slashes, half and infinity. */
const SERVED = /^(?:[0-9]+|[A-Z]{1,6}|[0-9A-Z]{1,2}(?:\/[0-9A-Z]{1,2}){1,2}|½|∞)$/;

const NAMES: Record<string, string> = {
  W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless",
  T: "tap", Q: "untap", X: "X", Y: "Y", Z: "Z", S: "snow", E: "energy", P: "Phyrexian",
  CHAOS: "chaos", PW: "planeswalker", TK: "ticket", A: "acorn", L: "legendary", D: "land drop",
  H: "half", "½": "one half", "∞": "infinity",
};

/** The file name Scryfall uses for a symbol code, or null when it isn't one it serves. */
export function symbolFile(code: string): string | null {
  const c = code.toUpperCase();
  if (!SERVED.test(c)) return null;
  if (c === "½") return "HALF";
  if (c === "∞") return "INFINITY";
  return c.replace(/\//g, "");
}

export function symbolUrl(code: string): string | null {
  const file = symbolFile(code);
  return file ? `https://svgs.scryfall.io/card-symbols/${file}.svg` : null;
}

/** What a screen reader says for a symbol: "{G/U}" is "green or blue", "{W/P}" is "Phyrexian white". */
export function symbolName(code: string): string {
  const parts = code.toUpperCase().split("/");
  const phyrexian = parts.length > 1 && parts[parts.length - 1] === "P";
  const named = (phyrexian ? parts.slice(0, -1) : parts).map((p) => NAMES[p] ?? p);
  const base = named.join(" or ");
  return phyrexian ? `Phyrexian ${base}` : base;
}

/** One symbol. Its alt text is the usual notation, so copying text keeps "{G}". */
export function ManaSymbol({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  const src = symbolUrl(code);
  if (!src || failed) return <span className="ms-text">{`{${code}}`}</span>;
  return (
    <img
      className="ms"
      src={src}
      alt={`{${code}}`}
      aria-label={symbolName(code)}
      title={symbolName(code)}
      draggable={false}
      decoding="async"
      crossOrigin="anonymous"
      onError={() => setFailed(true)}
    />
  );
}

/** Text with each {…} drawn as its symbol; everything else stays as written. */
export function SymbolText({ text }: { text: string | null | undefined }): ReactNode {
  if (!text) return null;
  if (!text.includes("{")) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SYMBOL)) {
    const at = m.index ?? 0;
    if (!symbolFile(m[1]!)) continue;
    if (at > last) out.push(text.slice(last, at));
    out.push(<ManaSymbol key={at} code={m[1]!} />);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Rules text: one paragraph per line, with symbols drawn. */
export function OracleText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return (
    <div className={className ? `oracle ${className}` : "oracle"}>
      {text.split("\n").map((line, i) => (
        <p key={i}>
          <SymbolText text={line} />
        </p>
      ))}
    </div>
  );
}

/** A card's mana cost as symbols ("{2}{G/U}"); faces of a split or modal card are joined by //. */
export function ManaCost({ cost }: { cost: string | null | undefined }) {
  if (!cost) return null;
  const faces = cost.split(/\s*\/\/\s*/);
  const spoken = faces.map((f) => [...f.matchAll(SYMBOL)].map((m) => symbolName(m[1]!)).join(", ")).join(", then ");
  return (
    <span className="mana-cost" role="img" aria-label={`mana cost ${spoken || cost}`}>
      {faces.map((f, i) => (
        <span key={i} className="mana-cost-face">
          {i > 0 && <span className="mana-cost-sep">//</span>}
          <SymbolText text={f} />
        </span>
      ))}
    </span>
  );
}
