import { CardHover } from "../components/CardRef";
import { CollectionItemSheet } from "./CollectionItemSheet";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { exportLink } from "../download";
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
import type { Added, Finish, Fix, ScanCandidate } from "../scanner";
// The scan choices and their notes, shown here outside the scanner too.
import "../scanner/scanner.css";

// The scanner pulls in OCR; load it only when someone opens it.
const scanner = () => import("../scanner");
const ScannerView = lazy(() => scanner().then((m) => ({ default: m.ScannerView })));
const AddedList = lazy(() => scanner().then((m) => ({ default: m.AddedList })));

/** Keep adding is remembered on this device. */
const KEEP_ADDING = "yama.scan.keepAdding";
/** The close-up step, on unless turned off on this device (a fixed camera). Shared with the deck scan. */
const CLOSEUPS = "yama.scan.closeups";

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
  const [container, setContainer] = useState("");
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  /** What the last change in a card's sheet did ("Mount Doom is now …"). */
  const [done, setDone] = useState<string | null>(null);
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

  const [newContainer, setNewContainer] = useState(false);
  const [scanning, setScanning] = useState(false);

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
                  {real.toLocaleString()} {real === 1 ? "card" : "cards"}, {day}
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
          <a className="button outline coll-export" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</a>
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
            {priced}.{" "}
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

        {done && (
          <p className="coll-done" role="status">
            {done} <button className="quiet small" onClick={() => setDone(null)}>OK</button>
          </p>
        )}
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
                  {i.image_art_crop ? <img className="coll-art" src={i.image_art_crop} alt="" loading="lazy" crossOrigin="anonymous" /> : <CardImage src={i.image_small} name={i.name ?? "?"} className="coll-art coll-thumb" />}
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
            TCGplayer market via Scryfall, {day}.
            {thumbArtists.length > 0 ? ` ${artCredits(thumbArtists)}` : ""}
          </p>
        )}
        {!!items.data?.length && <Details label="About collection prices">
          <p>Prices are per copy in its finish. Market values are not store quotes or resale offers. Proxies are excluded from collection value; missing prices stay unpriced.</p>
        </Details>}
        <a className="button outline coll-export-narrow" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</a>
      </section>

      {open && (
        <CollectionItemSheet
          item={open}
          containers={containers.data ?? []}
          onClose={(done) => {
            setOpen(null);
            setDone(done ?? null);
          }}
        />
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

export function ScanToCollection({ containers, onClose }: { containers: Container[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [finish, setFinish] = useState<Finish>("nonfoil");
  const [container, setContainer] = useState("");
  const [keepAdding, setKeepAdding] = useState(() => localStorage.getItem(KEEP_ADDING) === "1");
  const [closeups, setCloseups] = useState(() => localStorage.getItem(CLOSEUPS) !== "0");
  /**
   * What this session added, newest first, so mistakes can be fixed (see scanner/session.ts). The
   * ref is the truth (read right after a write); the state mirrors it for rendering.
   */
  const listRef = useRef<Added[]>([]);
  const [added, setAdded] = useState<Added[]>([]);
  const put = (list: Added[]) => {
    listRef.current = list;
    setAdded(list);
  };
  const patch = (key: string, fn: (a: Added) => Added | null) => put(listRef.current.flatMap((x) => (x.key === key ? (fn(x) ?? []) : [x])));
  const sending = useRef(new Set<string>());
  /** What this session's own writes left in each row (session.ts noteWrite). */
  const rowSeen = useRef(new Map<string, number>());
  /**
   * Rows whose count was lost (lookups failed, or a retry the server had already applied). They
   * stay unchecked for the rest of the session: a later count could already miss copies taken
   * out elsewhere meanwhile.
   */
  const unsure = useRef(new Set<string>());
  const rowsOf = (name: string, container: string | null) =>
    api<CollectionItem[]>(`/api/collection?container=${encodeURIComponent(container ?? "none")}&q=${encodeURIComponent(name)}`);
  /**
   * The session's writes run one at a time, each with its lookups: overlapping saves (Keep adding
   * the same printing twice quickly) would otherwise muddle what each one left in a row.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job);
    queue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  /**
   * Look up the count of a row the session doesn't know yet, right after its write (a few tries).
   * If it can't be had, the row stays unknown, and fixes to it are refused: checking later could
   * miss copies taken out elsewhere meanwhile.
   */
  const learn = async (r: Pick<Added, "name" | "scryfall_id" | "finish" | "container">) => {
    const { findRow, identity } = await scanner();
    const k = identity(r);
    if (unsure.current.has(k)) return;
    for (const wait of [0, 500, 1500]) {
      await new Promise((ok) => setTimeout(ok, wait));
      try {
        const row = findRow(await rowsOf(r.name, r.container), r);
        if (row && !rowSeen.current.has(k)) rowSeen.current.set(k, row.qty);
        else if (!row) unsure.current.add(k);
        return;
      } catch {
        // Try again.
      }
    }
    unsure.current.add(k);
  };
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" });

  /**
   * Write an entry's pending ops (call inside the queue). A retry sends the very same ops (same
   * ids), so a write that went through but lost its reply is applied once. Resolves whether the
   * server confirmed it.
   */
  const write = async (key: string): Promise<boolean> => {
    const a = listRef.current.find((x) => x.key === key);
    if (!a?.pending) return true;
    const { noteWrite, settled, touched } = await scanner();
    patch(key, (x) => (x.pending ? { ...x, pending: { ...x.pending, error: undefined } } : x));
    try {
      const res = a.pending.ops.length > 0 ? await api<{ applied: number; skipped_duplicates: number }>("/api/collection/ops", { method: "POST", json: a.pending.ops }) : null;
      // A retry the server had already applied: the rows may have changed elsewhere since, so their
      // counts can't be trusted now, and fixes to them are refused.
      if (res && res.skipped_duplicates > 0)
        for (const k of touched(a)) {
          rowSeen.current.delete(k);
          unsure.current.add(k);
        }
      else await Promise.all(noteWrite(rowSeen.current, a).map(learn));
      patch(key, (x) => {
        const done = settled(x);
        return done.copies > 0 ? done : null;
      });
      refresh();
      return true;
    } catch (e) {
      patch(key, (x) => (x.pending ? { ...x, pending: { ...x.pending, error: e instanceof Error ? e.message : String(e) } } : x));
      return false;
    }
  };
  /** Queue an entry's pending write (once: a second call while it waits does nothing). */
  const send = (key: string): Promise<boolean> => {
    if (sending.current.has(key)) return Promise.resolve(false);
    sending.current.add(key);
    return enqueue(() => write(key)).finally(() => sending.current.delete(key));
  };

  const accept = async (c: ScanCandidate, copies: number, auto: boolean): Promise<boolean> => {
    // The scanner only offers Add once the printing is settled (read from the card or picked).
    if (!c.scryfall_id) {
      setError(new Error(`Pick the printing of ${c.name} first`));
      return false;
    }
    const { addOp } = await scanner();
    const box = container || null;
    const entry: Added = {
      key: crypto.randomUUID(),
      name: c.name,
      scryfall_id: c.scryfall_id,
      set: c.set ?? "",
      number: c.number ?? "",
      image: c.thumb ?? c.image ?? null,
      finish,
      container: box,
      copies,
      auto,
      pending: { ops: [addOp(c.scryfall_id, copies, finish, box, crypto.randomUUID())], fix: null },
    };
    put([entry, ...listRef.current]);
    const ok = await send(entry.key);
    setError(ok ? null : new Error(`Couldn't save ${c.name}. It's kept in the Added list to try again.`));
    return ok;
  };

  const busyMessage = (a: Added) => (a.pending?.error ? "Try the last change again first." : "Still saving the last change.");
  const fix = async (a: Added, f: Fix) => {
    const before = listRef.current.find((x) => x.key === a.key);
    if (!before) return;
    if (before.pending || before.checking) throw new Error(busyMessage(before));
    // Lock the entry before anything waits, so no other change starts from the same state.
    const token = crypto.randomUUID();
    patch(before.key, (x) => ({ ...x, checking: token }));
    const unlock = () => patch(before.key, (x) => (x.checking === token ? { ...x, checking: undefined } : x));
    // Look up, check, plan and write in the queue, after any writes before it.
    const saved = await enqueue(async () => {
      let planned = false;
      try {
        const { changedElsewhere, findRow, identity, planFix } = await scanner();
        // Without the count this session's writes left in the row, a fix can't tell its copies from older ones.
        if (unsure.current.has(identity(before)) || !rowSeen.current.has(identity(before)))
          throw new Error(`Couldn't check the ${before.name} copies added here, so Yama won't change them. Fix them on the Collection page.`);
        const rows = await rowsOf(before.name, before.container);
        const now = listRef.current.find((x) => x.key === before.key);
        if (!now || now.checking !== token) return true;
        const row = findRow(rows, now);
        if (!row) throw new Error(`Couldn't find the ${now.name} added here. It may have been changed on the Collection page.`);
        // Copies taken out elsewhere since: they may have been older ones, so don't guess.
        if (changedElsewhere(rowSeen.current, now, row.qty))
          throw new Error(`Some ${now.name} copies were changed elsewhere since this scan, so Yama can't tell which are the ones added here. Fix them on the Collection page.`);
        patch(now.key, (x) => ({ ...x, checking: undefined, pending: { ops: planFix(now, f, row, () => crypto.randomUUID()), fix: f, base: row.qty } }));
        planned = true;
      } finally {
        if (!planned) unlock();
      }
      return write(before.key);
    });
    if (!saved) throw new Error("Couldn't save that change. Try again sends the same change.");
  };
  const retry = async (a: Added) => {
    if (!(await send(a.key))) throw new Error("Still couldn't save it. Try again in a moment.");
  };

  const controls = (
    <div className="scan-choices">
      <label>
        Finish
        <select value={finish} onChange={(e) => setFinish(e.target.value as Finish)}>
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
      <label className="scan-keep">
        <input
          type="checkbox"
          checked={keepAdding}
          onChange={(e) => {
            setKeepAdding(e.target.checked);
            localStorage.setItem(KEEP_ADDING, e.target.checked ? "1" : "0");
          }}
        />
        <span>
          <strong>Keep adding.</strong> Add each card as soon as the scanner is sure of its printing, and go on to the next. It still stops to ask when it isn't sure.
        </span>
      </label>
      <label className="scan-keep">
        <input
          type="checkbox"
          checked={closeups}
          onChange={(e) => {
            setCloseups(e.target.checked);
            localStorage.setItem(CLOSEUPS, e.target.checked ? "1" : "0");
          }}
        />
        <span>
          <strong>Close-ups.</strong> When several printings share the art, ask to bring the camera close to the set code and number. Turn off for a camera that stays put, such as a stand or card feeder: you tap the printing instead.
        </span>
      </label>
      <ErrorText error={error} />
    </div>
  );
  return (
    <div className="scan-overlay">
      <Suspense fallback={<p className="dim" style={{ padding: "1rem" }}>Starting the scanner…</p>}>
        <ScannerView
          onAccept={accept}
          onClose={onClose}
          addedCount={added.reduce((n, a) => n + a.copies, 0)}
          onShowAdded={() => setReviewing(true)}
          unsavedCount={added.filter((a) => a.pending?.error && a.pending.fix === null).length}
          autoAdd={keepAdding}
          closeups={closeups}
          paused={reviewing}
          recent={[...new Set(added.map((a) => (a.set ? `${a.name} (${a.set.toUpperCase()})` : a.name)))]}
          finish={finish === "proxy" ? "nonfoil" : finish}
          controls={controls}
          acceptLabel="Add and scan next"
        />
        {reviewing && (
          <Sheet onClose={() => setReviewing(false)} label="Added while scanning">
            <AddedList added={added} onFix={fix} onRetry={retry} onClose={() => setReviewing(false)} />
          </Sheet>
        )}
      </Suspense>
    </div>
  );
}
