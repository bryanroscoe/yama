import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bottom, draw, expandDeck, identityName, newHand, rng, type Goldfish } from "@yama/core";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, usd, type Container, type DeckCard, type DeckEntry, type DeckSummary, type DeckView } from "../api";
import { CardImage, ErrorText, ManaCost, Pips, Sheet } from "../components/ui";
import { ArtPanel } from "../components/ArtPanel";
import { CardSheet } from "./Cards";

export function DecksPage() {
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [adding, setAdding] = useState(false);
  return (
    <main className="page">
      <div className="page-head">
        <h1>Decks</h1>
        <button className="primary" onClick={() => setAdding(true)}>Add a deck</button>
      </div>
      <ErrorText error={decks.error} />
      {decks.data?.length === 0 && (
        <p className="empty">No decks yet. Paste a list from Moxfield, Archidekt, Arena or a text file to add one.</p>
      )}
      <div className="deck-tiles">
        {decks.data?.map((d) => (
          <Link key={d.id} to={`/decks/${d.id}`} className="deck-tile">
            <ArtPanel art={d.commander_image} artist={d.commander_artist} wash="bottom" empty={!d.commanders.length}>
              <span className="deck-tile-name">{d.name}</span>
              <span className="deck-tile-meta">
                <Pips identity={d.color_identity} />
                <span>{d.commanders.join(" and ") || "No commander set"}</span>
              </span>
              <span className="deck-tile-meta num">{d.card_count} cards</span>
            </ArtPanel>
          </Link>
        ))}
      </div>
      {adding && <AddDeck onClose={() => setAdding(false)} />}
    </main>
  );
}

function AddDeck({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [firstIsCommander, setFirst] = useState(true);
  const create = useMutation({
    mutationFn: () => api<{ id: string; unknown: string[] }>("/api/decks", { method: "POST", json: { name, text, first_is_commander: firstIsCommander } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["decks"] });
      if (r.unknown.length) alert(`Added. These names didn't match any card: ${r.unknown.join(", ")}`);
      navigate(`/decks/${r.id}`);
    },
  });
  return (
    <Sheet label="Add a deck" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="sheet-head">
          <h2>Add a deck</h2>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Omo lands" />
        </label>
        <label>
          Deck list
          <span className="hint">One card per line, like "1 Sol Ring". Sections such as "Commander" and set codes are fine.</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} required />
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
          <input type="checkbox" checked={firstIsCommander} onChange={(e) => setFirst(e.target.checked)} style={{ width: "auto", minHeight: 0 }} />
          With no Commander section, the first card is the commander
        </label>
        <ErrorText error={create.error} />
        <div className="row">
          <button className="primary" disabled={create.isPending}>Add the deck</button>
        </div>
      </form>
    </Sheet>
  );
}

const GROUPS: [string, (t: string) => boolean][] = [
  ["Creatures", (t) => t.includes("Creature")],
  ["Planeswalkers", (t) => t.includes("Planeswalker")],
  ["Instants", (t) => t.includes("Instant")],
  ["Sorceries", (t) => t.includes("Sorcery")],
  ["Artifacts", (t) => t.includes("Artifact")],
  ["Enchantments", (t) => t.includes("Enchantment")],
  ["Battles", (t) => t.includes("Battle")],
  ["Lands", (t) => t.includes("Land")],
];

function groupOf(e: DeckEntry): string {
  if (e.board === "commander") return "Commander";
  if (e.board === "side") return "Sideboard";
  // Lands that are also creatures (Dryad Arbor) read as lands; the front face decides for MDFCs.
  const t = (e.card?.type_line ?? "").split(" // ")[0]!;
  if (t.includes("Land")) return "Lands";
  return GROUPS.find(([, test]) => test(t))?.[0] ?? "Other";
}

export function DeckPage() {
  const { id } = useParams();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: () => api<DeckView>(`/api/decks/${id}`) });
  const [view, setView] = useState<"all" | "needed">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [goldfish, setGoldfish] = useState(false);

  const groups = useMemo(() => {
    const order = ["Commander", ...GROUPS.map(([g]) => g), "Other", "Sideboard"];
    const map = new Map<string, DeckEntry[]>();
    for (const e of deck.data?.cards ?? []) {
      if (view === "needed" && e.needed === 0) continue;
      const g = groupOf(e);
      map.set(g, [...(map.get(g) ?? []), e]);
    }
    return order.filter((g) => map.has(g)).map((g) => [g, map.get(g)!.sort((a, b) => (a.card?.cmc ?? 0) - (b.card?.cmc ?? 0) || a.name.localeCompare(b.name))] as const);
  }, [deck.data, view]);

  if (deck.error) return <main className="page"><ErrorText error={deck.error} /></main>;
  const d = deck.data;
  if (!d) return <main className="page" />;
  const v = d.validation;
  const o = d.ownership;
  const commander = d.cards.find((e) => e.board === "commander" && e.card?.image_art_crop)?.card;

  return (
    <main className="page">
      <p className="small"><Link to="/decks">Decks</Link></p>
      <ArtPanel className="deck-hero" art={commander?.image_art_crop} artist={commander?.artist} wash="bottom" toGround>
        <h1 className="hero-title">{d.name}</h1>
        <p className="hero-sub">
          <Pips identity={v.color_identity} /> {identityName(v.color_identity)}, {v.total} cards
        </p>
      </ArtPanel>
      <div className="page-head deck-actions">
        <div className="row">
          <button onClick={() => setGoldfish(true)}>Draw a sample hand</button>
          <button onClick={() => setEditing(true)}>Edit deck</button>
        </div>
      </div>
      {editing && <EditDeck deck={d} onClose={() => setEditing(false)} />}
      {goldfish && <SampleHand deck={d} onClose={() => setGoldfish(false)} />}

      <div className="figures">
        <div className="figure">
          <b className="num">{o.owned}/{o.cards}</b>
          <span>cards you own</span>
        </div>
        <div className="figure">
          <b className="num">{o.needed}</b>
          <span>still needed</span>
        </div>
        <div className="figure">
          <b className="num">{usd(o.needed_cost_usd)}</b>
          <span>
            cheapest market price for the rest, basics excluded
            {o.needed_without_price > 0 ? `; ${o.needed_without_price} have no price` : ""}
          </span>
        </div>
      </div>

      {v.ok ? (
        <p><span className="tag good">Commander-legal</span> <span className="dim small">by size, singleton, color identity and the ban list in our card data.</span></p>
      ) : (
        <div>
          <p><span className="tag bad">Not legal yet</span></p>
          <ul className="small">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {v.warnings.length > 0 && <ul className="small dim">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      <div className="segmented" role="tablist" style={{ margin: "1rem 0" }}>
        <button role="tab" aria-selected={view === "all"} onClick={() => setView("all")}>Whole deck</button>
        <button role="tab" aria-selected={view === "needed"} onClick={() => setView("needed")}>Cards you still need</button>
      </div>

      {groups.map(([group, entries]) => (
        <section key={group} style={{ marginBottom: "1.5rem" }}>
          <h3>
            {group} <span className="dim num">{entries.reduce((a, e) => a + e.qty, 0)}</span>
          </h3>
          <div className="list">
            {entries.map((e) => (
              <button key={`${e.oracle_id}-${e.board}`} className="list-row" onClick={() => setOpen(e.oracle_id)}>
                <CardImage src={e.card?.image_small} name={e.name} className="thumb" />
                <span>
                  <span className="title">{e.qty > 1 ? `${e.qty} ` : ""}{e.name}</span> <ManaCost cost={e.card?.mana_cost ?? null} />
                  <br />
                  <span className="small dim">
                    {e.owned > 0 ? `Own ${e.owned}: ${Object.entries(e.locations).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", ")}` : e.proxies > 0 ? "Proxy only" : "Not owned"}
                  </span>
                </span>
                <span className="small num" style={{ textAlign: "right" }}>
                  {e.needed > 0 ? <span className="tag">need {e.needed}</span> : <span className="tag good">have</span>}
                  {e.needed > 0 && <><br /><span className="dim">{usd(e.cheapest_usd)}</span></>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

function listText(cards: DeckCard[]): string {
  const section = (title: string, board: DeckCard["board"]) => {
    const rows = cards.filter((c) => c.board === board).map((c) => `${c.qty} ${c.name}`);
    return rows.length ? [title, ...rows, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side")].join("\n").trim();
}

function EditDeck({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const containers = useQuery({ queryKey: ["containers"], queryFn: () => api<Container[]>("/api/containers") });
  const [name, setName] = useState(deck.name);
  const [container, setContainer] = useState(deck.container_id ?? "");
  const [text, setText] = useState(() => listText(deck.cards));
  const [note, setNote] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = await api<{ cards: DeckCard[]; unknown: string[] }>("/api/decks/parse", {
        method: "POST",
        json: { text, first_is_commander: false },
      });
      if (parsed.unknown.length) {
        setUnknown(parsed.unknown);
        throw new Error("Some lines didn't match a card. Fix them, then save again.");
      }
      await api(`/api/decks/${deck.id}`, { method: "PATCH", json: { name, container_id: container || null } });
      if (listText(parsed.cards) !== listText(deck.cards)) {
        await api(`/api/decks/${deck.id}`, { method: "PUT", json: { cards: parsed.cards, note: note || null } });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deck", deck.id] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api(`/api/decks/${deck.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["decks"] });
      navigate("/decks");
    },
  });

  return (
    <Sheet label="Edit deck" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setUnknown([]); save.mutate(); }}>
        <div className="sheet-head">
          <h2>Edit deck</h2>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Physical deck
          <span className="hint">The collection container this deck's cards live in, so you can see which copies are already sleeved up.</span>
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            <option value="">None</option>
            {containers.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
          </select>
        </label>
        <label>
          Deck list
          <span className="hint">Keep the Commander and Deck headings. Saving makes a new version; older versions stay with the games they were played in.</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: "18rem" }} />
        </label>
        <label>
          What changed
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Swapped Cultivate for Three Visits" />
        </label>
        {unknown.length > 0 && <p className="error small">Not found: {unknown.join(", ")}</p>}
        <ErrorText error={save.error ?? archive.error} />
        <div className="row">
          <button className="primary" disabled={save.isPending}>Save changes</button>
          <button type="button" className="quiet" onClick={() => confirm("Archive this deck? Its game history stays.") && archive.mutate()}>
            Archive deck
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function SampleHand({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const library = useMemo(() => expandDeck(deck.cards), [deck]);
  const images = useMemo(() => new Map(deck.cards.map((c) => [c.name, c.card?.image_normal ?? null])), [deck]);
  const deal = (mulligans: number) => newHand(library, rng(crypto.getRandomValues(new Uint32Array(1))[0]!), mulligans);
  const [g, setG] = useState<Goldfish>(() => deal(0));
  const lands = g.hand.filter((c) => deck.cards.find((d) => d.name === c.name)?.card?.type_line.includes("Land")).length;
  return (
    <Sheet label="Sample hand" onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <div>
            <h2>Sample hand</h2>
            <p className="dim small" style={{ margin: 0 }}>
              {g.hand.length} cards, {lands} {lands === 1 ? "land" : "lands"}
              {g.mulligans ? `, mulligan ${g.mulligans}` : ""}
              {g.drawn ? `, drawn ${g.drawn}` : ""}. {g.library.length} left in the library.
            </p>
          </div>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        {g.toBottom > 0 && <p className="small">Tap {g.toBottom === 1 ? "a card" : `${g.toBottom} cards`} to put on the bottom.</p>}
        <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
          {g.hand.map((c, i) => (
            <button key={c.id} onClick={() => setG(bottom(g, i))} disabled={g.toBottom === 0} aria-label={c.name} style={{ opacity: 1 }}>
              <CardImage src={images.get(c.name)} name={c.name} />
            </button>
          ))}
        </div>
        <div className="row">
          <button className="primary" onClick={() => setG(draw(g))} disabled={g.toBottom > 0 || g.library.length === 0}>Draw a card</button>
          <button onClick={() => setG(deal(g.mulligans + 1))}>Mulligan</button>
          <button onClick={() => setG(deal(0))}>New hand</button>
        </div>
        <p className="small faint">The first mulligan is free, as in most Commander games.</p>
      </div>
    </Sheet>
  );
}
