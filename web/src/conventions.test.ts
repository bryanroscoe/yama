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
const BOARD_FILES = /^web\/src\/play\/(Board|Decide)\.tsx$/;

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

describe("dialogs use the shared modal layer", () => {
  const DIALOG = "web/src/components/Dialog.tsx";
  const CONFIRM = "web/src/components/confirm.tsx";
  // Full-screen layers with their own look: the card zoom, the full-screen picker, the scanner
  // and the sample hand. Each is a modal layer through useModalLayer. Don't add to this list:
  // a new dialog is a <Dialog>.
  const LAYERS = new Set([
    "web/src/components/ui.tsx",
    "web/src/components/GamePicker.tsx",
    "web/src/plan/SwapScanner.tsx",
    "web/src/decks/DeckCheckPage.tsx",
    "web/src/decks/DeckScanPage.tsx",
    "web/src/pages/Decks.tsx",
  ]);
  // The Cards tab's card page covers the results but not the rail: a page over a page, not a modal.
  const PAGE_OVER_PAGE = "web/src/pages/Cards.tsx";

  it("no page builds its own dialog", () => {
    // Use <Dialog title="…" onClose={…}> from components/ui (or label="…" when it draws its own first line).
    const found = uses(/role="(dialog|alertdialog)"/, (file) => file === DIALOG || LAYERS.has(file) || file === PAGE_OVER_PAGE || file === CONFIRM || BOARD.test(file));
    expect(found).toEqual([]);
  });

  it("no page uses the browser's confirm or alert", () => {
    // Use ask({ title, body, confirm, danger }) or tell({ title, body }) from components/confirm:
    // the app's own dialog, with a button that says what it does.
    const found = uses(/(^|[^.\w])(window\.)?(confirm|alert)\(/, (file) => file === CONFIRM);
    expect(found).toEqual([]);
  });

  it("every dialog has a name", () => {
    // Dialog's own types require a title or a label; the hand-built layers must say theirs.
    const found = uses(/role="(dialog|alertdialog)"/, (file, line) => /aria-label(ledby)?=/.test(line) || file === DIALOG);
    expect(found).toEqual([]);
  });

  it("every hand-built layer is a modal layer", () => {
    const missing = [...LAYERS].filter((file) => !readFileSync(join(ROOT, file), "utf8").includes("useModalLayer("));
    expect(missing).toEqual([]);
  });

  it("no page draws its own scrim or dialog heading", () => {
    // DialogHead (components/ui) is the heading with Close; Dialog draws it for a `title`.
    const found = uses(/className="(scrim|sheet-head)\b/, (file) => file === DIALOG || BOARD.test(file));
    expect(found).toEqual([]);
  });

  it("no page listens for Escape on the window to close a layer", () => {
    // A window listener can't tell which layer is on top. Dialog and useModalLayer can.
    // Floating menus and previews take Escape in the capture phase and mark it handled.
    const found = uses(
      /=== "Escape"\)? (&& )?(onClose|setOpen|close)\b/,
      (file) => file === DIALOG || BOARD.test(file) || file === PAGE_OVER_PAGE,
    );
    expect(found).toEqual([]);
  });
});

describe("errors and copying use the shared components", () => {
  it("no page writes its own error paragraph for something thrown", () => {
    // Use <ErrorText error={…} /> from components/ui (with retry={…} where asking again can work).
    // A sentence the page writes itself about its own state can stay a paragraph (a name ending in Note).
    const found = uses(/<(p|span)\b[^>]*className="(?:[^"]* )?error(?: [^"]*)?"[^>]*>\{[\w.?!]+\}<\/(p|span)>/, (file, line) => file === "web/src/components/ui.tsx" || BOARD_FILES.test(file) || /Note\}<\//.test(line));
    expect(found).toEqual([]);
  });

  it("no page writes to the clipboard itself", () => {
    // Use <CopyButton text={…} label="…" /> from components/ui: it says Copied, and shows the
    // text to copy by hand when the browser refuses. These five do more than copy (a status line
    // beside a link, copy then open a site, the share sheet first); don't add to them.
    const more = new Set([
      "web/src/decks/ShareDeck.tsx",
      "web/src/decks/DeckAnalysis.tsx",
      "web/src/bridges/mythic/MythicDeck.tsx",
      "web/src/play/PlayGame.tsx",
      "web/src/pages/Group.tsx",
    ]);
    const found = uses(/clipboard\.writeText\(/, (file) => file === "web/src/components/CopyButton.tsx" || more.has(file));
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

describe("buttons use the shared components", () => {
  const BUTTON = "web/src/components/Button.tsx";
  // The areas still to move over, one pull request each. This list only shrinks: don't add to it.
  const NOT_YET = /^web\/src\/(admin|advisor|bridges|datasets|lab|oauth|play|research|scanner|table)\//;

  it("no page writes a raw <button>", () => {
    // Use <Button> from components/ui: variant="primary", "outline", "quiet" or "destructive"
    // (secondary with none), size="small" for a row action, `danger` for --bad words. It is
    // type="button" unless you say type="submit". A row or a tile that is itself the control
    // keeps its own className.
    const found = uses(/<button\b/, (file) => file === BUTTON || NOT_YET.test(file));
    expect(found).toEqual([]);
  });

  it("no link is dressed as a button by hand", () => {
    // Use <ButtonLink to="…"> (a page in the app) or <ButtonLink href="…"> from components/ui.
    const found = uses(/className="button\b/, (file) => file === BUTTON || NOT_YET.test(file));
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
