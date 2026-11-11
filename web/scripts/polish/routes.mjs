import { createHash } from "node:crypto";

// Which pages a polish run visits: the static routes in web/src/App.tsx as seeds, then links
// found on the pages themselves, a few samples per route pattern (so ten decks don't mean ten
// near-identical deck pages).

/** Every <Route> in App.tsx as a full path, nested paths joined. `*` routes (redirects) are left out. */
export function routesFromApp(source) {
  const routes = [];
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("<Route", i);
    const close = source.indexOf("</Route>", i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      stack.pop();
      i = close + "</Route>".length;
      continue;
    }
    // Skip <Routes>.
    if (/[A-Za-z]/.test(source[open + "<Route".length] ?? "")) {
      i = open + "<Route".length;
      continue;
    }
    // Walk the tag to its closing ">", stepping over JSX in braces (element={<X />}).
    let j = open + "<Route".length;
    let depth = 0;
    while (j < source.length) {
      const c = source[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      j++;
    }
    const tag = source.slice(open, j + 1);
    const selfClosing = source[j - 1] === "/";
    const attrs = stripBraces(tag);
    const path = /\bpath="([^"]*)"/.exec(attrs)?.[1];
    const parent = stack.length ? stack[stack.length - 1] : "";
    const full = path === undefined ? parent : path.startsWith("/") ? path : join(parent, path);
    if (path !== undefined || /\bindex\b/.test(attrs)) {
      if (!full.includes("*")) routes.push(full || "/");
    }
    if (!selfClosing) stack.push(full);
    i = j + 1;
  }
  return [...new Set(routes)];
}

function stripBraces(s) {
  let out = "";
  let depth = 0;
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

function join(a, b) {
  return `${a.replace(/\/$/, "")}/${b}`.replace(/\/+/g, "/") || "/";
}

/** A matcher for a route pattern like /decks/:id, longest static prefix first when ranked. */
export function patternMatcher(pattern) {
  const parts = pattern.split("/").map((p) => (p.startsWith(":") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const re = new RegExp(`^${parts.join("/")}/?$`);
  const statics = pattern.split("/").filter((p) => p && !p.startsWith(":")).length;
  return { pattern, re, statics };
}

/** The route pattern a path belongs to. Static routes beat parameter routes (react-router ranks the same way). */
export function patternFor(pathname, matchers) {
  let best = null;
  for (const m of matchers) {
    if (m.re.test(pathname) && (!best || m.statics > best.statics)) best = m;
  }
  if (best) return best.pattern;
  // A server page (/precons/..., /u/..., /d/...): ids and slugs become :id.
  return pathname
    .split("/")
    .map((seg, n) => (n > 1 && seg ? ":id" : seg))
    .join("/");
}

// Public pages the server renders itself (server/src/public_precons.rs, sharing.rs) and static
// files in web/public. Listed so their static pages (methodology) aren't sampled as if they were
// one more deck, and seeded so a run always reaches them.
export const SERVER_ROUTES = [
  "/precons",
  "/precons/methodology",
  "/precons/:slug",
  "/u/:handle",
  "/u/:handle/collection",
  "/d/:token",
  "/about/",
  "/privacy/",
  "/tos/",
  "/delete-account/",
  "/docs/mcp/",
];

// Never visit these: they act on visiting (joining a table seat, an OAuth consent), or aren't pages.
export const NEVER_VISIT = [
  /^\/api\//,
  /^\/mcp/,
  /^\/oauth\//,
  /^\/\.well-known\//,
  /^\/scan-bundle/,
  /^\/table\/join\//,
  /^\/sitemap\.xml$/,
  /\.(json|csv|zip|txt|xml|pdf|png|jpe?g|webp|svg)$/i,
];

/** The key a URL is sampled under: its pattern plus the names of its query parameters. */
export function sampleKey(url, matchers) {
  const keys = [...url.searchParams.keys()].sort().join("&");
  return patternFor(url.pathname, matchers) + (keys ? `?${keys}` : "");
}

/** A short file-safe name for a URL, unique to its path and query (a hash tells apart URLs the
 *  readable part makes the same, like ?q=A-B and ?q=A.B). */
export function slugFor(url) {
  const s = (url.pathname + (url.search ? `-${url.search.slice(1)}` : ""))
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  const hash = createHash("sha256").update(url.pathname + url.search).digest("hex").slice(0, 6);
  return `${s || "home"}-${hash}`;
}

/**
 * The links on a page, as absolute addresses. Runs inside the page (`page.$$eval("a[href]",
 * pageLinks)`), so it uses nothing from this file. An SVG `<a>` (the charts on /precons) has an
 * SVGAnimatedString for `href`, not a string: reading it as one crashed the laptop crawl and lost
 * the page. Links that aren't addresses are left out.
 */
export function pageLinks(anchors) {
  const links = [];
  for (const a of anchors) {
    if (a.hasAttribute("download")) continue;
    const raw = typeof a.href === "string" ? a.href : (a.href?.baseVal ?? a.getAttribute("href"));
    if (!raw) continue;
    try {
      links.push(new URL(raw, document.baseURI).href);
    } catch {
      // Not an address (a malformed href): nothing to follow.
    }
  }
  return links;
}
