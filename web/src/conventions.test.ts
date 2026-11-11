import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The app keeps one way of doing each common thing (design/system/shared-code.md).
// These tests fail when a page grows its own again, so it can't drift back.
const WEB = fileURLToPath(new URL(".", import.meta.url));
const CORE = fileURLToPath(new URL("../../packages/core/src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Every line matching `pattern` outside `allowed`, as "file:line: text". */
function uses(pattern: RegExp, allowed: (file: string, line: string) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const path of [...sources(WEB), ...sources(CORE)]) {
    const file = relative(ROOT, path);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // A comment may name what it replaces.
        if (/^\s*(\/\/|\/?\*)/.test(line)) return;
        if (pattern.test(line) && !allowed(file, line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  return found;
}

// The online board belongs to another stream of work; its files join these rules when it does.
const BOARD = /^web\/src\/play\//;

describe("waiting and empty states use the shared components", () => {
  it("no page writes its own waiting paragraph", () => {
    // Use <Loading>Loading the deck…</Loading> from components/ui, for any "Doing something…" line.
    const found = uses(/<(p|span|div|li)\b[^>]*>\s*[A-Z][a-z]+ing\b[^<{]*…\s*</, (file) => file === "web/src/components/ui.tsx" || BOARD.test(file));
    expect(found).toEqual([]);
  });

  it("no page styles its own empty state", () => {
    // Use <EmptyState> from components/ui; its variants are plain, boxed, panel and compact.
    // An empty card slot (a dashed outline where a card goes) and a picker's "no match" row aren't empty states.
    // The power-users-only note is a note, not an empty state.
    const slots = /\b(plan-pair-empty|mpc-thumb-empty|combo-empty|power-only)\b/;
    const found = uses(/className="(?:[^"]* )?(?:[\w-]+-)?empty(?:[" ])/, (file, line) => file === "web/src/components/ui.tsx" || BOARD.test(file) || slots.test(line));
    expect(found).toEqual([]);
  });
});

describe("choosing one of a few uses the shared control", () => {
  it("no page builds its own segmented control", () => {
    // Use <Segmented> from components/ui: a labelled group of aria-pressed buttons. The Decks
    // sections strip (DeckTabs) is the navigation form of the same track, with links.
    const found = uses(/className="(seg|segmented)\b/, (file) => file === "web/src/components/DeckTabs.tsx");
    expect(found).toEqual([]);
  });
});

describe("formatting goes through @yama/core's format module", () => {
  const FORMAT = "packages/core/src/format.ts";

  it("no page formats a date, a time or a number with the browser's locale", () => {
    // Use fmtDate, shortDate, fmtTime, fmtDateTime, count, plural or usd instead.
    const found = uses(
      /\.toLocale(Date|Time)?String\(|Intl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat)\b/,
      // Reading the device's time zone name isn't formatting.
      (file, line) => file === FORMAT || line.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"),
    );
    expect(found).toEqual([]);
  });

  it("no page writes dollars by hand", () => {
    // `$${n.toFixed(2)}` drops the thousands comma and can print "$NaN". Use usd().
    expect(uses(/\$\$\{[^}]*\.toFixed\(/, (file) => file === FORMAT)).toEqual([]);
  });
});
