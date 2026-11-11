#!/usr/bin/env node
// Polish runs: visit every page of Yama at laptop, tablet and phone sizes, scroll through each
// one taking screenshots, open its menus, sheets, tabs and disclosures, and check the layout
// and copy as it goes. The output (report.md, index.html, screenshots, copy.txt) is for Claude to
// read in a polish pass, and for Bryan to page through. docs/polish.md explains it.
//
//   npm run polish -- shoot --base https://yama.saget.org --as you@example.com   every page, every size
//   npm run polish -- shoot --base http://localhost:5173 --as you@example.com    (dev login)
//   npm run polish -- shoot --base http://localhost:5173 /decks /cards   just these pages
//
// Read-only by default: every request that isn't GET, HEAD or OPTIONS is blocked, service workers
// and WebSockets are answered in the browser, service workers are off and each run starts from an
// empty browser profile, so a run on production changes no one's data however many buttons it
// presses (signing in still records the session and last_seen_at).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { audit, clearOverlay, drawOverlay, visibleText } from "./audit.mjs";
import { NEVER_VISIT, SERVER_ROUTES, pageLinks, patternMatcher, routesFromApp, sampleKey, slugFor } from "./routes.mjs";
import { writeReports } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const STATE_DIR = join(homedir(), ".config", "yama-polish");
const SESSION_COOKIE = "yama_session";
/** The only host that gets the bot-check header and the session as a header (sessionHeader). */
const PRODUCTION_HOST = "yama.ing";

export const VIEWPORTS = {
  laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, minTarget: 24, edgePad: 0 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true, minTarget: 44, edgePad: 12 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, minTarget: 44, edgePad: 12 },
};
const SPACING_SCALE = [1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64];

// Every run is a first visit in Chrome, which offers to install Yama: the page gets a
// beforeinstallprompt, as Chrome sends it, so the Install Yama card and buttons show. A fresh
// headless profile never gets one by itself, so earlier runs never saw them.
function chromeInstallPrompt() {
  addEventListener(
    "load",
    () => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      e.prompt = () => Promise.resolve();
      e.userChoice = Promise.resolve({ outcome: "dismissed" });
      dispatchEvent(e);
    },
    { once: true },
  );
}

// A game left on the device, for the states that show what happens to it.
const LOCAL_GAME = (id) => ({
  setup: { id, startedAt: "2026-11-01T19:00:00Z", format: "commander", startingLife: 40, players: [{ seat: 0, name: "Polish", colorIdentity: "" }, { seat: 1, name: "Run", colorIdentity: "" }] },
  log: [],
  redo: [],
  syncedThrough: 0,
});

/**
 * Browser and device states the default run doesn't reach. `--states a,b` (or `all`) adds a pass
 * per state after the main one: each page again, screens only, at the state's sizes, shot as
 * `<size>-<state>-…`. `storage` is put in localStorage before the app loads; `init` runs in the
 * page first; `offline` cuts the network once the page has loaded, as a train tunnel would.
 */
export const STATES = {
  iphone: {
    about: "Safari on an iPhone: no install prompt, so Share, then Add to Home Screen",
    viewports: ["mobile"],
    prompt: false,
    context: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1" },
    init: () => {
      if (!("share" in navigator)) navigator.share = () => Promise.resolve();
    },
  },
  installed: {
    about: "Opened as the installed app (no install offers, no Full screen button)",
    viewports: ["laptop", "mobile"],
    prompt: false,
    init: () => Object.defineProperty(navigator, "standalone", { value: true, configurable: true }),
  },
  returning: {
    about: "Someone who has read What's new and waved off Install: the steady state",
    viewports: ["laptop", "mobile"],
    prompt: false,
    storage: { "yama.whatsNew.seen": "__NEWEST__", "yama.install.dismissed": "1" },
  },
  offline: {
    about: "The connection drops after the page loads",
    viewports: ["laptop", "mobile"],
    offline: true,
  },
  unsynced: {
    about: "Games waiting to upload, one Yama refused, and games counted signed out",
    viewports: ["laptop", "mobile"],
    storage: {
      "yama.table.outbox": JSON.stringify([LOCAL_GAME("polish-waiting")]),
      "yama.table.rejected": JSON.stringify([{ game: LOCAL_GAME("polish-refused"), error: "A seat's deck isn't yours" }]),
      "yama.table.guestGames": JSON.stringify([{ ...LOCAL_GAME("polish-guest"), guest: true }]),
    },
  },
};

/** The newest What's new entry, so `returning` hides the notice as reading it would. */
function newestNewsId() {
  const src = readFileSync(join(REPO, "web", "src", "whatsNew.ts"), "utf8");
  return src.match(/\bid:\s*"([^"]+)"/)?.[1] ?? "";
}

// Buttons the safe mode presses: ones that say they open something.
const OPENER_WORDS = /\b(more|menu|filters?|sort|options?|details?|info|help|settings|share|show|view|open|expand|edit|choose|pick|change|why|how|about|account|profile|preview)\b|[…⋯⋮]/i;
// Never pressed, even with --interact all: the network guard would block the write, but the
// page's own state (an optimistic edit, a sign-out) would still muddle the rest of the run.
const NEVER_PRESS = /\b(delete|remove|discard|apply|save|buy|bought|mark|sign[ -]?out|log[ -]?out|leave|end|concede|start|run|cancel|reset|clear|confirm|submit|send|import|upload|install|accept|approve|invite|disable|enable|disconnect|revoke|forget|archive|restore|retry|join|resign|pass|undo|rematch|publish|unpublish|copy|download|export|print)\b/i;
// Pages whose buttons act on a live game: visited, never pressed.
const NO_PRESS_PAGES = /^\/(play|table)\//;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(code = 0) {
  console.log(`Usage:
  polish login --base URL --ssh-session EMAIL [--hours N]   a session from the server's shell
  polish login --base URL --dev-email EMAIL                  dev login (localhost)
  polish login --base URL --browser                          sign in by hand in Chrome
  polish login --base URL --cookie-stdin                     paste a yama_session value
  polish shoot --base URL [paths...] [options]
  polish sheets --run DIR [--size laptop] [--per N]           contact sheets of a run's screens

Sign-in for shoot: the saved session for the host, else with --as EMAIL a new one (dev login on
localhost, else --ssh-session over SSH to YAMA_POLISH_SSH, default the deploy target from
YAMA_DEPLOY_USER/YAMA_DEPLOY_HOST, deploy/.env or ~/.config/yama/deploy.env).

Options for shoot:
  --viewports laptop,tablet,mobile   sizes to shoot (default all three)
  --only REGEX            only pages whose path matches
  --exclude REGEX         skip pages whose path matches
  --no-crawl              don't follow links; only the seeds or the paths given
  --max-pages N           pages to visit (default 80)
  --samples N             pages per route pattern, e.g. /decks/:id (default 2)
  --max-frames N          screenshots down each page (default 6)
  --interact MODE         safe (openers, tabs, disclosures; default), all (every button
                          not on the never-press list) or none
  --max-interactions N    presses per page and size (default 14)
  --no-details            don't take the extra "all disclosures open" frames
  --states LIST           another pass per browser state after the main one: ${Object.keys(STATES).join(", ")}
                          or all (\`--states help\` says what each is)
  --jpeg                  JPEG screenshots (smaller) instead of PNG
  --out DIR               output folder (default output/polish/<time>)
  --state FILE            signed-in browser state (default ~/.config/yama-polish/<host>.json)
  --headed                show the browser
  --allow-writes          let writes through (only for a localhost base)`);
  process.exit(code);
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://localhost:5173" },
    state: { type: "string" },
    browser: { type: "boolean" },
    "dev-email": { type: "string" },
    "cookie-stdin": { type: "boolean" },
    "ssh-session": { type: "string" },
    hours: { type: "string", default: "3" },
    as: { type: "string" },
    viewports: { type: "string", default: "laptop,tablet,mobile" },
    only: { type: "string" },
    exclude: { type: "string" },
    "no-crawl": { type: "boolean" },
    "max-pages": { type: "string", default: "80" },
    samples: { type: "string", default: "2" },
    "max-frames": { type: "string", default: "6" },
    interact: { type: "string", default: "safe" },
    "max-interactions": { type: "string", default: "14" },
    "no-details": { type: "boolean" },
    states: { type: "string" },
    jpeg: { type: "boolean" },
    out: { type: "string" },
    headed: { type: "boolean" },
    "allow-writes": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    run: { type: "string" },
    size: { type: "string" },
    per: { type: "string" },
  },
});
if (args.help || !positionals.length) usage(args.help ? 0 : 1);

const command = positionals.shift();
const base = new URL(args.base);
// npm runs this from web/; a relative --out or --state means the caller's folder, not web/.
const CALLER = process.env.INIT_CWD ?? process.cwd();
const statePath = args.state ? resolve(CALLER, args.state) : join(STATE_DIR, `${base.host.replace(/[^a-z0-9.-]/gi, "_")}.json`);

async function launch(headed) {
  const executablePath = process.env.YAMA_POLISH_CHROME;
  return chromium.launch({ headless: !headed, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const cookies = state.cookies.filter((c) => base.hostname === c.domain.replace(/^\./, "") || base.hostname.endsWith(c.domain));
  writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }, null, 2), { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

/**
 * Headers that get a run past Cloudflare's Super Bot Fight Mode on production, which challenges a
 * headless browser: this machine's agent check header (`x-yama-check`, from
 * ~/.config/yama/edge-check-header, which a WAF rule skips the check for) and the saved session as
 * `Authorization` (also skipped; the server takes the session from it as from the cookie). Only
 * ever sent to the host itself.
 */
function sessionHeader() {
  // Production over HTTPS only: never another host, which could be anyone's.
  if (base.protocol !== "https:" || base.hostname !== PRODUCTION_HOST) return {};
  const check = join(homedir(), ".config", "yama", "edge-check-header");
  const edge = existsSync(check) ? { "x-yama-check": readFileSync(check, "utf8").trim() } : {};
  if (!existsSync(statePath)) return edge;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    // The cookie must be the host's own: its domain, or a parent domain at a dot boundary.
    const ownCookie = (c) => {
      const domain = c.domain.replace(/^\./, "");
      return base.hostname === domain || base.hostname.endsWith(`.${domain}`);
    };
    const cookie = (state.cookies ?? []).find((c) => c.name === SESSION_COOKIE && ownCookie(c));
    return cookie ? { ...edge, authorization: `Bearer ${cookie.value}` } : edge;
  } catch {
    return edge;
  }
}

async function whoAmI(request) {
  const res = await request.get(new URL("/api/me", base).href, { failOnStatusCode: false, headers: sessionHeader() });
  if (res.status() !== 200) return null;
  const me = await res.json().catch(() => null);
  return me ? { name: me.name ?? me.user?.name ?? null, email: me.email ?? me.user?.email ?? null } : null;
}

/** user@host for --ssh-session: YAMA_POLISH_SSH, else the deploy target as deploy/target.sh reads it
 *  (environment, then the gitignored deploy/.env, then this machine's file: YAMA_DEPLOY_ENV, else
 *  ~/.config/yama/deploy.env). Saget's address never lives in this file. */
function sshHost() {
  if (process.env.YAMA_POLISH_SSH) return process.env.YAMA_POLISH_SSH;
  const file = {};
  const machine =
    process.env.YAMA_DEPLOY_ENV || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "yama", "deploy.env");
  for (const envPath of [join(REPO, "deploy", ".env"), machine]) {
    if (!existsSync(envPath) || !statSync(envPath).isFile()) continue;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = /^(YAMA_DEPLOY_HOST|YAMA_DEPLOY_USER)=(.*)$/.exec(line.trim());
      // An empty value doesn't count, as in target.sh: the next file may still name it.
      if (m && !file[m[1]]) file[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const host = process.env.YAMA_DEPLOY_HOST || file.YAMA_DEPLOY_HOST;
  const user = process.env.YAMA_DEPLOY_USER || file.YAMA_DEPLOY_USER || "root";
  if (!host) {
    throw new Error(
      "Set YAMA_POLISH_SSH, or YAMA_DEPLOY_HOST in ~/.config/yama/deploy.env or deploy/.env (see deploy/.env.example)",
    );
  }
  if (!/^[A-Za-z0-9.:_-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(user)) throw new Error("YAMA_DEPLOY_HOST/USER must be plain names");
  return `${user}@${host}`;
}
const isLocal = (u) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);

function sessionCookie(value) {
  return {
    name: SESSION_COOKIE,
    value,
    domain: base.hostname,
    path: "/",
    httpOnly: true,
    secure: base.protocol === "https:",
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 30 * 86400,
  };
}

/** Save a session token as the host's state, once /api/me accepts it. */
async function saveToken(value) {
  const cookie = sessionCookie(value);
  const browser = await launch(false);
  const context = await browser.newContext({ storageState: { cookies: [cookie], origins: [] } });
  const me = await whoAmI(context.request);
  await browser.close();
  if (!me) throw new Error("That session didn't work: /api/me refused it");
  saveState({ cookies: [cookie] });
  console.log(`Signed in as ${me.email}; saved ${statePath}`);
  return me;
}

/** A short session minted on the server (`yama-server user session`), over SSH, never shown. */
async function sshSession(email, hours) {
  const { execFileSync } = await import("node:child_process");
  // It goes into a remote shell command: letters, digits and . _ % + - only.
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(email)) throw new Error(`${email} isn't an email address`);
  const out = execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshHost(), `docker exec yama yama-server user session ${email} --hours ${Number(hours)}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const token = out.trim().split("\n").pop();
  if (!token || /\s/.test(token)) throw new Error("The server didn't print a session");
  return saveToken(token);
}

async function devLogin(email) {
  const browser = await launch(false);
  const context = await browser.newContext();
  const res = await context.request.post(new URL("/api/auth/dev", base).href, { data: { email }, failOnStatusCode: false });
  if (!res.ok()) {
    await browser.close();
    throw new Error(`Dev login failed (${res.status()}): is the server running with YAMA_DEV_LOGIN=1 on localhost?`);
  }
  saveState(await context.storageState());
  const me = await whoAmI(context.request);
  console.log(`Signed in as ${me?.email}; saved ${statePath}`);
  await browser.close();
  return me;
}

async function login() {
  if (args["ssh-session"]) {
    await sshSession(args["ssh-session"], args.hours);
    return;
  }
  if (args["dev-email"]) {
    await devLogin(args["dev-email"]);
    return;
  }
  if (args["cookie-stdin"]) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const value = Buffer.concat(chunks).toString().trim().replace(new RegExp(`^${SESSION_COOKIE}=`), "").replace(/;.*$/, "");
    if (!value) throw new Error(`Paste the value of the ${SESSION_COOKIE} cookie on stdin`);
    await saveToken(value);
    return;
  }
  if (args.browser) {
    // A real Chrome window with its own profile. Sign in with Google there; the session cookie is
    // saved and the window closes. The profile is kept so the next sign-in is one click.
    const profile = join(STATE_DIR, `chrome-profile-${base.host.replace(/[^a-z0-9.-]/gi, "_")}`);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(base.href);
    console.log("Sign in to Yama in the Chrome window. Waiting up to 10 minutes…");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const cookies = await context.cookies(base.href);
      if (cookies.some((c) => c.name === SESSION_COOKIE)) {
        const me = await whoAmI(context.request);
        if (me) {
          saveState(await context.storageState());
          console.log(`Signed in as ${me.email}; saved ${statePath}`);
          await context.close();
          return;
        }
      }
      await sleep(1000);
    }
    await context.close();
    throw new Error("Timed out waiting for sign-in");
  }
  usage(1);
}

// ── shooting ────────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Requests in flight on a page, so a screenshot waits for the data and the art to arrive. */
function trackNetwork(page) {
  const t = { inflight: new Set(), last: Date.now() };
  const done = (r) => {
    t.inflight.delete(r);
    t.last = Date.now();
  };
  page.on("request", (r) => {
    if (["eventsource", "websocket"].includes(r.resourceType())) return;
    t.inflight.add(r);
    t.last = Date.now();
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return t;
}

async function settle(page, net, { quiet = 500, max = 12_000 } = {}) {
  const start = Date.now();
  await page.waitForLoadState("domcontentloaded", { timeout: max }).catch(() => {});
  await page
    .evaluate((ms) => Promise.race([document.fonts?.ready.then(() => true), new Promise((ok) => setTimeout(ok, ms))]), Math.min(max, 5000))
    .catch(() => {});
  while (Date.now() - start < max) {
    // Long polls don't count once they've been open a while.
    const pending = [...net.inflight].filter((r) => Date.now() - (r.timing().startTime || start) < 8000);
    if (pending.length === 0 && Date.now() - net.last > quiet) break;
    await sleep(100);
  }
  // A request that failed is retried after a backoff (React Query waits a second): the network
  // is quiet, but the page still says Loading. Give it until max to show the answer or the error.
  // Offline, a paused request says Loading for good: nothing to wait for.
  while (Date.now() - start < max && (await page.evaluate(() => navigator.onLine && /\bLoading(…|\.\.\.)/.test(document.body.innerText)).catch(() => false))) {
    await sleep(250);
  }
  await page
    .evaluate(
      (ms) =>
        Promise.race([
          Promise.all(
            [...document.images]
              .filter((img) => {
                const r = img.getBoundingClientRect();
                return !img.complete && r.bottom > 0 && r.top < innerHeight && r.width > 0;
              })
              // Listeners, not onload/onerror: the app's own fallbacks must still run.
              .map((img) => new Promise((ok) => (img.addEventListener("load", ok, { once: true }), img.addEventListener("error", ok, { once: true })))),
          ),
          new Promise((ok) => setTimeout(ok, ms)),
        ]),
      3000,
    )
    .catch(() => {});
}

/** The thing that scrolls: a big scrolling sheet on top in the middle of the screen (a full-screen
 *  sheet over a longer page), else the window, else the biggest scrolling box. */
async function findScroller(page) {
  return page.evaluate(() => {
    document.querySelectorAll("[data-polish-scroller]").forEach((e) => e.removeAttribute("data-polish-scroller"));
    const doc = document.scrollingElement || document.documentElement;
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    let best = null;
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 2) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < innerWidth * innerHeight * 0.4) continue;
      // On top only counts for a sheet over the page (fixed, or nearly screen-high): a code
      // block or a list that happens to sit mid-screen is part of the page, not its scroller.
      let fixed = false;
      for (let cur = el; cur && !fixed; cur = cur.parentElement) fixed = getComputedStyle(cur).position === "fixed";
      const onTop = !!hit && el.contains(hit) && (fixed || r.height >= innerHeight * 0.8);
      if (!best || onTop > best.onTop || (onTop === best.onTop && area > best.area)) best = { el, area, onTop };
    }
    const docScrolls = doc.scrollHeight > innerHeight + 2;
    if (!best || (docScrolls && !best.onTop)) return { window: true, height: doc.scrollHeight, view: innerHeight };
    best.el.setAttribute("data-polish-scroller", "");
    return { window: false, height: best.el.scrollHeight, view: best.el.clientHeight };
  });
}

async function scrollTo(page, scroller, y) {
  return page.evaluate(
    ({ win, y }) => {
      const el = win ? document.scrollingElement || document.documentElement : document.querySelector("[data-polish-scroller]");
      if (!el) return { y: 0, end: true };
      el.scrollTo({ top: y, behavior: "instant" });
      const max = el.scrollHeight - el.clientHeight;
      return { y: el.scrollTop, end: el.scrollTop >= max - 2 };
    },
    { win: scroller.window, y },
  );
}

class Run {
  constructor(outDir, opts) {
    this.outDir = outDir;
    this.opts = opts;
    this.pages = new Map(); // key: path+search
    this.blocked = [];
    this.shellPressed = new Set();
    this.offScale = {};
    this.copy = new Map();
    this.started = new Date().toISOString();
  }

  record(url) {
    const key = url.pathname + url.search;
    if (!this.pages.has(key)) this.pages.set(key, { url: key, pattern: null, title: "", finalUrl: null, views: {} });
    return this.pages.get(key);
  }

  file(page, vp, name) {
    const dir = join(this.outDir, "shots", slugFor(new URL(page.url, base)));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${vp}-${name}.${this.opts.jpeg ? "jpg" : "png"}`);
  }

  async shot(pw, path) {
    await pw.screenshot({ path, animations: "disabled", caret: "hide", ...(this.opts.jpeg ? { type: "jpeg", quality: 85 } : {}) });
    return relative(this.outDir, path);
  }

  save(me) {
    writeReports(this.outDir, {
      base: base.origin,
      signedInAs: me,
      started: this.started,
      finished: new Date().toISOString(),
      viewports: this.opts.viewports,
      states: this.opts.states,
      interact: this.opts.interact,
      pages: [...this.pages.values()],
      blockedWrites: this.blocked,
      offScale: this.offScale,
      copy: Object.fromEntries(this.copy),
    });
  }
}

/** Audit what's on screen and screenshot it, plus an outlined copy when something was found. */
async function capture(run, page, entry, vp, name, view, { atStart = false, atEnd = false } = {}) {
  const cfg = VIEWPORTS[vp];
  const found = await page
    .evaluate(audit, { minTarget: cfg.minTarget, edgePad: cfg.edgePad, atStart, atEnd, spacingScale: SPACING_SCALE, screenWidth: cfg.viewport.width })
    .catch((e) => ({ issues: [{ kind: "audit-failed", severity: "info", message: String(e).slice(0, 200), selector: "", text: "", rect: null }], offScale: {} }));
  const file = await run.shot(page, run.file(entry, view.key ?? vp, name));
  let annotated = null;
  const marked = found.issues.filter((i) => i.rect && i.severity !== "info");
  if (marked.length) {
    await page.evaluate(drawOverlay, found.issues).catch(() => {});
    annotated = await run.shot(page, run.file(entry, view.key ?? vp, `${name}-marked`));
    await page.evaluate(clearOverlay).catch(() => {});
  }
  for (const [k, n] of Object.entries(found.offScale)) {
    const [selector, prop, px] = k.split("|");
    const key = `${selector}|${prop}|${px}`;
    const agg = (run.offScale[key] ??= { selector, prop, px: Number(px), count: 0, pages: new Set(), viewports: new Set() });
    agg.count += n;
    agg.pages.add(entry.url);
    agg.viewports.add(vp);
  }
  const shot = { name, file, annotated, issues: found.issues };
  view.shots.push(shot);
  return shot;
}

/** Scroll down the page a screen at a time. */
async function frames(run, page, entry, vp, view, prefix, maxFrames) {
  const scroller = await findScroller(page);
  view.height = scroller.height;
  const step = Math.max(200, Math.round(scroller.view * 0.85));
  for (let f = 0; f < maxFrames; f++) {
    const pos = await scrollTo(page, scroller, f * step);
    if (f > 0) await sleep(250);
    await settle(page, run.net, { quiet: 250, max: 4000 });
    await capture(run, page, entry, vp, `${prefix}${String(f + 1).padStart(2, "0")}`, view, { atStart: f === 0, atEnd: pos.end });
    if (pos.end) return;
  }
  view.truncated = true;
}

async function candidates(page, mode) {
  return page.evaluate(
    ({ mode, opener, never }) => {
      const openerRe = new RegExp(opener, "i");
      const neverRe = new RegExp(never, "i");
      document.querySelectorAll("[data-polish-cand]").forEach((e) => e.removeAttribute("data-polish-cand"));
      const sel =
        mode === "all"
          ? 'button, [role="button"], summary, [role="tab"], [aria-haspopup], [aria-expanded], [popovertarget]'
          : 'summary, [role="tab"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded="false"], [popovertarget], button, [role="button"]';
      const out = [];
      const counts = {};
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("[data-polish-overlay]") || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width < 4 || r.height < 4 || s.visibility === "hidden" || s.display === "none") continue;
        if (el.closest("details:not([open])") && el.tagName !== "SUMMARY") continue;
        const label = (el.getAttribute("aria-label") || el.innerText || el.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (neverRe.test(label) || neverRe.test(el.title || "")) continue;
        if ((el.type === "submit" && el.form) || el.closest("a[href]")) continue;
        let kind;
        if (el.tagName === "SUMMARY") kind = "disclosure";
        else if (el.getAttribute("role") === "tab") {
          if (el.getAttribute("aria-selected") === "true") continue;
          kind = "tab";
        } else if (el.hasAttribute("aria-haspopup") || el.hasAttribute("popovertarget")) kind = "popup";
        else if (el.getAttribute("aria-expanded") === "false") kind = "expand";
        else if (mode === "all" || openerRe.test(label) || openerRe.test(el.title || "")) kind = "button";
        else continue;
        // The same label many times over (a "More" on every row): the first two are enough.
        const key = `${kind}|${label}`;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] > 2) continue;
        const shell = !!el.closest('nav, header, [role="navigation"], [role="banner"]');
        el.setAttribute("data-polish-cand", String(out.length));
        out.push({ index: out.length, label: label || el.tagName.toLowerCase(), kind, shell });
      }
      return out;
    },
    { mode, opener: OPENER_WORDS.source, never: NEVER_PRESS.source },
  );
}

const POPUP_SEL = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], :popover-open';

async function openState(page, index) {
  return page.evaluate(
    ({ index, sel }) => {
      const el = document.querySelector(`[data-polish-cand="${index}"]`);
      const popups = [...document.querySelectorAll(sel)].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(p).visibility !== "hidden";
      }).length;
      return {
        url: location.pathname + location.search,
        popups,
        expanded: el ? el.getAttribute("aria-expanded") : null,
        open: el && el.tagName === "SUMMARY" ? el.parentElement.open : null,
        selected: el ? el.getAttribute("aria-selected") : null,
      };
    },
    { index, sel: POPUP_SEL },
  );
}

async function watchAdded(page) {
  await page.evaluate(() => {
    window.__polishAdded = [];
    window.__polishObs?.disconnect();
    window.__polishObs = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__polishAdded.push(n);
    });
    window.__polishObs.observe(document.body, { childList: true, subtree: true });
  });
}

async function addedOverlay(page) {
  return page.evaluate(() => {
    window.__polishObs?.disconnect();
    return (window.__polishAdded || []).some((n) => {
      if (!n.isConnected) return false;
      const r = n.getBoundingClientRect();
      const s = getComputedStyle(n);
      return r.width * r.height > 1500 && (s.position === "fixed" || s.position === "absolute") && s.visibility !== "hidden";
    });
  });
}

async function interact(run, page, entry, vp, view, url, discover) {
  const path = new URL(entry.url, base).pathname;
  if (run.opts.interact === "none" || NO_PRESS_PAGES.test(path)) return;
  const list = await candidates(page, run.opts.interact);
  let pressed = 0;
  let stale = false;
  for (const cand of list) {
    if (pressed >= run.opts.maxInteractions) break;
    // The account menu and other parts of the app's frame: once per size, not on every page.
    const shellKey = `${vp}|${cand.kind}|${cand.label}`;
    if (cand.shell && run.shellPressed.has(shellKey)) continue;
    if (stale) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page, run.net);
      const again = await candidates(page, run.opts.interact);
      const same = again.filter((c) => c.label === cand.label && c.kind === cand.kind);
      const match = same.sort((a, b) => Math.abs(a.index - cand.index) - Math.abs(b.index - cand.index))[0];
      if (!match) continue;
      Object.assign(cand, { index: match.index });
      stale = false;
    }
    const handle = page.locator(`[data-polish-cand="${cand.index}"]`);
    if (!(await handle.count())) continue;
    await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const before = await openState(page, cand.index);
    await watchAdded(page);
    try {
      await handle.click({ timeout: 2500 });
    } catch {
      continue;
    }
    if (cand.shell) run.shellPressed.add(shellKey);
    pressed++;
    await sleep(150);
    await settle(page, run.net, { quiet: 300, max: 5000 });
    const after = await openState(page, cand.index);
    const overlay = await addedOverlay(page);
    if (after.url !== before.url) {
      const next = new URL(after.url, base);
      discover?.(next);
      stale = true;
      // A tab or filter kept in the query string: the same page in another state, so shoot it.
      if (next.pathname !== new URL(before.url, base).pathname) continue;
    }
    const changed = after.url !== before.url || after.popups > before.popups || overlay || after.expanded !== before.expanded || after.open !== before.open || after.selected !== before.selected;
    if (!changed) continue;
    const name = `${cand.kind}-${String(pressed).padStart(2, "0")}-${cand.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 30).replace(/^-|-$/g, "") || "x"}`;
    const shot = await capture(run, page, entry, vp, name, view, { atStart: false });
    shot.label = cand.label;
    shot.kind = cand.kind;
    // Put it back: Escape for a popup, a second press for a disclosure. A tab stays (the next
    // candidates are on it); anything that won't close means a fresh load.
    if (stale) {
      // Reloaded before the next press.
    } else if (after.popups > before.popups || overlay) {
      await page.keyboard.press("Escape");
      await sleep(250);
      const now = await openState(page, cand.index);
      if (now.popups > before.popups || (await addedOverlay(page))) stale = true;
    } else if (cand.kind === "disclosure" || cand.kind === "expand") {
      await handle.click({ timeout: 1500 }).catch(() => (stale = true));
      await sleep(150);
    } else if (cand.kind !== "tab") {
      stale = true;
    }
  }
}

async function visit(run, context, vp, url, discover, state = null) {
  const entry = run.record(url);
  const key = state ? `${vp}-${state}` : vp;
  const view = (entry.views[key] = { key, shots: [], errors: [], height: 0, truncated: false });
  const page = await context.newPage();
  run.net = trackNetwork(page);
  page.on("console", (m) => {
    // The network guard's own refusals aren't the page's errors.
    if (m.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) view.errors.push(`console: ${m.text().slice(0, 300)}`);
    // React Router renders nothing for an address it doesn't know: say so, or the run shoots a blank page.
    else if (m.type() === "warning" && /No routes matched/.test(m.text())) view.errors.push(`no route: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => view.errors.push(`page error: ${String(e.message || e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() === 401 && new URL(r.url()).pathname === "/api/me") return; // signed out
    if (r.status() >= 400 && r.request().method() === "GET") view.errors.push(`${r.status()} ${r.url().slice(0, 200)}`);
  });
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (state && STATES[state].offline && /ERR_INTERNET_DISCONNECTED/.test(f)) return;
    if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(f)) view.errors.push(`failed ${r.url().slice(0, 200)}: ${f}`);
  });
  try {
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page, run.net);
    if (!(await page.evaluate(() => document.body.innerText.trim().length).catch(() => 1))) view.errors.push("blank page: nothing on screen to read");
    entry.title = await page.title();
    entry.finalUrl = new URL(page.url()).pathname + new URL(page.url()).search;
    if (state) {
      // A state pass: the screens down the page, nothing pressed.
      if (STATES[state].offline) {
        await context.setOffline(true);
        await sleep(400);
      }
      await frames(run, page, entry, vp, view, "page-", run.opts.maxFrames);
      return;
    }
    if (!run.copy.has(entry.url)) run.copy.set(entry.url, await page.evaluate(visibleText).catch(() => ""));
    if (discover) {
      const hrefs = await page.$$eval("a[href]", pageLinks);
      for (const h of hrefs) discover(new URL(h));
    }
    await frames(run, page, entry, vp, view, "page-", run.opts.maxFrames);
    if (run.opts.details) {
      const opened = await page.evaluate(() => {
        let n = 0;
        for (const d of document.querySelectorAll("details:not([open])")) {
          d.open = true;
          n++;
        }
        return n;
      });
      if (opened) {
        await settle(page, run.net, { quiet: 300, max: 4000 });
        await frames(run, page, entry, vp, view, "open-", Math.min(4, run.opts.maxFrames));
        await page.goto(url.href, { waitUntil: "domcontentloaded" }).catch(() => {});
        await settle(page, run.net);
      }
    }
    await scrollTo(page, await findScroller(page), 0);
    await interact(run, page, entry, vp, view, url.href, discover);
  } catch (e) {
    view.errors.push(`visit failed: ${String(e.message || e).slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
    if (state && STATES[state].offline) await context.setOffline(false).catch(() => {});
  }
}

async function shoot() {
  const viewports = args.viewports.split(",").map((v) => v.trim()).filter(Boolean);
  for (const v of viewports) if (!VIEWPORTS[v]) throw new Error(`Unknown viewport ${v}; use ${Object.keys(VIEWPORTS).join(", ")}`);
  if (!["safe", "all", "none"].includes(args.interact)) throw new Error("--interact is safe, all or none");
  if (args["allow-writes"] && !isLocal(base)) throw new Error("--allow-writes only works against localhost");
  if (args.states === "help") {
    for (const [name, s] of Object.entries(STATES)) console.log(`${name.padEnd(10)} ${s.about} (${s.viewports.join(", ")})`);
    return;
  }
  const states = !args.states ? [] : args.states === "all" ? Object.keys(STATES) : args.states.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of states) if (!STATES[s]) throw new Error(`Unknown state ${s}; use ${Object.keys(STATES).join(", ")}, all or help`);
  // Its seeded games would upload into the signed-in account once writes go through.
  if (states.includes("unsynced") && args["allow-writes"]) throw new Error("--states unsynced can't be used with --allow-writes");
  const count = (name, min) => {
    const n = Number(args[name]);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} takes a whole number of at least ${min}`);
    return n;
  };
  const opts = {
    viewports,
    interact: args.interact,
    maxPages: count("max-pages", 1),
    samples: count("samples", 1),
    maxFrames: count("max-frames", 1),
    maxInteractions: count("max-interactions", 0),
    details: !args["no-details"],
    jpeg: !!args.jpeg,
    states,
  };
  const outDir = args.out ? resolve(CALLER, args.out) : join(REPO, "output", "polish", stamp());
  mkdirSync(outDir, { recursive: true });
  const run = new Run(outDir, opts);

  if (args.as) {
    // Reuse the saved session while it works; otherwise make one.
    let ok = false;
    if (existsSync(statePath)) {
      const b = await launch(false);
      const c = await b.newContext({ storageState: statePath });
      const me = await whoAmI(c.request);
      ok = !!me && (me.email ?? "").toLowerCase() === args.as.toLowerCase();
      await b.close();
    }
    if (!ok) await (isLocal(base) ? devLogin(args.as) : sshSession(args.as, args.hours));
  }
  const hasState = existsSync(statePath);
  const browser = await launch(!!args.headed);
  const newsId = newestNewsId();
  const newContext = async (vp, state = null) => {
    const { minTarget, edgePad, ...cfg } = VIEWPORTS[vp];
    const st = state ? STATES[state] : {};
    const context = await browser.newContext({
      ...cfg,
      ...st.context,
      storageState: hasState ? statePath : undefined,
      serviceWorkers: "block",
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    if (st.prompt !== false) await context.addInitScript(chromeInstallPrompt);
    if (st.init) await context.addInitScript(st.init);
    if (st.storage) {
      const items = Object.fromEntries(Object.entries(st.storage).map(([k, v]) => [k, v === "__NEWEST__" ? newsId : v]));
      await context.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      }, items);
    }
    const auth = sessionHeader();
    if (!args["allow-writes"] || Object.keys(auth).length) {
      await context.route("**/*", (route) => {
        const req = route.request();
        if (!args["allow-writes"] && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
          run.blocked.push({ method: req.method(), url: req.url().slice(0, 200), viewport: vp });
          return route.abort("blockedbyclient");
        }
        // The session as a header past Cloudflare's bot check, to the host only (sessionHeader).
        if (Object.keys(auth).length && new URL(req.url()).origin === base.origin) return route.continue({ headers: { ...req.headers(), ...auth } });
        return route.continue();
      });
    }
    if (!args["allow-writes"]) {
      // context.route doesn't see WebSocket traffic, and Yama's sockets write (a game's stop
      // preferences on connect, a shared table's state). Answer them here, never connecting to
      // the server: live pages show as disconnected, which is the price of a read-only run.
      await context.routeWebSocket(/.*/, (ws) => {
        const url = ws.url().slice(0, 200);
        if (!run.blocked.some((b) => b.method === "WEBSOCKET" && b.url === url && b.viewport === vp)) run.blocked.push({ method: "WEBSOCKET", url, viewport: vp });
        ws.onMessage(() => {});
      });
    }
    return context;
  };

  try {
    const probe = await newContext(viewports[0]);
    const me = await whoAmI(probe.request);
    await probe.close();
    console.log(me ? `Signed in as ${me.email ?? me.name}` : `Not signed in (no working session in ${statePath}); shooting the public pages and the sign-in screen`);

    const appSource = readFileSync(join(REPO, "web", "src", "App.tsx"), "utf8");
    const patterns = routesFromApp(appSource);
    const appMatchers = patterns.map(patternMatcher);
    const matchers = [...appMatchers, ...SERVER_ROUTES.map(patternMatcher)];
    const only = args.only ? new RegExp(args.only) : null;
    const exclude = args.exclude ? new RegExp(args.exclude) : null;

    const publicPages = SERVER_ROUTES.filter((p) => !p.includes(":"));
    const seeds = positionals.length ? positionals : me ? [...patterns.filter((p) => !p.includes(":")), ...publicPages] : ["/", ...publicPages];
    const queue = [];
    const queued = new Set();
    const perKey = new Map();
    const crawl = !args["no-crawl"] && !positionals.length;
    // Signed out, every app route is the sign-in screen: follow only links to the server's public
    // pages (/precons/..., /u/..., /d/...).
    const appRoute = (u) => appMatchers.some((m) => m.re.test(u.pathname));
    const allowed = (u) =>
      u.origin === base.origin && !NEVER_VISIT.some((re) => re.test(u.pathname)) && (!only || only.test(u.pathname)) && !(exclude && exclude.test(u.pathname));
    const enqueue = (u, force = false) => {
      u.hash = "";
      if (!allowed(u)) return;
      const key = u.pathname + u.search;
      if (queued.has(key)) return;
      if (!me && !force && appRoute(u)) return;
      const sk = sampleKey(u, matchers);
      const n = perKey.get(sk) ?? 0;
      if (!force && n >= opts.samples) return;
      if (queued.size >= opts.maxPages) return;
      perKey.set(sk, n + 1);
      queued.add(key);
      queue.push(u);
    };
    for (const s of seeds) enqueue(new URL(s, base), true);

    // The first size finds the pages; the others visit the same list.
    const [first, ...rest] = viewports;
    let context = await newContext(first);
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      const entry = run.record(u);
      entry.pattern = sampleKey(u, matchers);
      console.log(`[${first}] ${i + 1}/${queue.length} ${u.pathname}${u.search}`);
      await visit(run, context, first, u, crawl ? enqueue : null);
      run.save(me);
    }
    await context.close();
    for (const vp of rest) {
      context = await newContext(vp);
      for (let i = 0; i < queue.length; i++) {
        console.log(`[${vp}] ${i + 1}/${queue.length} ${queue[i].pathname}${queue[i].search}`);
        await visit(run, context, vp, queue[i], null);
        run.save(me);
      }
      await context.close();
    }
    for (const state of states) {
      for (const vp of STATES[state].viewports.filter((v) => viewports.includes(v))) {
        context = await newContext(vp, state);
        for (let i = 0; i < queue.length; i++) {
          console.log(`[${vp}, ${state}] ${i + 1}/${queue.length} ${queue[i].pathname}${queue[i].search}`);
          await visit(run, context, vp, queue[i], null, state);
          run.save(me);
        }
        await context.close();
      }
    }
    run.save(me);
    console.log(`\nDone: ${join(outDir, "report.md")}\n      ${join(outDir, "index.html")}`);
  } finally {
    await browser.close();
  }
}

/**
 * Contact sheets: a run's screens down each page, several pages to an image, labelled, so a
 * polish pass can look at the whole run in a few dozen images instead of hundreds. Written to
 * <run>/sheets/<size>[-state]-NN.png. Only page frames (not presses or marked copies).
 */
async function sheets() {
  if (!args.run) throw new Error("sheets needs --run DIR (an output/polish/<time> folder)");
  const dir = resolve(CALLER, args.run);
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const keys = [...new Set(report.pages.flatMap((p) => Object.keys(p.views)))].filter((k) => !args.size || k === args.size || k.startsWith(`${args.size}-`));
  const outDir = join(dir, "sheets");
  mkdirSync(outDir, { recursive: true });
  const browser = await launch(false);
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let written = 0;
  try {
    for (const key of keys) {
      const phone = key.startsWith("mobile") || key.startsWith("tablet");
      const per = Number(args.per ?? (phone ? 3 : 2));
      if (!Number.isInteger(per) || per < 1) throw new Error("--per takes a whole number of at least 1");
      const cols = phone ? 6 : 3;
      const rows = report.pages
        .map((p) => ({ url: p.url, shots: (p.views[key]?.shots ?? []).filter((s) => /^page-/.test(s.name)).slice(0, cols) }))
        .filter((r) => r.shots.length);
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#202226;color:#fff;font:600 18px system-ui;padding:8px}
section{margin:0 0 10px}h2{font-size:18px;margin:4px 0 6px;color:#ffd60a}
.row{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px}
figure{margin:0;position:relative}img{width:100%;display:block;outline:1px solid #555}
figcaption{position:absolute;left:0;top:0;background:#000c;font-size:13px;padding:1px 5px}
</style>${chunk
          .map(
            (r) =>
              `<section><h2>${esc(r.url)} <span style="color:#aaa">${esc(key)}</span></h2><div class="row">${r.shots
                .map((s) => `<figure><img src="${esc(s.file)}"><figcaption>${esc(s.name)}</figcaption></figure>`)
                .join("")}</div></section>`,
          )
          .join("")}`;
        const htmlPath = join(outDir, "_sheet.html");
        // In the run folder's sheets/, so the screens' relative paths need ../
        writeFileSync(htmlPath, html.replaceAll('src="shots/', 'src="../shots/'));
        await page.goto(pathToFileURL(htmlPath).href);
        await page.waitForLoadState("load");
        const out = join(outDir, `${key}-${String(i / per + 1).padStart(2, "0")}.png`);
        await page.screenshot({ path: out, fullPage: true });
        written++;
      }
    }
  } finally {
    await browser.close();
    rmSync(join(outDir, "_sheet.html"), { force: true });
  }
  console.log(`${written} sheets in ${outDir}`);
}

try {
  // A session token sent over plain HTTP to another machine could be read on the way.
  if (base.protocol !== "https:" && !isLocal(base)) throw new Error(`Use https for ${base.host}: only localhost may be plain http`);
  if (command === "login") await login();
  else if (command === "shoot") await shoot();
  else if (command === "sheets") await sheets();
  else usage(1);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
