// Synthetic, local-only two-phone regression. Start Vite with
// VITE_RELAY_URL=ws://synthetic.local npm run dev -w web -- --host 127.0.0.1 --port 5193
// then node web/scripts/test-shared-table.mjs [base] [screenshot-directory].
// No production data, accounts, API writes or relay connections are used.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://127.0.0.1:5193";
assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "local server required");
const shots = process.argv[3];
if (shots) await mkdir(shots, { recursive: true });
const id = "10f0d402-851d-4aab-90f0-6e1720bbb641";
const setup = { id, startedAt: new Date().toISOString(), format: "commander", startingLife: 40, playgroupId: "bros", players: [
  { seat: 0, name: "Host", userId: "host", colorIdentity: "R" },
  { seat: 1, name: "Friend", userId: "friend", colorIdentity: "U" },
  { seat: 2, name: "Third", colorIdentity: "G" },
  { seat: 3, name: "Fourth", colorIdentity: "W" },
] };
const old = { ...setup, id: "old-local", startedAt: "2026-10-01T19:00:00Z", players: [{ seat: 0, name: "Old test", colorIdentity: "" }] };
const local = (setup, owner) => ({ setup, owner, log: [], redo: [], syncedThrough: 0 });
const rooms = new Map();
const events = [];
const uploads = [];
const errors = [];
let liveKey = "a".repeat(32);
let activeId = id;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  async function phone(user, host = false, shareAtBoot = true) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await context.addInitScript(({ user, game, id, host, shareAtBoot }) => {
      if (localStorage.getItem("synthetic-seeded")) return;
      localStorage.setItem("synthetic-seeded", "1");
      localStorage.setItem("yama.me", JSON.stringify({ id: user, email: `${user}@example.com`, display_name: user, is_admin: false }));
      localStorage.setItem(`yama.table.current.${user}`, JSON.stringify(game));
      localStorage.setItem("yama.table.layout.4", "ends");
      localStorage.setItem("yama.table.turns", "on");
      localStorage.setItem("yama.table.art", host ? "off" : "on");
      if (host && shareAtBoot) localStorage.setItem(`yama.table.hosting.${user}`, id);
    }, { user, game: local(host ? setup : old, user), id, host, shareAtBoot });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let data = [];
      if (url.pathname === "/api/me") data = { id: user, email: `${user}@example.com`, display_name: user, is_admin: false };
      else if (url.pathname === "/api/table/active") data = activeId ? [{ id: activeId, group_name: "Magic Bros", host_name: "Host", started_at: setup.startedAt, key: liveKey, relay: "edge" }] : [];
      else if (/\/api\/table\/.*\/live/.test(url.pathname) && route.request().method() === "PUT") { liveKey = route.request().postDataJSON().key; data = {}; }
      else if (url.pathname === "/api/games" && route.request().method() === "POST") { uploads.push(route.request().frame().page()); data = { id: route.request().postDataJSON().id }; }
      else if (url.pathname === "/api/people/search") data = [];
      else if (url.pathname === "/api/cards/offline") return route.fulfill({ status: 503, body: "synthetic cards unavailable" });
      await route.fulfill({ json: data });
    });
    await context.routeWebSocket("ws://synthetic.local/**", (ws) => {
      const url = new URL(ws.url());
      const gameId = url.pathname.split("/")[2];
      let room = rooms.get(gameId);
      if (!room) { room = { host: null, guests: new Set(), snapshot: null }; rooms.set(gameId, room); }
      const isHost = url.searchParams.get("role") === "host";
      if (isHost) {
        room.host = ws;
        for (const guest of room.guests) guest.send(JSON.stringify({ type: "host", connected: true }));
      } else {
        room.guests.add(ws);
        ws.send(JSON.stringify({ type: "host", connected: !!room.host }));
        if (room.snapshot) ws.send(room.snapshot);
      }
      ws.onMessage((message) => {
        const value = JSON.parse(String(message));
        if (isHost) {
          room.snapshot = String(message);
          for (const guest of room.guests) guest.send(message);
        } else {
          events.push(value.event);
          room.host?.send(message);
        }
      });
      ws.onClose(() => {
        if (isHost && room.host === ws) {
          room.host = null;
          for (const guest of room.guests) guest.send(JSON.stringify({ type: "host", connected: false }));
        } else room.guests.delete(ws);
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  const host = await phone("host", true, false);
  await host.goto(`${base}/table/play`);
  await host.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  // Start with two already-open, unshared copies. Starting sharing must fence the old
  // second document immediately, without relying on a reload or changed game ID.
  const preopened = await host.context().newPage();
  preopened.on("pageerror", (error) => errors.push(error.message));
  await preopened.goto(`${base}/table/play`);
  await preopened.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  await preopened.evaluate(async () => { await (await import("/src/table/store.ts")).sync(); });
  const previousUploads = uploads.filter((p) => p === preopened).length;
  await host.getByRole("button", { name: "Table menu", exact: true }).click();
  await host.getByRole("button", { name: "Show the code", exact: true }).click();
  await preopened.waitForURL("**/table/join/**");
  await preopened.getByRole("button", { name: /Host.*40/ }).click();
  await preopened.getByRole("button", { name: "Whole table", exact: true }).click();
  await preopened.evaluate(async () => {
    const store = await import("/src/table/store.ts");
    store.dispatch({ type: "life", seat: 0, delta: -10 });
    await store.sync();
  });
  assert.equal(uploads.filter((p) => p === preopened).length, previousUploads, "an already-open follower makes no stale uploads");
  assert.equal(await preopened.evaluate(() => JSON.parse(localStorage.getItem("yama.table.current.host")).log.length), 0);
  await host.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await host.getByRole("button", { name: "Back to the game", exact: true }).click();
  // Removal must clear following/read-only state in that same document. Navigate through
  // the app, without reloading it, and confirm the local counter is editable again.
  await preopened.getByRole("button", { name: "Table menu", exact: true }).click();
  await preopened.getByRole("button", { name: "Leave the table", exact: true }).click();
  await preopened.getByRole("button", { name: "Back to the table", exact: true }).click();
  await preopened.waitForURL(`${base}/table/play`);
  await preopened.getByRole("button", { name: "Host gains 1 life", exact: true }).click();
  await host.getByRole("region", { name: /^Host, 41 life/ }).waitFor();
  await host.getByRole("button", { name: "Host loses 1 life", exact: true }).click();
  await preopened.getByRole("region", { name: /^Host, 40 life/ }).waitFor();
  await preopened.close();
  await host.getByRole("button", { name: "Table menu", exact: true }).click();
  await host.getByRole("button", { name: "Show the code", exact: true }).click();
  await host.getByRole("button", { name: "Back to the game", exact: true }).click();
  await host.evaluate((id) => localStorage.removeItem(`yama.guest.${id}`), id);
  const secondary = await host.context().newPage();
  secondary.on("pageerror", (error) => errors.push(error.message));
  await secondary.goto(`${base}/table/play`);
  await secondary.waitForURL("**/table/join/**");
  await secondary.getByRole("button", { name: /Host.*40/ }).click();
  await secondary.getByRole("button", { name: "Whole table", exact: true }).click();
  await secondary.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  assert(await host.getByRole("button", { name: "Host gains 1 life", exact: true }).isVisible(), "original host keeps its counter");
  assert.equal(uploads.filter((p) => p === secondary).length, 0, "passive second tab must not upload stale state, even at startup");
  await secondary.close();
  const guest = await phone("friend");
  await guest.goto(base);
  await guest.getByRole("heading", { name: "Magic Bros is playing" }).waitFor();
  await guest.getByRole("link", { name: "Join the table", exact: true }).click();
  await guest.getByRole("button", { name: /Friend.*40/ }).click();
  await guest.getByRole("button", { name: "Whole table", exact: true }).click();
  await guest.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  // The host gets the same direct view switch as every other player.
  await host.getByRole("button", { name: "My seat", exact: true }).click();
  await host.locator(".table-my-panel").waitFor();
  assert.equal(await host.locator(".table-my-panel > .panel").count(), 1);
  await host.getByRole("button", { name: "Whole table", exact: true }).click();
  await guest.getByRole("button", { name: "My seat", exact: true }).click();
  await guest.locator(".table-my-panel").waitFor();
  await guest.getByRole("button", { name: "Whole table", exact: true }).click();
  async function geometry(page) {
    return page.locator(".table > .panel").evaluateAll((panels) => panels.map((p) => ({ area: p.style.gridArea, transform: p.querySelector(".panel-inner").style.transform, noArt: p.classList.contains("no-art") })));
  }
  for (const [name, width, height] of [["mobile", 390, 844], ["tablet", 820, 1180], ["laptop", 1440, 900]]) {
    await host.setViewportSize({ width, height }); await guest.setViewportSize({ width, height });
    await host.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await guest.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await geometry(guest), await geometry(host), `${name}: joined table must match host`);
    assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow`);
    if (shots) await guest.screenshot({ path: `${shots}/${name}-shared-table.png` });
    await guest.getByRole("button", { name: "My seat", exact: true }).click();
    await guest.locator(".table-my-panel").waitFor();
    assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: own view fits`);
    if (shots) await guest.screenshot({ path: `${shots}/${name}-my-seat.png` });
    await guest.getByRole("button", { name: "Whole table", exact: true }).click();
  }
  await guest.getByRole("button", { name: "Host loses 1 life", exact: true }).click();
  await host.locator(".panel").filter({ has: host.getByRole("button", { name: "Host gains 1 life", exact: true }) }).locator(".life").getByText("39", { exact: true }).waitFor();
  assert.equal(events.at(-1).type, "life");
  // The host's art-off choice must override the follower's locally enabled art setting,
  // including mana fills rather than neutral "missing art" panels in both views.
  assert.equal(await guest.locator(".panel.no-art").count(), 0);
  await guest.getByRole("button", { name: "My seat", exact: true }).click();
  assert.equal(await guest.locator(".table-my-panel .panel.no-art").count(), 0);
  await guest.getByRole("button", { name: "Whole table", exact: true }).click();
  const observer = await phone("observer");
  await observer.goto(`${base}/table/join/${id}#k=${liveKey}&r=cf`);
  await observer.getByRole("button", { name: /Just following/ }).click();
  await observer.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  await guest.clock.install();
  await observer.clock.install();
  const deliver = (event) => rooms.get(id).host.send(JSON.stringify({ type: "event", event }));
  const life = (page, name, value) => page.getByRole("region", { name: new RegExp(`^${name}, ${value} life`) });
  // Other seats' lethal totals prompt the host, not this selected follower or a watcher.
  deliver({ type: "life", seat: 0, delta: -40 });
  await life(guest, "Host", -1).waitFor();
  await life(observer, "Host", -1).waitFor();
  await guest.clock.fastForward(1200); await observer.clock.fastForward(1200);
  await host.getByRole("dialog", { name: "Out of the game?", exact: true }).waitFor();
  assert.equal(await guest.getByRole("dialog", { name: "Out of the game?", exact: true }).count(), 0);
  assert.equal(await observer.getByRole("dialog", { name: "Out of the game?", exact: true }).count(), 0);
  await host.getByRole("button", { name: "Not out, keep playing", exact: true }).click();
  deliver({ type: "life", seat: 0, delta: 40 });
  await life(guest, "Host", 39).waitFor();
  // The follower still gets their own lethal prompt; a watcher never gets one.
  deliver({ type: "life", seat: 1, delta: -40 });
  await life(guest, "Friend", 0).waitFor();
  await life(observer, "Friend", 0).waitFor();
  await guest.clock.fastForward(1200); await observer.clock.fastForward(1200);
  await guest.getByRole("dialog", { name: "Out of the game?", exact: true }).waitFor();
  await host.getByRole("dialog", { name: "Out of the game?", exact: true }).waitFor();
  assert.equal(await observer.getByRole("dialog", { name: "Out of the game?", exact: true }).count(), 0);
  await guest.getByRole("button", { name: "Not out, keep playing", exact: true }).click();
  await host.getByRole("button", { name: "Not out, keep playing", exact: true }).click();
  deliver({ type: "life", seat: 1, delta: 40 });
  await life(guest, "Friend", 40).waitFor();
  await observer.close();
  await guest.getByRole("button", { name: /Open table menu/ }).click();
  assert.equal(await guest.getByRole("button", { name: "Finish the game", exact: true }).count(), 0);
  assert.equal(await guest.getByRole("button", { name: "Discard game", exact: true }).count(), 0);
  assert.equal(await guest.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  await guest.getByRole("button", { name: "Roll for first", exact: true }).click();
  assert.equal(events.at(-1).type, "set_first");
  assert.equal(await guest.evaluate(() => JSON.parse(localStorage.getItem("yama.table.current.friend")).log.length), 0, "guest must not mutate saved old game");
  await guest.getByRole("button", { name: "Leave the table", exact: true }).click();
  await guest.getByRole("link", { name: "Back to the shared table", exact: true }).waitFor();
  await guest.reload();
  await guest.getByRole("link", { name: "Back to the shared table", exact: true }).click();
  await guest.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  await host.reload();
  await host.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  await guest.getByRole("button", { name: "Host gains 1 life", exact: true }).click();
  await host.locator(".panel").filter({ has: host.getByRole("button", { name: "Host gains 1 life", exact: true }) }).locator(".life").getByText("40", { exact: true }).waitFor();
  await host.getByRole("button", { name: /Open table menu/ }).click();
  await host.getByRole("button", { name: "Finish the game", exact: true }).click();
  await host.getByRole("dialog", { name: "Table menu" }).getByRole("button", { name: "Host", exact: true }).click();
  await host.getByRole("button", { name: "Save and play again", exact: true }).click();
  await host.getByRole("heading", { name: "Who goes first?", exact: true }).waitFor();
  await host.getByRole("button", { name: "Skip", exact: true }).click();
  await guest.getByRole("button", { name: "Host gains 1 life", exact: true }).waitFor();
  assert.notEqual(new URL(guest.url()).pathname, `/table/join/${id}`, "guest follows rematch");
  const nextId = new URL(guest.url()).pathname.split("/").at(-1);
  // Reopening the previous QR follows its retained rematch address too.
  await guest.goto(`${base}/table/join/${id}#k=${liveKey}&r=cf`);
  await guest.waitForURL(`**/table/join/${nextId}*`);
  await host.getByRole("button", { name: /Open table menu/ }).click();
  host.once("dialog", (dialog) => dialog.accept());
  await host.getByRole("button", { name: "Discard game", exact: true }).click();
  activeId = null;
  await guest.getByRole("heading", { name: "This table has ended", exact: true }).waitFor();
  await guest.getByRole("link", { name: "Back to Table", exact: true }).click();
  assert.equal(await guest.getByRole("link", { name: "Back to the shared table", exact: true }).count(), 0);
  assert.deepEqual(errors, [], "no browser runtime errors");
  console.log("PASS: already-open tab marker creation/removal, immediate write fencing, group discovery, host-identical layouts at three sizes, remote life/first-player actions, host-only controls, home return/reload, host reload, rematch/live and sleeping phones, discard/end, old-local isolation, follower-selected lethal prompts, watcher suppression, shared art-off fills, no runtime errors.");
} finally { await browser.close(); }
