import { SinglesPrice } from "../components/DeckPrices";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bottom, draw, expandDeck, newHand, rng, type Goldfish, plural, priceSource } from "@yama/core";
import { deckCounts, deckLogs, swapSource, swapStatus, type PlanDeck, type Swap } from "@yama/core/plan";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { api, type DeckEntry, type DeckSummary, type DeckView } from "../api";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { LoadFailed, queryFailure, RefreshFailed } from "../components/QueryError";
import { BackLink, Button, ButtonLink, CardImage, EmptyState, ErrorText, Pips, StatusPill, toneOf } from "../components/ui";
import { pct } from "../lab/logic";
import { pairedFor, simShort, useRuns } from "../lab/paired";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView, type PlanView } from "../plan/view";
import "./decks.css";
import { ArtPanel, ArtCredits, artCredit } from "../components/ArtPanel";
import { BracketChips } from "../components/Bracket";
import { useDeckAnalysis } from "../decks/DeckAnalysis";
import { DeckStatsTab } from "../decks/DeckStatsTab";
import { DeckExport } from "../components/DeckExport";
import { DeckHistoryBody, HistoryTabNote } from "../components/DeckHistory";
import { DeckPlanTab } from "../decks/DeckPlanTab";
import { planTabNote } from "../decks/deckPlanHub";
import { PageTabs } from "../components/SectionTabs";
import { AskClaudeButton, AskClaudeSheet, useAskClaudeOffered } from "../advisor/AskClaude";
import { MenuSeparator, MoreMenu } from "../components/MoreMenu";
import { ChangesBanner } from "../advisor/Changes";
import { CardSheet } from "./Cards";
import { CollectSheet } from "../decks/CollectSheet";
import { DeleteDeck, deleteWording } from "../decks/DeleteDeck";
import { NewConfiguration, ShareDeck } from "../decks/ShareDeck";
import { MythicSend, MythicSendButton } from "../bridges/mythic/MythicDeck";
import { placesText } from "../decks/checkTargets";
import { groupConfigurations } from "../decks/configurations";
import { arrangeDecks, folderOf, foldersOf, isFiltered, readFilter, writeFilter, type DeckFilter } from "../decks/deckIndex";
import { CLEARED, DeckIndexTools } from "../decks/DeckIndexTools";
import { DeckSettings } from "../decks/DeckSettings";
import { DeckAbout, EditDescription } from "../decks/DeckDescription";
import { Considering } from "../decks/Considering";
import { DeckTiles, deckStatus, ListPicker, SavedListBar } from "../decks/DeckHeader";
import { DeckCardsTab, useCardControls } from "../decks/DeckCardsTab";
import { WhyBracket } from "../decks/WhyBracket";
import { boxBracket, bracketSwaps, SwapPanel } from "../decks/BracketSwaps";
import { usePlaygroupVariants } from "../decks/PlaygroupBuilds";
import { useModalLayer } from "../components/Dialog";

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

/** "1 card", "100 cards": a deck tile's size when ownership isn't known. */
export function cardCount(n: number): string {
  return plural(n, "card");
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
  const [params, setParams] = useSearchParams();
  const precon = params.get("precon");
  // Folder, colors, bracket, search and sort (decks/deckIndex.ts), kept in the address.
  // By the address's own string, so a new params object for the same address isn't a new filter.
  const address = params.toString();
  const filter = useMemo(() => readFilter(new URLSearchParams(address)), [address]);
  const groups = useMemo(() => groupConfigurations(decks.data ?? []), [decks.data]);
  const mains = useMemo(() => groups.map((g) => g.main), [groups]);
  const folders = useMemo(() => foldersOf(mains), [mains]);
  const shown = useMemo(() => arrangeDecks(groups, filter), [groups, filter]);
  if (precon) return <Navigate to={`/decks/import?precon=${encodeURIComponent(precon)}`} replace />;
  // Once shown the tools stay, so clearing the search of a one-deck list doesn't take the box away mid-typing.
  const tools = useRef(false);
  if (groups.length > 1 || isFiltered(filter)) tools.current = true;
  // The router moves the address before React renders it. One change is laid over the filter the
  // address holds now, not the one last rendered, so quick typing never drops a letter and a
  // second change never puts back what the first one changed.
  const change = (patch: Partial<DeckFilter>, typing = false) => {
    const now = new URLSearchParams(window.location.search);
    setParams(writeFilter(now, { ...readFilter(now), ...patch }), { replace: typing });
  };
  return (
    <main className="page">
      <AreaHead
        index
        title="Decks"
        action={
          <ButtonLink variant="primary" aria-label="Add a deck" to="/decks/import">
            <span className="wide-only">Add a deck</span>
            <span className="phone-only">Add</span>
          </ButtonLink>
        }
      />
      <ChangesBanner />
      <ErrorText error={decks.error} />
      {decks.data?.length === 0 && (
        <EmptyState
          action={
            <>
              <ButtonLink variant="primary" to="/decks/import">Import a list</ButtonLink>
              <ButtonLink variant="outline" to="/lab">Start from a precon</ButtonLink>
            </>
          }
        >
          No decks yet.
        </EmptyState>
      )}
      {decks.data && tools.current && (
        <DeckIndexTools filter={filter} onChange={change} folders={folders} hasUnfiled={mains.some((d) => folderOf(d) === null)} shown={shown.length} total={groups.length} />
      )}
      {groups.length > 0 && shown.length === 0 && (
        <EmptyState variant="boxed" action={<Button onClick={() => change(CLEARED)}>Clear filters</Button>}>
          No decks match.
        </EmptyState>
      )}
      {/* Sorted by record, every tile shows its record, on a phone too. */}
      <ul className={`deck-tiles${filter.sort === "record" ? " by-record" : ""}`}>
        {/* Configurations and bracket builds live on the deck's own page, not under its tile. */}
        {shown.map(({ main }) => (
          <li key={main.id}>
            {/* The folder shows on each tile unless the list is already down to one folder. */}
            <DeckTile d={main} folder={filter.folder === null ? folderOf(main) : null} />
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

function DeckTile({ d, folder = null }: { d: DeckSummary; folder?: string | null }) {
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
            <span>{cardCount(d.card_count)}</span>
          )}
          {played && <span className="deck-record">{played}</span>}
          {folder && <span className="deck-folder">In {folder}</span>}
          {SHARED_LABEL[d.visibility] && <span className="deck-shared">{SHARED_LABEL[d.visibility]}</span>}
        </span>
      </ArtPanel>
    </Link>
  );
}

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
  const cards = useCardControls();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [goldfish, setGoldfish] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [mythic, setMythic] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [describing, setDescribing] = useState(false);
  const askOffered = useAskClaudeOffered();
  // "?collect=1": the end of a deck import offers to add its cards to the collection.
  const [search, setSearch] = useSearchParams();
  // The deck's sections are tabs (design/tokens.md, rule 4; deck page SPEC): Cards at /decks/:id,
  // Stats and History at /decks/:id/stats and /history, so links and Back land on the same tab.
  const { pathname } = useLocation();
  const tab = (["stats", "plan", "history"] as const).find((t) => pathname.endsWith(`/${t}`)) ?? "cards";
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
  const variants = usePlaygroupVariants(deck.data?.id ?? id ?? "");
  const analysis = useDeckAnalysis(deck.data?.id ?? "", deck.data?.version_id ?? null);
  const measures = analysis.data?.current?.power_bracket ?? null;
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
    setDescribing(false);
    setOpen(null);
  }, [id]);

  // Only with no deck to show: a refresh that failed leaves the page, and any sheet open on it.
  if (queryFailure(deck) === "page") return <main className="page"><LoadFailed query={deck} /></main>;
  const d = deck.data;
  if (!d) return <main className="page" />;
  const v = d.validation;
  const o = d.ownership;
  const commanderEntries = d.cards.filter((e) => e.board === "commander");
  const commander = commanderEntries.find((e) => e.card?.image_art_crop)?.card;
  const summary = decks.data?.find((x) => x.id === d.id);
  const priced = priceSource(o.price_date);
  const openByName = (name: string) => {
    const hit = d.cards.find((c) => c.name === name);
    if (hit) setOpen(hit.oracle_id);
  };

  const status = deckStatus(d);
  // Play it at a lower bracket: the plan's swap bags, previewed from the List picker (?at=3).
  // Only an approved plan's bags are instructions for the box (as on Print swap cards).
  const planInForce = !!plan && ["in_progress", "done"].includes(plan.view.planOf(plan.deck).state);
  const brackets = planInForce ? bracketSwaps(plan!.deck.bracket) : [];
  const atSwaps = brackets.find((b) => String(b.bracket) === search.get("at")) ?? null;
  const outAt = new Set(atSwaps?.swaps.map((s) => s.out) ?? []);
  const atHref = (b: number | null) => {
    const next = new URLSearchParams(search);
    if (b == null) next.delete("at");
    else next.set("at", String(b));
    return `${pathname}${next.size ? `?${next}` : ""}`;
  };
  // The ActionBar (design/tokens.md, rule 2; SPEC section 0): Edit list, Check cards, Share, More.
  const checkActions = <>
    <Link className="deck-check-action" to={`/decks/${d.id}/check`}><span>Check physical cards</span><span className="more-menu-note">Compare with this list without saving changes</span></Link>
    <Link className="deck-check-action" to={`/decks/${d.id}/scan`}><span>Scan a new version</span><span className="more-menu-note">Save a list from your physical cards</span></Link>
    <Button className="deck-check-action" onClick={() => { cards.setShow("need"); if (tab !== "cards") navigate(tabHref("cards")); }}><span>Find missing cards</span><span className="more-menu-note">Compare this list with my collection</span></Button>
  </>;
  const moreActions = <>
    <Button onClick={() => navigate("/", { state: { deckId: d.id } })}>Play</Button>
    <Button onClick={() => setGoldfish(true)}>Sample hand</Button>
    <MenuSeparator />
    <Button onClick={() => setExporting(true)}>Copy or export</Button>
    <MythicSendButton className="" onClick={() => setMythic(true)} />
    <MenuSeparator />
    <Button onClick={() => setCollecting(true)}>Add to collection</Button>
    <Button onClick={() => setEditing(true)}>Deck settings</Button>
    <Button onClick={() => setDescribing(true)}>{d.description ? "Edit the description" : "Add a description"}</Button>
    {askOffered && <AskClaudeButton onClick={() => setAsking(true)} />}
    <MenuSeparator />
    <Button danger onClick={() => setDeleting(true)}>{deleteWording(d).action}</Button>
  </>;

  return (
    <main className="deck-page">
      <ArtPanel as="header" className="deck-hero" art={commander?.image_art_crop} artist={commander?.artist} wash="bottom" toGround credit={false}>
        <BackLink to="/decks" label="Back to decks" text="Decks" onArt />
        {commander && (
          <span className="hero-credit">
            <span className="hero-credit-card">{commander.name}. </span>
            {artCredit(commander.artist)}.
          </span>
        )}
        <div className="hero-inner">
          <div className="hero-text">
            <span className="hero-sub">
              <Pips identity={v.color_identity} />
              <span>{commanderEntries.map((e) => e.name).join(" and ") || "No commander set"}</span>
            </span>
            <h1 className="hero-title">{d.parent_id ? d.configurations.find((c) => c.id === d.parent_id)?.name ?? d.name : d.name}</h1>
            <span className="hero-status">
              <StatusPill tone={toneOf(status.tone)}>{status.pill}</StatusPill>
              <span>{status.line}</span>
            </span>
          </div>
          <div className="wide-only"><DeckTiles deck={d} summary={summary} measures={measures} hrefFor={tabHref} /></div>
        </div>
      </ArtPanel>

      <div className="page deck-body" inert={deck.isPlaceholderData} aria-busy={deck.isPlaceholderData}>
        <RefreshFailed query={deck} what="this deck" />
        <div className="phone-only"><DeckTiles deck={d} summary={summary} measures={measures} hrefFor={tabHref} /></div>
        <div className="deck-actionbar">
          <div className="deck-actions" role="toolbar" aria-label="Deck actions">
            <ButtonLink variant="primary" to={`/decks/${d.id}/edit`}>Edit list</ButtonLink>
            <MoreMenu label="Check cards" align="start">{checkActions}</MoreMenu>
            <Button onClick={() => setSharing(true)}>Share</Button>
            <MoreMenu title={d.name}>{moreActions}</MoreMenu>
          </div>
          {d.configurations.length > 1 || variants.length > 0 || brackets.length > 0 ? (
            <ListPicker
              deck={d}
              shownId={id ?? d.id}
              onPrefetch={prefetch}
              onNewList={() => setConfiguring(true)}
              variants={variants}
              brackets={brackets.map((b) => ({ bracket: b.bracket, count: b.swaps.length }))}
              boxBracket={planInForce ? boxBracket(plan!.deck.bracket) : null}
              at={atSwaps?.bracket ?? null}
              atHref={planInForce ? atHref : undefined}
            />
          ) : (
            <Button variant="quiet" className="deck-new-list" onClick={() => setConfiguring(true)}>Save a copy as a new list</Button>
          )}
        </div>
        <SavedListBar deck={d} />
        {!v.ok && v.errors.length > 1 && <ul className="small deck-errors">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>}

        <DeckAbout deck={d} onEdit={() => setDescribing(true)} />
        {editing && <DeckSettings key={d.id} deck={d} onClose={() => setEditing(false)} />}
        {describing && <EditDescription key={d.id} deck={d} onClose={() => setDescribing(false)} />}
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
            { id: "plan", label: "Plan", note: planTabNote(plan) },
            { id: "history", label: "History", note: <HistoryTabNote deckId={d.id} currentVersionId={d.version_id} /> },
          ]}
          current={tab}
          hrefFor={tabHref}
          label="Deck sections"
        />

        {atSwaps && plan && (tab === "cards" || tab === "stats") && (
          <SwapPanel at={atSwaps.bracket} swaps={atSwaps.swaps} view={plan.view} printHref={`/decks/builds?savedDeck=${d.id}&from=${encodeURIComponent(`saved:${d.id}`)}&to=${encodeURIComponent(`plan:${plan.deck.key}:b${atSwaps.bracket}`)}`} backHref={atHref(null)} />
        )}
        {tab === "cards" && (
          <div className="cards-layout">
            <DeckCardsTab
              deck={d}
              controls={cards}
              outAt={outAt}
              atBracket={atSwaps?.bracket ?? null}
              status={(e) => <CardStatus e={e} small plan={plan} />}
              onOpen={setOpen}
            />
            <WhyBracket deck={d} at={atSwaps?.bracket ?? null} outAt={outAt} onCard={openByName} />
          </div>
        )}
        {tab === "cards" && <Considering cards={d.maybe ?? []} deckId={d.id} onOpen={setOpen} />}

        {/* Stats: everything about the deck that isn't the list (design: the deck's Stats tab). */}
        {tab === "stats" && <DeckStatsTab deck={d} onCard={openByName} />}
        {tab === "plan" && <section className="deck-plan-tab-wrap" aria-label="Plan"><DeckPlanTab deckId={d.id} deckName={d.name} />{plan?.sim && <p className="deck-sim">{plan.sim}</p>}</section>}
        {tab === "history" && <section className="deck-history-tab" aria-label="History"><DeckHistoryBody deckId={d.id} currentVersionId={d.version_id} /></section>}
        {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} />}
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

function SampleHand({ deck, art, artist, onClose }: { deck: DeckView; art: string | null; artist: string | null; onClose: () => void }) {
  const library = useMemo(() => expandDeck(deck.cards), [deck]);
  const images = useMemo(() => new Map(deck.cards.map((c) => [c.name, c.card?.image_normal ?? null])), [deck]);
  const deal = (mulligans: number) => newHand(library, rng(crypto.getRandomValues(new Uint32Array(1))[0]!), mulligans);
  const [g, setG] = useState<Goldfish>(() => deal(0));
  const root = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const layer = useModalLayer(root, onClose, done);
  const lands = g.hand.filter((c) => deck.cards.find((d) => d.name === c.name)?.card?.type_line.includes("Land")).length;
  return (
    <div ref={root} className="hand-view" role="dialog" aria-modal="true" aria-label="Sample hand" tabIndex={-1} {...layer}>
      <ArtPanel as="header" className="hand-head" art={art} artist={artist} wash="bottom" toGround>
        <span className="hand-title">
          <span className="hand-deck">{deck.name}</span>
          <span className="hand-name">Sample hand</span>
        </span>
        <Button ref={done} variant="primary" className="hand-done" onClick={onClose}>Done</Button>
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
              <Button onClick={() => setG(bottom(g, i))} disabled={g.toBottom === 0} aria-label={g.toBottom ? `Put ${c.name} on the bottom` : c.name}>
                <CardImage src={images.get(c.name)} name={c.name} />
              </Button>
            </li>
          ))}
        </ul>
        <p className="small dim hand-note">First mulligan free. Card images from Scryfall, © Wizards of the Coast.</p>
      </div>
      <div className="hand-bar">
        <Button variant="primary" onClick={() => setG(draw(g))} disabled={g.toBottom > 0 || g.library.length === 0}>Draw</Button>
        <Button onClick={() => setG(deal(g.mulligans + 1))}>Mulligan</Button>
        <Button onClick={() => setG(deal(0))}>New hand</Button>
      </div>
    </div>
  );
}
