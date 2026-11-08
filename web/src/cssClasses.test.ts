import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every stylesheet is global once loaded, so a bare `.name {` rule in two files styles both
// pages. The table picker's `.combo-list` (an absolute dropdown) once hid the deck page's
// combo lists this way. Give each page its own class names instead.
const SRC = fileURLToPath(new URL(".", import.meta.url));

// Older clashes, not yet untangled. Don't add to this list.
const KNOWN = new Set([".link-button", ".rail-foot"]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

describe("stylesheets", () => {
  it("don't define the same bare class rule in two files", () => {
    const owners = new Map<string, Set<string>>();
    for (const file of cssFiles(SRC)) {
      for (const [, name = ""] of readFileSync(file, "utf8").matchAll(/^(\.[A-Za-z][\w-]*)\s*\{/gm)) {
        const files = owners.get(name) ?? new Set<string>();
        files.add(relative(SRC, file));
        owners.set(name, files);
      }
    }
    const clashes = [...owners]
      .filter(([name, files]) => files.size > 1 && !KNOWN.has(name))
      .map(([name, files]) => `${name}: ${[...files].sort().join(", ")}`);
    expect(clashes).toEqual([]);
  });
});
