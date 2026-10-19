import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { api, API_BASE, priceSource, usd, type CollectionItem, type CollectionSummary, type Container, type DeckSummary, type ImportReport } from "../api";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { CardImage, ErrorText, Sheet } from "../components/ui";

const KIND_LABEL: Record<string, string> = { binder: "Binder", box: "Box", deck: "Deck box", list: "List" };

/** "146 cards, $402" for a tile; copies without a price are said, not counted as $0. */
function tileMeta(copies: number, value: number | undefined, unpriced: number | undefined): string {
  const cards = `${copies.toLocaleString()} ${copies === 1 ? "card" : "cards"}`;
  if (value === undefined) return cards;
  const money = `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `${cards}, ${money}${unpriced ? `, ${unpriced} with no price` : ""}`;
}
import type { ScanCandidate } from "../scanner";

// The scanner pulls in OCR; load it only when someone opens it.
const ScannerView = lazy(() => import("../scanner").then((m) => ({ default: m.ScannerView })));

export function CollectionPage() {
  const qc = useQueryClient();
  const [container, setContainer] = useState("");
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<CollectionItem | null>(null);

  const summary = useQuery({ queryKey: ["collection-summary"], queryFn: () => api<CollectionSummary>("/api/collection/summary") });
  const containers = useQuery({ queryKey: ["containers"], queryFn: () => api<Container[]>("/api/containers") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const items = useQuery({
    queryKey: ["collection", container, filter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (container) p.set("container", container);
      if (filter.trim()) p.set("q", filter.trim());
      return api<CollectionItem[]>(`/api/collection?${p}`);
    },
    placeholderData: (prev) => prev,
  });

  const op = useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/api/collection/ops", { method: "POST", json: [{ op_id: crypto.randomUUID(), ...body }] }),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" }),
  });
  const [newContainer, setNewContainer] = useState(false);
  const [scanning, setScanning] = useState(false);
  const adjust = useMutation({
    mutationFn: (v: { item: CollectionItem; delta: number }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "adjust", item_id: v.item.id, delta: v.delta }],
      }),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" }),
  });

  const s = summary.data;
  // A deck box shows its deck's commander; anything else, the most valuable card inside.
  const tiles = (containers.data ?? []).map((c) => {
    const deck = decks.data?.find((d) => d.container_id === c.id && d.commander_image);
    return { c, art: deck ? deck.commander_image : (c.art ?? null), artist: deck ? deck.commander_artist : (c.artist ?? null) };
  });
  const filed = (containers.data ?? []).reduce((a, c) => a + c.copies, 0);
  const loose = s ? s.copies - filed : 0;
  const chosen = containers.data?.find((c) => c.id === container);
  const priced = priceSource(s?.price_date);
  return (
    <main className="page">
      <div className="page-head">
        <h1>Collection</h1>
        <div className="row">
          <a className="button" href={`${API_BASE}/api/collection/export.csv`}>Export CSV</a>
          <button className="primary" onClick={() => setScanning(true)}>Scan cards</button>
          <button onClick={() => setImporting(true)}>Import from Mythic Tools</button>
        </div>
      </div>

      {s && s.copies > 0 && (
        <div className="figures">
          <div className="figure">
            <b className="num">{s.copies.toLocaleString()}</b>
            <span>cards</span>
          </div>
          <div className="figure">
            <b className="num">${s.market_value_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
            <span>
              market value, {priced}
              {s.copies_without_price > 0 ? `. ${s.copies_without_price} ${s.copies_without_price === 1 ? "has no price and isn't" : "have no price and aren't"} counted` : ""}
            </span>
          </div>
          <div className="figure">
            <b className="num">${s.purchase_total_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
            <span>paid, where recorded</span>
          </div>
        </div>
      )}

      {(tiles.length > 0 || loose > 0) && (
        <section className="containers" aria-labelledby="where">
          <div className="section-head">
            <h2 id="where">Binders, boxes and decks</h2>
            <button onClick={() => setNewContainer(true)}>New</button>
          </div>
          {newContainer && <NewContainer onClose={() => setNewContainer(false)} />}
          <ul className="container-tiles">
            {tiles.map(({ c, art, artist }) => (
              <li key={c.id}>
                <button className="container-tile" aria-pressed={container === c.id} onClick={() => setContainer(container === c.id ? "" : c.id)}>
                  <ArtPanel as="span" art={art} artist={artist} wash="bottom" credit={false}>
                    <span className="ct-kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                    <span className="ct-name">{c.name}</span>
                    <span className="ct-meta num">{tileMeta(c.copies, c.market_value_usd, c.copies_without_price)}</span>
                  </ArtPanel>
                </button>
              </li>
            ))}
            {loose > 0 && (
              <li>
                <button className="container-tile" aria-pressed={container === "none"} onClick={() => setContainer(container === "none" ? "" : "none")}>
                  <ArtPanel as="span" art={null} wash="bottom" empty>
                    <span className="ct-kind">Not filed</span>
                    <span className="ct-name">Loose cards</span>
                    <span className="ct-meta num">{tileMeta(loose, undefined, undefined)}</span>
                  </ArtPanel>
                </button>
              </li>
            )}
          </ul>
          <p className="small dim">
            Values are {priced}.{" "}
            {tiles.some((t) => t.art) ? artCredits(tiles.filter((t) => t.art).map((t) => t.artist)) : ""}
          </p>
        </section>
      )}
      {tiles.length === 0 && loose === 0 && newContainer && <NewContainer onClose={() => setNewContainer(false)} />}

      <div className="section-head">
        <h2>{chosen ? chosen.name : container === "none" ? "Loose cards" : "Every card"}</h2>
        {container && <button className="quiet small" onClick={() => setContainer("")}>Show everything</button>}
      </div>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <input type="search" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: "1 1 12rem" }} aria-label="Filter by name" />
        {tiles.length === 0 && loose === 0 && <button onClick={() => setNewContainer(true)}>New binder, box or deck</button>}
      </div>

      <ErrorText error={items.error ?? summary.error} />
      {items.data && items.data.length === 0 && !filter && !container && (
        <div className="empty">
          <p>Your collection is empty. Import your Mythic Tools export to bring everything over, or add cards from the Cards tab.</p>
        </div>
      )}
      <div className="list">
        {items.data?.map((i) => (
          <button key={i.id} className="list-row" onClick={() => setOpen(i)}>
            <CardImage src={i.image_small} name={i.name ?? "?"} className="thumb" />
            <span>
              <span className="title">{i.name ?? i.scryfall_id}</span>
              {i.finish !== "nonfoil" && <span className="tag" style={{ marginLeft: 6 }}>{i.finish[0]!.toUpperCase() + i.finish.slice(1)}</span>}
              {i.proxy && <span className="tag" style={{ marginLeft: 6 }}>Proxy</span>}
              <br />
              <span className="dim small">
                {i.set_name} #{i.collector_number}, {i.condition}
                {i.container_name ? `, in ${i.container_name}` : ""}
              </span>
            </span>
            <span className="num" style={{ textAlign: "right" }}>
              ×{i.qty}
              <br />
              <span className="dim small">{usd(i.unit_price_usd)}</span>
            </span>
          </button>
        ))}
      </div>
      {!!items.data?.length && (
        <p className="small dim">
          Each price is for one copy in that finish, {priced}. A market price isn't a quote from any store.
        </p>
      )}

      {open && (
        <Sheet label={open.name ?? "Card"} onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>{open.name}</h2>
              <button className="quiet" onClick={() => setOpen(null)}>Close</button>
            </div>
            <div style={{ maxWidth: 260 }}>
              <CardImage src={open.image_normal} name={open.name ?? ""} />
            </div>
            <p className="dim">
              {open.set_name} #{open.collector_number}, {open.finish}, {open.condition}, {open.lang}
              {open.purchase_price != null ? `. Paid ${usd(open.purchase_price)}` : ""}
            </p>
            <div className="row">
              <button onClick={() => { adjust.mutate({ item: open, delta: -1 }); setOpen(null); }}>Remove one</button>
              <button onClick={() => { adjust.mutate({ item: open, delta: 1 }); setOpen(null); }}>Add one more</button>
            </div>
            <label>
              Kept in
              <select
                value={open.container_id ?? ""}
                onChange={(e) => {
                  op.mutate({ kind: "update", item_id: open.id, container_id: e.target.value || null });
                  setOpen(null);
                }}
              >
                <option value="">Not filed anywhere</option>
                {containers.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
              </select>
            </label>
            <label>
              Condition
              <select
                value={open.condition}
                onChange={(e) => {
                  op.mutate({ kind: "update", item_id: open.id, condition: e.target.value });
                  setOpen(null);
                }}
              >
                {["NM", "LP", "MP", "HP", "DMG"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={open.proxy}
                style={{ width: "auto", minHeight: 0 }}
                onChange={(e) => {
                  op.mutate({ kind: "update", item_id: open.id, proxy: e.target.checked });
                  setOpen(null);
                }}
              />
              This is a proxy
            </label>
            <p className="small faint">Moving all copies in this row. To move just one, remove one here and add it from the Cards tab into the new place.</p>
          </div>
        </Sheet>
      )}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {scanning && <ScanToCollection containers={containers.data ?? []} onClose={() => setScanning(false)} />}
    </main>
  );
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [report, setReport] = useState<ImportReport | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => api<ImportReport>("/api/collection/import/mythic", { method: "POST", body: await file.text(), headers: { "Content-Type": "text/csv" } }),
    onSuccess: (r) => {
      setReport(r);
      void qc.invalidateQueries();
    },
  });
  return (
    <Sheet label="Import" onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <h2>Import from Mythic Tools</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        <p className="dim">In Mythic Tools, export your collection as CSV, then choose the file here. Importing the same file again won't add anything twice.</p>
        <p className="dim small">
          Mythic Tools' collection export leaves your decks out. To bring a deck over, export that deck from Mythic Tools (as
          CSV, or as a text list to paste on the Decks tab). Cards in a deck become a Yama deck, linked to those cards.
        </p>
        <label>
          CSV file
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        </label>
        {upload.isPending && <p className="dim">Importing…</p>}
        <ErrorText error={upload.error} />
        {report && (
          <div>
            <p>
              Added {report.copies} {report.copies === 1 ? "card" : "cards"} from {report.added_rows} rows.
              {report.already_imported_rows > 0 && ` ${report.already_imported_rows} rows were already imported.`}
            </p>
            {report.containers.length > 0 && <p className="dim">Containers: {report.containers.join(", ")}</p>}
            {report.decks_created.length > 0 && <p>New decks: {report.decks_created.join(", ")}. Check each one's commander on the Decks tab.</p>}
            {report.decks_updated.length > 0 && <p className="dim">Updated decks: {report.decks_updated.join(", ")}</p>}
            {report.unknown_printings.length > 0 && (
              <p className="dim">Not in our card data yet (kept anyway): {report.unknown_printings.join(", ")}</p>
            )}
            {report.errors.length > 0 && (
              <ul className="error small">{report.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function NewContainer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState("binder");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api("/api/containers", { method: "POST", json: { kind, name } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["containers"] });
      onClose();
    },
  });
  return (
    <form className="row" style={{ marginBottom: "1rem", alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <label style={{ flex: "0 1 9rem" }}>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="binder">Binder</option>
          <option value="box">Box</option>
          <option value="deck">Deck</option>
          <option value="list">List</option>
        </select>
      </label>
      <label style={{ flex: "1 1 12rem" }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Trade binder" />
      </label>
      <button className="primary" disabled={create.isPending}>Create</button>
      <button type="button" className="quiet" onClick={onClose}>Cancel</button>
      <ErrorText error={create.error} />
    </form>
  );
}

function ScanToCollection({ containers, onClose }: { containers: Container[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [finish, setFinish] = useState<"nonfoil" | "foil">("nonfoil");
  const [container, setContainer] = useState("");
  const [added, setAdded] = useState<{ name: string; set?: string }[]>([]);
  const [error, setError] = useState<unknown>(null);

  const accept = async (c: ScanCandidate) => {
    try {
      // A name-only read has no printing; use the card's default printing and fix it later if needed.
      let id = c.scryfall_id;
      if (!id) {
        const r = await api<{ cards: { default_printing: string | null }[] }>(`/api/cards/search?q=${encodeURIComponent(`!"${c.name}"`)}`);
        id = r.cards[0]?.default_printing ?? undefined;
      }
      if (!id) throw new Error(`Couldn't find a printing for ${c.name}`);
      await api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "add", scryfall_id: id, qty: 1, finish, container_id: container || null }],
      });
      setAdded((a) => [{ name: c.name, set: c.set?.toUpperCase() }, ...a]);
      setError(null);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="scan-overlay">
      <Suspense fallback={<p className="dim" style={{ padding: "1rem" }}>Starting the scanner…</p>}>
        <ScannerView onAccept={(c) => void accept(c)} onClose={onClose} />
      </Suspense>
      <div className="scan-controls">
        <div className="row">
          <label style={{ flex: "1 1 8rem" }}>
            Finish
            <select value={finish} onChange={(e) => setFinish(e.target.value as "nonfoil" | "foil")}>
              <option value="nonfoil">Regular</option>
              <option value="foil">Foil</option>
            </select>
          </label>
          <label style={{ flex: "2 1 12rem" }}>
            Put in
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              <option value="">Not filed anywhere</option>
              {containers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
            </select>
          </label>
        </div>
        <ErrorText error={error} />
        {added.length > 0 && (
          <p className="small dim" role="status">
            Added {added.length}: {added.slice(0, 5).map((a) => `${a.name}${a.set ? ` (${a.set})` : ""}`).join(", ")}
            {added.length > 5 ? "…" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
