import { HelpPopover } from "../components/HelpPopover";
import { CardHover } from "../components/CardRef";
import { CollectionItemSheet } from "./CollectionItemSheet";
import { ImportCollectionSheet } from "./ImportCollectionSheet";
import { CollectionGrid } from "./CollectionGrid";
import { markWords } from "./collectionEdit";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import { closeQuestion, unsavedScans } from "./scanClose";
import { SellSheet } from "./SellSheet";
import { ContainerSections, Breadcrumb } from "./ContainerSections";
import { optionLabel, pathLabel, placeLabel, treeOrder } from "./containerTree";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { exportLink } from "../download";
import { api, API_BASE, ApiError, type CollectionItem, type CollectionSummary, type Container, type DeckSummary, type Printing } from "../api";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { BackLink, Button, ButtonLink, CardImage, CardThumb, Details, Dialog, EmptyState, ErrorText, Field, Loading, Segmented, Tag } from "../components/ui";
import "./collection.css";
import "../decks/collect.css";
import { changeText, keptText, missingLabel, missingText, previewLines, resultLines, type MythicReport } from "./mythicImport";
import { activeFilters, clampFilters, COLOR_OPTIONS, filterOptions, FINISH_LABEL, NO_FILTERS, passes, rarityLabel, totals, totalsText, type Filters } from "./collectionFilters";

const KIND_LABEL: Record<string, string> = { binder: "Binder", box: "Box", deck: "Deck box", list: "List" };

/** "146 cards, $402" for a tile; copies without a price are said, not counted as $0. */
function tileMeta(copies: number, value: number | undefined, unpriced: number | undefined): string {
  const cards = plural(copies, "card");
  if (value === undefined) return cards;
  return `${cards}, ${usdWhole(value)}${unpriced ? `, ${unpriced} with no price` : ""}`;
}
import type { Added, Finish, Fix, ScanCandidate } from "../scanner";
import { useDebounced } from "../useDebounced";
// The scan choices and their notes, shown here outside the scanner too.
import "../scanner/scanner.css";
import { priceSource, shortDate, usd, count, plural, usdWhole, treatmentLabel, finishName, finishesOf, pickFinish } from "@yama/core";

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
/** Rows shown at first, and how many more each "Show more" adds: a collection can run to thousands,
 *  and drawing every row at once made the page crawl. */
const SHOW = 24;
const MORE = 200;
/** List or pictures, remembered on this device. */
const VIEW = "yama.collection.view";
function storedView(): "list" | "grid" {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(VIEW) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

/** Most valuable first (by the price of one copy); copies with no price go last, by name. */
function byValue(a: Item, b: Item): number {
  if (a.unit_price_usd == null && b.unit_price_usd == null) return (a.name ?? "").localeCompare(b.name ?? "");
  if (a.unit_price_usd == null) return 1;
  if (b.unit_price_usd == null) return -1;
  return b.unit_price_usd - a.unit_price_usd;
}

export function CollectionPage() {
  // The open box is in the address, so the phone's Back closes it and a box can be linked to.
  const [params, setParams] = useSearchParams();
  const container = params.get("box") ?? "";
  const setContainer = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("box", id);
    else next.delete("box");
    // Opening a box is going somewhere (Back returns); closing one replaces it.
    setParams(next, { replace: !id });
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };
  const [filter, setFilter] = useState("");
  // The import that is open: a list or another app's file, or a Mythic Tools export.
  const [importing, setImporting] = useState<"cards" | "mythic" | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  /** What the last change in a card's sheet did ("Mount Doom is now …"). */
  const [done, setDone] = useState<string | null>(null);
  const [sort, setSort] = useState<"value" | "name">("value");
  const [limit, setLimit] = useState(SHOW);
  const [kind, setKind] = useState<"all" | "real" | "proxy">("all");
  const [chosenFilters, setFilters] = useState<Filters>(NO_FILTERS);
  /** An open container's cards: its own, or with every section under it too. */
  const [withSections, setWithSections] = useState(false);
  const [show, setShow] = useState(storedView);
  const showAs = (v: "list" | "grid") => {
    setShow(v);
    try {
      localStorage.setItem(VIEW, v);
    } catch {
      // Private browsing: the choice lasts for this visit.
    }
  };
  // Asked of the server once typing settles, not on every key.
  const query = useDebounced(filter.trim(), 250);

  const summary = useQuery({ queryKey: ["collection-summary"], queryFn: ({ signal }) => api<CollectionSummary>("/api/collection/summary", { signal }) });
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }) });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  // An open container's sections' cards too, when it has sections and that's asked for.
  const openSections = withSections && !!containers.data?.find((c) => c.id === container)?.sections;
  const items = useQuery({
    queryKey: ["collection", container, query, kind, ...(openSections ? ["sections"] : [])],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams();
      if (container) p.set("container", container);
      if (openSections) p.set("sections", "1");
      if (query) p.set("q", query);
      if (kind !== "all") p.set("proxy", kind === "proxy" ? "only" : "none");
      return api<Item[]>(`/api/collection?${p}`, { signal });
    },
    placeholderData: (prev) => prev,
  });

  const [newContainer, setNewContainer] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [selling, setSelling] = useState(false);
  const [deleting, setDeleting] = useState<Container | null>(null);

  const s = summary.data;
  const proxies = s?.proxies ?? 0;
  const real = (s?.copies ?? 0) - proxies;
  // A deck box shows its deck's commander; anything else, the most valuable card inside.
  const all = containers.data ?? [];
  // The tiles are the top-level containers; a section shows inside its box.
  const tiles = all.filter((c) => !c.parent_id).map((c) => {
    const deck = decks.data?.find((d) => d.container_id === c.id && d.commander_image);
    return { c, art: deck ? deck.commander_image : (c.art ?? null), artist: deck ? deck.commander_artist : (c.artist ?? null) };
  });
  const filed = (containers.data ?? []).reduce((a, c) => a + c.copies, 0);
  const loose = s ? s.copies - filed : 0;
  const chosen = containers.data?.find((c) => c.id === container);
  const hasSections = !!chosen?.sections;
  const priced = priceSource(s?.price_date);
  const day = shortDate(s?.price_date) ?? "an unknown date";
  // The filters offer what the rows in view hold; a choice those rows no longer have is dropped.
  const options = useMemo(() => filterOptions(items.data ?? []), [items.data]);
  const filters = useMemo(() => clampFilters(chosenFilters, options), [chosenFilters, options]);
  // Once the rows are in, a choice they don't hold is forgotten: left chosen, it would come
  // back unasked when another box or search brought rows that have it.
  if (items.data && !items.isPlaceholderData && Object.values(filters).join("|") !== Object.values(chosenFilters).join("|")) setFilters(filters);
  const filtering = activeFilters(filters) > 0;
  const sorted = useMemo(
    () => (items.data ?? []).filter((i) => passes(i, filters)).sort(sort === "value" ? byValue : (a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [items.data, sort, filters],
  );
  const filter1 = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  // Another binder, filter or order starts from the top again.
  const view = `${container}|${query}|${kind}|${sort}|${show}|${openSections}|${Object.values(filters).join("|")}`;
  const [viewed, setViewed] = useState(view);
  if (viewed !== view) {
    setViewed(view);
    setLimit(SHOW);
  }
  const shown = sorted.slice(0, limit);
  const left = sorted.length - shown.length;
  const heading = container ? "Cards" : sort === "value" ? "Most valuable" : "Every card";
  // The list shows art crops (credited under it); the pictures are whole cards, which name their artist.
  const thumbArtists = show === "list" ? shown.filter((i) => i.image_art_crop).map((i) => i.artist) : [];
  return (
    <main className="page coll-page">
      <div className="coll-head">
        <div className="coll-title">
          <h1>Collection</h1>
          {s && s.copies > 0 && (
            <>
              <span className="coll-value">
                <b className="num">{usdWhole(s.market_value_usd)}</b>
                <span className="coll-wide">
                  market value of {plural(real, "card")} on {day}.
                  {s.copies_without_price > 0 ? ` ${count(s.copies_without_price)} ${s.copies_without_price === 1 ? "has" : "have"} no price.` : ""}
                  {proxies > 0 ? ` Your ${count(proxies)} ${proxies === 1 ? "proxy isn't" : "proxies aren't"} counted.` : ""}
                </span>
                <span className="coll-narrow">
                  {plural(real, "card")}, {day}
                </span>
              </span>
              <span className="coll-sub">
                {s.copies_without_price > 0 && (
                  <span className="coll-narrow">
                    {count(s.copies_without_price)} {s.copies_without_price === 1 ? "card has no price and isn't" : "cards have no price and aren't"} counted.{" "}
                  </span>
                )}
                {s.purchase_total_usd > 0 && <>You paid {usdWhole(s.purchase_total_usd)}, where recorded{s.copies_without_purchase_price ? ` (${count(s.copies_without_purchase_price)} ${s.copies_without_purchase_price === 1 ? "copy has" : "copies have"} no purchase price)` : ""}{s.copies_paid_in_other_currency ? `; ${count(s.copies_paid_in_other_currency)} paid in another currency ${s.copies_paid_in_other_currency === 1 ? "isn't" : "aren't"} added in` : ""}.</>}
              </span>
            </>
          )}
        </div>
        <div className="coll-actions">
          <Button variant="outline" className="coll-import" onClick={() => setImporting("cards")}>
            <span className="coll-wide">Import cards</span>
            <span className="coll-narrow">Import</span>
          </Button>
          <ButtonLink variant="outline" className="coll-export" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</ButtonLink>
          <Button variant="primary" className="coll-scan" onClick={() => setScanning(true)}>Scan cards</Button>
        </div>
      </div>

      {container && (
        <section className="containers coll-open" aria-label={chosen ? chosen.name : "Loose cards"}>
          <BackLink inline to="/collection" text="Every binder, box and deck" label="Back to every binder, box and deck" />
          {(() => {
            const t = tiles.find((x) => x.c.id === container);
            // An id that names no box (deleted, or a stale link) says so rather than passing for loose cards.
            const c = chosen;
            const name = c ? c.name : container === "none" ? "Loose cards" : containers.data ? "No such binder or box" : "";
            return (
              <ArtPanel art={t?.art ?? c?.art ?? null} artist={t?.artist ?? c?.artist ?? null} wash="bottom" empty={!(t?.art ?? c?.art)} className="coll-open-art">
                <span className="ct-kind">{c ? (c.parent_id ? "Section" : (KIND_LABEL[c.kind] ?? c.kind)) : container === "none" ? "Not filed" : ""}</span>
                <h2 className="ct-name">{name}</h2>
                <span className="ct-meta num">{c ? tileMeta(c.total_copies ?? c.copies, c.total_market_value_usd ?? c.market_value_usd, c.total_copies_without_price ?? c.copies_without_price) : container === "none" && s ? tileMeta(loose, undefined, undefined) : ""}</span>
              </ArtPanel>
            );
          })()}
          {chosen && <Breadcrumb id={chosen.id} all={all} onOpen={setContainer} />}
          {chosen && <ContainerSections key={chosen.id} container={chosen} all={all} onOpen={setContainer} onDone={setDone} />}
        </section>
      )}
      {!container && (tiles.length > 0 || loose > 0) && (
        <section className="containers" aria-labelledby="where">
          <div className="section-head">
            <h2 id="where">
              <span className="coll-wide">Binders, boxes and decks</span>
              <span className="coll-narrow">Where they live</span>
            </h2>
            <Button className="coll-new" onClick={() => setNewContainer(true)}>New</Button>
          </div>
          {newContainer && <NewContainer onClose={() => setNewContainer(false)} />}
          <ul className="container-tiles">
            {tiles.map(({ c, art, artist }) => (
              <li key={c.id}>
                <Button className="container-tile" onClick={() => setContainer(c.id)}>
                  <ArtPanel as="span" art={art} artist={artist} wash="bottom" credit={false}>
                    <span className="ct-kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                    <span className="ct-name">{c.name}</span>
                    <span className="ct-meta num">
                      {tileMeta(c.total_copies ?? c.copies, c.total_market_value_usd ?? c.market_value_usd, c.total_copies_without_price ?? c.copies_without_price)}
                      {c.sections ? `, ${plural(c.sections, "section")}` : ""}
                    </span>
                  </ArtPanel>
                </Button>
              </li>
            ))}
            {loose > 0 && (
              <li>
                <Button className="container-tile" onClick={() => setContainer("none")}>
                  <ArtPanel as="span" art={null} wash="bottom" empty>
                    <span className="ct-kind">Not filed</span>
                    <span className="ct-name">
                      <span className="coll-wide">Loose cards</span>
                      <span className="coll-narrow">Not filed</span>
                    </span>
                    <span className="ct-meta num">{tileMeta(loose, undefined, undefined)}</span>
                  </ArtPanel>
                </Button>
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
          {chosen && <Button variant="outline" size="small" onClick={() => setDeleting(chosen)}>Delete {chosen.parent_id ? "section" : (KIND_LABEL[chosen.kind] ?? "container").toLowerCase()}</Button>}
          {hasSections && (
            <label className="coll-with-sections small">
              <input type="checkbox" checked={withSections} onChange={(e) => setWithSections(e.target.checked)} />
              <span>Include its sections</span>
            </label>
          )}
          <Segmented className="coll-sort" label="Order" value={sort} onChange={setSort} options={[["value", "By value"], ["name", "By name"]]} />
          {(proxies > 0 || kind !== "all") && (
            <Segmented className="coll-kind" label="Real cards or proxies" value={kind} onChange={setKind} options={[["all", "All"], ["real", "Real"], ["proxy", "Proxies"]]} />
          )}
          {!!items.data?.length && !items.isPlaceholderData && filter.trim() === query && (
            <Button variant="outline" className="coll-sell" onClick={() => setSelling(true)}>Sell list</Button>
          )}
          <label className="coll-filter">
            <span className="visually-hidden">Filter by name</span>
            <input type="search" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {tiles.length === 0 && loose === 0 && <Button onClick={() => setNewContainer(true)}>New binder, box or deck</Button>}
        </div>

        {!!items.data?.length && (
          <div className="coll-filters" role="group" aria-label="Filter and view">
            <select aria-label="Set" value={filters.set} onChange={(e) => filter1({ set: e.target.value })}>
              <option value="">Any set</option>
              {options.sets.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code.toUpperCase()})</option>)}
            </select>
            <select aria-label="Color" value={filters.color} onChange={(e) => filter1({ color: e.target.value })}>
              <option value="">Any color</option>
              {COLOR_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <select aria-label="Card type" value={filters.type} onChange={(e) => filter1({ type: e.target.value })}>
              <option value="">Any type</option>
              {options.types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select aria-label="Rarity" value={filters.rarity} onChange={(e) => filter1({ rarity: e.target.value })}>
              <option value="">Any rarity</option>
              {options.rarities.map((r) => <option key={r} value={r}>{rarityLabel(r)}</option>)}
            </select>
            <select aria-label="Finish" value={filters.finish} onChange={(e) => filter1({ finish: e.target.value })}>
              <option value="">Any finish</option>
              {options.finishes.map((x) => <option key={x} value={x}>{FINISH_LABEL[x] ?? x}</option>)}
            </select>
            {filtering && <Button variant="quiet" size="small" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>}
            <Segmented className="coll-show" label="Show as" value={show} onChange={showAs} options={[["list", "List"], ["grid", "Pictures"]]} />
          </div>
        )}
        {filtering && sorted.length > 0 && (
          <p className="small dim coll-note" role="status">{totalsText(totals(sorted), usdWhole)}</p>
        )}

        {done && (
          <p className="coll-done" role="status">
            {done} <Button variant="quiet" size="small" onClick={() => setDone(null)}>OK</Button>
          </p>
        )}
        <ErrorText error={items.error ?? summary.error} />
        {items.data && items.data.length === 0 && !query && !container && kind === "all" && (
          <EmptyState
            action={
              <>
                <Button variant="outline" onClick={() => setImporting("cards")}>Import a list or a file</Button>
                <Button variant="outline" onClick={() => setScanning(true)}>Scan cards</Button>
                <ButtonLink variant="outline" to="/cards">Add from card search</ButtonLink>
              </>
            }
          >
            No cards yet.
          </EmptyState>
        )}
        {items.data && items.data.length === 0 && (query || container || kind !== "all") && (
          <EmptyState>
            {kind === "proxy" ? "No proxies" : kind === "real" ? "No real cards" : "Nothing"} here{query ? ` called "${query}"` : ""}.
          </EmptyState>
        )}
        {!!items.data?.length && sorted.length === 0 && (
          <EmptyState action={<Button variant="outline" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>}>
            Nothing here matches those filters.
          </EmptyState>
        )}
        {show === "grid" && <CollectionGrid items={shown} onOpen={setOpen} />}
        {show === "list" && (
        <ul className="coll-list">
          {shown.map((i) => {
            const place = placeLabel(i.container_id, all) ?? i.container_name ?? "Not filed";
            const cond = CONDITIONS[i.condition] ?? i.condition;
            // "Surge foil", "Showcase": what makes this copy's printing special.
            const special = treatmentLabel(i, i.finish);
            return (
              <li key={i.id}>
                <Button className="coll-row" onClick={() => setOpen(i)}>
                  <CardThumb className="coll-art" src={i.image_art_crop} fallback={<CardImage src={i.image_small} name={i.name ?? "?"} className="coll-art coll-thumb" />} />
                  <span className="coll-row-text">
                    <span className="coll-row-name">
                      <CardHover name={i.name??i.scryfall_id} oracleId={i.oracle_id} image={i.image_small}/>
                      {i.finish !== "nonfoil" && <Tag>{i.finish[0]!.toUpperCase() + i.finish.slice(1)}</Tag>}
                      {i.proxy && <Tag>Proxy</Tag>}
                      {/* What makes this row its own beside another of the same printing. */}
                      {markWords(i).map((w) => <Tag key={w}>{w[0]!.toUpperCase() + w.slice(1)}</Tag>)}
                    </span>
                    <span className="coll-row-where coll-wide">
                      {place}, {i.set_name ?? "unknown set"} #{i.collector_number}{special ? `, ${special}` : ""}, {cond}
                    </span>
                    <span className="coll-row-where coll-narrow">
                      {place}
                      {special ? `, ${special}` : ""}
                      {i.condition !== "NM" ? `, ${cond}` : ""}
                      {i.qty > 1 ? `, ${i.qty} copies` : ""}
                    </span>
                  </span>
                  <span className="coll-qty num">×{i.qty}</span>
                  <span className="coll-price num">{usd(i.unit_price_usd)}</span>
                </Button>
              </li>
            );
          })}
        </ul>
        )}
        {left > 0 && (
          <Button className="coll-more" onClick={() => setLimit((n) => n + MORE)}>
            {left > MORE ? `Show ${MORE} more of ${count(left)}` : `Show the last ${count(left)}`}
          </Button>
        )}
        {!!items.data?.length && (
          <div className="small dim coll-note help-heading">
            <span>
              TCGplayer market via Scryfall, {day}.
            </span>
            <HelpPopover label="About collection prices">
              <p>Prices are per copy in its finish. Market values are not store quotes or resale offers. Proxies are excluded from collection value; missing prices stay unpriced.</p>
            </HelpPopover>
            {thumbArtists.length > 0 ? <span>{artCredits(thumbArtists)}</span> : null}
          </div>
        )}
        <ButtonLink variant="outline" className="coll-export-narrow" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</ButtonLink>
      </section>

      {open && (
        <CollectionItemSheet
          key={open.id}
          item={open}
          containers={containers.data ?? []}
          onClose={(done) => {
            setOpen(null);
            setDone(done ?? null);
          }}
        />
      )}
      {selling && (
        <SellSheet
          items={sorted}
          from={(chosen ? pathLabel(chosen, all) : container === "none" ? "loose cards" : "every card") + (query ? ` called "${query}"` : "") + (filtering ? ", filtered" : "")}
          inDeckBox={chosen?.kind === "deck"}
          onClose={() => setSelling(false)}
        />
      )}
      {deleting && <DeleteContainer container={deleting} onClose={() => setDeleting(null)} onDeleted={() => {
        setContainer("");
        setDeleting(null);
        setDone(`Deleted “${pathLabel(deleting, all)}”. Its cards are still in your collection as loose cards.`);
      }} />}
      {importing === "cards" && <ImportCollectionSheet containers={containers.data ?? []} onClose={() => setImporting(null)} onMythic={() => setImporting("mythic")} />}
      {importing === "mythic" && <MythicImportSheet onClose={() => setImporting(null)} />}
      {scanning && <ScanToCollection containers={containers.data ?? []} onClose={() => setScanning(false)} />}
    </main>
  );
}

/** A Mythic Tools export, brought up to date with its boxes and decks (the other import takes any list or file). */
function MythicImportSheet({ onClose }: { onClose: () => void }) {
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
    <Dialog title="Import from Mythic Tools" onClose={onClose}>
      <div className="stack">
        <p className="dim">
          Choose a Mythic Tools CSV to preview the changes. Cards you've moved in Yama stay where you put them.
        </p>
        <p className="dim small">
          Mythic Tools exports decks separately. Import each deck's CSV here, or its text list from Decks.
        </p>
        <Field label="CSV file">
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} />
        </Field>
        {preview.isFetching && <Loading>Checking the file against your collection…</Loading>}
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
                <Button variant="primary" disabled={apply.isPending || preview.isFetching} onClick={() => apply.mutate()}>
                  {apply.isPending ? "Importing…" : "Import"}
                </Button>
                <Button variant="quiet" onClick={onClose}>Cancel</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteContainer({ container, onClose, onDeleted }: { container: Container; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const label = (KIND_LABEL[container.kind] ?? "container").toLowerCase();
  const remove = useMutation({
    // Not found means it is already deleted (a second try after a lost reply): the same outcome.
    mutationFn: () => api(`/api/containers/${encodeURIComponent(container.id)}`, { method: "DELETE" }).catch((e: unknown) => { if (!(e instanceof ApiError && e.status === 404)) throw e; }),
    onSuccess: () => {
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || ["containers", "decks", "deck", "deck-collect"].includes(String(q.queryKey[0])) });
      onDeleted();
    },
  });
  return (
    <Dialog label={`Delete ${label}`} onClose={() => { if (!remove.isPending) onClose(); }}>
      <div className="stack">
        <h2>Delete “{container.name}”?</h2>
        <p>Any cards inside will stay in your collection as loose cards. Saved decks and their lists will stay too.</p>
        <div className="row">
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? "Deleting…" : `Delete ${label}`}</Button>
          <Button variant="quiet" disabled={remove.isPending} onClick={onClose}>Cancel</Button>
        </div>
        <ErrorText error={remove.error} />
      </div>
    </Dialog>
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
      <Button type="submit" variant="primary" disabled={create.isPending}>Create</Button>
      <Button variant="quiet" onClick={onClose}>Cancel</Button>
      <ErrorText error={create.error} />
    </form>
  );
}

export function ScanToCollection({ containers, onClose }: { containers: Container[]; onClose: () => void }) {
  const qc = useQueryClient();
  /** The finish chosen last. Each card is filed in the finish its printing comes in (`pickFinish`). */
  const [finish, setFinish] = useState<Finish>("nonfoil");
  /** The printing the found card is settled on, whose finishes the Finish choice offers. */
  const [printing, setPrinting] = useState<Printing | null>(null);
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
    // Its only finish, else the one chosen last if it comes that way, else regular (Etched too).
    const filed: Finish = finish === "proxy" ? "proxy" : (pickFinish({ finishes: c.finishes }, finish) as Finish);
    const entry: Added = {
      key: crypto.randomUUID(),
      name: c.name,
      scryfall_id: c.scryfall_id,
      set: c.set ?? "",
      number: c.number ?? "",
      image: c.thumb ?? c.image ?? null,
      finish: filed,
      finishes: c.finishes,
      treatment: c.treatment,
      container: box,
      copies,
      auto,
      prices: c.prices ?? null,
      pending: { ops: [addOp(c.scryfall_id, copies, filed, box, crypto.randomUUID())], fix: null },
    };
    put([entry, ...listRef.current]);
    filedAs.current.set(c, entry.key);
    const ok = await send(entry.key);
    setError(ok ? null : new Error(`Couldn't save ${c.name}. It's kept in the Added list to try again.`));
    return ok;
  };

  /** The session entry each card the scanner filed went into, for its Undo. */
  const filedAs = useRef(new WeakMap<ScanCandidate, string>());
  /** Undo on the scanner's "Added …": take this session's copies of that card back out (the same fix as Remove in the Added list). */
  const undo = async (c: ScanCandidate) => {
    const key = filedAs.current.get(c);
    const a = key ? listRef.current.find((x) => x.key === key) : undefined;
    if (!a) throw new Error("It's no longer in the Added list");
    const { removeFix } = await scanner();
    await fix(a, removeFix(a));
  };
  /**
   * Wrong printing after filing: move that entry's copies to the right printing (a fix, as in the
   * Added list), and let `to` stand for them. Says what is filed now: "kept" when the entry was
   * already that printing (it may have been changed in the Added list since).
   */
  const correct = async (from: ScanCandidate, to: ScanCandidate): Promise<"changed" | "kept"> => {
    const key = filedAs.current.get(from);
    const a = key ? listRef.current.find((x) => x.key === key) : undefined;
    if (!key || !a || !to.scryfall_id) throw new Error("It's no longer in the Added list");
    filedAs.current.set(to, key);
    if (a.scryfall_id === to.scryfall_id && !a.pending) return "kept";
    const { printingFix } = await scanner();
    await fix(a, printingFix(a, { scryfall_id: to.scryfall_id, set: to.set, number: to.number, name: to.name, image: to.thumb ?? to.image ?? null, prices: to.prices, finishes: to.finishes, treatment: to.treatment }));
    return "changed";
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

  // Closing with scans that haven't reached the collection asks first (scanClose.ts): a failed
  // save lives only on this screen, and one still on its way could fail after the scanner is gone.
  const [closing, setClosing] = useState(false);
  const unsaved = unsavedScans(added);
  const question = closeQuestion(unsaved);
  const close = () => (closeQuestion(unsavedScans(listRef.current)) ? setClosing(true) : onClose());
  // The scanner's own Close asks above; Back, a link, a reload or closing the tab ask through the
  // unsaved-work guard, since any of them takes the scanner away with what it couldn't save.
  const guard = useUnsavedChanges(question !== null);
  useEffect(() => {
    // Asked to close while saves were out, and they have all gone through since.
    if (closing && !question) onClose();
  }, [closing, question, onClose]);
  const retryAll = () => {
    for (const a of listRef.current) if (a.pending?.error) void send(a.key);
  };

  // The finishes the found card's printing comes in (all three while none is found), and Proxy.
  const shownFinish: Finish = finish === "proxy" ? "proxy" : (pickFinish(printing, finish) as Finish);
  const finishOptions = [...finishesOf(printing), "proxy"];
  const finishLabel = finishName(shownFinish);
  const filedIn = placeLabel(container, containers);
  const settingsSummary = [finishLabel, filedIn ? `into ${filedIn}` : "not filed", keepAdding && "keep adding", !closeups && "no close-ups"].filter(Boolean).join(", ");
  const settings = (
    <>
      <Field label="Finish">
        <select value={shownFinish} onChange={(e) => setFinish(e.target.value as Finish)}>
          {finishOptions.map((f) => (
            <option key={f} value={f}>
              {finishName(f)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Put in">
        <select value={container} onChange={(e) => setContainer(e.target.value)}>
          <option value="">Not filed anywhere</option>
          {treeOrder(containers).map((c) => <option key={c.id} value={c.id}>{optionLabel(c, containers)}</option>)}
        </select>
      </Field>
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
          <strong>Close-ups.</strong> When several printings share the art, the scanner reads the set code and number while you hold the card. If that doesn't work within a few tries, it asks you to bring the camera close to them. Turn it off to never be asked, for example with a stand or card feeder. The scanner then keeps reading the whole card, and you tap the printing if it can't tell.
        </span>
      </label>
    </>
  );
  const controls = error ? <ErrorText error={error} /> : null;
  return (
    <div className="scan-overlay">
      <Suspense fallback={<Loading padded>Starting the scanner…</Loading>}>
        <ScannerView
          onAccept={accept}
          onUndo={undo}
          onCorrect={correct}
          onClose={close}
          addedCount={added.reduce((n, a) => n + a.copies, 0)}
          onShowAdded={() => setReviewing(true)}
          unsavedCount={added.filter((a) => a.pending?.error && a.pending.fix === null).length}
          autoAdd={keepAdding}
          closeups={closeups}
          paused={reviewing || closing}
          recentCards={added.map((a) => ({ key: a.key, name: a.name, set: a.set, number: a.number, finish: a.finish, copies: a.copies, prices: a.prices }))}
          finish={finish}
          onPrinting={setPrinting}
          controls={controls}
          settings={settings}
          settingsSummary={settingsSummary}
          acceptLabel="Add and scan next"
        />
        {reviewing && (
          <Dialog onClose={() => setReviewing(false)} label="Added while scanning">
            <AddedList added={added} onFix={fix} onRetry={retry} onClose={() => setReviewing(false)} />
          </Dialog>
        )}
        <UnsavedPrompt guard={guard} what="the scans that aren't saved yet" />
        {closing && question && (
          <Dialog centered title="Not saved yet" onClose={() => setClosing(false)}>
            <div className="stack">
              <p role="status">{question}</p>
              <div className="row">
                {unsaved.failed > 0 && <Button variant="primary" disabled={unsaved.sending > 0} onClick={retryAll}>{unsaved.sending > 0 ? "Saving…" : "Try again"}</Button>}
                <Button onClick={() => setClosing(false)}>Keep scanning</Button>
                <Button variant="quiet" onClick={onClose}>Close without saving</Button>
              </div>
            </div>
          </Dialog>
        )}
      </Suspense>
    </div>
  );
}
