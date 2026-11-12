import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url).pathname;

/** Every app source file that isn't a test, with comment lines dropped: what people can read. */
function shownText(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "whatsNew.ts")
        out.push({
          file: path.slice(here.length),
          text: readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
            .map((line) => line.replace(/\s\/\/ .*$/, "").replace(/\{\/\*.*?\*\/\}/g, ""))
            .join("\n"),
        });
    }
  };
  walk(here);
  return out;
}

describe("wording everyone sees", () => {
  // Yama started as one person's tool; these named his scripts, his computer and his server.
  it("doesn't name the owner's own scripts, computer or server", () => {
    const owners = [/commander-decks/, /\b(publish|pull|analyze)\.py\b/, /on the Mac\b/, /placeholder="saget"/, /Contact Bryan/, /this phone/];
    const found = shownText().flatMap(({ file, text }) => owners.filter((re) => re.test(text)).map((re) => `${file}: ${re}`));
    expect(found).toEqual([]);
  });

  it("says what a limit is instead of how the account joined", () => {
    // The admin area too: it names the allowance (standard, or the larger one an invite gives).
    const joined = [/without an invite/, /\(no invite\)/, /smaller allowance/, /power users for now/];
    const found = shownText().flatMap(({ file, text }) => joined.filter((re) => re.test(text)).map((re) => `${file}: ${re}`));
    expect(found).toEqual([]);
  });

  it("describes the app to search engines and installers without 'our playgroup'", () => {
    const index = readFileSync(join(here, "../index.html"), "utf8");
    expect(index).toMatch(/<meta name="description" content="[^"]{50,200}"/);
    const manifest = JSON.parse(readFileSync(join(here, "../public/manifest.webmanifest"), "utf8")) as { description: string };
    expect(manifest.description).not.toMatch(/our playgroup/);
    for (const page of ["about/index.html", "docs/mcp/index.html"]) expect(readFileSync(join(here, "../public", page), "utf8"), page).not.toMatch(/Contact Bryan|power users for now/);
  });
});
