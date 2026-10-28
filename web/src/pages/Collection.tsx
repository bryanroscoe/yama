import { CardHover, CardRef } from "../components/CardRef";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { api, API_BASE, priceSource, shortDate, usd, type CollectionItem, type CollectionSummary, type Container, type DeckSummary } from "../api";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { CardImage, Details, ErrorText, Sheet } from "../components/ui";
import "./collection.css";
import "../decks/collect.css";
import { changeText, keptText, missingLabel, missingText, previewLines, resultLines, type MythicReport } from "./mythicImport";

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

/** A collection row with its printing's art crop and artist, for the art thumbnails. */
type Item = CollectionItem & { image_art_crop?: string | null; artist?: string | null };
const CONDITIONS: Record<string, string> = { NM: "near mint", LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };
const SHOW = 24;

/** Most valuable first (by the price of one copy); copies with no price go last, by name. */
function byValue(a: Item, b: Item): number {
  if (a.unit_price_usd == null && b.unit_price_usd == null) return (a.name ?? "").localeCompare(b.name ?? "");
  if (a.unit_price_usd == null) return 1;
  if (b.unit_price_usd == null) return -1;
  return b.unit_price_usd - a.unit_price_usd;
}

export function CollectionPage() {
  const qc = useQueryClient();
  const [container, setContainer] = useState("");
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const [sort, setSort] = useState<"value" | "name">("value");
  const [all, setAll] = useState(false);
  const [kind, setKind] = useState<"all" | "real" | "proxy">("all");

  const summary = useQuery({ queryKey: ["collection-summary"], queryFn: () => api<CollectionSummary>("/api/collection/summary") });
  const containers = useQuery({ queryKey: ["containers"], queryFn: () => api<Container[]>("/api/containers") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const items = useQuery({
    queryKey: ["collection", container, filter, kind],
    queryFn: () => {
      const p = new URLSearchParams();
      if (container) p.set("container", container);
      if (filter.trim()) p.set("q", filter.trim());
      if (kind !== "all") p.set("proxy", kind === "proxy" ? "only" : "none");
      return api<Item[]>(`/api/collection?${p}`);
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
    mutationFn: (v: { item: Item; delta: number }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "adjust", item_id: v.item.id, delta: v.delta }],
      }),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" }),
  });

  const s = summary.data;
  const proxies = s?.proxies ?? 0;
  const real = (s?.copies ?? 0) - proxies;
  // A deck box shows its deck's commander; anything else, the most valuable card inside.
  const tiles = (containers.data ?? []).map((c) => {
    const deck = decks.data?.find((d) => d.container_id === c.id && d.commander_image);
    return { c, art: deck ? deck.commander_image : (c.art ?? null), artist: deck ? deck.commander_artist : (c.artist ?? null) };
  });
  const filed = (containers.data ?? []).reduce((a, c) => a + c.copies, 0);
  const loose = s ? s.copies - filed : 0;
  const chosen = containers.data?.find((c) => c.id === container);
  const priced = priceSource(s?.price_date);
  const day = shortDate(s?.price_date) ?? "an unknown date";
  const money = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const sorted = [...(items.data ?? [])].sort(sort === "value" ? byValue : (a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const shown = all || filter ? sorted : sorted.slice(0, SHOW);
  const heading = chosen ? chosen.name : container === "none" ? "Loose cards" : sort === "value" ? "Most valuable" : "Every card";
  const thumbArtists = shown.filter((i) => i.image_art_crop).map((i) => i.artist);
  return (
    <main className="page coll-page">
      <div className="coll-head">
        <div className="coll-title">
          <h1>Collection</h1>
          {s && s.copies > 0 && (
            <>
              <span className="coll-value">
                <b className="num">{money(s.market_value_usd)}</b>
                <span className="coll-wide">
                  market value of {real.toLocaleString()} {real === 1 ? "card" : "cards"} on {day}.
                  {s.copies_without_price > 0 ? ` ${s.copies_without_price.toLocaleString()} ${s.copies_without_price === 1 ? "has" : "have"} no price.` : ""}
                  {proxies > 0 ? ` Your ${proxies.toLocaleString()} ${proxies === 1 ? "proxy isn't" : "proxies aren't"} counted.` : ""}
                </span>
                <span className="coll-narrow">
                  {s.copies.toLocaleString()} {s.copies === 1 ? "card" : "cards"}, {day}
                </span>
              </span>
              <span className="coll-sub">
                {s.copies_without_price > 0 && (
                  <span className="coll-narrow">
                    {s.copies_without_price.toLocaleString()} {s.copies_without_price === 1 ? "card has no price and isn't" : "cards have no price and aren't"} counted.{" "}
                  </span>
                )}
                {s.purchase_total_usd > 0 && <>You paid {money(s.purchase_total_usd)}, where recorded.</>}
              </span>
            </>
          )}
        </div>
        <div className="coll-actions">
          <button className="outline coll-import" onClick={() => setImporting(true)}>
            <span className="coll-wide">Import from Mythic Tools</span>
            <span className="coll-narrow">Import</span>
          </button>
          <a className="button outline coll-export" href={`${API_BASE}/api/collection/export.csv`}>Export CSV</a>
          <button className="primary coll-scan" onClick={() => setScanning(true)}>Scan cards</button>
        </div>
      </div>

      {(tiles.length > 0 || loose > 0) && (
        <section className="containers" aria-labelledby="where">
          <div className="section-head">
            <h2 id="where">
              <span className="coll-wide">Binders, boxes and decks</span>
              <span className="coll-narrow">Where they live</span>
            </h2>
            <button className="coll-new" onClick={() => setNewContainer(true)}>New</button>
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
                    <span className="ct-name">
                      <span className="coll-wide">Loose cards</span>
                      <span className="coll-narrow">Not filed</span>
                    </span>
                    <span className="ct-meta num">{tileMeta(loose, undefined, undefined)}</span>
                  </ArtPanel>
                </button>
              </li>
            )}
          </ul>
          <p className="small dim coll-note">
            Values are {priced}.{" "}
            {tiles.some((t) => t.art) ? artCredits(tiles.filter((t) => t.art).map((t) => t.artist)) : ""}
          </p>
        </section>
      )}
      {tiles.length === 0 && loose === 0 && newContainer && <NewContainer onClose={() => setNewContainer(false)} />}

      <section className="coll-cards" aria-labelledby="coll-cards-h">
        <div className="coll-cards-head">
          <h2 id="coll-cards-h">{heading}</h2>
          {container && <button className="quiet small" onClick={() => setContainer("")}>Show everything</button>}
          <div className="segmented coll-sort" role="group" aria-label="Order">
            <button aria-pressed={sort === "value"} onClick={() => setSort("value")}>By value</button>
            <button aria-pressed={sort === "name"} onClick={() => setSort("name")}>By name</button>
          </div>
          {(proxies > 0 || kind !== "all") && (
            <div className="segmented coll-kind" role="group" aria-label="Real cards or proxies">
              <button aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button>
              <button aria-pressed={kind === "real"} onClick={() => setKind("real")}>Real</button>
              <button aria-pressed={kind === "proxy"} onClick={() => setKind("proxy")}>Proxies</button>
            </div>
          )}
          <label className="coll-filter">
            <span className="visually-hidden">Filter by name</span>
            <input type="search" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {tiles.length === 0 && loose === 0 && <button onClick={() => setNewContainer(true)}>New binder, box or deck</button>}
        </div>

        <ErrorText error={items.error ?? summary.error} />
        {items.data && items.data.length === 0 && !filter && !container && kind === "all" && (
          <div className="empty">
            <p>Your collection is empty. Import your Mythic Tools export to bring everything over, or add cards from the Cards tab.</p>
          </div>
        )}
        {items.data && items.data.length === 0 && (filter || container || kind !== "all") && (
          <p className="empty">
            {kind === "proxy" ? "No proxies" : kind === "real" ? "No real cards" : "Nothing"} here{filter ? ` called "${filter}"` : ""}.
          </p>
        )}
        <ul className="coll-list">
          {shown.map((i) => {
            const place = i.container_name ?? "Not filed";
            const cond = CONDITIONS[i.condition] ?? i.condition;
            return (
              <li key={i.id}>
                <button className="coll-row" onClick={() => setOpen(i)}>
                  {i.image_art_crop ? <img className="coll-art" src={i.image_art_crop} alt="" loading="lazy" /> : <CardImage src={i.image_small} name={i.name ?? "?"} className="coll-art coll-thumb" />}
                  <span className="coll-row-text">
                    <span className="coll-row-name">
                      <CardHover name={i.name??i.scryfall_id} oracleId={i.oracle_id} image={i.image_small}/>
                      {i.finish !== "nonfoil" && <span className="tag">{i.finish[0]!.toUpperCase() + i.finish.slice(1)}</span>}
                      {i.proxy && <span className="tag">Proxy</span>}
                    </span>
                    <span className="coll-row-where coll-wide">
                      {place}, {i.set_name ?? "unknown set"} #{i.collector_number}, {cond}
                    </span>
                    <span className="coll-row-where coll-narrow">
                      {place}
                      {i.condition !== "NM" ? `, ${cond}` : ""}
                      {i.qty > 1 ? `, ${i.qty} copies` : ""}
                    </span>
                  </span>
                  <span className="coll-qty num">×{i.qty}</span>
                  <span className="coll-price num">{usd(i.unit_price_usd)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {!all && !filter && sorted.length > SHOW && (
          <button className="coll-more" onClick={() => setAll(true)}>Show all {sorted.length.toLocaleString()}</button>
        )}
        {!!items.data?.length && (
          <p className="small dim coll-note">
            Each price is the TCGplayer market price via Scryfall on {day}, for one copy in its finish. It isn't a quote from any store.
            {thumbArtists.length > 0 ? ` ${artCredits(thumbArtists)}` : ""}
          </p>
        )}
        <a className="button outline coll-export-narrow" href={`${API_BASE}/api/collection/export.csv`}>Export CSV</a>
      </section>

      {open && (
        <Sheet label={open.name ?? "Card"} onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>{open.name&&<CardRef name={open.name} oracleId={open.oracle_id} image={open.image_small}/>}</h2>
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
  // Each file chosen gets a number, so choosing the same file again previews it again.
  const [file, setFile] = useState<{ n: number; text: string } | null>(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [result, setResult] = useState<MythicReport | null>(null);
  const send = (text: string, dryRun: boolean) =>
    api<MythicReport>(`/api/collection/import/mythic?dry_run=${dryRun ? 1 : 0}&remove_missing=${removeMissing ? 1 : 0}`, {
      method: "POST",
      body: text,
      headers: { "Content-Type": "text/csv" },
    });
  // The preview is a dry run: the server plans the import and writes nothing.
  const preview = useQuery({
    queryKey: ["mythic-preview", file?.n, removeMissing],
    queryFn: () => send(file!.text, true),
    enabled: !!file && !result,
    retry: false,
    staleTime: Infinity,
  });
  const apply = useMutation({
    mutationFn: () => send(file!.text, false),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || ["containers", "decks", "deck"].includes(String(q.queryKey[0])) });
    },
  });
  const choose = async (f: File) => {
    setResult(null);
    setRemoveMissing(false);
    setFile({ n: (file?.n ?? 0) + 1, text: await f.text() });
  };
  const r = result ?? preview.data;
  return (
    <Sheet label="Import" onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <h2>Import from Mythic Tools</h2>
          <button className="quiet" onClick={onClose}>{result ? "Done" : "Close"}</button>
        </div>
        <p className="dim">
          In Mythic Tools, export your collection as CSV, then choose the file here. You'll see what changes before anything is saved. A newer export adds only
          what's new, and cards you've moved in Yama stay where you put them.
        </p>
        <p className="dim small">
          Mythic Tools' collection export leaves your decks out. To bring a deck over, export that deck from Mythic Tools (as CSV, or as a text list to paste on
          the Decks tab). Cards in a deck become a Yama deck, linked to those cards.
        </p>
        <label>
          CSV file
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} />
        </label>
        {preview.isFetching && <p className="dim">Checking the file against your collection…</p>}
        <ErrorText error={preview.error ?? apply.error} />
        {r && (
          <>
            {result ? (
              <ul className="collect-facts collect-result" role="status">
                {resultLines(result).map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : (
              <ul className="collect-facts">
                {previewLines(r, (d) => shortDate(d) ?? d).map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            {r.added_cards.length > 0 && (
              <Details label={result ? "Cards added" : "Cards to add"}>
                <ul className="collect-cards small">{r.added_cards.map((c, i) => <li key={i}>{changeText(c)}</li>)}</ul>
              </Details>
            )}
            {r.kept_cards.length > 0 && (
              <Details label="Kept where Yama has them">
                <ul className="collect-cards small">{r.kept_cards.map((c, i) => <li key={i}>{keptText(c)}</li>)}</ul>
              </Details>
            )}
            {r.missing > 0 && (
              <div className="stack">
                {!result && <p>{missingText(r)}</p>}
                <Details label={result?.removed ? "Removed" : "No longer in this export"}>
                  <ul className="collect-cards small">{r.missing_cards.map((c, i) => <li key={i}>{changeText(c)}</li>)}</ul>
                </Details>
                {!result && (
                  <label className="collect-remove">
                    <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
                    {missingLabel(r)}
                  </label>
                )}
              </div>
            )}
            {r.unknown_printings.length > 0 && <p className="dim small">Not in our card data yet (kept anyway): {r.unknown_printings.join(", ")}</p>}
            {r.errors.length > 0 && <ul className="error small">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            {!result && (
              <div className="row">
                <button className="primary" disabled={apply.isPending || preview.isFetching} onClick={() => apply.mutate()}>
                  {apply.isPending ? "Importing…" : "Import"}
                </button>
                <button className="quiet" onClick={onClose}>Cancel</button>
              </div>
            )}
          </>
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
  const [finish, setFinish] = useState<"nonfoil" | "foil" | "proxy">("nonfoil");
  const [container, setContainer] = useState("");
  const [added, setAdded] = useState<{ name: string; set?: string }[]>([]);
  const [error, setError] = useState<unknown>(null);

  const accept = async (c: ScanCandidate, copies: number) => {
    try {
      // The scanner only offers Add once the printing is settled (read from the card or picked).
      if (!c.scryfall_id) throw new Error(`Pick the printing of ${c.name} first`);
      await api("/api/collection/ops", {
        method: "POST",
        json: [
          {
            op_id: crypto.randomUUID(),
            kind: "add",
            scryfall_id: c.scryfall_id,
            qty: copies,
            finish: finish === "proxy" ? "nonfoil" : finish,
            proxy: finish === "proxy",
            container_id: container || null,
          },
        ],
      });
      setAdded((a) => [...Array.from({ length: copies }, () => ({ name: c.name, set: c.set?.toUpperCase() })), ...a]);
      setError(null);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" });
    } catch (e) {
      setError(e);
    }
  };

  const controls = (
    <div className="scan-choices">
      <label>
        Finish
        <select value={finish} onChange={(e) => setFinish(e.target.value as "nonfoil" | "foil" | "proxy")}>
          <option value="nonfoil">Regular</option>
          <option value="foil">Foil</option>
          <option value="proxy">Proxy</option>
        </select>
      </label>
      <label>
        Put in
        <select value={container} onChange={(e) => setContainer(e.target.value)}>
          <option value="">Not filed anywhere</option>
          {containers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
        </select>
      </label>
      <ErrorText error={error} />
    </div>
  );
  return (
    <div className="scan-overlay">
      <Suspense fallback={<p className="dim" style={{ padding: "1rem" }}>Starting the scanner…</p>}>
        <ScannerView
          onAccept={(c, copies) => void accept(c, copies)}
          onClose={onClose}
          addedCount={added.length}
          recent={[...new Set(added.map((a) => (a.set ? `${a.name} (${a.set})` : a.name)))]}
          finish={finish === "proxy" ? "nonfoil" : finish}
          controls={controls}
          acceptLabel="Add and scan next"
        />
      </Suspense>
    </div>
  );
}
