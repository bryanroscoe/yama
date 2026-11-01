/**
 * What a person pastes into the browser console on mythic.tools, signed in there: one snippet
 * saves their Mythic games and decks as a file for Yama's import and only reads; the other sends
 * one Yama deck to Mythic. Both run on Mythic's own page with that page's session, so no Mythic
 * password or token ever reaches Yama (ARCHITECTURE.md, "Mythic Tools bridge"; the API they call
 * is in docs/mythic-bridge.md).
 *
 * Kept as plain, readable source rather than a compiled function, so whoever pastes one can read
 * what it does.
 */
/** Mythic's settings, this browser's Mythic sign-in, and a signed request: every snippet starts so. */
const PRELUDE = String.raw`  // Mythic's public web settings (API address and request keys), read from its own page.
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

`;

/** Reads only: the person's games and decks, saved as a file. */
const SAVE = String.raw`  const me = inner(await call("POST", "/auth/signin", { fcmToken: null, locale: "en", firstname: null })).user;
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

  // Each deck with its main list (Yama compares commander and main deck).
  const deckList = inner(await call("GET", "/user/decks"));
  const decks = [];
  for (const d of Array.isArray(deckList) ? deckList : deckList.decks || []) {
    const b = inner(await call("GET", "/deck/" + d.id));
    const groups = (b.lists && b.lists.main && b.lists.main.grouped_cards) || [];
    decks.push({
      id: b.deck.id,
      name: b.deck.name,
      formatid: b.deck.formatid,
      cards: groups.flatMap((grp) => (grp.cards || []).map((c) => ({
        name: c.name, oracle_id: c.oracleid, set_code: c.set_code, collector_number: c.collector_number,
        finish: c.finish, quantity: c.quantity, commander: grp.type === "Commander",
      }))),
    });
  }
  console.log("Saved " + decks.length + " decks.");

  const file = { source: "mythic.tools", exported_at: new Date().toISOString(), me: { id: me.id, name: me.firstname || me.username || null }, games, decks };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
  a.download = "mythic-games-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  console.log("Saved " + games.length + " games and " + decks.length + " decks. Upload the file on Yama's Mythic Tools import.");
`;

export const MYTHIC_SNIPPET = "(async () => {\n" + PRELUDE + SAVE + "})();";

/** What the send snippet carries: the deck as the deck page shows it. */
export interface MythicSend {
  /** Yama's one-time code for this send, which links the deck when the snippet comes back. */
  code: string;
  /** The Mythic deck it updates, if the deck is linked; else it makes one. */
  mythic_id: string | null;
  name: string;
  /** private, shared, unlisted or public: Mythic's own choices, for a deck it makes. */
  privacy: string;
  cards: { name: string; oracle_id: string; qty: number; board: string; printing: { set_code: string; collector_number: string; finish: string } | null }[];
  /** Where Yama answers: the page that links the deck. */
  back: string;
}

/** Creates the Mythic deck, or brings the linked one in step, then opens Yama to link it. */
const SEND = String.raw`
  const me = inner(await call("POST", "/auth/signin", { fcmToken: null, locale: "en", firstname: null })).user;
  mythicId = String(me.id);
  const q = encodeURIComponent;
  const piles = (d) => ((d.lists && d.lists.main && d.lists.main.grouped_cards) || []).flatMap((grp) => (grp.cards || []).map((c) => ({ ...c, commander: grp.type === "Commander" })));
  const load = async (id) => inner(await call("GET", "/deck/" + id));
  // Mythic names cards by its own ids: find the commander's by its printing.
  const cardId = async (p) => {
    const b = inner(await call("GET", "/card?set_code=" + q(p.set_code) + "&collector_number=" + q(p.collector_number) + "&lang=en&finish=" + q(p.finish || "nonfoil")));
    const c = (b && b.card) || b;
    return (c && (c.cardid || c.card_id)) || null;
  };
  const commanders = SEND.cards.filter((c) => c.board === "commander");

  // The linked Mythic deck, if it's still there and still yours; else a new one.
  let deck = null;
  if (SEND.mythic_id) {
    try {
      const b = await load(SEND.mythic_id);
      if (b.deck && !b.deck.deleted && String(b.deck.created_by) === mythicId) deck = b;
    } catch (e) {
      // Only a deck that's gone gets replaced; a passing failure stops here, so it isn't doubled.
      if (!/answered 404 /.test(String(e && e.message))) throw e;
    }
  }
  if (!deck) {
    const ids = [];
    for (const c of commanders.slice(0, 2)) ids.push(c.printing ? await cardId(c.printing) : null);
    const made = inner(await call("POST", "/deck", {
      type: 0, name: SEND.name, formatid: 6, colors: "",
      commander_card_id: ids[0] || null, partner_card_id: ids[1] || null,
      signature_spell_card_id: null, partner_signature_spell_card_id: null, companion_card_id: null, externalurl: null,
      rightplaymat_card_id: ids[0] || null, rightplaymat_face_index: 0,
      privacy: { type: SEND.privacy, options: { share_stats: true, share_games: false }, circleIds: [] },
    }));
    if (!made.deckId) throw new Error("Mythic didn't make the deck.");
    deck = await load(made.deckId);
    console.log("Made " + SEND.name + " in Mythic.");
  } else {
    if (deck.deck.name !== SEND.name) await call("PUT", "/deck/" + deck.deck.id, { name: SEND.name });
    const had = piles(deck).filter((c) => c.commander).map((c) => c.oracleid).sort().join();
    const want = commanders.map((c) => c.oracle_id).sort().join();
    if (had !== want && commanders[0] && commanders[0].printing) {
      // The commander, then the partner (or none), as Mythic's deck form saves them.
      await call("PUT", "/deck/" + deck.deck.id + "/commander", { card_id: await cardId(commanders[0].printing), allow_color_change: true });
      const partner = commanders[1] && commanders[1].printing ? await cardId(commanders[1].printing) : null;
      await call("PUT", "/deck/" + deck.deck.id, { partner_card_id: partner });
      deck = await load(deck.deck.id);
      const now = piles(deck).filter((c) => c.commander).map((c) => c.oracleid).sort().join();
      if (now !== want) console.warn("Mythic kept other commanders; set them on mythic.tools. Yama will show the deck as changed.");
    }
  }

  // The main deck by card: take away what Yama's list doesn't have, add what it has more of.
  const want = new Map();
  for (const c of SEND.cards.filter((c) => c.board === "main")) {
    const w = want.get(c.oracle_id) || { qty: 0, card: c };
    w.qty += c.qty;
    want.set(c.oracle_id, w);
  }
  const remove = [];
  const have = new Map();
  for (const p of piles(deck).filter((c) => !c.commander)) {
    const left = Math.max(0, (want.get(p.oracleid) || { qty: 0 }).qty - (have.get(p.oracleid) || 0));
    const keep = Math.min(left, p.quantity);
    have.set(p.oracleid, (have.get(p.oracleid) || 0) + keep);
    if (p.quantity > keep) remove.push({ list_card_id: p.list_card_id, quantity: p.quantity - keep });
  }
  if (remove.length) await call("POST", "/user/lists/" + deck.deck.listid + "/cards/remove", { cards: remove });
  const add = [];
  const missing = [];
  for (const [oracle, w] of want) {
    const more = w.qty - (have.get(oracle) || 0);
    if (more <= 0) continue;
    if (!w.card.printing) { missing.push(w.card.name); continue; }
    const p = w.card.printing;
    add.push({ set_code: p.set_code, collector_number: p.collector_number, lang: "en", finish: p.finish || "nonfoil", quantity: more, condition: "NM", incollection: false, proxy: false });
  }
  for (let i = 0; i < add.length; i += 50) {
    const r = inner(await call("POST", "/user/lists/" + deck.deck.listid + "/cards", { cards: add.slice(i, i + 50) }));
    const failed = (r && r.result && r.result.failed_cards) || [];
    failed.forEach((f) => missing.push(f.name || f.set_code + " " + f.collector_number));
  }
  if (missing.length) console.warn("Mythic didn't take: " + missing.join(", "));

  // What Mythic has now, printed as Yama prints a list, so Yama knows whether all of it arrived.
  deck = await load(deck.deck.id);
  const rows = new Map();
  for (const p of piles(deck)) {
    const k = (p.commander ? "c:" : "m:") + p.oracleid;
    rows.set(k, (rows.get(k) || 0) + p.quantity);
  }
  const print = await sha256([...rows].map(([k, n]) => k + ":" + n).sort().join("\n"));
  const back = SEND.back + "?code=" + q(SEND.code) + "&mythic=" + q(deck.deck.id) + "&print=" + print;
  console.log("Sent " + SEND.name + " to Mythic. Finish in Yama: " + back);
  window.open(back, "_blank");
`;

/** The send snippet for one deck, with the deck in it. */
export function mythicSendSnippet(send: MythicSend): string {
  return "(async () => {\n  const SEND = " + JSON.stringify(send) + ";\n" + PRELUDE + SEND + "})();";
}
