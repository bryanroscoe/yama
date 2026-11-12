import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManaCost, OracleText, spokenText, SymbolText, symbolFile, symbolName } from "./ManaSymbols";

describe("symbolFile", () => {
  it("maps codes to Scryfall's symbol file names", () => {
    expect(symbolFile("G")).toBe("G");
    expect(symbolFile("10")).toBe("10");
    expect(symbolFile("G/U")).toBe("GU");
    expect(symbolFile("2/W")).toBe("2W");
    expect(symbolFile("W/P")).toBe("WP");
    expect(symbolFile("G/W/P")).toBe("GWP");
    expect(symbolFile("½")).toBe("HALF");
    expect(symbolFile("∞")).toBe("INFINITY");
    expect(symbolFile("CHAOS")).toBe("CHAOS");
  });

  it("refuses anything that isn't a symbol code", () => {
    expect(symbolFile("../x")).toBeNull();
    expect(symbolFile("a b")).toBeNull();
    expect(symbolFile("TOOLONGCODE")).toBeNull();
    expect(symbolFile("THIS")).toBeNull();
  });
});

describe("symbolName", () => {
  it("names symbols for screen readers", () => {
    expect(symbolName("G")).toBe("green");
    expect(symbolName("T")).toBe("tap");
    expect(symbolName("G/U")).toBe("green or blue");
    expect(symbolName("2/W")).toBe("2 or white");
    expect(symbolName("W/P")).toBe("Phyrexian white");
  });
});

describe("rendering", () => {
  it("draws a mana cost as symbol images with no raw braces showing", () => {
    const html = renderToStaticMarkup(<ManaCost cost="{2}{G/U}" />);
    expect(html).toContain('src="https://svgs.scryfall.io/card-symbols/2.svg"');
    expect(html).toContain('src="https://svgs.scryfall.io/card-symbols/GU.svg"');
    expect(html).toContain('aria-label="mana cost 2, green or blue"');
    expect(html.replace(/alt="[^"]*"/g, "")).not.toMatch(/\{/);
  });

  it("joins the faces of a split card", () => {
    const html = renderToStaticMarkup(<ManaCost cost="{1}{R} // {3}{U}" />);
    expect(html).toContain("//");
    expect(html).toContain("then");
  });

  it("keeps the words around symbols in rules text", () => {
    const html = renderToStaticMarkup(<SymbolText text="{T}: Add {G}." />);
    expect(html).toContain("T.svg");
    expect(html).toContain(": Add ");
    expect(html).toContain("G.svg");
    expect(html).toContain('alt="{T}"');
  });

  it("leaves text that only looks like braces alone", () => {
    expect(renderToStaticMarkup(<SymbolText text="a {weird thing}" />)).toBe("a {weird thing}");
  });

  it("puts each line of Oracle text in its own paragraph", () => {
    const html = renderToStaticMarkup(<OracleText text={"Flying\n{1}: Draw a card."} />);
    expect(html.match(/<p>/g)).toHaveLength(2);
  });
});

describe("spokenText", () => {
  it("reads symbols by name for string-only labels", () => {
    expect(spokenText("Pay {2}{R}.")).toBe("Pay 2 red.");
    expect(spokenText("Choose a mode")).toBe("Choose a mode");
    expect(spokenText("{T}: Add {G}")).toBe("tap: Add green");
  });
});
