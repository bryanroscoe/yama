import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const px = (css: string, selector: string, property: string) => {
  const body = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
  const value = new RegExp(`${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";
  return value === "var(--gap)" ? 16 : value.endsWith("px") ? Number.parseFloat(value) : value === "0" ? 0 : Number.NaN;
};

describe("the Swap cards page", () => {
  it("leaves 24 px between the help fold and the first deck, not a band", () => {
    // The page is a grid, so the gap and both margins add up; they used to make 64 px.
    const css = read("./build-choices.css");
    const space = px(css, ".build-choices > .how-to", "margin-bottom") + px(css, ".build-choices.page", "gap") + px(css, ".build-choices > .note-decks", "margin-top");
    expect(space).toBe(24);
  });
});
