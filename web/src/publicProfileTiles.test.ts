import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// /u/:handle is drawn by the server with web/public/precons.css. Its deck tiles sit in a grid
// whose rows stretch every tile to the tallest one; these rules keep what is inside lined up.
const css = readFileSync(fileURLToPath(new URL("../public/precons.css", import.meta.url)), "utf8");
const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

describe("deck tiles on a public profile", () => {
  it("give every deck the same art height, so the build links start on one line across a row", () => {
    const art = rule(".share-deck-main");
    expect(art).toContain("flex:none");
    expect(art).toContain("min-height:200px");
  });

  it("let the art fill a tile that has no build links under it", () => {
    expect(rule(".share-deck-main:only-child")).toContain("flex:1 0 auto");
  });

  it("stop a long deck name and a pair of commanders at two lines", () => {
    expect(rule(".share-deck-copy b, .share-deck-copy b + span")).toContain("-webkit-line-clamp:2");
  });
});
