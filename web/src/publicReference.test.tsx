import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteNotice } from "./components/SiteNotice";

describe("public reference and content rights", () => {
  it("keeps public pages and stock exports out of the private offline shell", () => {
    let fetchHandler: (event: { request: { method: string; mode: string; url: string }; respondWith: () => void }) => void = () => {};
    runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
      self: { addEventListener: (name: string, fn: typeof fetchHandler) => { if (name === "fetch") fetchHandler = fn; } },
      location: { origin: "https://yama.saget.org" },
      URL,
    });
    for (const path of ["/precons", "/precons?c=UG", "/precons/a-deck", "/precons/a-deck/decklist.txt", "/precons/methodology", "/sitemap.xml", "/api/public/precons"]) {
      let intercepted = false;
      fetchHandler({ request: { method: "GET", mode: "navigate", url: `https://yama.saget.org${path}` }, respondWith: () => { intercepted = true; } });
      expect(intercepted, path).toBe(false);
    }
  });

  it("reserves Yama's original work while keeping third-party ownership clear", () => {
    const markup = renderToStaticMarkup(<SiteNotice />);
    expect(markup).toContain("All rights reserved");
    expect(markup).toContain("Bryan Roscoe");
    expect(markup).toContain("Third-party content belongs to its respective owners");
    expect(markup).toContain("not affiliated with, endorsed by, or sponsored by Wizards");
    for (const path of ["about", "privacy", "tos"]) {
      expect(readFileSync(new URL(`../public/${path}/index.html`, import.meta.url), "utf8"), path).toContain("All rights reserved");
    }
    const terms = readFileSync(new URL("../public/tos/index.html", import.meta.url), "utf8");
    expect(terms).toContain('id="rights"');
    expect(terms).toContain("does not claim exclusive rights in facts");
  });
});
