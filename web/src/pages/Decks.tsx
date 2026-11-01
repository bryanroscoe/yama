import { CardHover, CardRef } from "../components/CardRef";
import { DeckPrices, neededCost, SinglesPrice } from "../components/DeckPrices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bottom, draw, expandDeck, GROUP_ORDER, groupOf, identityName, listText, newHand, rng, type Goldfish } from "@yama/core";
import { deckCounts, deckLogs, swapSource, swapStatus, type PlanDeck, type Swap } from "@yama/core/plan";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { api, priceSource, shortDate, usd, type Container, type DeckCard, type DeckCheck, type DeckEntry, type DeckSummary, type DeckView } from "../api";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { Crop } from "../components/Crop";
import { CardImage, ErrorText, Pips, Sheet } from "../components/ui";
import { pct } from "../lab/logic";
import { pairedFor, simShort, useRuns } from "../lab/paired";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView, type PlanView } from "../plan/view";
import "./decks.css";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { NameList, OnlineSupport } from "../components/OnlineSupport";
import { day } from "../components/Rulings";
import { BRACKETS, BracketChips, BracketPanel } from "../components/Bracket";
import { SENDS_LIST } from "../components/deckCheck";
import { DeckStatsPanel } from "../components/DeckStats";
import { DeckExport } from "../components/DeckExport";
import { DeckHistory } from "../components/DeckHistory";
import { DeckResults } from "../components/DeckResults";
import { AskClaude } from "../advisor/AskClaude";
import { ChangesBanner } from "../advisor/Changes";
import { CardSheet } from "./Cards";
import { CollectSheet } from "../decks/CollectSheet";
import { NewConfiguration, ShareDeck } from "../decks/ShareDeck";
import { legacyConfiguration, configurationLabel } from "../decks/buildCatalog";
import { groupConfigurations } from "../decks/configurations";
import { DeckLists } from "../decks/DeckLists";

/** "Own 87 of 100" (still short: warn) or "Own all 100" (good), and the phone tile's "Need 13" or
 *  "Complete". A proxy covers a card for play, so a deck of real cards and proxies is complete;
 *  the text then says how many are real and how many proxies: "90 real, 10 proxies". */
function ownership(owned: number | undefined, total: number, proxies = 0): { text: string; short: string; tone: "good" | "warn" } | null {
  if (owned === undefined) return null;
  const have = owned + proxies;
  const px = proxies === 1 ? "1 proxy" : `${proxies} proxies`;
  if (have >= total) {
    return proxies > 0
      ? { text: `${owned} real, ${px}`, short: "Complete", tone: "good" }
      : { text: `Own all ${total}`, short: "Complete", tone: "good" };
  }
  return {
    text: proxies > 0 ? `${owned} real, ${px}, need ${total - have}` : `Own ${owned} of ${total}`,
    short: `Need ${total - have}`,
    tone: "warn",
  };
}

/** "6 wins, 3 losses" from finished games with the deck, or "Not played yet". */
function record(d: Pick<DeckSummary, "games" | "wins" | "draws">): string | null {
  if (d.games === undefined) return null;
  if (!d.games) return "Not played yet";
  const wins = d.wins ?? 0;
  const draws = d.draws ?? 0;
  const losses = d.games - wins - draws;
  const parts = [`${wins} ${wins === 1 ? "win" : "wins"}`, `${losses} ${losses === 1 ? "loss" : "losses"}`];
  if (draws) parts.push(`${draws} ${draws === 1 ? "draw" : "draws"}`);
  return parts.join(", ");
}

export function DecksPage() {
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  // "Start a deck" on a precon (older links to /decks?precon=…) opens the import page with its stock list.
  const [params] = useSearchParams();
  const precon = params.get("precon");
  if (precon) return <Navigate to={`/decks/import?precon=${encodeURIComponent(precon)}`} replace />;
  return (
    <main className="page">
      <AreaHead
        index
        title="Decks"
        action={
          <Link className="button primary" aria-label="Add a deck" to="/decks/import">
            <span className="wide-only">Add a deck</span>
            <span className="phone-only">Add</span>
          </Link>
        }
      />
      <ChangesBanner />
      <ErrorText error={decks.error} />
      {decks.data?.length === 0 && (
        <div className="empty">
          <p>No decks yet. Bring one in from Moxfield, Archidekt, MTG Arena, MTGO, ManaBox, a file or a typed list.</p>
          <Link className="button primary" to="/decks/import">Add a deck</Link>
        </div>
      )}
      <ul className="deck-tiles">
        {groupConfigurations(decks.data ?? []).map(({ main, configurations }) => (
          <li key={main.id} className={configurations.length ? "has-configs" : undefined}>
            <DeckTile d={main} />
            <div className="deck-configs"><Link to={`/decks/builds?savedDeck=${encodeURIComponent(main.id)}`}>[2] / [3] / [4] builds and swap cards</Link></div>
            {configurations.length > 0 && <ConfigurationList main={main} configurations={configurations} />}
          </li>
        ))}
      </ul>
      {!!decks.data?.some((d) => d.commander_image) && (
        <p className="small dim art-credits">{artCredits(decks.data.filter((d) => d.commander_image).map((d) => d.commander_artist))}</p>
      )}
    </main>
  );
}

const SHARED_LABEL: Record<string, string> = { link: "Shared by link", public: "Public" };

function DeckTile({ d }: { d: DeckSummary }) {
  const own = ownership(d.owned, d.card_count, d.proxies ?? 0);
  const played = record(d);
  return (
    <Link to={`/decks/${d.id}`} className="deck-tile">
      {/* One credit line for every tile's art sits under the grid. */}
      <ArtPanel art={d.commander_image} artist={d.commander_artist} wash="bottom" empty={!d.commanders.length} credit={false}>
        <Pips identity={d.color_identity} />
        <span className="deck-tile-name">{d.name}</span>
        <span className="deck-tile-meta deck-tile-cmdr">{d.commanders.join(" and ") || "No commander set"}</span>
        {(d.bracket != null || d.estimate) && (
          <span className="deck-tile-meta deck-tile-bracket">
            <BracketChips declared={d.bracket} estimate={d.estimate} />
          </span>
        )}
        <span className="deck-tile-meta"><SinglesPrice value={d.singles_value} /></span>
        <span className="deck-tile-foot num">
          {own ? (
            <span className={`deck-own ${own.tone}`}>
              <span className="wide-only">{own.text}</span>
              <span className="phone-only">{own.short}</span>
            </span>
          ) : (
            <span>{d.card_count} cards</span>
          )}
          {played && <span className="deck-record">{played}</span>}
          {SHARED_LABEL[d.visibility] && <span className="deck-shared">{SHARED_LABEL[d.visibility]}</span>}
        </span>
      </ArtPanel>
    </Link>
  );
}

/** A main deck's configurations as a row of links under its tile, always in view: the main
 *  list first, then the others, each with how close it is to complete. */
function ConfigurationList({ main, configurations }: { main: DeckSummary; configurations: DeckSummary[] }) {
  const qc = useQueryClient();
  const prefetch = (id: string) => void qc.prefetchQuery({ queryKey: ["deck", id], queryFn: () => api<DeckView>(`/api/decks/${id}`), staleTime: 30_000 });
  return (
    <nav className="deck-configs" aria-label={`Configurations of ${main.name}`}>
      <ul className="deck-configs-list">
        {[main, ...configurations.filter((c) => !legacyConfiguration(c.configuration))].map((c, i) => {
          const own = ownership(c.owned, c.card_count, c.proxies ?? 0);
          const shared = SHARED_LABEL[c.visibility];
          return (
            <li key={c.id}>
              <Link
                to={`/decks/${c.id}`}
                onMouseEnter={() => prefetch(c.id)}
                onFocus={() => prefetch(c.id)}
                title={[own?.text, shared].filter(Boolean).join(". ") || undefined}
              >
                <b>{configurationLabel(c.configuration, c.name, i === 0)}</b>
                <span className="dim small">
                  {i === 0 ? "In the deck. " : ""}
                  {own ? own.short : `${c.card_count} cards`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {configurations.some((c) => legacyConfiguration(c.configuration)) && <details><summary>Legacy</summary><ul>{configurations.filter((c) => legacyConfiguration(c.configuration)).map((c) => <li key={c.id}><Link to={`/decks/${c.id}`}>{c.configuration ?? c.name}</Link></li>)}</ul></details>}
    </nav>
  );
}

/** How many cards a collapsed stack shows before "Show all". */
const STACK_PEEK = 6;

export function DeckPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Switching to another configuration of the same deck keeps this one on screen until the
  // other arrives, instead of an empty page; everything but the switcher is inert meanwhile
  // (the hero's actions, the whole body, the action bar), so nothing acts on the deck just left.
  const deck = useQuery({
    queryKey: ["deck", id],
    queryFn: () => api<DeckView>(`/api/decks/${id}`),
    placeholderData: (prev) => (prev?.configurations.some((c) => c.id === id) ? prev : undefined),
  });
  const prefetch = (other: string) => void qc.prefetchQuery({ queryKey: ["deck", other], queryFn: () => api<DeckView>(`/api/decks/${other}`), staleTime: 30_000 });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [view, setView] = useState<"all" | "needed">("all");
  const [layout, setLayoutState] = useState<"stacks" | "list">(() => {
    const saved = localStorage.getItem("yama.deck.layout");
    if (saved === "stacks" || saved === "list") return saved;
    return window.matchMedia("(min-width: 900px)").matches ? "stacks" : "list";
  });
  const setLayout = (l: "stacks" | "list") => {
    localStorage.setItem("yama.deck.layout", l);
    setLayoutState(l);
  };
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeckEntry | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const [goldfish, setGoldfish] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  // "?collect=1": the end of a deck import offers to add its cards to the collection.
  const [search, setSearch] = useSearchParams();
  const offer = search.get("collect") === "1";
  const [collecting, setCollecting] = useState(offer);
  const closeCollect = () => {
    setCollecting(false);
    if (offer) setSearch((cur) => {
      const next = new URLSearchParams(cur);
      next.delete("collect");
      return next;
    }, { replace: true });
  };
  const plan = useDeckPlan(deck.data?.id);
  // Another configuration: close any sheet opened on the one just left, so nothing saves to it.
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current === id) return;
    shownId.current = id;
    setCollecting(false);
    setEditing(false);
    setGoldfish(false);
    setExporting(false);
    setHistory(false);
    setSharing(false);
    setConfiguring(false);
    setOpen(null);
  }, [id]);

  const groups = useMemo(() => {
    const map = new Map<string, DeckEntry[]>();
    for (const e of deck.data?.cards ?? []) {
      if (view === "needed" && e.needed === 0) continue;
      const g = groupOf(e.board, e.card?.type_line);
      map.set(g, [...(map.get(g) ?? []), e]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!.sort((a, b) => (a.card?.cmc ?? 0) - (b.card?.cmc ?? 0) || a.name.localeCompare(b.name))] as const);
  }, [deck.data, view]);

  if (deck.error) return <main className="page"><ErrorText error={deck.error} /></main>;
  const d = deck.data;
  if (!d) return <main className="page" />;
  const v = d.validation;
  const o = d.ownership;
  const commanderEntries = d.cards.filter((e) => e.board === "commander");
  const commander = commanderEntries.find((e) => e.card?.image_art_crop)?.card;
  const summary = decks.data?.find((x) => x.id === d.id);
  const played = summary ? record(summary) : null;
  const priced = priceSource(o.price_date);
  const priceDay = shortDate(o.price_date);
  const shown = preview ?? commanderEntries[0] ?? d.cards[0] ?? null;
  const openByName = (name: string) => {
    const hit = d.cards.find((c) => c.name === name);
    if (hit) setOpen(hit.oracle_id);
  };
  const losses = summary?.games ? summary.games - (summary.wins ?? 0) - (summary.draws ?? 0) : 0;
  const listArtists = layout === "list" ? groups.flatMap(([, es]) => es.map((e) => (e.card?.image_art_crop ? e.card.artist : null))) : [];

  const proxies = o.proxies ?? 0;
  const stats = (
    <>
      <span className="deck-stat">
        <b className="num">{o.owned}/{o.cards}</b>
        <span>{o.owned === o.cards ? "real cards, all of them" : "real cards"}</span>
      </span>
      {proxies > 0 && (
        <span className="deck-stat">
          <b className="num">{proxies}</b>
          <span>{proxies === 1 ? "proxy" : "proxies"} standing in</span>
        </span>
      )}
      <span className="deck-stat">
        <b className="num">{o.needed ? usd(neededCost(o)) : "Done"}</b>
        <span>
          {o.needed ? `to get the last ${o.needed}, basics excluded` : "nothing left to get"}
          {o.needed_without_price > 0 ? `; ${o.needed_without_price} with no price` : ""}. {priced}
        </span>
      </span>
      {played && summary?.games ? (
        <span className="deck-stat">
          <b className="num">{summary.wins ?? 0}–{losses}</b>
          <span>{played} in Yama games</span>
        </span>
      ) : null}
    </>
  );
  const actions = (
    <>
      <button className="on-art" onClick={() => setGoldfish(true)}>Sample hand</button>
      <button className="on-art" onClick={() => setEditing(true)}>Edit deck</button>
      <Link className="button on-art" to={`/decks/import?deck=${d.id}`}>Update from a list</Link>
      <Link className="button on-art" to={`/decks/${d.id}/scan`}>Scan this deck</Link>
      <button className="on-art" onClick={() => setCollecting(true)}>Add to my collection</button>
      <button className="on-art" onClick={() => setSharing(true)}>Share</button>
      <button className="on-art" onClick={() => setExporting(true)}>Export</button>
      <button className="on-art" onClick={() => setHistory(true)}>History</button>
      <button className="on-art" onClick={() => setConfiguring(true)}>New configuration</button>
      <Link className="button on-art" to={`/decks/builds?savedDeck=${encodeURIComponent(d.id)}`}>[2] / [3] / [4] and swap cards</Link>
      <AskClaude className="on-art" context={{ kind: "deck", ref: d.id }} about={d.name} ideasFor={plan?.deck.key ?? null} />
      <button className="primary" onClick={() => navigate("/", { state: { deckId: d.id } })}>Play this deck</button>
    </>
  );
  const legal = v.ok ? <span className="pill good deck-legal-pill">Commander-legal</span> : <span className="pill bad deck-legal-pill">Not legal yet</span>;
  const planLink = plan && (
    <Link to={`/decks/plan/d/${plan.deck.key}`} className="deck-plan-link">
      <span className="deck-plan-text">
        <b>
          Plan: {plan.line}
          {plan.more && <span className="wide-only">, {plan.more}</span>}
        </b>
        <span className="phone-only">
          {d.bracket != null ? `Bracket ${d.bracket}, ` : ""}
          {v.ok ? "Commander-legal" : "not legal yet"}
        </span>
      </span>
      <span className="deck-plan-open wide-only">Open plan</span>
      <svg className="phone-only" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  );

  return (
    <main className="deck-page">
      <ArtPanel as="header" className="deck-hero" art={commander?.image_art_crop} artist={commander?.artist} wash="bottom" toGround credit={false}>
        <Link to="/decks" className="hero-back" aria-label="Back to decks">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          <span className="hero-back-text">Decks</span>
        </Link>
        {commander && (
          <span className="hero-credit">
            <span className="hero-credit-card">{commander.name}. </span>
            {artCredit(commander.artist)}.
          </span>
        )}
        <div className="hero-inner">
          <span className="hero-sub">
            <Pips identity={v.color_identity} />
            <span>
              {commanderEntries.map((e) => e.name).join(" and ") || "No commander set"}
              <span className="wide-only">
                . {identityName(v.color_identity)}
                {d.bracket != null ? `, bracket ${d.bracket}` : ""}
              </span>
            </span>
          </span>
          <h1 className="hero-title">{d.name}</h1>
          {d.configurations.length > 1 && (
            <nav className="hero-configs" aria-label="Configurations of this deck" aria-busy={deck.isPlaceholderData}>
              <span className="hero-configs-label">Configurations</span>
              {d.configurations.filter((c, i) => i === 0 || !legacyConfiguration(c.configuration)).map((c, i) => {
                const label = configurationLabel(c.configuration, c.name, i === 0);
                const loading = deck.isPlaceholderData && c.id === id;
                return (
                  <Link
                    key={c.id}
                    to={`/decks/${c.id}`}
                    className="on-art"
                    aria-current={c.id === (deck.isPlaceholderData ? id : d.id) ? "page" : undefined}
                    onMouseEnter={() => prefetch(c.id)}
                    onFocus={() => prefetch(c.id)}
                  >
                    {label}
                    {i === 0 ? ", in the deck" : ""}
                    {loading && <span className="hero-configs-loading">, opening…</span>}
                  </Link>
                );
              })}
              {d.configurations.some((c, i) => i > 0 && legacyConfiguration(c.configuration)) && <details open={legacyConfiguration(d.configuration)}><summary>Legacy</summary>{d.configurations.filter((c, i) => i > 0 && legacyConfiguration(c.configuration)).map((c) => <Link key={c.id} className="on-art" to={`/decks/${c.id}`}>{c.configuration ?? c.name}</Link>)}</details>}
            </nav>
          )}
          <div className="hero-row">
            <div className="hero-stats">{stats}</div>
            <div className="hero-actions" inert={deck.isPlaceholderData}>{actions}</div>
          </div>
        </div>
      </ArtPanel>

      <div className="page deck-body" inert={deck.isPlaceholderData} aria-busy={deck.isPlaceholderData}>
        <DeckPrices singles={d.singles_value} ownership={o} />
        {/* Phones: three figure tiles, the plan, then the other actions. */}
        <div className="deck-stats-tiles">
          <span className="deck-stat">
            <b className="num">{o.owned}</b>
            <span>{proxies ? `of ${o.cards} real, ${proxies} ${proxies === 1 ? "proxy" : "proxies"}` : `of ${o.cards} owned`}</span>
          </span>
          <span className="deck-stat">
            <b className="num">{o.needed ? usd(neededCost(o)) : "Done"}</b>
            <span>{o.needed ? `for the last ${o.needed}${priceDay ? `, ${priceDay}` : ""}` : "nothing to buy"}</span>
          </span>
          <span className="deck-stat">
            <b className="num">{summary?.games ? `${summary.wins ?? 0}–${losses}` : "0"}</b>
            <span>{summary?.games ? "in Yama games" : "games played"}</span>
          </span>
        </div>
        {o.needed > 0 && (
          <p className="deck-price-note phone-only">
            To finish: basics excluded{o.needed_without_price > 0 ? `, ${o.needed_without_price} with no price` : ""}. {priced}.
          </p>
        )}
        {planLink && <div className="phone-only deck-plan-phone">{planLink}</div>}
        <div className="row deck-actions-phone">
          <button className="outline" onClick={() => setEditing(true)}>Edit deck</button>
          <details className="deck-actions-more">
            <summary>More actions</summary>
            <div className="deck-extra-actions">
              <Link className="button outline" to={`/decks/import?deck=${d.id}`}>Update from a list</Link>
              <Link className="button outline" to={`/decks/${d.id}/scan`}>Scan this deck</Link>
              <button className="outline" onClick={() => setCollecting(true)}>Add to my collection</button>
              <button className="outline" onClick={() => setSharing(true)}>Share</button>
              <button className="outline" onClick={() => setExporting(true)}>Export</button>
              <button className="outline" onClick={() => setHistory(true)}>History</button>
              <button className="outline" onClick={() => setConfiguring(true)}>New configuration</button>
              <AskClaude className="outline" context={{ kind: "deck", ref: d.id }} about={d.name} ideasFor={plan?.deck.key ?? null} />
            </div>
          </details>
        </div>

        {/* The status row: legality, the plan for this deck, and its simulated strength. */}
        <div className={`deck-status${plan ? " has-plan" : ""}`}>
          {legal}
          {planLink && <span className="wide-only deck-plan-wide">{planLink}</span>}
          {plan?.sim && <span className="deck-sim">{plan.sim}</span>}
        </div>
        {!v.ok && <ul className="small deck-errors">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        <DeckLists deck={d} />

        {editing && <EditDeck deck={d} onClose={() => setEditing(false)} />}
        {goldfish && <SampleHand deck={d} art={commander?.image_art_crop ?? null} artist={commander?.artist ?? null} onClose={() => setGoldfish(false)} />}
        {exporting && <DeckExport deck={d} onClose={() => setExporting(false)} />}
        {sharing && <ShareDeck deck={d} onClose={() => setSharing(false)} />}
        {configuring && <NewConfiguration deck={d} onClose={() => setConfiguring(false)} />}
        {history && <DeckHistory deckId={d.id} currentVersionId={d.version_id} onClose={() => setHistory(false)} />}
        {collecting && <CollectSheet deckId={d.id} offer={offer} onClose={closeCollect} />}

        <div className="deck-toolbar">
          <div className="deck-show" role="tablist" aria-label="Show">
            <button role="tab" aria-selected={view === "all"} onClick={() => setView("all")}>Whole deck</button>
            <button role="tab" aria-selected={view === "needed"} onClick={() => setView("needed")}>Still need {o.needed}</button>
          </div>
          <div className="deck-layout" role="group" aria-label="View">
            <button aria-pressed={layout === "stacks"} onClick={() => setLayout("stacks")}>Stacks</button>
            <button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
          </div>
        </div>

        {groups.length === 0 && <p className="empty">Nothing left to get for this deck.</p>}

        {layout === "stacks" ? (
          <div className="deck-stacks-wrap">
            <div className="deck-stacks">
              {groups.map(([group, entries]) => {
                const count = entries.reduce((a, e) => a + e.qty, 0);
                const need = entries.reduce((a, e) => a + e.needed, 0);
                const all = expanded.has(group) || entries.length <= STACK_PEEK + 1;
                const cards = all ? entries : entries.slice(0, STACK_PEEK);
                return (
                  <section key={group} className="deck-stack" aria-label={group}>
                    <h2>
                      {group} <span className="deck-stack-meta num">{count}{need && view === "all" ? `, need ${need}` : ""}</span>
                    </h2>
                    <div className="stack-cards">
                      {cards.map((e) => (
                        <button
                          key={`${e.oracle_id}-${e.board}`}
                          className="stack-card"
                          onClick={() => setOpen(e.oracle_id)}
                          onMouseEnter={() => setPreview(e)}
                          onFocus={() => setPreview(e)}
                          aria-label={`${e.qty > 1 ? `${e.qty} ` : ""}${e.name}${e.needed > 0 ? `, need ${e.needed}` : ""}`}
                        >
                          <CardHover name={e.name} oracleId={e.oracle_id} image={e.card?.image_normal}><CardImage src={e.card?.image_normal} name={e.name}/></CardHover>
                          {/* Still needed: an amber dot just off the card's left edge, so the mana cost stays clear. */}
                          {e.needed > 0 && <span className="need-dot" aria-hidden="true" title={`Need ${e.needed}`} />}
                          {e.qty > 1 && <span className="qty-badge num">×{e.qty}</span>}
                        </button>
                      ))}
                    </div>
                    {entries.length > STACK_PEEK + 1 && (
                      <button
                        className="small stack-more"
                        onClick={() => setExpanded((cur) => {
                          const next = new Set(cur);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })}
                      >
                        {expanded.has(group) ? "Show fewer" : `Show all ${entries.length}`}
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
            {shown && (
              <aside className="deck-preview" aria-label="Card preview">
                <CardImage src={shown.card?.image_normal} name={shown.name} />
                <div className="deck-preview-facts">
                  <b><CardRef name={shown.name} oracleId={shown.oracle_id} image={shown.card?.image_normal}/></b>
                  <CardStatus e={shown} />
                  {shown.board !== "side" && (
                    <span>
                      {shown.cheapest_usd != null ? <>Cheapest {usd(shown.cheapest_usd)} </> : "No price "}
                      <span className="dim">{priced}</span>
                    </span>
                  )}
                  {plan && <PlanCardLine plan={plan} name={shown.name} />}
                </div>
              </aside>
            )}
          </div>
        ) : (
          <>
            {groups.map(([group, entries]) => (
              <section key={group} className="deck-group">
                <h2 className="deck-group-head">
                  {group} <span className="deck-stack-meta num">{entries.reduce((a, e) => a + e.qty, 0)}</span>
                </h2>
                <div className="deck-rows">
                  {entries.map((e) => (
                    <button key={`${e.oracle_id}-${e.board}`} className="deck-row" onClick={() => setOpen(e.oracle_id)}>
                      <Crop src={e.card?.image_art_crop} size="sm" />
                      <span className="deck-row-text">
                        <span className="deck-row-name">
                          {e.qty > 1 ? `${e.qty} ` : ""}
                          <CardHover name={e.name} oracleId={e.oracle_id} image={e.card?.image_normal}/>
                        </span>
                        <CardStatus e={e} small plan={plan} />
                      </span>
                      <span className="deck-row-state num">
                        {e.needed > 0 ? <span className="need">Need{e.needed > 1 ? ` ${e.needed}` : ""}</span> : <span className="have">Have</span>}
                        {e.needed > 0 && <span className="dim">{usd(e.cheapest_usd)}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {listArtists.some(Boolean) && <p className="small dim art-credits">{artCredits(listArtists)}</p>}
          </>
        )}
        <p className="small dim">
          Cheapest printing per copy. {priced}.
        </p>

        {/* Everything else about the deck, under the cards. */}
        <section className="deck-more" aria-label="More about this deck">
          <div className="deck-legal">
            <p className="dim small">
              {v.ok ? "Commander-legal" : "Not legal yet"} by size, singleton, color identity and the ban list in our card data.
            </p>
            {v.warnings.length > 0 && <ul className="small dim">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </div>

          <div className="deck-facts">
            {d.game_changers ? (
              <div>
                <p>
                  <b>Game Changers: {d.game_changers.length}</b>
                  {d.game_changers_as_of && <span className="as-of"> Scryfall's list as of {day(d.game_changers_as_of)}</span>}
                </p>
                {d.game_changers.length > 0 && (
                  <p className="names"><NameList names={d.game_changers} onCard={openByName} /></p>
                )}
              </div>
            ) : (
              <div>
                <p><b>Game Changers: not checked yet</b></p>
                <p className="card-note">The Game Changer list isn't loaded on this server yet. It comes with the next card data import.</p>
              </div>
            )}
            <OnlineSupport deckId={d.id} versionId={d.version_id} onCard={openByName} />
          </div>

          <BracketPanel
            deckId={d.id}
            versionId={d.version_id}
            declared={d.bracket}
            gameChangers={d.game_changers}
            cards={d.cards}
            onCard={openByName}
            onDeclare={() => setEditing(true)}
          />
          <DeckResults deckId={d.id} versionId={d.version_id} />
          <DeckStatsPanel cards={d.cards} />
        </section>
        {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} />}
      </div>

      {/* Phones: the two actions you reach for, kept above the tab bar. */}
      <div className="deck-actbar" inert={deck.isPlaceholderData}>
        <button onClick={() => setGoldfish(true)}>Sample hand</button>
        <button className="primary" onClick={() => navigate("/", { state: { deckId: d.id } })}>Play this deck</button>
      </div>
    </main>
  );
}

/** The plan linked to a Yama deck: its counts in a line, its swaps by card, and its simulated strength. */
interface DeckPlanInfo {
  deck: PlanDeck;
  view: PlanView;
  /** The first thing to do, and (laptops) the next. */
  line: string;
  more: string;
  swapsByIn: Map<string, Swap>;
  sim: string | null;
}

function useDeckPlan(deckId: string | undefined): DeckPlanInfo | null {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  const box = useOutbox(userId);
  const runs = useRuns(!!plan.bundle?.decks.some((p) => p.deck_id === deckId));
  return useMemo(() => {
    const deck = plan.bundle?.decks.find((p) => p.deck_id === deckId && p.status !== "archived");
    if (!plan.bundle || !deck || !userId) return null;
    const view = planView(plan.bundle, outbox.localOps(userId));
    const swaps = view.swapsOf(deck.key).filter((s) => !s.retired);
    const c = deckCounts(deck, swaps, view.answers, view.ctx.orders);
    const prints = c.printsOnOrder + c.printsNext;
    const parts: string[] = [];
    if (prints) parts.push(`${prints} ${prints === 1 ? "swap waits" : "swaps wait"} on prints`);
    if (c.planned - c.ready - prints > 0) parts.push(`${c.planned - c.ready - prints} more to get`);
    if (c.undecided) parts.push(`${c.undecided} ${c.undecided === 1 ? "proposal" : "proposals"} to review`);
    const line = parts[0] ?? (c.planned ? `all ${c.planned} swaps in hand` : "no swaps yet");
    const more = parts.slice(1, 2).join(", ");
    const swapsByIn = new Map(swaps.filter((s) => s.stage === "planned").map((s) => [s.in, s]));
    const paired = pairedFor(runs.data, deck.key);
    const now = paired?.versions.find((x) => x.state === "now");
    const after = paired?.versions.find((x) => x.state === "after");
    const sim =
      paired && (now || after)
        ? `Raw simulated win rate ${[now ? `${pct(now.variant.win_rate)} now` : null, after ? `${pct(after.variant.win_rate)} after prints` : null].filter(Boolean).join(", ")}. ${simShort(paired.run, paired.versions)}.`
        : null;
    return { deck, view, line, more, swapsByIn, sim };
    // `box` moves when a tap lands in the outbox, so the counts follow answers made here.
  }, [plan.bundle, box, deckId, userId, runs.data]);
}

/** What the plan says about one card of the deck, when it's one of the plan's swaps. */
function PlanCardLine({ plan, name }: { plan: DeckPlanInfo; name: string }) {
  const s = plan.swapsByIn.get(name);
  if (!s) return null;
  const status = swapStatus(s, deckLogs(plan.deck), plan.view.deckName, plan.view.ctx.orders);
  return (
    <span className="dim">
      In the plan{s.out ? ` for ${s.out}` : ""}
      {status ? `: ${status.label.charAt(0).toLowerCase()}${status.label.slice(1)}` : ""}. {swapSource(s, plan.view.ctx)}
    </span>
  );
}

/** Where your copies are, or that you still need it (in the warn color), with what the plan
 *  says about a card you don't own yet. */
function CardStatus({ e, small = false, plan }: { e: DeckEntry; small?: boolean; plan?: DeckPlanInfo | null }) {
  const cls = small ? "small" : "";
  if (e.owned > 0) {
    const where = Object.entries(e.locations).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", ");
    return <span className={`${cls} dim`}>Own {e.owned}: {where}</span>;
  }
  if (e.proxies > 0) return <span className={`${cls} dim`}>Proxy only</span>;
  const s = plan?.swapsByIn.get(e.name);
  const status = s && plan ? swapStatus(s, deckLogs(plan.deck), plan.view.deckName, plan.view.ctx.orders) : null;
  return (
    <span className={`${cls} not-owned`}>
      Not owned{status ? <span className="dim">. Plan: {status.label.charAt(0).toLowerCase()}{status.label.slice(1)}</span> : null}
    </span>
  );
}

function EditDeck({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const containers = useQuery({ queryKey: ["containers"], queryFn: () => api<Container[]>("/api/containers") });
  // The bracket panel has already asked whether this server sends lists to Spellbook.
  const checksOn = qc.getQueryData<DeckCheck>(["deck-check", deck.id, deck.version_id])?.enabled === true;
  const [name, setName] = useState(deck.name);
  const [container, setContainer] = useState(deck.container_id ?? "");
  const [bracket, setBracket] = useState(deck.bracket == null ? "" : String(deck.bracket));
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [parent, setParent] = useState(deck.parent_id ?? "");
  const [configuration, setConfiguration] = useState(deck.configuration ?? "");
  // A deck with configurations of its own stays a main deck; the others can go under a main deck.
  const hasConfigs = deck.configurations.length > 1 && !deck.parent_id;
  const mains = (decks.data ?? []).filter((x) => !x.parent_id && x.id !== deck.id);
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
      await api(`/api/decks/${deck.id}`, {
        method: "PATCH",
        json: {
          name,
          container_id: container || null,
          bracket: bracket ? Number(bracket) : null,
          configuration: configuration.trim() || null,
          ...(hasConfigs ? {} : { parent_id: parent || null }),
        },
      });
      if (listText(parsed.cards) !== listText(deck.cards)) {
        await api(`/api/decks/${deck.id}`, { method: "PUT", json: { cards: parsed.cards, note: note || null } });
      }
    },
    onSuccess: () => {
      // Every deck in its configuration group lists the group.
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions", deck.id] });
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
          Bracket
          <span className="hint">
            The bracket you'd tell the table before a game. Yama's starting suggestion from the card list is shown beside it and never changes it. Choose 1 for a deliberately theme-first deck; an unflagged card list starts provisionally at 2.
            {checksOn && ` ${SENDS_LIST}`}
          </span>
          <select value={bracket} onChange={(e) => setBracket(e.target.value)}>
            <option value="">Not declared</option>
            {BRACKETS.map((b) => <option key={b.value} value={b.value}>{b.value}, {b.name}</option>)}
          </select>
        </label>
        <label>
          Configuration of
          <span className="hint">
            {hasConfigs
              ? "This is a main deck with configurations of its own, so it stays one."
              : "Group this deck under another as one of its builds (stock, budget, high power). It keeps its own versions, games and sharing."}
          </span>
          <select value={parent} onChange={(e) => setParent(e.target.value)} disabled={hasConfigs}>
            <option value="">None, it's a main deck</option>
            {mains.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>
          Configuration name
          <span className="hint">{parent ? "How this build shows under its main deck." : "What this deck's own list is called beside its configurations; blank reads as Main."}</span>
          <input value={configuration} onChange={(e) => setConfiguration(e.target.value)} maxLength={60} placeholder={parent ? "stock" : "Main"} />
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
          <span className="hint">
            Keep the Commander and Deck headings. Saving makes a new version; older versions stay with the games they were played in. Got a newer
            list on Moxfield or Archidekt, or a file? <Link to={`/decks/import?deck=${deck.id}`}>Update from a list or file</Link> shows what changes first.
          </span>
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

function SampleHand({ deck, art, artist, onClose }: { deck: DeckView; art: string | null; artist: string | null; onClose: () => void }) {
  const library = useMemo(() => expandDeck(deck.cards), [deck]);
  const images = useMemo(() => new Map(deck.cards.map((c) => [c.name, c.card?.image_normal ?? null])), [deck]);
  const deal = (mulligans: number) => newHand(library, rng(crypto.getRandomValues(new Uint32Array(1))[0]!), mulligans);
  const [g, setG] = useState<Goldfish>(() => deal(0));
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    done.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const lands = g.hand.filter((c) => deck.cards.find((d) => d.name === c.name)?.card?.type_line.includes("Land")).length;
  return (
    <div className="hand-view" role="dialog" aria-modal="true" aria-label="Sample hand">
      <ArtPanel as="header" className="hand-head" art={art} artist={artist} wash="bottom" toGround>
        <span className="hand-title">
          <span className="hand-deck">{deck.name}</span>
          <span className="hand-name">Sample hand</span>
        </span>
        <button ref={done} className="primary hand-done" onClick={onClose}>Done</button>
      </ArtPanel>
      <div className="hand-body">
        <p className="hand-summary" aria-live="polite">
          {g.hand.length} cards, {lands} {lands === 1 ? "land" : "lands"}
          {g.mulligans ? `, mulligan ${g.mulligans}${g.mulligans === 1 ? " (the first is free)" : ""}` : ""}
          {g.drawn ? `, drawn ${g.drawn}` : ""}. {g.library.length} left in the library.
        </p>
        {g.toBottom > 0 && <p className="hand-bottom">Tap {g.toBottom === 1 ? "a card" : `${g.toBottom} cards`} to put on the bottom.</p>}
        <ul className="hand-cards" aria-label="Your hand">
          {g.hand.map((c, i) => (
            <li key={c.id}>
              <button onClick={() => setG(bottom(g, i))} disabled={g.toBottom === 0} aria-label={g.toBottom ? `Put ${c.name} on the bottom` : c.name}>
                <CardImage src={images.get(c.name)} name={c.name} />
              </button>
            </li>
          ))}
        </ul>
        <p className="small dim hand-note">The first mulligan is free, as in most Commander games. Card images from Scryfall, © Wizards of the Coast.</p>
      </div>
      <div className="hand-bar">
        <button className="primary" onClick={() => setG(draw(g))} disabled={g.toBottom > 0 || g.library.length === 0}>Draw</button>
        <button onClick={() => setG(deal(g.mulligans + 1))}>Mulligan</button>
        <button onClick={() => setG(deal(0))}>New hand</button>
      </div>
    </div>
  );
}
