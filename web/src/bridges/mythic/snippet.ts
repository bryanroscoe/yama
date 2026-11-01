/**
 * What a person pastes into the browser console on mythic.tools, signed in there, to save their
 * Mythic games as a file for Yama's import. It runs on Mythic's own page with that page's session,
 * so no Mythic password or token ever reaches Yama (ARCHITECTURE.md, "Mythic Tools bridge"; the
 * API it calls is in docs/mythic-bridge.md). It only reads.
 *
 * Kept as plain, readable source rather than a compiled function, so whoever pastes it can read
 * what it does.
 */
export const MYTHIC_SNIPPET = String.raw`(async () => {
  // Mythic's public web settings (API address and request keys), read from its own page.
  const page = await (await fetch("/login")).text();
  const cfg = {};
  for (const k of ["MYTHIC_API_URL", "MYTHIC_API_KEY", "MYTHIC_WEB_KEY", "SLUG_1", "SLUG_2", "FIREBASE_API_KEY"]) {
    const m = page.match(new RegExp("\\b" + k + ':"([^"]*)"'));
    if (!m) throw new Error("Mythic's page has changed (" + k + " is missing); Yama's snippet needs an update.");
    cfg[k] = m[1];
  }
  const API = cfg.MYTHIC_API_URL.replace(/\/$/, "");

  // This browser's Mythic sign-in.
  const db = await new Promise((ok, fail) => { const r = indexedDB.open("firebaseLocalStorageDb"); r.onsuccess = () => ok(r.result); r.onerror = fail; });
  const saved = await new Promise((ok) => { const r = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll(); r.onsuccess = () => ok(r.result); });
  const account = saved.map((x) => x.value).find((v) => v && v.stsTokenManager);
  if (!account) throw new Error("Sign in to Mythic Tools on this page first.");
  let token = account.stsTokenManager.accessToken;
  if (!token || account.stsTokenManager.expirationTime < Date.now() + 60000) {
    const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + cfg.FIREBASE_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(account.stsTokenManager.refreshToken),
    });
    token = (await r.json()).id_token;
  }

  const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  let mythicId = null;
  const call = async (method, path, body) => {
    const ts = String(Date.now());
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": cfg.MYTHIC_API_KEY,
      "x-mythic-timestamp": ts,
      "x-mythic-signature": await sha256(cfg.SLUG_1 + "+/" + ts + "." + cfg.MYTHIC_WEB_KEY + "/+" + cfg.SLUG_2 + "!"),
      "x-mythic-device": "web",
      "x-app-locale": "en",
      authorization: "Bearer " + token,
    };
    if (mythicId) headers["x-mythic-id"] = mythicId;
    const r = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error("Mythic answered " + r.status + " for " + path);
    await new Promise((ok) => setTimeout(ok, 300));
    return r.json();
  };
  const inner = (b) => (b && b.data && Object.keys(b).length <= 3 ? inner(b.data) : b);

  const me = inner(await call("POST", "/auth/signin", { fcmToken: null, locale: "en", firstname: null })).user;
  mythicId = String(me.id);
  console.log("Saving Mythic games for " + (me.firstname || me.username || mythicId) + "...");

  // Every game, newest first, paging back by the oldest start time seen.
  const ids = new Set();
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const b = inner(await call("GET", "/games" + (cursor ? "?timestamp=" + encodeURIComponent(cursor) : "")));
    const batch = (Array.isArray(b) ? b : b.games || b.items || []).filter((g) => !ids.has(g.id));
    if (!batch.length) break;
    batch.forEach((g) => ids.add(g.id));
    cursor = batch.map((g) => g.started_at).filter(Boolean).sort()[0];
    if (!cursor) break;
  }

  // Each game in full, and its commanders by name (Mythic names cards by its own ids).
  const names = new Map();
  const cardName = async (id) => {
    if (!id) return null;
    if (!names.has(id)) {
      try {
        const c = inner(await call("GET", "/card/id?id=" + encodeURIComponent(id)));
        names.set(id, (c && (c.name || (c.card && c.card.name))) || null);
      } catch (e) {
        names.set(id, null);
      }
    }
    return names.get(id);
  };
  const games = [];
  let n = 0;
  for (const id of ids) {
    const g = inner(await call("GET", "/game/" + id));
    const game = g.game || g;
    for (const p of game.players || []) {
      if (!p.deck) continue;
      // Yama keeps one commander per seat, as Log a game does.
      p.deck = { id: p.deck.id, name: p.deck.name, commander_name: await cardName(p.deck.commander_card_id) };
      delete p.picture;
    }
    delete game.events;
    games.push({ game });
    if (++n % 10 === 0) console.log(n + " of " + ids.size + " games");
  }

  const file = { source: "mythic.tools", exported_at: new Date().toISOString(), me: { id: me.id, name: me.firstname || me.username || null }, games };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
  a.download = "mythic-games-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  console.log("Saved " + games.length + " games. Upload the file on Yama's Mythic Tools import.");
})();`;
