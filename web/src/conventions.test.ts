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

/** The opening tag that starts at `from`, to the `>` that closes it (not one inside `{…}`). */
function openingTag(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
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

  it("no page writes a raw <button>", () => {
    // Use <Button> from components/ui: variant="primary", "outline", "quiet" or "destructive"
    // (secondary with none), size="small" for a row action, `danger` for --bad words. It is
    // type="button" unless you say type="submit". A row or a tile that is itself the control
    // keeps its own className.
    const found = uses(/<button\b/, (file) => file === BUTTON || BOARD_FILES.test(file));
    expect(found).toEqual([]);
  });

  it("no link is dressed as a button by hand", () => {
    // Use <ButtonLink to="…"> (a page in the app) or <ButtonLink href="…"> from components/ui.
    // The class written as a string, in braces, in a template or as cx's first name.
    const found = uses(/className=\{?\s*(cx\()?["'`]button[\s"'`]/, (file) => file === BUTTON || BOARD_FILES.test(file));
    expect(found).toEqual([]);
  });
});

describe("card pictures use the shared components", () => {
  it("no page writes a raw <img> for a card or its art", () => {
    // Use <CardThumb src={…} /> from components/ui for a small picture beside a name,
    // <CardImage> for a full card, <Crop> or <ArtPanel> for an art tile. These files are those
    // components, or show pictures that aren't Scryfall's (MPC Autofill's, the print sheet's).
    // ManaSymbols.tsx draws mana symbols ({G}, {T}) and is the one place for those.
    const own = new Set(["ui.tsx", "Crop.tsx", "ArtPanel.tsx", "ArtMosaic.tsx", "CardRef.tsx", "CardThumb.tsx", "ManaSymbols.tsx"].map((f) => `web/src/components/${f}`).concat(["web/src/plan/MpcPrint.tsx", "web/src/plan/SwapSheet.tsx"]));
    const found = uses(/<img\b/, (file) => own.has(file) || BOARD.test(file));
    expect(found).toEqual([]);
    // The placeholder goes in `fallback`, so a picture that fails to load gets it too.
    expect(uses(/\? <CardThumb\b/, (file) => BOARD.test(file))).toEqual([]);
  });
});

describe("tabs are one of the shared pieces", () => {
  it("no page builds a tablist", () => {
    // SubNav or DeckTabs for pages, SectionTabs for sections of a page, Segmented for a view,
    // aria-expanded buttons for things that open and close (design/system/shared-code.md, Tabs).
    const found = uses(/role="(tablist|tab|tabpanel)"/, (file) => BOARD.test(file));
    expect(found).toEqual([]);
  });
});

describe("a page's title row uses the shared header", () => {
  it("no page writes its own page-head", () => {
    // Use <PageHeader title="…" sub={…} actions={…} /> from components/ui. The stand-in drawn
    // while a page's code loads has no title yet, so it keeps the bare row.
    const found = uses(/className="page-head\b/, (file) => file === "web/src/components/PageHeader.tsx" || file === "web/src/components/StandIn.tsx");
    expect(found).toEqual([]);
  });
});

describe("paging and showing the rest use the shared controls", () => {
  it("no page writes its own Previous and Next", () => {
    // Use <Pager label="…" page={n} pages={total} onPrevious={…} onNext={…} /> from components/ui.
    // Read whole files: the words are often on a line of their own inside the button.
    const found = sources(WEB)
      .map((path) => relative(ROOT, path))
      .filter((file) => file !== "web/src/components/Pager.tsx" && !BOARD.test(file))
      .filter((file) => />\s*(Previous|Next)\s*<\/(Button|ButtonLink|button|a|Link)>/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(found).toEqual([]);
  });

  it("no list writes its own Show all and Show fewer toggle", () => {
    // Use <ShowMore total={n} onToggle={…} /> (with expanded={…} when it folds back) from
    // components/ui. A list that names what it shows ("Show the slowest 12") keeps its own words.
    const found = uses(/"Show fewer"|>\s*Show fewer\s*</, (file) => file === "web/src/components/Pager.tsx" || BOARD_FILES.test(file));
    expect(found).toEqual([]);
    // "Show all 42" written out: these four keep theirs (a link-styled line on the import page,
    // the scanner's printing tiles, the admin tables that name what they show). Don't add to them.
    const own = new Set(["web/src/decks/ImportPage.tsx", "web/src/scanner/AddedList.tsx", "web/src/scanner/ScannerView.tsx", "web/src/admin/Server.tsx"]);
    const written = sources(WEB)
      .map((path) => relative(ROOT, path))
      .filter((file) => file !== "web/src/components/Pager.tsx" && !own.has(file) && !BOARD_FILES.test(file))
      .filter((file) => /(>|`)\s*Show all (\$?\{)/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(written).toEqual([]);
  });
});

describe("the way back uses the shared link", () => {
  it("no page draws its own back link", () => {
    // Use <BackLink to="…" label="Back to …" text="…"> from components/ui (onArt on an art
    // header, inline on a page with no top row). The card page's Back is a button: it goes
    // back in history, wherever that is.
    const found = uses(/className="[^"]*\b(area-back|hero-back|lobby-back|gd-back)\b|←/, (file) => file === "web/src/components/BackLink.tsx" || BOARD.test(file));
    expect(found).toEqual([]);
  });
});

describe("every control has a name", () => {
  /** A label's own words: what is left of it without its control and without tags. */
  const wordsOf = (label: string) =>
    label
      .replace(/<(select|textarea)\b[^]*?<\/\1>/g, "")
      .replace(/<(input|select|textarea)\b[^]*?\/>/g, "")
      .replace(/^<label\b[^>]*>/, "")
      .replace(/<\/?[A-Za-z][^>]*>/g, "");

  it("no input, select or textarea goes without a label that has words, an aria-label or aria-labelledby", () => {
    // Use <Field label="…"> or <CheckRow> from components/ui. A control whose name is already
    // on the page takes aria-labelledby; a search box or a bare number takes aria-label; a
    // label written by hand with htmlFor names its control by id.
    const found: string[] = [];
    for (const path of sources(WEB)) {
      const file = relative(ROOT, path);
      if (BOARD_FILES.test(file) || file === "web/src/components/Field.tsx") continue;
      const text = readFileSync(path, "utf8");
      // A <label> counts only when it says something: a letter or an expression beside the control.
      const inside: [number, number][] = [...text.matchAll(/<(label|Field|CheckRow)\b/g)]
        .map((m): [number, number, string] => [m.index, text.indexOf(`</${m[1]}>`, m.index), m[1] ?? ""])
        .filter(([from, to, tag]) => tag !== "label" || /[A-Za-z{]/.test(wordsOf(text.slice(from, to))))
        .map(([from, to]) => [from, to]);
      for (const m of text.matchAll(/<(input|select|textarea)\b/g)) {
        const tag = openingTag(text, m.index);
        if (inside.some(([from, to]) => from < m.index && m.index < to)) continue;
        // The hidden attribute itself, not a class or an aria- attribute that ends in "hidden".
        if (/aria-label(ledby)?=|type="hidden"|(?<![\w-])hidden(?=[\s/>={])/.test(tag)) continue;
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        if (id && text.includes(`htmlFor="${id}"`)) continue;
        found.push(`${file}:${text.slice(0, m.index).split("\n").length}: ${tag.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("a row of actions uses the shared bar", () => {
  it("no page adds its own -actions row class", () => {
    // Use <ActionBar> from components/ui (align="end" | "between" | "center", as="span").
    // These rows do more than line buttons up (a grid on phones, their own gap or button
    // sizes), or belong to a shared piece (dialog-actions, empty-actions). The list only shrinks
    // (31 names: ps-actions-row keeps its class for the button sizes its stylesheet sets, and
    // edit-list-hit-actions is a grid that keeps Remove and Add in fixed places).
    const known = new Set(
      "admin-actions ask-actions attack-actions coll-actions cp-actions dataset-actions deck-actions deck-scan-actions dialog-actions edit-list-hit-actions empty-actions grp-delete-actions grp-member-actions grp-you-actions how-to-actions lab-row-actions lab-runcard-actions lobby-actions oauth-actions ps-actions ps-actions-row research-review-actions rg-actions rules-actions scan-added-actions source-actions ss-actions ss-deck-select-actions stats-actions tm-actions tm-share-actions".split(" "),
    );
    const found = uses(/className=(?:"|\{`)[^"`]*\b[a-z-]+-actions\b/, (file, line) => BOARD_FILES.test(file) || [...line.matchAll(/\b([a-z-]+-actions(?:-[a-z-]+)?)(?![\w-])/g)].every((m) => known.has(m[1] ?? "")));
    expect(found).toEqual([]);
  });
});

describe("a state is shown with the shared pill", () => {
  it("no page writes its own status pill or tag", () => {
    // Use <StatusPill tone="good|warn|bad"> from components/ui for a state ("In the deck",
    // "Waiting for your OK"), or <Tag> for a label that names a kind ("Foil", "Proxy").
    // The class written as a string, in braces, in a template or as cx's first name.
    const found = uses(/className=\{?\s*(cx\()?["'`](tag|pill)[\s"'`]/, (file) => file === "web/src/components/StatusPill.tsx" || BOARD_FILES.test(file));
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

describe("styles come from the scales", () => {
  function stylesheets(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return stylesheets(path);
      return e.name.endsWith(".css") ? [path] : [];
    });
  }

  it("no stylesheet adds a font size of its own", () => {
    // Use a --t-* token (web/src/styles.css; design/tokens.md, Type). What is left, file by
    // file: display numbers with no step (life totals, big prices), the 16 px root and a few
    // chips under 11 px. A file's list only shrinks, and a file not listed has none. An em
    // size, a clamp() and a print pt size are fine: they follow their parent, the container or
    // the paper.
    const left: Record<string, string> = {
      "web/src/datasets/datasets.css": "1.7rem 1.8rem",
      "web/src/decks/deckAnalysis.css": "10px",
      "web/src/decks/deckCheck.css": "1.2rem 1.6rem 1.8rem 2.6rem",
      "web/src/decks/deckStatsTab.css": "8px 9px 1.875rem 4rem",
      // A card's name inside a 48 px thumbnail, in the deck editor's search results.
      "web/src/decks/edit-list.css": "0.6rem",
      "web/src/lab/lab.css": "1.625rem 1.875rem",
      "web/src/pages/cards.css": "1.0625rem 1.625rem 4.25rem",
      "web/src/pages/collection.css": "3.5rem",
      // 0.6rem: a card's name inside a 40 px thumbnail, in a deck's Considering list.
      "web/src/pages/decks.css": "0.6rem 3.5rem",
      "web/src/pages/group.css": "1.625rem 1.875rem",
      "web/src/pages/landing.css": ".625rem 1.0625rem",
      "web/src/plan/plan.css": "0.55rem 0.625rem 1.0625rem 1.625rem 3rem 3.125rem 4.75rem",
      "web/src/plan/swapsheet.css": "9.5px 17px",
      "web/src/play/play.css": "10px 26px 30px 38px 46px 54px 72px",
      "web/src/scanner/scanner.css": "1.0625rem",
      "web/src/styles.css": "0.5625rem 16px 1.0625rem 1.625rem 1.875rem 2.125rem 6rem",
      "web/src/table/home.css": "26px 30px 34px",
      "web/src/table/layouts.css": "26px",
      "web/src/table/table.css": "10px 1.875rem 2.125rem 2.375rem 3rem 64px 72px",
    };
    const found: string[] = [];
    for (const path of stylesheets(WEB)) {
      const file = relative(ROOT, path);
      if (file === "web/src/play/board.css") continue;
      const allowed = new Set((left[file] ?? "").split(" "));
      const css = readFileSync(path, "utf8").replace(/\/\*[^]*?\*\//g, "");
      for (const m of css.matchAll(/font-size:\s*((?:\d*\.)?\d+(?:px|rem))\s*(?:!important\s*)?[;}]/g)) {
        if (!allowed.has(m[1] ?? "")) found.push(`${file}: font-size: ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
    // In code too: a style's fontSize is a token, not a number.
    expect(uses(/fontSize:\s*["'`]?\d/, (file) => BOARD.test(file))).toEqual([]);
  });

  it("nothing sits over the page on a z-index of its own", () => {
    // Use a --z-* layer (web/src/styles.css). A small number, -2 to 6, orders the parts of one
    // component among themselves and is fine.
    const found: string[] = [];
    for (const path of stylesheets(WEB)) {
      const file = relative(ROOT, path);
      if (file === "web/src/play/board.css") continue;
      const css = readFileSync(path, "utf8").replace(/\/\*[^]*?\*\//g, "");
      for (const m of css.matchAll(/z-index:\s*([^;}]+)/g)) {
        const value = (m[1] ?? "").trim();
        const local = /^-?\d+$/.test(value) && Number(value) >= -2 && Number(value) <= 6;
        if (!local && !/^var\(--z-[a-z-]+\)$/.test(value)) found.push(`${file}: z-index: ${value}`);
      }
    }
    expect(found).toEqual([]);
    // In code too: a style's zIndex is a small local number or a layer's name, and a layer
    // isn't kept as a number in a constant.
    const inCode = uses(/zIndex:\s*-?\d+|\b[A-Z_]*LAYER\s*=\s*\d/, (file, line) => {
      if (BOARD.test(file)) return true;
      const n = /zIndex:\s*(-?\d+)/.exec(line)?.[1];
      return n !== undefined && Number(n) >= -2 && Number(n) <= 6 && !/LAYER\s*=\s*\d/.test(line);
    });
    expect(inCode).toEqual([]);
  });

  it("layouts change at 600, 900 and 1200 px and nowhere else", () => {
    // Phone under 600, tablet 600 to 899, laptop from 900, wide from 1200 (design/tokens.md,
    // Shape and spacing). Three rules fit their own content and keep their widths: the table
    // menu's markers go four across from 420 px, and the sign-in page folds its second column
    // under at 720 px and narrows it at 1040 px. Don't add to them.
    const own = new Set(["web/src/table/table.css: 420", "web/src/pages/landing.css: 720", "web/src/pages/landing.css: 1040"]);
    const found: string[] = [];
    for (const path of stylesheets(WEB)) {
      const file = relative(ROOT, path);
      if (file === "web/src/play/board.css") continue;
      const css = readFileSync(path, "utf8").replace(/\/\*[^]*?\*\//g, "");
      for (const query of css.matchAll(/@media[^{]*\{/g)) {
        // One spelling: min-width and max-width, so a range (width < 700px) can't slip by.
        if (/\(\s*(?:\d[^)]*[<>]=?\s*)?width\s*[<>]/.test(query[0]) || /[<>]=?\s*width\s*\)/.test(query[0])) found.push(`${file}: ${query[0].trim()}`);
        for (const m of query[0].matchAll(/\((min|max)-width:\s*([^)]+)\)/g)) {
          const px = /^(\d+)px$/.exec((m[2] ?? "").trim())?.[1];
          // A layout starts at 600, 900 or 1200 and so ends at 599, 899 or 1199: no width is in both.
          if (px && (m[1] === "min" ? ["600", "900", "1200"] : ["599", "899", "1199"]).includes(px)) continue;
          if (px && own.has(`${file}: ${px}`)) continue;
          found.push(`${file}: ${m[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
    // A width asked for in code (matchMedia) is one of the three too.
    const inCode = uses(/\((min|max)-width:\s*\d+px\)/, (file, line) => BOARD.test(file) || [...line.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every((m) => (m[1] === "min" ? ["600", "900", "1200"] : ["599", "899", "1199"]).includes(m[2] ?? "")));
    expect(inCode).toEqual([]);
  });
});
