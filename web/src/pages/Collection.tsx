import { HelpPopover } from "../components/HelpPopover";
import { CardHover } from "../components/CardRef";
import { CollectionItemSheet } from "./CollectionItemSheet";
import { ImportCollectionSheet } from "./ImportCollectionSheet";
import { CollectionGrid, CopyPrice } from "./CollectionGrid";
import { conditionWord, markWords } from "./collectionEdit";
import { UnsavedPrompt, useUnsavedChanges } from "../unsaved";
import { closeQuestion, unsavedScans } from "./scanClose";
import { SellSheet } from "./SellSheet";
import { buylistStore } from "./SellOffers";
import { usePlan } from "../plan/store";
import { useMe } from "../auth";
import { ContainerSections, Breadcrumb } from "./ContainerSections";
import { optionLabel, pathLabel, placeLabel, subtreeIds, treeOrder } from "./containerTree";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { exportLink } from "../download";
import { api, API_BASE, ApiError, placeName, type CollectionItem, type CollectionSummary, type Container, type DeckSummary, type Printing } from "../api";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ActionBar, BackLink, Button, ButtonLink, CardImage, CardThumb, Details, Dialog, EmptyState, ErrorText, Field, Loading, PageHeader, Segmented, Tag } from "../components/ui";
import "./collection.css";
import "../decks/collect.css";
import { changeText, keptText, missingLabel, missingText, previewLines, resultLines, type MythicReport } from "./mythicImport";
import { activeFilters, byValue, cardsAndProxies, clampFilters, COLOR_OPTIONS, filterOptions, FINISH_LABEL, foundText, money, NO_FILTERS, passes, rarityLabel, totals, totalsText, type Filters } from "./collectionFilters";

const KIND_LABEL: Record<string, string> = { binder: "Binder", box: "Box", deck: "Deck box", list: "List" };

/**
 * "146 cards, $402" for a tile, "5 cards and 1 proxy" where some are proxies, "Empty" for none.
 * Copies without a price are said, not counted as $0, and no value is printed when nothing has one.
 */
export function tileMeta(copies: number, proxies: number | undefined, value: number | undefined, unpriced: number | undefined): string {
  const cards = cardsAndProxies(copies, proxies);
  if (copies <= 0) return cards;
  return `${cards}${value ? `, ${money(value)}` : ""}${unpriced ? `, ${unpriced} with no price` : ""}`;
}
import type { Added, Finish, Fix, RecentCard, ScanCandidate } from "../scanner";
import { useOpenedEntry } from "../scanner/opened";
import { useDebounced } from "../useDebounced";
// The scan choices and their notes, shown here outside the scanner too.
import "../scanner/scanner.css";
import { priceSource, shortDate, count, plural, usdWhole, treatmentLabel, finishName, finishesOf, pickFinish } from "@yama/core";
import { BugButton } from "../bugs/BugButton";

// The scanner pulls in OCR; load it only when someone opens it.
const scanner = () => import("../scanner");
const ScannerView = lazy(() => scanner().then((m) => ({ default: m.ScannerView })));
const AddedList = lazy(() => scanner().then((m) => ({ default: m.AddedList })));
const ScannedCard = lazy(() => scanner().then((m) => ({ default: m.ScannedCard })));

/** Keep adding is remembered on this device. */
const KEEP_ADDING = "yama.scan.keepAdding";
/** The close-up step, on unless turned off on this device (a fixed camera). Shared with the deck scan. */
const CLOSEUPS = "yama.scan.closeups";

/** A collection row with its printing's art crop and artist, for the art thumbnails. */
type Item = CollectionItem & { image_art_crop?: string | null; artist?: string | null };
/** Rows shown at first, and how many more each "Show more" adds: a collection can run to thousands,
 *  and drawing every row at once made the page crawl. */
const SHOW = 24;
const MORE = 200;
/** List or pictures, remembered on this device. */
const VIEW = "yama.collection.view";
/** Whether the binder, box and deck tiles are shown, remembered on this device. Unset, they
 *  show while they fit about a row; past that they fold away behind the dropdown, so the search
 *  and the cards stay near the top. */
const PLACES = "yama.collection.places";
const FEW_PLACES = 6;
function storedPlaces(): "tiles" | "folded" | null {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(PLACES) : null;
    return v === "tiles" || v === "folded" ? v : null;
  } catch {
    return null;
  }
}
function storedView(): "list" | "grid" {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(VIEW) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
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
  const [placesChoice, setPlacesChoice] = useState(storedPlaces);
  /** The dropdown's choice while picking with the keyboard (Enter opens it). */
  const [placePick, setPlacePick] = useState("");
  const pickByKey = useRef(false);
  const choosePlaces = (v: "tiles" | "folded") => {
    setPlacesChoice(v);
    try {
      localStorage.setItem(PLACES, v);
    } catch {
      // Private browsing: the choice lasts for this visit.
    }
  };
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
  // "Scan my cards" elsewhere (the Cards tab) lands here with the scanner open.
  const [scanning, setScanningState] = useState(() => params.get("scan") === "1");
  const setScanning = (on: boolean) => {
    setScanningState(on);
    if (!on && params.has("scan")) {
      const next = new URLSearchParams(params);
      next.delete("scan");
      setParams(next, { replace: true });
    }
  };
  const [selling, setSelling] = useState(false);
  const [deleting, setDeleting] = useState<Container | null>(null);
  /** The phone's filters, folded behind one button until asked for. */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const s = summary.data;
  const proxies = s?.proxies ?? 0;
  const real = (s?.copies ?? 0) - proxies;
  /** Whether any real copy has a market price: without one there is no total, and never "$0.00". */
  const valued = real > (s?.copies_without_price ?? 0);
  /** Nothing in the collection at all: the page is its empty state. */
  const empty = !!s && s.copies === 0;
  // An empty collection has no search box, so a search left in it couldn't be cleared and would
  // go on hiding the rest of the page: with nothing to search, the search goes too.
  if (empty && filter !== "") setFilter("");
  // A deck box shows its deck's commander; anything else, the most valuable card inside.
  const all = useMemo(() => containers.data ?? [], [containers.data]);
  // The tiles are the top-level containers; a section shows inside its box.
  const tiles = all.filter((c) => !c.parent_id).map((c) => {
    const deck = decks.data?.find((d) => d.container_id === c.id && d.commander_image);
    return { c, art: deck ? deck.commander_image : (c.art ?? null), artist: deck ? deck.commander_artist : (c.artist ?? null) };
  });
  const filed = (containers.data ?? []).reduce((a, c) => a + c.copies, 0);
  const loose = s ? s.copies - filed : 0;
  // Which place each proxy is in, so a tile counts them apart from real cards as the head does.
  // The same rows (and the same cache) as this page's own "Proxies" view.
  const proxyRows = useQuery({
    queryKey: ["collection", "", "", "proxy"],
    queryFn: ({ signal }) => api<Item[]>("/api/collection?proxy=only", { signal }),
    enabled: proxies > 0,
  });
  /** The proxies in a place (its sections included), or undefined until they're known. */
  const proxiesIn = useMemo(() => {
    const own = new Map<string, number>();
    for (const i of proxyRows.data ?? []) own.set(i.container_id ?? "none", (own.get(i.container_id ?? "none") ?? 0) + i.qty);
    const known = proxies === 0 || !!proxyRows.data;
    return (id: string): number | undefined => {
      if (!known) return undefined;
      if (id === "none") return own.get("none") ?? 0;
      let n = 0;
      for (const x of subtreeIds(id, all)) n += own.get(x) ?? 0;
      return n;
    };
  }, [proxyRows.data, proxies, all]);
  const boxMeta = (c: Container) => tileMeta(c.total_copies ?? c.copies, proxiesIn(c.id), c.total_market_value_usd ?? c.market_value_usd, c.total_copies_without_price ?? c.copies_without_price);
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
  // A search says what it found where the heading was: the rows under it are the answer.
  const searching = filter.trim() !== "";
  /** The rows on the page are the answer to what is typed (not the last search's, still on its way out). */
  const settled = !!items.data && !items.isPlaceholderData && filter.trim() === query;
  const where = chosen ? chosen.name : container === "none" ? "loose cards" : null;
  const heading = searching
    ? settled
      ? foundText(totals(sorted), query, where)
      : `Cards called “${filter.trim()}”`
    : container
      ? "Cards"
      : sort === "value"
        ? "Most valuable"
        : "Every card";
  // The list shows art crops (credited under it); the pictures are whole cards, which name their artist.
  const thumbArtists = show === "list" ? shown.filter((i) => i.image_art_crop).map((i) => i.artist) : [];
  const places = tiles.length + (loose > 0 ? 1 : 0);
  /** Everything the dropdown offers: every container, sections included, and the loose cards. */
  const choices = all.length + (loose > 0 ? 1 : 0);
  const showTiles = (placesChoice ?? (places > FEW_PLACES ? "folded" : "tiles")) === "tiles";
  const searchLabel = chosen ? `Search ${chosen.name}` : container === "none" ? "Search loose cards" : "Search your collection";
  /** How many choices narrow the list, for the phone's Filter button. */
  const narrowed = activeFilters(filters) + (kind !== "all" ? 1 : 0);
  // An id that names no box (deleted, or a stale link) says so rather than passing for loose cards.
  const openName = chosen ? chosen.name : container === "none" ? "Loose cards" : containers.data ? "No such binder or box" : "";
  const openTile = tiles.find((x) => x.c.id === container);
  // What the last change did (a deleted row or box). It sits over the cards and stays in view
  // while they scroll: the change was made from a row that may be far down the list.
  const doneLine = done && (
    <p className="coll-done" role="status">
      {done} <Button variant="quiet" size="small" onClick={() => setDone(null)}>OK</Button>
    </p>
  );
  return (
    <main className="page coll-page">
      {/* With a box open, the box is the page: the way back, then its name as the heading. */}
      {!container && (
        <div className="coll-head">
          <div className="coll-title">
            <div className="head-with-bug"><h1>Collection</h1><BugButton /></div>
            {s && s.copies > 0 && (
              <span className="coll-value">
                {/* Proxies have no market value, and a missing price isn't $0: with no priced real
                    card there is no total to print, and no day it would be the total on. */}
                {valued && <b className="num">{money(s.market_value_usd)}</b>}
                <span className="coll-wide">
                  {cardsAndProxies(s.copies, proxies)}
                  {valued ? `, market value on ${day}` : ""}
                  {/* In brackets: after the date, ", 25 with no price" read as the year. */}
                  {s.copies_without_price > 0 ? ` (${count(s.copies_without_price)} with no price)` : ""}
                </span>
                <span className="coll-narrow">
                  {cardsAndProxies(s.copies, proxies)}
                  {valued ? `, ${day}` : ""}
                </span>
                <HelpPopover label="About this total">
                  <p>
                    {valued
                      ? `TCGplayer market value of your real cards on ${day}, per copy in its finish. It is not a store quote or a resale offer.`
                      : `The total is the TCGplayer market value of your real cards. ${real > 0 ? (real === 1 ? "Yours has no price" : "None of yours has a price") : "You have none here yet"}, so there is no total.`}
                    {valued && s.copies_without_price > 0 ? ` ${count(s.copies_without_price)} ${s.copies_without_price === 1 ? "card has no price and isn't" : "cards have no price and aren't"} counted.` : ""}
                    {proxies > 0 ? ` Your ${count(proxies)} ${proxies === 1 ? "proxy isn't" : "proxies aren't"} counted.` : ""}
                  </p>
                  {s.purchase_total_usd > 0 && (
                    <p>
                      You paid {usdWhole(s.purchase_total_usd)}, where recorded{s.copies_without_purchase_price ? ` (${count(s.copies_without_purchase_price)} ${s.copies_without_purchase_price === 1 ? "copy has" : "copies have"} no purchase price)` : ""}
                      {s.copies_paid_in_other_currency ? `; ${count(s.copies_paid_in_other_currency)} paid in another currency ${s.copies_paid_in_other_currency === 1 ? "isn't" : "aren't"} added in` : ""}.
                    </p>
                  )}
                </HelpPopover>
              </span>
            )}
          </div>
          {/* An empty collection offers these once, in its empty state. */}
          {!empty && (
            <div className="coll-actions">
              <Button variant="outline" className="coll-import" onClick={() => setImporting("cards")}>Import</Button>
              <ButtonLink variant="outline" className="coll-export" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</ButtonLink>
              <Button variant="primary" className="coll-scan" onClick={() => setScanning(true)}>Scan cards</Button>
            </div>
          )}
        </div>
      )}

      {container && (
        <section className="containers coll-open" aria-label={chosen ? chosen.name : "Loose cards"}>
          <BackLink inline to="/collection" text="Every binder, box and deck" label="Back to every binder, box and deck" />
          <ArtPanel art={openTile?.art ?? chosen?.art ?? null} artist={openTile?.artist ?? chosen?.artist ?? null} wash="bottom" empty={!(openTile?.art ?? chosen?.art)} className="coll-open-art">
            <span className="ct-kind">{chosen ? (chosen.spares_of_deck ? `${chosen.spares_of_deck}'s box (swappable)` : chosen.parent_id ? "Section" : (KIND_LABEL[chosen.kind] ?? chosen.kind)) : container === "none" ? "Not filed" : ""}</span>
            <h1 className="ct-name">{openName}</h1>
            <span className="ct-meta num">{chosen ? boxMeta(chosen) : container === "none" && s ? tileMeta(loose, proxiesIn("none"), undefined, undefined) : ""}</span>
          </ArtPanel>
          {chosen && <Breadcrumb id={chosen.id} all={all} onOpen={setContainer} />}
        </section>
      )}

      {/* The search sits under the head (or the open box's name), above everything a search hides. */}
      {!empty && (
        <div className="coll-filter" role="search">
          <input type="search" aria-label={`${searchLabel} by name`} placeholder={`${searchLabel} by name`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}

      {/* The open box's sections and what can be done with it. A search hides them (kept as they
          are, with any form half filled in), so its rows come straight under the search. */}
      {chosen && (
        <div className="coll-open" hidden={searching}>
          <ContainerSections key={chosen.id} container={chosen} all={all} onOpen={setContainer} onDone={setDone} onDelete={() => setDeleting(chosen)} onImport={() => setImporting("cards")} />
        </div>
      )}
      {container === "none" && !searching && (
        <ActionBar>
          <Button variant="primary" size="small" onClick={() => setScanning(true)}>Scan cards</Button>
          <Button size="small" onClick={() => setImporting("cards")}>Import</Button>
        </ActionBar>
      )}
      {/* Only once the containers are in: before, every card counts as loose and a lone tile flashes. */}
      {!container && !searching && containers.data && (tiles.length > 0 || loose > 0) && (
        <section className={showTiles ? "containers" : "containers coll-folded"} aria-labelledby="where">
          <div className="section-head">
            <h2 id="where">
              <span className="coll-wide">Binders, boxes and decks</span>
              <span className="coll-narrow">Where they live</span>
            </h2>
            {!showTiles && (
              <select
                className="coll-place"
                aria-label="Open a binder, box or deck"
                value={placePick}
                onKeyDown={(e) => {
                  // Arrow keys and letters change a closed select on some systems: with the
                  // keyboard, the choice waits for Enter rather than leaving the page at once.
                  if (e.key === "Enter" && placePick) {
                    e.preventDefault();
                    setContainer(placePick);
                  } else if (e.key !== "Tab") pickByKey.current = true;
                }}
                onPointerDown={() => (pickByKey.current = false)}
                onChange={(e) => {
                  const id = e.target.value;
                  if (pickByKey.current) setPlacePick(id);
                  else if (id) setContainer(id);
                }}
              >
                <option value="">Open one of {count(choices)}</option>
                {treeOrder(all).map((c) => <option key={c.id} value={c.id}>{optionLabel(c, all)}</option>)}
                {loose > 0 && <option value="none">Loose cards</option>}
              </select>
            )}
            <Button variant="quiet" size="small" className="coll-tiles-toggle" aria-expanded={showTiles} aria-controls={showTiles ? "coll-tiles" : undefined} onClick={() => choosePlaces(showTiles ? "folded" : "tiles")}>
              {showTiles ? "Hide tiles" : "Show tiles"}
            </Button>
            <Button className="coll-new" onClick={() => setNewContainer(true)}>New</Button>
          </div>
          {newContainer && <NewContainer onClose={() => setNewContainer(false)} />}
          {showTiles && (
          <>
          <ul className="container-tiles" id="coll-tiles">
            {tiles.map(({ c, art, artist }) => (
              <li key={c.id}>
                <Button className="container-tile" onClick={() => setContainer(c.id)}>
                  <ArtPanel as="span" art={art} artist={artist} wash="bottom" credit={false}>
                    <span className="ct-kind">{c.spares_of_deck ? `${c.spares_of_deck}'s box (swappable)` : (KIND_LABEL[c.kind] ?? c.kind)}</span>
                    <span className="ct-name">{c.name}</span>
                    <span className="ct-meta num">
                      {boxMeta(c)}
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
                    <span className="ct-meta num">{tileMeta(loose, proxiesIn("none"), undefined, undefined)}</span>
                  </ArtPanel>
                </Button>
              </li>
            )}
          </ul>
          {/* The date and source of the tiles' values: said only where a tile shows one. */}
          {(!empty || tiles.some((t) => t.art)) && (
            <p className="small dim coll-note">
              {empty ? "" : `${priced}. `}
              {tiles.some((t) => t.art) ? artCredits(tiles.filter((t) => t.art).map((t) => t.artist)) : ""}
            </p>
          )}
          </>
          )}
        </section>
      )}

      {empty && !container ? (
        <section className="coll-cards" aria-label="Start your collection">
          {doneLine}
          <ErrorText error={items.error ?? summary.error} />
          <EmptyState
            action={
              <>
                <Button variant="primary" onClick={() => setScanning(true)}>Scan cards</Button>
                <Button variant="outline" onClick={() => setImporting("cards")}>Import a list</Button>
                <ButtonLink variant="outline" to="/cards">Add from card search</ButtonLink>
              </>
            }
          >
            Keep track of the cards you own: what they're worth, where each one is kept, and which cards your decks still need.
          </EmptyState>
          {tiles.length === 0 &&
            (newContainer ? (
              <NewContainer onClose={() => setNewContainer(false)} />
            ) : (
              <p className="small dim coll-note">
                Sorting them as you go? <Button variant="quiet" size="small" onClick={() => setNewContainer(true)}>Make a binder, box or deck</Button> first.
              </p>
            ))}
        </section>
      ) : (
      <section className="coll-cards" aria-labelledby="coll-cards-h">
        <div className="coll-cards-top">
          <div className="coll-cards-head">
            {/* While a search is on, the heading is its count, read out as it changes. */}
            <h2 id="coll-cards-h" className={searching ? "coll-found" : undefined} aria-live={searching ? "polite" : undefined}>{heading}</h2>
            {hasSections && (
              <label className="coll-with-sections small">
                <input type="checkbox" checked={withSections} onChange={(e) => setWithSections(e.target.checked)} />
                <span>Include its sections</span>
              </label>
            )}
            <Segmented className="coll-sort" label="Order" value={sort} onChange={setSort} options={[["value", "By value"], ["name", "By name"]]} />
            {/* On a laptop these two sit in the heading's row; a phone has them in its Filter fold. */}
            {(proxies > 0 || kind !== "all") && (
              <Segmented className="coll-kind coll-only-wide" label="Real cards or proxies" value={kind} onChange={setKind} options={[["all", "All"], ["real", "Real"], ["proxy", "Proxies"]]} />
            )}
            {!!items.data?.length && settled && (
              <Button variant="outline" className="coll-sell coll-only-wide" onClick={() => setSelling(true)}>Sell list</Button>
            )}
          </div>
          {(!!items.data?.length || kind !== "all") && (
            <div className="coll-tools">
              {/* Phones fold the filters behind one button, so the cards stay near the top. */}
              <Button className="coll-filters-toggle" aria-expanded={filtersOpen} aria-controls="coll-filters" onClick={() => setFiltersOpen(!filtersOpen)}>
                {narrowed > 0 ? `Filter (${narrowed})` : "Filter"}
              </Button>
              <Segmented className="coll-show" label="Show as" value={show} onChange={showAs} options={[["list", "List"], ["grid", "Pictures"]]} />
              <div id="coll-filters" className={filtersOpen ? "coll-filters is-open" : "coll-filters"} role="group" aria-label="Filter">
                {(proxies > 0 || kind !== "all") && (
                  <Segmented className="coll-kind coll-only-narrow" label="Real cards or proxies" value={kind} onChange={setKind} options={[["all", "All"], ["real", "Real"], ["proxy", "Proxies"]]} />
                )}
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
                {!!items.data?.length && settled && (
                  <Button variant="outline" className="coll-sell coll-only-narrow" onClick={() => setSelling(true)}>Sell list</Button>
                )}
              </div>
            </div>
          )}
        </div>
        {filtering && sorted.length > 0 && (
          <p className="small dim coll-note" role="status">{totalsText(totals(sorted), money)}</p>
        )}
        {doneLine}

        <ErrorText error={items.error ?? summary.error} />
        {items.data && items.data.length === 0 && (
          <EmptyState action={query && settled ? <Link to={`/cards?q=${encodeURIComponent(query)}`}>Look it up in card search</Link> : undefined}>
            {kind === "proxy" ? "No proxies" : kind === "real" ? "No real cards" : "Nothing"} {where ? `in ${where}` : "in your collection"}{query ? ` called “${query}”` : ""}.
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
            const place = i.spares_of_deck ? placeName(i) : (placeLabel(i.container_id, all) ?? placeName(i));
            const cond = conditionWord(i.condition);
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
                    {/* The phone's line names the printing by its code: two printings in one place read apart. */}
                    <span className="coll-row-where coll-narrow">
                      {[
                        // Inside one box every row is in it: the place is said only where rows differ.
                        container && !openSections ? null : place,
                        i.set_code ? `${i.set_code.toUpperCase()} ${i.collector_number ?? ""}`.trim() : null,
                        special,
                        i.condition !== "NM" ? cond : null,
                        i.qty > 1 ? `${i.qty} copies` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </span>
                  <span className="coll-qty num">×{i.qty}</span>
                  <CopyPrice item={i} className="coll-price" />
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
        {!container && <ButtonLink variant="outline" className="coll-export-narrow" {...exportLink("/api/collection/export.csv", "yama-collection.csv")}>Export CSV</ButtonLink>}
      </section>
      )}

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
        <AccountSellSheet
          items={sorted}
          from={(chosen ? pathLabel(chosen, all) : container === "none" ? "loose cards" : "every card") + (query ? ` called "${query}"` : "") + (filtering ? ", filtered" : "")}
          inDeckBox={chosen?.kind === "deck"}
          onClose={() => setSelling(false)}
        />
      )}
      {deleting && <DeleteContainer container={deleting} parent={placeLabel(deleting.parent_id, all)} onClose={() => setDeleting(null)} onDeleted={() => {
        setContainer("");
        setDeleting(null);
        const parent = placeLabel(deleting.parent_id, all);
        setDone(`Deleted “${pathLabel(deleting, all)}”. ${parent ? `Its cards are now in ${parent}.` : "Its cards are still in your collection as loose cards."}`);
      }} />}
      {importing === "cards" && <ImportCollectionSheet containers={containers.data ?? []} place={chosen?.id} onClose={() => setImporting(null)} onMythic={() => setImporting("mythic")} />}
      {importing === "mythic" && <MythicImportSheet onClose={() => setImporting(null)} />}
      {scanning && <ScanToCollection containers={containers.data ?? []} onClose={() => setScanning(false)} />}
    </main>
  );
}

/**
 * The sell list with the account's own stores: a store's buylist check is offered only to an
 * account that has that store. The stores are read when the sheet opens, not with the page;
 * until they are in, the sheet doesn't say which it is.
 */
function AccountSellSheet(props: Omit<Parameters<typeof SellSheet>[0], "buylist">) {
  const me = useMe().data;
  const mine = !!me && !me.viewing;
  const plan = usePlan(mine ? me.id : undefined);
  return <SellSheet {...props} buylist={mine && plan.pending ? undefined : buylistStore(plan.bundle)} />;
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

export function DeleteContainer({ container, parent, onClose, onDeleted }: { container: Container; parent?: string | null; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const label = container.parent_id ? "section" : (KIND_LABEL[container.kind] ?? "container").toLowerCase();
  const remove = useMutation({
    // Not found means it is already deleted (a second try after a lost reply): the same outcome.
    mutationFn: () => api(`/api/containers/${encodeURIComponent(container.id)}`, { method: "DELETE" }).catch((e: unknown) => { if (!(e instanceof ApiError && e.status === 404)) throw e; }),
    onSuccess: () => {
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || ["containers", "decks", "deck", "deck-collect"].includes(String(q.queryKey[0])) });
      onDeleted();
    },
  });
  // The server refuses a container that still has sections, so the dialog says so instead of
  // promising what can't happen.
  if (container.sections) {
    return (
      <Dialog label={`Delete ${label}`} onClose={onClose}>
        <div className="stack">
          <h2>“{container.name}” still has {plural(container.sections, "section")}</h2>
          <p>Move or delete {container.sections === 1 ? "it" : "them"} first. Then this {label} can be deleted, and any cards inside stay in your collection.</p>
          <div className="row">
            <Button variant="primary" onClick={onClose}>OK</Button>
          </div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog label={`Delete ${label}`} onClose={() => { if (!remove.isPending) onClose(); }}>
      <div className="stack">
        <h2>Delete “{container.name}”?</h2>
        <p>{parent ? `Any cards inside go into ${parent}, the box it's in.` : "Any cards inside will stay in your collection as loose cards."} Saved decks and their lists will stay too.</p>
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
          <option value="deck">Deck box</option>
          <option value="list">List</option>
        </select>
      </label>
      <label style={{ flex: "1 1 12rem" }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Trade binder" />
      </label>
      <Button type="submit" variant="primary" disabled={create.isPending}>Create</Button>
      <Button variant="quiet" onClick={onClose}>Cancel</Button>
      {/* The two kinds that aren't plain storage, said where they're chosen. */}
      <p className="small dim coll-kind-help">
        A deck box holds the cards of a deck you play, so a sell list leaves it out unless you ask. A list is a group of cards you pick by hand, such as a pile to sell or trade.
      </p>
      <ErrorText error={create.error} />
    </form>
  );
}

/**
 * The Scan tab (/scan, the phone's bottom bar; Bryan, 22 Nov 2026: "replace that with a scanner
 * button"): the camera opens straight away, filing into the collection. Closing it leaves this
 * page, to scan again or find the other scans (a deck's, a box's).
 */
export function ScanPage() {
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }) });
  const [scanning, setScanning] = useState(true);
  return (
    <main className="page stack scan-home">
      <PageHeader title="Scan cards" />
      <p>Hold a card up to the camera and Yama adds it to your collection, in the box you pick in Scan settings.</p>
      <ActionBar>
        <Button variant="primary" onClick={() => setScanning(true)}>
          Scan cards into your collection
        </Button>
      </ActionBar>
      <p className="dim">
        To scan a deck or check one card by card, open it in <Link to="/decks">Decks</Link>: Scan this deck and Check this deck are on its page. To check what's in a box, open the box in{" "}
        <Link to="/collection">Collection</Link>. Every scanner has Test scan in its settings, to try it without saving anything.
      </p>
      <ErrorText error={containers.error} />
      {scanning && <ScanToCollection containers={containers.data ?? []} onClose={() => setScanning(false)} />}
    </main>
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
      oracle_id: c.oracle_id,
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

  /** What Move all or Clear the list just did, said on the sheet and in the Added list. */
  const [notice, setNotice] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  /**
   * Move all (Bryan, 22 Nov 2026: "an easy way to add all the things recently scanned to a
   * different box that was selected"): every card this session added, into `to`, one fix each, so
   * copies owned before the session stay where they were.
   */
  const moveAll = async (to: string | null) => {
    const { boxFix, toMove } = await scanner();
    const { move, busy } = toMove(listRef.current, to);
    const where = placeLabel(to, containers) ?? "not filed anywhere";
    setMoving(true);
    setNotice(null);
    let moved = 0;
    const failed: string[] = [];
    for (const { key } of move) {
      // As it is now: a fix or Clear the list during the move (each move waits on the server) must
      // neither be undone by a plan made from the entry as it was, nor be counted as moved.
      const a = listRef.current.find((x) => x.key === key);
      if (!a || a.copies === 0 || a.container === to) continue;
      try {
        // fix() locks the entry before it first waits, so nothing changes it between here and there.
        await fix(a, boxFix(a, to));
        moved += a.copies;
      } catch {
        failed.push(a.name);
      }
    }
    setMoving(false);
    const parts = [moved > 0 ? `Moved ${plural(moved, "card")} ${to ? `into ${where}` : "out of their box"}.` : null];
    if (failed.length) parts.push(`Couldn't move ${failed.length === 1 ? failed[0] : `${failed.length} cards`}: open ${failed.length === 1 ? "it" : "them"} in Review all.`);
    if (busy) parts.push(`${plural(busy, "card")} still saving, so left where ${busy === 1 ? "it is" : "they are"}.`);
    setNotice(parts.filter(Boolean).join(" ") || "Nothing to move.");
  };
  /** Clear the list: the strip starts again; the cards stay in the collection. */
  const clearList = async () => {
    const { afterClear } = await scanner();
    const kept = afterClear(listRef.current);
    const cleared = listRef.current.length - kept.length;
    put(kept);
    setNotice(kept.length ? `Cleared ${plural(cleared, "card")}. ${plural(kept.length, "card")} not saved yet stay${kept.length === 1 ? "s" : ""} in the list.` : null);
  };
  /** Cards this session put somewhere other than the box chosen now, for "Move them here". */
  const elsewhere = added.filter((a) => a.copies > 0 && a.container !== (container || null)).reduce((n, a) => n + a.copies, 0);

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
      {/* A box chosen after scanning into another: the cards so far can follow it. */}
      {elsewhere > 0 && (
        <div className="scan-clear">
          <Button size="small" variant="outline" disabled={moving} onClick={() => void moveAll(container || null)}>
            {moving ? "Moving…" : `Move the ${plural(elsewhere, "card")} scanned so far ${container ? `into ${filedIn}` : "out of their box"}`}
          </Button>
        </div>
      )}
      {notice && <p className="scan-note" role="status">{notice}</p>}
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
  const controls = error || notice ? (
    <>
      {notice && <p className="scan-note" role="status">{notice}</p>}
      <ErrorText error={error} />
    </>
  ) : null;
  // Removed (its copies taken back out): the large view has nothing left to show.
  // The card opened large from the scanner's strip (or the Added list); gone once removed.
  const { entry: openedEntry, open: setOpened, close: closeOpened } = useOpenedEntry(added);
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
          paused={reviewing || closing || openedEntry != null}
          recentCards={added.map((a) => ({ key: a.key, name: a.name, set: a.set, number: a.number, finish: a.finish, copies: a.copies, prices: a.prices, image: a.image, oracleId: a.oracle_id, state: entryState(a) }))}
          entryOf={(c) => filedAs.current.get(c)}
          onOpenCard={setOpened}
          finish={finish}
          onPrinting={setPrinting}
          controls={controls}
          settings={settings}
          settingsSummary={settingsSummary}
          acceptLabel="Add and scan next"
          onClear={() => void clearList()}
          clearNote="The cards stay in your collection."
        />
        {reviewing && (
          <Dialog onClose={() => setReviewing(false)} label="Added while scanning">
            <AddedList
              added={added}
              onFix={fix}
              onRetry={retry}
              onClose={() => setReviewing(false)}
              onOpen={(a) => setOpened(a.key)}
              actions={<MoveAllBar containers={containers} chosen={container} moving={moving} notice={notice} count={added.reduce((n, a) => n + a.copies, 0)} onMove={(to) => void moveAll(to)} onClear={() => void clearList()} />}
            />
          </Dialog>
        )}
        {openedEntry && (
          <Dialog onClose={closeOpened} label={openedEntry.name} className="scan-big-sheet">
            <ScannedCard a={openedEntry} onFix={fix} onRetry={retry} onClose={closeOpened} />
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

/**
 * At the top of the Added list: move every card added this session into one box, or clear the list
 * (the cards stay in the collection). The box offered first is the one chosen in Scan settings.
 */
function MoveAllBar({ containers, chosen, moving, notice, count, onMove, onClear }: { containers: Container[]; chosen: string; moving: boolean; notice: string | null; count: number; onMove: (to: string | null) => void; onClear: () => void }) {
  const [to, setTo] = useState(chosen);
  if (count === 0) return notice ? <p className="scan-note" role="status">{notice}</p> : null;
  return (
    <div className="scan-move-all">
      <div className="row">
        <Field label="Move all to">
          <select value={to} onChange={(e) => setTo(e.target.value)} disabled={moving}>
            <option value="">Not filed anywhere</option>
            {treeOrder(containers).map((c) => <option key={c.id} value={c.id}>{optionLabel(c, containers)}</option>)}
          </select>
        </Field>
        <Button variant="primary" disabled={moving} onClick={() => onMove(to || null)}>
          {moving ? "Moving…" : `Move ${plural(count, "card")}`}
        </Button>
        <Button variant="quiet" disabled={moving} onClick={onClear}>
          Clear the list
        </Button>
      </div>
      <p className="dim small">Moves only the copies added here. Clearing starts the list again; the cards stay in your collection.</p>
      {notice && <p className="scan-note" role="status">{notice}</p>}
    </div>
  );
}

/** An entry's state for its tile in the scanner's strip: its add not saved, a change to it not saved, or on its way. */
function entryState(a: Added): RecentCard["state"] {
  if (!a.pending) return undefined;
  if (!a.pending.error) return "saving";
  return a.pending.fix ? "change-failed" : "failed";
}
