import { CardRef } from "../components/CardRef";
import { GROUP_ORDER, groupOf, identityName } from "@yama/core";
import {
  bagSource,
  bracketBuilds,
  cardCount,
  cheapestMarket,
  deckChanges,
  installedState,
  selectChangeSwaps,
  type ChangeSort,
  deckDiff,
  deckLogs,
  deckWarnings,
  exportText,
  fmtDate,
  gameChangersIn,
  newNames,
  ownedOrStockedLocally,
  proposalBuild,
  slotSource,
  swapSource,
  swapStatus,
  usd,
  answerState,
  opTime,
  type IdeaOp,
  type PlanCard,
  type PlanDeck,
  type PlanGroup,
  type Review,
  type Slot,
  type StateName,
  type Swap,
} from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe, usePower } from "../auth";
import { planSummaries, planSummariesKey } from "../research/view";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { Crop, WinBar, winCeiling } from "../components/Crop";
import { BackButton } from "../components/DeckTabs";
import { Details, ErrorText, Pips } from "../components/ui";
import { ConfidenceLine, ConfidenceMark, ConfidenceNote } from "../lab/confidence";
import { cantJudge, pct, pctRange, pointsRange, pointsWord, worstConfidence } from "../lab/logic";
import { pairedFor, simShort, stateLabel, useRuns, variantState, type PlanSim } from "../lab/paired";
import { AskClaude } from "../advisor/AskClaude";
import { CardSheet } from "../pages/Cards";
import { SwapInSheet } from "./SwapIn";
import { linkDeck, makeYamaDeck } from "./api";
import { deviceId, outbox, useOutbox } from "./outbox";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { BoughtLine, InstalledTick, marketSentence } from "./marks";
import { CopyButton, Thumb } from "./parts";
import { PlansForDeck } from "../research/PlanTiles";
import { PlanAnswer } from "./Review";
import { useScrollToHash } from "../components/useScrollToHash";
import type { PlanView } from "./view";

const TABS = [
  { id: "changes", label: "Changes" },
  { id: "stock", label: "Stock" },
  { id: "now", label: "Now" },
  { id: "after", label: "After prints" },
  { id: "brackets", label: "Brackets" },
  { id: "lab", label: "Lab" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const LIST_ABOUT: Record<"stock" | "now" | "after", string> = {
  stock: "The precon as it came out of the box, with the plan's commander.",
  now: "Every swap whose card is in hand. This is the plan, not what's in your deck box.",
  after: "The full plan once your prints arrive.",
};

/** "Bracket 4, with swap bags for 3 and 2". */
function bracketLine(deck: PlanDeck): string | null {
  const b = deck.bracket;
  if (!b) return null;
  const bags = Object.keys(b.bags ?? {})
    .filter((k) => Number.isFinite(Number(k)))
    .sort((x, y) => Number(y) - Number(x));
  const list = bags.length <= 1 ? bags.join("") : `${bags.slice(0, -1).join(", ")} and ${bags[bags.length - 1]}`;
  return `Bracket ${b.target ?? 4}${bags.length ? `, with swap ${bags.length === 1 ? "bag" : "bags"} for ${list}` : ""}`;
}

/** The plan's cards a question names (longest first), so the question can show the card's art. */
function namedCard(text: string, names: string[]): string | null {
  return [...new Set(names)].sort((a, b) => b.length - a.length).find((n) => n.length > 3 && text.includes(n)) ?? null;
}

/** "Where did this Mount Doom come from?" bold, the rest dim. */
function splitQuestion(text: string): [string, string] {
  const m = /^(.+?[?.])\s+(.*)$/s.exec(text);
  return m ? [m[1]!, m[2]!] : [text, ""];
}

/** `/decks/plan/d/:key`: one plan deck (design: PlanDeck, PlanDeckWide). */
export function DeckPlan() {
  const { key = "" } = useParams();
  const { view, banner } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "changes") as TabId;
  const deck = view.deck(key);
  const runs = useRuns();
  // Review links to the proposals (#proposed) on the Changes tab.
  useScrollToHash(!!deck && tab === "changes");

  if (!deck) {
    return (
      <div className="page">
        <PlansHead title="Plans" />
        <p className="empty">There's no plan deck called "{key}" in your plans.</p>
      </div>
    );
  }
  const notes = deck.notes;
  const questions = notes.filter((n) => n.kind === "open_question");
  const warnings = [...notes.filter((n) => n.kind === "warning").map((n) => n.text), ...deckWarnings(deck, view.b.head?.warnings ?? [], view.b.head?.export_warnings ?? [])];
  const other = notes.filter((n) => n.kind === "note");
  const commander = view.card(deck.commander[0]);
  const art = view.art(deck);
  const head = view.b.head;
  const swapNames = view.swapsOf(deck.key).flatMap((s) => [s.in, s.out ?? ""]);
  const sim = pairedFor(runs.data, deck.key);
  const brackets = bracketLine(deck);

  return (
    <>
      <ArtPanel as="header" className="plan-hero" art={art} artist={commander?.artist} wash="bottom" toGround credit={false}>
        <BackButton to="/decks/plan" label="Back to plans" className="on-art" />
        {art && <span className="plan-hero-credit">{artCredit(commander?.artist)}</span>}
        <div className="plan-hero-inner">
          <nav className="plan-crumbs" aria-label="Breadcrumb">
            <Link to="/decks">Decks</Link>
            <span aria-hidden="true">/</span>
            <Link to="/decks/plan">Plans</Link>
          </nav>
          <span className="plan-hero-cmdr phone-only">
            <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
          </span>
          <h1 className="plan-hero-title">{deck.name} plan</h1>
          {brackets && <span className="plan-hero-sub phone-only">{brackets}</span>}
          <span className="plan-hero-chips wide-only">
            <span className="plan-hero-cmdr">
              <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
              <span className="visually-hidden">, {identityName(deck.color_identity ?? "")}</span>
            </span>
            {brackets && <span className="art-chip plain">{brackets}</span>}
            {deck.source === "import" && head && (
              <span className="art-chip plain dim-on-art">
                Planned in {head.app ?? "an outside planner"}
                {head.guide_version != null ? `, guide v${head.guide_version}` : ""}, imported {fmtDate(head.imported_at)}
              </span>
            )}
          </span>
        </div>
      </ArtPanel>

      <div className="page plan-deck-body">
        {banner}
        {questions.map((n) => {
          const [lead, rest] = splitQuestion(n.text);
          const card = namedCard(n.text, swapNames);
          const crop = card ? view.card(card)?.image_art_crop : null;
          return (
            <section key={n.text} className="plan-question" aria-label="Open question">
              {crop && <Crop src={crop} size="md" />}
              <span className="plan-question-text">
                <b>{lead}</b>
                {rest && <span>{rest}</span>}
                <span className="small">Settle it with your planner, or suggest a change below.</span>
                {n.source && (
                  <Details>
                    <p>From {n.source}.</p>
                  </Details>
                )}
              </span>
            </section>
          );
        })}
        <p className="small dim plan-deck-about">
          {deck.product ? `${deck.product}. ` : ""}
          {deck.note ? <FromNote note={deck.note} stopped={deck.status === "archived"} /> : deck.source === "import" ? "Planned outside Yama; read-only here." : "Made in Yama."}
          {deck.status === "proposals_only" ? " Proposals only; no approved swaps." : ""}
          {deck.status === "archived" && !deck.note ? " The latest import didn't include this deck." : ""}
        </p>
        <PlansForDeck name={deck.name} current={deck.note ? { note: deck.note.id, deck: deck.note.deck } : { plan: deck.key }} />
        <div className="row">
          <AskClaude context={{ kind: "plan_deck", ref: deck.key }} about={`the ${deck.name} plan`} ideasFor={deck.key} />
        </div>
        {warnings.length > 0 && (
          <details className="plan-warnings">
            <summary>
              <span className="tag warn">{warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}</span>
            </summary>
            <ul className="small">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        {other.length > 0 && (
          <ul className="small dim plan-deck-notes">
            {other.map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
          </ul>
        )}

        <div className="plan-tabs" role="tablist" aria-label="Plan views">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setParams({ tab: t.id }, { replace: true })}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="plan-deck-cols">
          <div className="plan-deck-main">
            {tab === "changes" && <ChangesTab key={deck.key} deck={deck} view={view} />}
            {(tab === "stock" || tab === "now" || tab === "after") && <ListTab deck={deck} view={view} state={tab} />}
            {tab === "brackets" && <BracketsTab deck={deck} view={view} />}
            {tab === "lab" && <LabTab deck={deck} sim={sim} loading={runs.isPending} error={runs.error} />}
          </div>
          <aside className="plan-deck-side" aria-label="About this plan">
            {tab !== "lab" && sim && <VersionsPanel deck={deck} sim={sim} compact />}
            <BagsPanel deck={deck} onOpen={() => setParams({ tab: "brackets" }, { replace: true })} />
            <CopyAfter deck={deck} />
          </aside>
        </div>

        <Ideas deck={deck} view={view} />
        <LinkDeck deck={deck} />
      </div>
    </>
  );
}

/** A tracked plan's way back to its plan: the note's deck page at the tracked build. A stopped
 *  one says only that it isn't tracked: you may have stopped it, or the plan may have dropped
 *  that deck or build when it was saved again (the build may be gone, so the link opens the deck). */
function FromNote({ note, stopped }: { note: NonNullable<PlanDeck["note"]>; stopped: boolean }) {
  const userId = useMe().data?.id;
  const plans = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries, enabled: !!userId });
  const title = plans.data?.find((p) => p.id === note.id)?.title;
  const deckPage = `/decks/research/${encodeURIComponent(note.id)}/${encodeURIComponent(note.deck)}`;
  const label = title ? `the plan “${title}”` : "your plan";
  return stopped ? (
    <>
      No longer tracked. It came from <Link to={deckPage}>{label}</Link>; track a build there to follow it again.
    </>
  ) : (
    <>
      Tracking a build of <Link to={`${deckPage}?build=${encodeURIComponent(note.build)}`}>{label}</Link>. Switch builds or stop tracking from there.
    </>
  );
}

// ── Simulated strength ──────────────────────────────────────────────────────

/** Each list's raw win rate with its interval, the 25% line, and the label every simulated number carries. */
function VersionsPanel({ deck, sim, compact = false }: { deck: PlanDeck; sim: PlanSim; compact?: boolean }) {
  const power = usePower();
  const max = winCeiling(sim.versions.map((v) => v.variant.wilson?.[1]));
  const level = sim.run.level ? `${Math.round(sim.run.level * 100)}%` : "90%";
  const stockAfter = sim.comparisons.find((c) => variantState(c.base, deck.key) === "stock" && variantState(c.variant, deck.key) === "after");
  const tryHref = deck.deck_id ? `/lab/try?deck=${encodeURIComponent(deck.deck_id)}` : "/lab/try";
  const conf = worstConfidence(sim.versions.map((v) => v.variant.confidence));
  const method = sim.run.confidence?.method;
  return (
    <section className="plan-panel plan-versions" aria-labelledby={`versions-${compact ? "c" : "f"}`}>
      <h2 id={`versions-${compact ? "c" : "f"}`}>{sim.versions.length === 3 ? "Three versions" : "Simulated strength"}</h2>
      {conf && conf.level !== "ok" && (
        <ConfidenceNote level={conf.level} reasons={conf.reasons} fold={compact}>
          {cantJudge(conf) && sim.versions.some((v) => !cantJudge(v.variant.confidence)) && <p>Only the versions marked sim unreliable are affected.</p>}
        </ConfidenceNote>
      )}
      {sim.versions.map((v) => {
        const w = v.variant.wilson;
        return (
          <div key={v.variant.id} className="plan-version">
            <b className="plan-version-name">
              {v.label} <ConfidenceMark confidence={v.variant.confidence} name={`${deck.name}, ${v.label.toLowerCase()}`} method={method} />
            </b>
            <b className="plan-version-rate num">{pct(v.variant.win_rate)}</b>
            <span className="plan-version-note">
              {v.note}. {v.variant.games} games
            </span>
            <span className="plan-version-ci num">{w ? pctRange(w[0], w[1]) : "no interval"}</span>
            <WinBar
              value={v.variant.win_rate}
              lo={w?.[0]}
              hi={w?.[1]}
              max={max}
              few={v.variant.games < 10}
              label={`${v.label}: won ${pct(v.variant.win_rate, 1)} of ${v.variant.games} games${w ? `, ${level} interval ${pctRange(w[0], w[1])}` : ""}`}
            />
          </div>
        );
      })}
      <p className="plan-panel-note">
        Raw win rate in simulated 4-player games.
        {stockAfter?.delta_win_rate != null && stockAfter.delta_ci
          ? ` Stock to after: ${pointsWord(stockAfter.delta_win_rate)}, ${level} interval ${pointsRange(stockAfter.delta_ci)}.`
          : ""}{" "}
        {simShort(sim.run, sim.versions)}. Bars show the {level} interval; the line is 25%. Simulated games, not your table.
      </p>
      {power && <Link className="button" to={tryHref}>Try a change</Link>}
    </section>
  );
}

function LabTab({ deck, sim, loading, error }: { deck: PlanDeck; sim: PlanSim | null; loading: boolean; error: unknown }) {
  const power = usePower();
  if (loading) return <p className="dim">Loading your runs…</p>;
  if (error) return <ErrorText error={error} />;
  if (!sim) {
    return (
      <div className="stack">
        <p className="empty">No simulated runs for this plan yet.</p>
        <p className="small dim">Imported paired runs appear here.{power && " You can also try a change yourself in the lab."}</p>
        {power && (
          <div className="row">
            <Link className="button" to={deck.deck_id ? `/lab/try?deck=${encodeURIComponent(deck.deck_id)}` : "/lab/try"}>Try a change</Link>
          </div>
        )}
      </div>
    );
  }
  const level = sim.run.level ? `${Math.round(sim.run.level * 100)}%` : "90%";
  const confOf = (id: string) => sim.run.paired?.variants.find((v) => v.id === id)?.confidence ?? null;
  return (
    <div className="stack">
      <VersionsPanel deck={deck} sim={sim} />
      <section className="plan-panel">
        <h2>Comparisons</h2>
        {sim.comparisons.map((c) => {
          const a = stateLabel(variantState(c.base, deck.key) ?? c.base)[0];
          const z = stateLabel(variantState(c.variant, deck.key) ?? c.variant)[0];
          const conf = worstConfidence([confOf(c.base), confOf(c.variant)]);
          return (
            <div key={`${c.base}>${c.variant}`} className="plan-compare">
              <span className="plan-compare-head">
                <b>
                  {z} against {a.toLowerCase()}
                </b>
                <span className={`pill ${c.verdict.kind === "better" ? "good" : c.verdict.kind === "worse" ? "bad" : "warn"}`}>
                  {c.verdict.kind === "better" ? "Probably better" : c.verdict.kind === "worse" ? "Probably worse" : "Can't tell yet"}
                </span>
              </span>
              <span className="small">
                {c.delta_win_rate != null && c.delta_ci ? `${pointsWord(c.delta_win_rate)}, ${level} interval ${pointsRange(c.delta_ci)}. ` : ""}
                {c.pods} paired pods: only {z.toLowerCase()} won {c.variant_only}, only {a.toLowerCase()} won {c.base_only}.
              </span>
              {cantJudge(conf) && (
                <ConfidenceLine confidence={conf} name={`${deck.name}, ${z.toLowerCase()} against ${a.toLowerCase()}`} method={sim.run.confidence?.method} />
              )}
            </div>
          );
        })}
        <p className="plan-panel-note">
          Run {sim.run.name}, analysed in your planner and imported {fmtDate(sim.run.imported_at)}. {simShort(sim.run)}. The lab's model win rates for these lists are on the{" "}
          <Link to="/lab">precon table</Link>; these are raw win rates.
        </p>
        <div className="row">
          <Link className="button" to={`/lab/runs/batch/${sim.run.id}`}>Open the run</Link>
        </div>
      </section>
    </div>
  );
}

/** The deck's bracket swap card, ready to print. */
const swapCardHref = (deck: PlanDeck) => `/decks/plan/swap-cards?deck=${encodeURIComponent(deck.key)}`;

/** What each bracket bag does, with a link to the Brackets tab. */
function BagsPanel({ deck, onOpen }: { deck: PlanDeck; onOpen: () => void }) {
  const builds = useMemo(() => bracketBuilds(deck.states.after?.cards ?? [], deck.bracket), [deck]);
  if (builds.length < 2) return null;
  return (
    <section className="plan-panel" aria-label="Bracket bags">
      <h2>Bracket bags</h2>
      <span className="small">
        <b>Bracket {builds[0]!.bracket}:</b> the full plan, after prints.
      </span>
      {builds.slice(1).map((b, i) => (
        <span key={b.bracket} className="small">
          <b>Bracket {b.bracket}:</b> swap {b.swaps.length} {b.swaps.length === 1 ? "card" : "cards"} back{i > 0 ? ` on top of Bracket ${builds[i]!.bracket}` : ""}
          {b.warnings.length ? `, ${b.warnings.length} to check` : ""}.
        </span>
      ))}
      <button className="quiet small plan-panel-link" onClick={onOpen}>See the bags</button>
      <Link className="small plan-panel-link" to={swapCardHref(deck)}>Print swap card</Link>
    </section>
  );
}

/** The after-prints list, ready to paste. */
function CopyAfter({ deck }: { deck: PlanDeck }) {
  const after = deck.states.after?.cards;
  if (!after?.length) return null;
  return (
    <div className="plan-copy">
      <CopyButton text={exportText(after)} label="Copy names" />
      <CopyButton text={exportText(after, { printings: true })} label="Copy for Moxfield" />
      <span className="small dim">The after-prints list, {cardCount(after)} cards.</span>
    </div>
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────

/** Where "In the deck" comes from: the Yama deck's current list, else your ticks. */
export function InstallSource({ deck }: { deck: PlanDeck }) {
  const yd = deck.yama_deck;
  if (!yd) {
    return <p className="small dim plan-install-source">No linked deck. Mark swaps as you install them.</p>;
  }
  return (
    <p className="small plan-install-source">
      "In the deck" is read from <Link to={`/decks/${yd.id}`}>{yd.name}</Link>
      {yd.list_at ? `, its list saved ${fmtDate(yd.list_at)}` : ""}
      {yd.linked ? "" : " (found by its name; link a deck to this plan to choose another)"}: a swap is in when its card is in that list and the card it
      replaces is gone. To try another build, put a configuration's list in the deck from the deck's page.
    </p>
  );
}

function ChangesTab({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const { userId } = usePlanOutlet();
  const swaps = view.swapsOf(deck.key);
  const c = useMemo(() => deckChanges(deck.key, deck.groups, swaps), [deck, swaps]);
  const logs = useMemo(() => deckLogs(deck), [deck]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ChangeSort>("plan");
  const [show, setShow] = useState("all");
  const select = (list: Swap[]) => selectChangeSwaps(list, query, sort, c.standins).filter((s) => {
    if (show === "all") return true;
    const st = installedState(s, view.markBy.get(s.key)?.installed);
    const tick = s.stage === "planned" && (s.role !== "optional" || !!s.out);
    return tick && (show === "installed" ? st.on : !st.on && !st.skipped);
  });
  const visible = {
    now: select(c.now), prints: select(c.prints), loose: select(c.loose), optional: select(c.optional),
    proposed: c.proposed.map((g) => ({ ...g, swaps: select(g.swaps) })).filter((g) => g.swaps.length),
  };
  const total = c.now.length + c.prints.length + c.loose.length + c.optional.length + c.proposed.reduce((n, g) => n + g.swaps.length, 0);
  const count = visible.now.length + visible.prints.length + visible.loose.length + visible.optional.length + visible.proposed.reduce((n, g) => n + g.swaps.length, 0);
  const row = (s: Swap) => <SwapRow key={s.key} s={s} view={view} userId={userId} logs={logs} standins={c.standins.get(s.key) ?? []} />;
  const nothing = !c.now.length && !c.prints.length && !c.optional.length && !c.proposed.length && !c.loose.length;
  const [swapping, setSwapping] = useState(false);
  const shownArtists = [...visible.now, ...visible.prints, ...visible.loose, ...visible.optional, ...visible.proposed.flatMap((g) => g.swaps)].flatMap((s) => [s.in, s.out]).map((n) => view.card(n)?.artist);

  const group = (title: string, list: Swap[], about?: string) =>
    list.length > 0 && (
      <section className="plan-group" aria-label={title}>
        <h2 className="plan-group-title">
          {title} <span className="num">{list.length}</span>
        </h2>
        {about && <p className="dim small">{about}</p>}
        {list.map(row)}
      </section>
    );
  return (
    <div className="plan-changes">
      {deck.status === "active" && <div className="row plan-swapin">
        <Link to={`/decks/plan/prints/swap?sheet=takeout&deck=${encodeURIComponent(deck.key)}`}>Takeout sheet, A to Z</Link>
        <Link className="button outline" to={`/decks/plan/prints/swap?deck=${encodeURIComponent(deck.key)}&scan=1`}>Scan a card for a swap</Link>
      </div>}
      {!nothing && <>
        <div className="plan-change-controls" role="search" aria-label="Find swaps">
          <label className="plan-change-search">Search swaps
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Card in, card out, or notes" />
          </label>
          <label>Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as ChangeSort)}>
              <option value="plan">Plan order</option>
              <option value="in">Card in: A to Z</option>
              <option value="in-desc">Card in: Z to A</option>
              <option value="out">Card out: A to Z</option>
              <option value="tier">Tier</option>
            </select>
          </label>
          <label>Show
            <select value={show} onChange={(e) => setShow(e.target.value)}>
              <option value="all">All swaps</option>
              <option value="pending">Still to put in</option>
              <option value="installed">In the deck</option>
            </select>
          </label>
          {(query || sort !== "plan" || show !== "all") && <button type="button" className="quiet" onClick={() => { setQuery(""); setSort("plan"); setShow("all"); }}>Reset</button>}
        </div>
        <p className="small dim" role="status">Showing {count} of {total} swaps. Sorted within each group.</p>
        <InstallSource deck={deck} />
        {count === 0 && <p className="empty">No swaps match. Try another search or reset the filters.</p>}
      </>}
      {nothing && <p className="empty">No swaps or proposals for this deck yet.</p>}
      {group("Swap in now", visible.now)}
      {c.prints.length > 0 && deck.status === "active" && (
        <div className="row plan-swapin">
          <button className="outline" onClick={() => setSwapping(true)}>
            Swap in the prints
          </button>
          <Link to={`/decks/plan/prints/swap?deck=${encodeURIComponent(deck.key)}`}>Swap sheet to print</Link>
        </div>
      )}
      {swapping && <SwapInSheet deckKey={deck.key} deckName={deck.name} onClose={() => setSwapping(false)} />}
      {group("When your prints arrive", visible.prints)}
      {group("Stand-ins", visible.loose)}
      {group("Optional extras", visible.optional, "Cards you have for this deck that the plan doesn't need a slot for.")}
      {visible.proposed.length > 0 && (
        <section className="plan-group" id="proposed" aria-label="Proposed, not in the plan">
          <h2 className="plan-group-title">
            Proposed, not in the plan <span className="num">{visible.proposed.reduce((n, g) => n + g.swaps.length, 0)}</span>
          </h2>
          <p className="small dim">
            Answer each one: Want, Unsure or Don't want, with a note if you like.
            {deck.source === "import" ? ` Your answers go to your ${view.app} inbox; a want joins the plan when the plan is updated there.` : " Want tells your assistant to add it to the plan."}
          </p>
          {c.proposed.length > 1 && deck.groups.length > 1 && <p className="dim small">Each group builds on the ones before it.</p>}
          {visible.proposed.map((g) => (
            <div key={g.group?.label ?? "none"} className="plan-subgroup">
              {(g.group || c.proposed.length > 1) && (
                <h3 className="plan-group-head">
                  {g.group ? g.group.label : "Other proposals"}
                  {g.group?.bracket != null && <span className="pill">Bracket {g.group.bracket}</span>}
                </h3>
              )}
              {g.group?.note && <p className="dim small">{g.group.note}</p>}
              {g.swaps.map(row)}
            </div>
          ))}
          <ProposedBuild deck={deck} view={view} />
        </section>
      )}
      {shownArtists.some(Boolean) && <p className="small dim art-credits">{artCredits(shownArtists)}</p>}
    </div>
  );
}

function SwapRow({ s, view, userId, logs, standins }: { s: Swap; view: PlanView; userId: string; logs: ReturnType<typeof deckLogs>; standins: Swap[] }) {
  const status = swapStatus(s, logs, view.deckName, view.ctx.orders);
  const answer = view.answers.get(s.key);
  const deck = view.deck(s.deck);
  const priced = s.stage === "proposed" && s.src !== "owned";
  const tick = s.stage === "planned" && (s.role !== "optional" || !!s.out);
  const inCard = view.card(s.in);
  const outCard = view.card(s.out);
  const lead = s.why ?? s.advice ?? s.when;
  const more = s.note || s.later_out || (s.advice && s.advice !== lead) || (s.when && s.when !== lead);
  return (
    <article className={`swap-card${s.stage === "proposed" ? " is-proposed" : ""}`}>
      <div className="swap-crops">
        <span className="swap-crop">
          <CropButton name={s.out} card={outCard} oracleId={view.oracleId(s.out)} />
          <span className="swap-crop-label">Out: {s.out?<CardRef name={s.out} oracleId={view.oracleId(s.out)} image={outCard?.image_normal}/>:"no slot"}</span>
        </span>
        <svg className="swap-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <span className="swap-crop is-in">
          <CropButton name={s.in} card={inCard} oracleId={view.oracleId(s.in)} />
          <span className="swap-crop-label">In: <CardRef name={s.in} oracleId={view.oracleId(s.in)} image={inCard?.image_normal}/></span>
        </span>
      </div>
      <div className="swap-text">
        <b className="swap-title">
          <CardRef name={s.in} oracleId={view.oracleId(s.in)} image={inCard?.image_normal}/> <span>{s.out?<>for <CardRef name={s.out} oracleId={view.oracleId(s.out)} image={outCard?.image_normal}/></>:"(no slot)"}</span>
        </b>
        {lead && <p className="swap-why"><b>Why add it:</b> {lead}</p>}
        {(s.out || s.why_out) && (
          <p className="swap-why"><b>Why cut{s.out ? ` ${s.out}` : " it"}:</b> {s.why_out || "No cut reason recorded in this plan."}</p>
        )}
        <p className="swap-source">
          {swapSource(s, view.ctx)}
          {priced ? ` ${marketSentence(cheapestMarket(s.in, view.b), !!view.oracleId(s.in))}` : ""}
        </p>
        {more && (
          <details className="swap-more small">
            <summary>More</summary>
            {s.when && s.when !== lead && <p>{/^when\b/i.test(s.when) ? s.when : `When: ${s.when}`}</p>}
            {s.advice && s.advice !== lead && <p>{s.advice}</p>}
            {s.later_out && <p>Later cut (suggested, not in the plan): {s.later_out}</p>}
            {s.note && <p className="dim">Note: {s.note}</p>}
          </details>
        )}
        {s.stage === "proposed" && deck ? (
          <PlanAnswer swap={s} deck={deck} view={view} userId={userId} />
        ) : (
          <>
            {answer && <AnswerLine s={s} answer={answer} view={view} />}
            {/* A planned swap can still be answered (a change of mind, a note), folded away. A
                tracked build's swaps are answered on its plan's page instead. */}
            {deck && !deck.note && (
              <details className="swap-more small">
                <summary>{answer?.decision ? "Change your answer" : "Answer this swap"}</summary>
                <PlanAnswer swap={s} deck={deck} view={view} userId={userId} />
              </details>
            )}
          </>
        )}
        {s.stage === "planned" && <BoughtLine swap={s} view={view} />}
        {standins.map((st) => (
          <div key={st.key} className="swap-standin small">
            <span className="pill">Stand-in</span> <b>{st.in}</b> holds the slot until the print arrives, then becomes a spare. {swapSource(st, view.ctx)}
            {st.later_out && <> Later cut (suggested, not in the plan): {st.later_out}. If you follow it, {st.in} stays and {st.later_out} is the spare instead.</>}
            <InstalledTick swap={st} view={view} userId={userId} compact />
          </div>
        ))}
      </div>
      <div className="swap-side">
        <span className="swap-pills">
          {status ? <span className={`pill${status.tone === "plain" ? "" : ` ${status.tone}`}`}>{status.label}</span> : s.stage === "proposed" ? <span className="pill quiet">Proposed</span> : null}
          {s.role === "standin" && <span className="pill">Stand-in</span>}
          {s.tier && <span className="pill quiet">{s.tier}</span>}
          {s.game_changer && <span className="pill quiet">Game Changer</span>}
          {s.plan_card && s.plan_card !== s.in && <span className="pill quiet">Budget pick for {s.plan_card}</span>}
          {!tick && s.upgrade && (s.upgrade.status === "installed" || s.upgrade.status === "skipped") && <span className="pill quiet">Planner says {s.upgrade.status}</span>}
        </span>
        {tick && <InstalledTick swap={s} view={view} userId={userId} short />}
      </div>
    </article>
  );
}

/** A swap card's art crop; tapping it opens the card (read-only) when Yama knows it. */
function CropButton({ name, card, oracleId }: { name: string | null; card: PlanCard | undefined; oracleId: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (!name) return <Crop src={null} empty />;
  const crop = <Crop src={card?.image_art_crop} />;
  if (!oracleId) return <span title={`${name} isn't in Yama's card data yet`}>{crop}</span>;
  return (
    <>
      <button type="button" className="swap-crop-btn" onClick={() => setOpen(true)} aria-label={`Show ${name}`}>
        {crop}
      </button>
      {open && <CardSheet oracleId={oracleId} readOnly onClose={() => setOpen(false)} />}
    </>
  );
}

const DECISION: Record<string, string> = { want: "You want this", unsure: "You're unsure", no: "You said no" };

function AnswerLine({ s, answer, view }: { s: Swap; answer: Review; view: PlanView }) {
  const { decision, note, cut } = answer;
  const deck = view.deck(s.deck);
  const state = deck ? answerState(answer, { source: deck.source, pulledThrough: view.b.inputs.pulled_through ?? 0, app: view.app }) : null;
  return (
    <p className="small">
      {decision && <span className={`tag${decision === "want" ? " good" : decision === "no" ? " bad" : ""}`}>{DECISION[decision]}</span>}
      {cut && <> Cut: {cut}.</>}
      {note && <> {note}</>}
      {decision === "no" && s.stage === "planned" && (
        <span className="dim"> Nothing changes until you and your planner decide what to do with this swap.</span>
      )}
      {state && <span className="faint"> {state.label}.</span>}
    </p>
  );
}

function ProposedBuild({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const groups = deck.groups;
  const [through, setThrough] = useState<string>(groups.length ? groups[groups.length - 1]!.label : "");
  const [localOnly, setLocalOnly] = useState(false);
  const after = deck.states.after?.cards ?? [];
  const build = useMemo(
    () =>
      proposalBuild(after, view.swapsOf(deck.key), view.answers, groups, {
        throughGroup: through || null,
        only: localOnly ? ownedOrStockedLocally(view.b.quotes, view.b.stores) : undefined,
      }),
    [after, view, deck.key, groups, through, localOnly],
  );
  return (
    <div className="plan-build stack">
      <h4>The proposed build</h4>
      <p className="dim small">
        The after-prints list with every proposal you haven't said no to. Each takes out your chosen cut, else its suggested one, else its later cut.
      </p>
      {groups.length > 1 && (
        <label>
          Up to
          <select value={through} onChange={(e) => setThrough(e.target.value)}>
            {groups.map((g) => (
              <option key={g.label} value={g.label}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="plan-check">
        <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />
        Only cards you own or a local store had in stock when checked
      </label>
      <p className="small">
        {cardCount(build.cards)} cards. {build.added.length} {build.added.length === 1 ? "proposal" : "proposals"} in
        {build.notes.length > build.added.length ? `, ${build.notes.length - build.added.length} left out` : ""}.
      </p>
      {build.notes.length > 0 && (
        <details className="small">
          <summary>What went in and what was left out</summary>
          <ul>
            {build.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="row">
        <CopyButton text={exportText(build.cards)} label="Copy the proposed build" />
      </div>
    </div>
  );
}

// ── Lists ───────────────────────────────────────────────────────────────────

const KIND_TAG: Record<string, string> = {
  owner: "Your change",
  bought: "Bought",
  standin: "Stand-in",
  fill: "Basic for now",
  print: "Print",
  moved: "Moved",
  optional: "Optional",
  proposed: "Proposed",
  bracket: "Swapped back",
};

function ListTab({ deck, view, state }: { deck: PlanDeck; view: PlanView; state: "stock" | "now" | "after" }) {
  const list = deck.states[state];
  const stock = deck.states.stock?.cards ?? [];
  if (!list) return <p className="empty">This plan has no {state === "after" ? "after-prints" : state} list.</p>;
  const fresh = state === "stock" ? new Set<string>() : newNames(stock, list.cards);
  const diff = state === "stock" ? null : deckDiff(stock, list.cards);
  return (
    <div className="stack">
      <p className="dim small">
        {LIST_ABOUT[state]} Cards with no note came in the precon. {cardCount(list.cards)} cards
        {diff ? `; ${diff.added.reduce((n, l) => n + l.qty, 0)} different from stock` : ""}. {list.computed_by}.
      </p>
      {list.unresolved.length > 0 && (
        <p className="small">
          <span className="tag warn">Not in Yama's card data yet</span> {list.unresolved.join(", ")}
        </p>
      )}
      <ListActions deck={deck} state={state} cards={list.cards} unresolved={list.unresolved} />
      <SlotGroups cards={list.cards} view={view} deck={deck} fresh={fresh} />
    </div>
  );
}

function SlotGroups({ cards, view, deck, fresh }: { cards: Slot[]; view: PlanView; deck: PlanDeck; fresh: Set<string> }) {
  const groups = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const c of cards) {
      const g = groupOf(c.board, view.card(c.name)?.type_line);
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    const cmc = (c: Slot) => view.card(c.name)?.cmc ?? 0;
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!.sort((a, b) => cmc(a) - cmc(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))] as const);
  }, [cards, view]);
  return (
    <>
      {groups.map(([group, slots]) => (
        <section key={group}>
          <h3>
            {group} <span className="dim num">{slots.reduce((n, c) => n + c.qty, 0)}</span>
          </h3>
          <div className="list">
            {slots.map((c, i) => (
              <div key={`${c.name}-${i}`} className="list-row plan-slot">
                <Thumb name={c.name} card={view.card(c.name)} oracleId={view.oracleId(c.name)} />
                <span>
                  <span className="title">
                    {c.qty > 1 ? `${c.qty} ` : ""}
                    <CardRef name={c.name} oracleId={view.oracleId(c.name)} image={view.card(c.name)?.image_normal}/>
                  </span>
                  {c.set && c.num ? <span className="faint small"> {c.set.toUpperCase()} {c.num}</span> : null}
                  {c.kind !== "stock" && (
                    <>
                      <br />
                      <span className="small dim">
                        {c.replaces ? `For ${c.replaces}. ` : ""}
                        {slotSource(c, view.ctx, deck)}
                      </span>
                    </>
                  )}
                </span>
                <span className="row plan-slot-tags">
                  {c.kind && KIND_TAG[c.kind] && <span className="tag">{KIND_TAG[c.kind]}</span>}
                  {fresh.has(c.name) && c.kind !== "stock" && <span className="tag good">New</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function ListActions({ deck, state, cards, unresolved }: { deck: PlanDeck; state: StateName; cards: Slot[]; unresolved: string[] }) {
  const qc = useQueryClient();
  const make = useMutation({
    mutationFn: () => makeYamaDeck(deck.key, state),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["decks"] }),
  });
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <div className="row">
        <CopyButton text={exportText(cards)} label="Copy names" />
        <CopyButton text={exportText(cards, { printings: true })} label="Copy with printings" />
        <button onClick={() => make.mutate()} disabled={make.isPending || unresolved.length > 0}>
          Make this a Yama deck
        </button>
      </div>
      <p className="faint small">
        Names only is the format EDHbots takes; with printings suits Moxfield. A Yama deck made from this list goes in your folder "Plans" and doesn't
        change the plan.
      </p>
      {make.data && (
        <p className="small" role="status">
          {make.data.existing ? "You already made this list into a deck: " : "Made "}
          <Link to={`/decks/${make.data.id}`}>{make.data.name}</Link>.
        </p>
      )}
      <ErrorText error={make.error} />
    </div>
  );
}

// ── Brackets ────────────────────────────────────────────────────────────────

function BracketsTab({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const after = deck.states.after?.cards ?? [];
  const gc = view.b.game_changers;
  const builds = useMemo(() => bracketBuilds(after, deck.bracket), [after, deck.bracket]);
  const bracketGroups = deck.groups.filter((g) => g.bracket != null);
  const checked = gc?.checked_on ? `Game Changer list checked ${fmtDate(gc.checked_on)}.` : "No Game Changer list in the plan.";
  const gcLine = (cards: Slot[]) => {
    if (!gc) return null;
    const found = gameChangersIn(cards, gc.names);
    return found.length ? `${found.length} Game ${found.length === 1 ? "Changer" : "Changers"}: ${found.join(", ")}.` : "No Game Changers.";
  };
  // Any bracket plan has a card, even one with only a box bracket or extras and no bags.
  const printCard = deck.bracket && (
    <div className="row">
      <Link className="button outline" to={swapCardHref(deck)}>Print swap card</Link>
      <span className="small dim">A card for the deck box: which cards to swap to change bracket.</span>
    </div>
  );
  if (builds.length === 1 && bracketGroups.length === 0) {
    return (
      <div className="stack">
        {printCard}
        <p className="dim">This plan has no bracket builds.</p>
        {gc && <p className="small">After prints: {gcLine(after)} <span className="faint">{checked}</span></p>}
      </div>
    );
  }
  return (
    <div className="stack">
      {printCard}
      {deck.bracket?.keep_note && <p>{deck.bracket.keep_note}</p>}
      {deck.bracket?.callouts?.map((c) => (
        <p key={c} className="plan-callout small">{c}</p>
      ))}
      {builds.length > 1 &&
        builds.map((b, i) => (
          <section key={b.bracket} className="stack plan-bracket">
            <h3>
              Bracket {b.bracket}
              <span className="dim small">
                {i === 0 ? " (the full plan, after prints)" : i === 1 ? " (the full plan with these swaps)" : ` (Bracket ${builds[i - 1]!.bracket} with these swaps)`}
              </span>
            </h3>
            <p className="small">
              {gcLine(b.cards)} <span className="faint">{checked}</span>
            </p>
            {b.swaps.length > 0 && (
              <div className="list">
                {b.swaps.map((s) => (
                  <div key={`${s.out}-${s.in}`} className="swap-row">
                    <div className="swap-thumbs">
                      <Thumb name={s.out} card={view.card(s.out)} oracleId={view.oracleId(s.out)} dim />
                      <span className="swap-arrow" aria-hidden>→</span>
                      <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} />
                    </div>
                    <div className="swap-body">
                      <p className="swap-title">
                        <b><CardRef name={s.in} oracleId={view.oracleId(s.in)} image={view.card(s.in)?.image_normal}/></b> <span className="dim">back for {s.out&&<CardRef name={s.out} oracleId={view.oracleId(s.out)}/>}</span>
                      </p>
                      <p className="small dim">{bagSource(s, view.ctx, deck)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {b.warnings.map((w) => (
              <p key={w} className="small"><span className="tag warn">Check</span> {w}</p>
            ))}
            <div className="row">
              <CopyButton text={exportText(b.cards)} label={`Copy Bracket ${b.bracket} names`} />
            </div>
          </section>
        ))}
      {bracketGroups.length > 0 && <ProposalBrackets deck={deck} view={view} gcLine={gcLine} checked={checked} />}
    </div>
  );
}

/** Proposal groups that go up a bracket (adding Game Changers), each on top of the groups before it. */
function ProposalBrackets({ deck, view, gcLine, checked }: { deck: PlanDeck; view: PlanView; gcLine: (c: Slot[]) => string | null; checked: string }) {
  const after = deck.states.after?.cards ?? [];
  const steps = deck.groups.map((g: PlanGroup) => ({
    group: g,
    build: proposalBuild(after, view.swapsOf(deck.key), view.answers, deck.groups, { throughGroup: g.label }),
  }));
  return (
    <section className="stack">
      <h3>Proposed builds by group</h3>
      <p className="dim small">These proposals aren't in the plan. Each group builds on the ones before it; proposals you said no to are left out.</p>
      {steps.map(({ group, build }) => (
        <div key={group.label} className="plan-bracket stack">
          <h4 className="plan-group-head">
            {group.label}
            {group.bracket != null && <span className="tag">Bracket {group.bracket}</span>}
          </h4>
          <p className="small">
            {build.added.length} proposals in. {gcLine(build.cards)} <span className="faint">{checked}</span>
          </p>
          <div className="row">
            <CopyButton text={exportText(build.cards)} label="Copy names" />
          </div>
        </div>
      ))}
    </section>
  );
}

// ── The Yama deck this plan is for ──────────────────────────────────────────

function LinkDeck({ deck }: { deck: PlanDeck }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const [open, setOpen] = useState(false);
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }), enabled: open || !!deck.deck_id });
  const linked = decks.data?.find((d) => d.id === deck.deck_id);
  const link = useMutation({
    mutationFn: (id: string | null) => linkDeck(deck.key, id),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["plan", userId] });
    },
  });
  return (
    <section className="plan-link stack">
      <h3>Your deck in Yama</h3>
      {deck.deck_id ? (
        <p className="small">
          This plan is for {linked ? <Link to={`/decks/${linked.id}`}>{linked.name}</Link> : "a deck that's archived or no longer yours"}.{" "}
          <button className="quiet small" onClick={() => link.mutate(null)} disabled={link.isPending}>Unlink</button>
        </p>
      ) : (
        <p className="dim small">Link a deck to see its game results here.</p>
      )}
      {open ? (
        <div className="row">
          <select defaultValue="" onChange={(e) => e.target.value && link.mutate(e.target.value)} aria-label="Your Yama deck" style={{ flex: "1 1 14rem" }}>
            <option value="" disabled>
              {decks.isPending ? "Loading your decks…" : "Pick a deck"}
            </option>
            {decks.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.folder ? ` (${d.folder})` : ""}
              </option>
            ))}
          </select>
          <button className="quiet" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setOpen(true)}>{deck.deck_id ? "Link another deck" : "Link a Yama deck"}</button>
        </div>
      )}
      <ErrorText error={link.error ?? decks.error} />
    </section>
  );
}

// ── Ideas for the planner ───────────────────────────────────────────────────

/**
 * "Suggest a change": an imported plan can't be edited here (its export owns it), so an idea goes
 * to the planner's inbox as an `idea` op, with what the planner later did with it.
 */
function Ideas({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const userId = useMe().data?.id;
  const box = useOutbox(userId);
  const [open, setOpen] = useState(false);
  const [inn, setInn] = useState("");
  const [out, setOut] = useState("");
  const [why, setWhy] = useState("");
  const [saved, setSaved] = useState(false);
  const sent = view.b.inputs.ideas.filter((i) => i.deck_key === deck.key);
  const local = [...box.sent.map((x) => x.op), ...box.pending].filter((op): op is IdeaOp => op.kind === "idea" && op.deck_key === deck.key && !sent.some((i) => i.op_id === op.op_id));
  const pendingIds = new Set(box.pending.map((op) => op.op_id));
  const submit = () => {
    if (!userId || !inn.trim()) return;
    outbox.enqueue(userId, {
      kind: "idea", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), deck_key: deck.key,
      in: inn.trim(), out: out.trim() || null, why: why.trim() || null,
    });
    setInn("");
    setOut("");
    setWhy("");
    setOpen(false);
    setSaved(true);
  };
  return (
    <section className="plan-link stack">
      <h3>Ideas for your planner</h3>
      <p className="dim small">
        {deck.source === "import"
          ? `Suggestions go to your ${view.app} inbox; they don't edit the plan.`
          : "Suggest a change to come back to."}
      </p>
      {(sent.length > 0 || local.length > 0) && (
        <ul className="small">
          {local.map((i) => (
            <li key={i.op_id}>
              {i.in}
              {i.out ? ` for ${i.out}` : ""}
              {i.why ? `: ${i.why}` : ""} <span className="faint">{pendingIds.has(i.op_id) ? "Saved on this phone, waiting to sync." : "Saved in Yama."}</span>
            </li>
          ))}
          {sent.map((i) => (
            <li key={i.op_id}>
              {i.in}
              {i.out ? ` for ${i.out}` : ""}
              {i.why ? `: ${i.why}` : ""}{" "}
              <span className="faint">
                {fmtDate(i.at)}.{" "}
                {i.outcome ? `${i.outcome}.` : i.seq <= (view.b.inputs.pulled_through ?? 0) ? `Picked up by ${view.app}.` : `Waiting for ${view.app} to pick it up.`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {saved && !open && <p className="small" role="status">Saved. It goes to your planner's inbox.</p>}
      {open ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label>
            Card to put in
            <input value={inn} onChange={(e) => setInn(e.target.value)} required maxLength={200} />
          </label>
          <label>
            Card to take out (optional)
            <input value={out} onChange={(e) => setOut(e.target.value)} maxLength={200} />
          </label>
          <label>
            Why (optional)
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={2000} />
          </label>
          <div className="row">
            <button className="primary" disabled={!inn.trim()}>Send to the inbox</button>
            <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button onClick={() => { setSaved(false); setOpen(true); }} disabled={!userId}>Suggest a change</button>
        </div>
      )}
    </section>
  );
}
