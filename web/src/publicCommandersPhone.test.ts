import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// /commanders is drawn by the server with web/public/precons.css. On a phone each row was 272 px:
// the win rate and the games shared a second row, and the sources fold's 44 px target sat under
// the count with space above and below it.
const css = readFileSync(fileURLToPath(new URL("../public/precons.css", import.meta.url)), "utf8");
const phone = css.split("/* A phone row is the commander with its win rate beside it")[1]?.split("\n}\n")[0] ?? "";
const rule = (selector: string) => phone.split("\n").find((line) => line.trim().startsWith(`${selector} {`)) ?? "";

describe("a commander's row on a phone", () => {
  it("puts the win rate beside the commander, not under it", () => {
    expect(phone).toContain("@media(max-width:600px)");
    expect(rule(".commander-table tr")).toContain("grid-template-columns:minmax(0,1fr) auto");
    expect(rule(".commander-table .meta-cell")).toContain("grid-row:1");
  });

  it("keeps the games and the sources fold on one line, the fold dropping below when open", () => {
    expect(rule(".commander-table td:last-child")).toContain("display:flex");
    expect(rule(".commander-table td:last-child")).toContain("align-items:center");
    expect(rule(".commander-table .commander-sources[open]")).toContain("flex-basis:100%");
  });

  it("draws one rule under the row, not a second under the name", () => {
    expect(rule(".commander-table th:first-child")).toContain("border-bottom:0");
  });
});
