import { planHref } from "../plan/href";
import { CardHover, CardRef } from "../components/CardRef";
import { BuylistReferences, DeckPrices, neededCost, SinglesPrice } from "../components/DeckPrices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bottom, draw, expandDeck, GROUP_ORDER, groupOf, identityName, listText, newHand, rng, type Goldfish } from "@yama/core";
import { deckCounts, deckLogs, swapSource, swapStatus, type PlanDeck, type Swap } from "@yama/core/plan";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
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
import { ArtPanel, ArtCredits, artCredit, artCredits } from "../components/ArtPanel";
import { NameList, OnlineSupport } from "../components/OnlineSupport";
import { day } from "../components/Rulings";
import { BRACKETS, BracketChips, BracketPanel } from "../components/Bracket";
import { DeckAnalysisPanel } from "../decks/DeckAnalysis";
import { SENDS_LIST } from "../components/deckCheck";
import { DeckStatsPanel } from "../components/DeckStats";
import { DeckExport } from "../components/DeckExport";
import { DeckHistoryBody } from "../components/DeckHistory";
import { PageTabs } from "../components/SectionTabs";
import { DeckResults } from "../components/DeckResults";
import { AskClaudeButton, AskClaudeSheet, useAskClaudeOffered } from "../advisor/AskClaude";
import { MenuSeparator, MoreMenu } from "../components/MoreMenu";
import { ChangesBanner } from "../advisor/Changes";
import { CardSheet } from "./Cards";
import { CollectSheet } from "../decks/CollectSheet";
import { DeleteDeck, deleteWording } from "../decks/DeleteDeck";
import { NewConfiguration, ShareDeck } from "../decks/ShareDeck";
import { MythicSend, MythicSendButton } from "../bridges/mythic/MythicDeck";
import { legacyConfiguration, configurationLabel } from "../decks/buildCatalog";
import { placesText } from "../decks/checkTargets";
import { groupConfigurations } from "../decks/configurations";
import { DeckLists } from "../decks/DeckLists";
import { DeckTextList, type TextDrafts } from "../decks/DeckTextList";
import { DeckPriceList } from "../decks/DeckPriceList";
import { PlaygroupBuilds } from "../decks/PlaygroupBuilds";

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
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
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
          <p>No decks yet.</p>
          <Link className="button primary" to="/decks/import">Add a deck</Link>
        </div>
      )}
      <ul className="deck-tiles">
        {/* Configurations and bracket builds live on the deck's own page, not under its tile. */}
        {groupConfigurations(decks.data ?? []).map(({ main }) => (
          <li key={main.id}>
            <DeckTile d={main} />
          </li>
        ))}
      </ul>
      {!!decks.data?.some((d) => d.commander_image) && (
        <ArtCredits artists={decks.data.filter((d) => d.commander_image).map((d) => d.commander_artist)} />
      )}
    </main>
  );
}

const SHARED_LABEL: Record<string, string> = { link: "Shared by link", public: "Public" };

function DeckTile({ d }: { d: DeckSummary }) {
  const own = d.acquisition_status === "planned" ? null : ownership(d.owned, d.card_count, d.proxies ?? 0);
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
          {d.acquisition_status === "planned" ? <span>Planned deck</span> : own ? (
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

/** How many cards a collapsed stack shows before "Show all". */
const STACK_PEEK = 6;

type Layout = "stacks" | "list" | "prices" | "text";

export function DeckPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Switching to another configuration of the same deck keeps this one on screen until the
  // other arrives, instead of an empty page; everything but the switcher is inert meanwhile
  // (the hero's actions, the whole body, the action bar), so nothing acts on the deck just left.
  const deck = useQuery({
    queryKey: ["deck", id],
    queryFn: ({ signal }) => api<DeckView>(`/api/decks/${id}`, { signal }),
    placeholderData: (prev) => (prev?.configurations.some((c) => c.id === id) ? prev : undefined),
  });
  const prefetch = (other: string) => void qc.prefetchQuery({ queryKey: ["deck", other], queryFn: ({ signal }) => api<DeckView>(`/api/decks/${other}`, { signal }), staleTime: 30_000 });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const [view, setView] = useState<"all" | "needed">("all");
  const textDrafts = useRef<TextDrafts>(new Map());
  const [layout, setLayoutState] = useState<Layout>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("yama.deck.layout");
    } catch {
      // Storage blocked: start from the default.
    }
    if (saved === "stacks" || saved === "list" || saved === "text" || saved === "prices") return saved;
    return window.matchMedia("(min-width: 900px)").matches ? "stacks" : "list";
  });
  const setLayout = (l: Layout) => {
    if (l === "text" || l === "prices") setView("all");
    try {
      localStorage.setItem("yama.deck.layout", l);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
    setLayoutState(l);
  };
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeckEntry | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const [goldfish, setGoldfish] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [mythic, setMythic] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const askOffered = useAskClaudeOffered();
  // "?collect=1": the end of a deck import offers to add its cards to the collection.
  const [search, setSearch] = useSearchParams();
  // The deck's sections are tabs (design/tokens.md, rule 4; deck page SPEC): Cards at /decks/:id,
  // Stats and History at /decks/:id/stats and /history, so links and Back land on the same tab.
  const { pathname } = useLocation();
  const tab = (["stats", "history"] as const).find((t) => pathname.endsWith(`/${t}`)) ?? "cards";
  const tabHref = (t: string) => `/decks/${id}${t === "cards" ? "" : `/${t}`}${search.size ? `?${search}` : ""}`;
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
    setSharing(false);
    setMythic(false);
    setConfiguring(false);
    setDeleting(false);
    setAsking(false);
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
  const stats = d.acquisition_status === "planned" ? <span className="deck-stat"><b>Planned</b><span>Deck not acquired</span></span> : (
    <>
      <span className="deck-stat">
        <b className="num">{o.owned}/{o.cards}</b>
        <span>real cards</span>
      </span>
      {proxies > 0 && (
        <span className="deck-stat">
          <b className="num">{proxies}</b>
          <span>{proxies === 1 ? "proxy" : "proxies"} standing in</span>
        </span>
      )}
      <span className="deck-stat">
        <b className="num">{o.needed ? usd(neededCost(o)) : "Complete"}</b>
        <span>
          {o.needed ? `${o.needed} missing, basics excluded` : "Cards accounted for"}
          {o.needed_without_price > 0 ? `; ${o.needed_without_price} unpriced` : ""}{o.needed > 0 ? `. ${priced}` : ""}
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
  // More, a floating menu (design/tokens.md, rule 2): the cards, the list and sending it, then delete.
  const moreActions = <>
    <Link className="button" to={`/decks/${d.id}/scan`}>Scan cards</Link>
    <Link className="button" to={`/decks/${d.id}/check`}>Check cards</Link>
    <button onClick={() => setCollecting(true)}>Add to collection</button>
    <MenuSeparator />
    <button onClick={() => setConfiguring(true)}>New configuration</button>
    <button onClick={() => setExporting(true)}>Export</button>
    <MythicSendButton className="" onClick={() => setMythic(true)} />
    {askOffered && <AskClaudeButton onClick={() => setAsking(true)} />}
    <MenuSeparator />
    <button onClick={() => setEditing(true)}>Deck settings</button>
    <button className="deck-delete" onClick={() => setDeleting(true)}>{deleteWording(d).action}</button>
  </>;
  const actions = <>
    <button className="primary" onClick={() => navigate("/", { state: { deckId: d.id } })}>Play</button>
    <button className="on-art" onClick={() => setGoldfish(true)}>Sample hand</button>
    <Link className="button on-art" to={`/decks/import?deck=${d.id}`}>Update from a list</Link>
    <button className="on-art" onClick={() => setSharing(true)}>Share</button>
    <MoreMenu className="on-art">{moreActions}</MoreMenu>
  </>;
  const legal = v.ok ? <span className="pill good deck-legal-pill">Commander-legal</span> : <span className="pill bad deck-legal-pill">Not legal yet</span>;
  const planLink = plan && (
    <Link to={planHref(plan.deck.key)} className="deck-plan-link">
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
          <h1 className="hero-title">{d.parent_id ? d.configurations.find((c) => c.id === d.parent_id)?.name ?? d.name : d.name}</h1>
          {d.configurations.length > 1 && (
            <nav className="hero-configs" aria-label="Configurations of this deck" aria-busy={deck.isPlaceholderData}>
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

                    {loading && <span className="hero-configs-loading">, opening…</span>}
                  </Link>
                );
              })}
              {d.configurations.some((c, i) => i > 0 && legacyConfiguration(c.configuration)) && (
                <details className="hero-configs-legacy" open={legacyConfiguration(d.configuration)}>
                  <summary>Older snapshots</summary>
                  <div className="hero-configs-legacy-list">
                    {d.configurations.filter((c, i) => i > 0 && legacyConfiguration(c.configuration)).map((c) => (
                      <Link
                        key={c.id}
                        className="on-art"
                        to={`/decks/${c.id}`}
                        aria-current={c.id === (deck.isPlaceholderData ? id : d.id) ? "page" : undefined}
                        onMouseEnter={() => prefetch(c.id)}
                        onFocus={() => prefetch(c.id)}
                      >
                        {c.configuration ?? c.name}
                        {deck.isPlaceholderData && c.id === id && <span className="hero-configs-loading">, opening…</span>}
                      </Link>
                    ))}
                  </div>
                </details>
              )}
            </nav>
          )}
          <div className="hero-row">
            <div className="hero-stats">{stats}</div>
            <div className="hero-actions" inert={deck.isPlaceholderData}>{actions}</div>
          </div>
        </div>
      </ArtPanel>

      <div className="page deck-body" inert={deck.isPlaceholderData} aria-busy={deck.isPlaceholderData}>
        {d.buylist && <BuylistReferences b={d.buylist} />}
        {/* Phones: three figure tiles, the plan, then the other actions. */}
        <div className="deck-stats-tiles">
          {d.acquisition_status === "planned" ? <span className="deck-stat"><b>Planned</b><span>Deck not acquired</span></span> : <>
          <span className="deck-stat">
            <b className="num">{o.owned}</b>
            <span>{proxies ? `of ${o.cards} real, ${proxies} ${proxies === 1 ? "proxy" : "proxies"}` : `of ${o.cards} owned`}</span>
          </span>
          <span className="deck-stat">
            <b className="num">{o.needed ? usd(neededCost(o)) : "Complete"}</b>
            <span>{o.needed ? `for the last ${o.needed}${priceDay ? `, ${priceDay}` : ""}` : "Cards accounted for"}</span>
          </span>
          <span className="deck-stat">
            <b className="num">{summary?.games ? `${summary.wins ?? 0}–${losses}` : "0"}</b>
            <span>{summary?.games ? "in Yama games" : "games played"}</span>
          </span>
          </>}
        </div>
        {d.acquisition_status !== "planned" && o.needed > 0 && (
          <p className="deck-price-note phone-only">
            To finish: basics excluded{o.needed_without_price > 0 ? `, ${o.needed_without_price} with no price` : ""}. {priced}.
          </p>
        )}
        {planLink && <div className="phone-only deck-plan-phone">{planLink}</div>}
        <div className="row deck-actions-phone">
          <Link className="button outline" to={`/decks/import?deck=${d.id}`}>Update from a list</Link>
          <button className="outline" onClick={() => setSharing(true)}>Share</button>
          <MoreMenu className="outline">{moreActions}</MoreMenu>
        </div>

        {/* The status row: legality, the plan for this deck, and its simulated strength. */}
        <div className={`deck-status${plan ? " has-plan" : ""}`}>
          {legal}
          {planLink && <span className="wide-only deck-plan-wide">{planLink}</span>}
          {plan?.sim && <span className="deck-sim">{plan.sim}</span>}
        </div>
        {!v.ok && <ul className="small deck-errors">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        <DeckLists deck={d} />
        <PlaygroupBuilds deckId={d.id} />

        {editing && <EditDeck deck={d} onClose={() => setEditing(false)} onDelete={() => { setEditing(false); setDeleting(true); }} />}
        {deleting && <DeleteDeck deck={d} onClose={() => setDeleting(false)} />}
        {asking && askOffered && <AskClaudeSheet context={{ kind: "deck", ref: d.id }} about={d.name} ideasFor={plan?.deck.key ?? null} onClose={() => setAsking(false)} />}
        {goldfish && <SampleHand deck={d} art={commander?.image_art_crop ?? null} artist={commander?.artist ?? null} onClose={() => setGoldfish(false)} />}
        {exporting && <DeckExport deck={d} onClose={() => setExporting(false)} />}
        {sharing && <ShareDeck deck={d} onClose={() => setSharing(false)} />}
        {mythic && <MythicSend deck={d} onClose={() => setMythic(false)} />}
        {configuring && <NewConfiguration deck={d} onClose={() => setConfiguring(false)} />}
        {collecting && <CollectSheet deckId={d.id} offer={offer} onClose={closeCollect} />}

        <PageTabs
          tabs={[
            { id: "cards", label: "Cards", note: o.cards },
            { id: "stats", label: "Stats" },
            { id: "history", label: "History" },
          ]}
          current={tab}
          hrefFor={tabHref}
          label="Deck sections"
        />

        {tab === "cards" && (<>
        <div className="deck-toolbar">
          {layout !== "text" && layout !== "prices" && <div className="deck-show" role="tablist" aria-label="Show">
            <button role="tab" aria-selected={view === "all"} onClick={() => setView("all")}>Whole deck</button>
            <button role="tab" aria-selected={view === "needed"} onClick={() => setView("needed")}>Still need {o.needed}</button>
          </div>}
          <div className="deck-layout" role="group" aria-label="View">
            <button aria-pressed={layout === "stacks"} onClick={() => setLayout("stacks")}>Stacks</button>
            <button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
            <button aria-pressed={layout === "prices"} onClick={() => setLayout("prices")}>Prices</button>
            <button aria-pressed={layout === "text"} onClick={() => setLayout("text")}>Text</button>
          </div>
        </div>

        {groups.length === 0 && layout !== "prices" && <p className="empty">Nothing left to get for this deck.</p>}

        <div hidden={layout !== "text"}><DeckTextList key={d.id} deck={d} drafts={textDrafts.current} /></div>
        {layout === "prices" && <DeckPriceList key={d.id} deck={d} onOpen={setOpen} />}
        {layout === "text" || layout === "prices" ? null : layout === "stacks" ? (
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
          </>
        )}

        </>)}

        {/* Stats: everything about the deck that isn't the list (design: the deck's Stats tab). */}
        {tab === "stats" && (
        <section className="deck-more" aria-label="Stats">
          <details className="deck-value-details"><summary>Market value and card inventory</summary><DeckPrices singles={d.singles_value} ownership={o} /></details>
          <div className="deck-legal">
            <p className="dim small">
              {v.ok ? "Commander-legal" : "Not legal yet"} by size, singleton, color identity and the ban list in our card data.
            </p>
            {v.warnings.length > 0 && <ul className="small dim">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {!!v.prerelease?.length && <ul className="small dim">{v.prerelease.map((p) => <li key={p}>{p}</li>)}</ul>}
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
            {d.reserved_list ? (
              <div>
                <p>
                  <b>Reserve List: {d.reserved_list.length} {d.reserved_list.length === 1 ? "card" : "cards"}</b>
                  {d.reserved_list_as_of && <span className="as-of"> Scryfall's data as of {day(d.reserved_list_as_of)}</span>}
                </p>
                {d.reserved_list.length > 0 && (
                  <p className="names"><NameList names={d.reserved_list} onCard={openByName} /></p>
                )}
                <p className="card-note">Cards Wizards has promised never to reprint. Being on the list says a card is scarce, not that it's strong, so the power level leaves it out.</p>
              </div>
            ) : (
              <div>
                <p><b>Reserve List: not checked yet</b></p>
                <p className="card-note">The Reserve List flags aren't loaded on this server yet. They come with the next card data import.</p>
              </div>
            )}
            <OnlineSupport deckId={d.id} versionId={d.version_id} onCard={openByName} />
          </div>

          <DeckAnalysisPanel deckId={d.id} versionId={d.version_id} cards={d.cards} onCard={openByName} />
          <BracketPanel
            deckId={d.id}
            versionId={d.version_id}
            declared={d.bracket}
            gameChangers={d.game_changers}
            onCard={openByName}
            onDeclare={() => setEditing(true)}
          />
          <DeckResults deckId={d.id} versionId={d.version_id} />
          <DeckStatsPanel cards={d.cards} />
        </section>
        )}
        {tab === "history" && <section className="deck-history-tab" aria-label="History"><DeckHistoryBody deckId={d.id} currentVersionId={d.version_id} /></section>}
        {tab === "cards" && <details className="deck-sources small dim"><summary>Art credits and price source</summary>{listArtists.some(Boolean) && <p>{artCredits(listArtists)}</p>}<p>Cheapest printing per copy. {priced}.</p></details>}
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
    const all = Object.entries(e.locations).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", ");
    return <span className={`${cls} dim`} title={all}>Own {e.owned}: {placesText(e.locations)}</span>;
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

function EditDeck({ deck, onClose, onDelete }: { deck: DeckView; onClose: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }) });
  // The bracket panel has already asked whether this server sends lists to Spellbook.
  const checksOn = qc.getQueryData<DeckCheck>(["deck-check", deck.id, deck.version_id])?.enabled === true;
  const [name, setName] = useState(deck.name);
  const [acquired, setAcquired] = useState(deck.acquisition_status ?? "");
  const [container, setContainer] = useState(deck.container_id ?? "");
  const [bracket, setBracket] = useState(deck.bracket == null ? "" : String(deck.bracket));
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
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
          ...(!deck.parent_id && !parent ? { acquisition_status: acquired || null } : {}),
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
        {!deck.parent_id && <label>Deck ownership
          <select value={acquired} onChange={(e) => setAcquired(e.target.value as typeof acquired)}>
            <option value="">Not recorded</option><option value="owned">Owned</option><option value="planned">Planned, not acquired</option>
          </select>
          <span className="hint">Card inventory is tracked separately in Collection.</span>
        </label>}
        <label>
          Bracket
          {checksOn && <span className="hint">{SENDS_LIST}</span>}
          <select value={bracket} onChange={(e) => setBracket(e.target.value)}>
            <option value="">Not declared</option>
            {BRACKETS.map((b) => <option key={b.value} value={b.value}>{b.value}, {b.name}</option>)}
          </select>
        </label>
        <label>
          Configuration of
          <span className="hint">
            {hasConfigs
              ? "This deck has configurations of its own."
              : "Keeps its own versions, games and sharing."}
          </span>
          <select value={parent} onChange={(e) => setParent(e.target.value)} disabled={hasConfigs}>
            <option value="">None, it's a main deck</option>
            {mains.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>
          Configuration name
          <input value={configuration} onChange={(e) => setConfiguration(e.target.value)} maxLength={60} placeholder={parent ? "Stock, Bracket 2…" : "Current"} />
        </label>
        <label>
          Collection box
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            <option value="">None</option>
            {containers.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
          </select>
        </label>
        <label>
          Deck list
          <span className="hint">
            Keep the Commander and Deck headings. Saving keeps earlier versions in History. <Link to={`/decks/import?deck=${deck.id}`}>Import an updated list</Link>
          </span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: "18rem" }} />
        </label>
        <label>
          What changed
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Swapped Cultivate for Three Visits" />
        </label>
        {unknown.length > 0 && <p className="error small">Not found: {unknown.join(", ")}</p>}
        <ErrorText error={save.error} />
        <div className="row">
          <button className="primary" disabled={save.isPending}>Save changes</button>
          <button type="button" className="outline deck-delete" onClick={onDelete}>
            {deleteWording(deck).action}
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
        <p className="small dim hand-note">First mulligan free. Card images from Scryfall, © Wizards of the Coast.</p>
      </div>
      <div className="hand-bar">
        <button className="primary" onClick={() => setG(draw(g))} disabled={g.toBottom > 0 || g.library.length === 0}>Draw</button>
        <button onClick={() => setG(deal(g.mulligans + 1))}>Mulligan</button>
        <button onClick={() => setG(deal(0))}>New hand</button>
      </div>
    </div>
  );
}
