import { GROUP_ORDER, groupOf, identityName } from "@yama/core";
import {
  bagSource,
  bracketBuilds,
  cardCount,
  deckChanges,
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
  type PlanDeck,
  type PlanGroup,
  type Slot,
  type StateName,
  type Swap,
} from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { ErrorText, Pips } from "../components/ui";
import { linkDeck, makeYamaDeck } from "./api";
import { usePlanOutlet } from "./PlanLayout";
import { ArtPanel, CopyButton, StatusTag, Thumb } from "./parts";
import type { PlanView } from "./view";

const TABS = [
  { id: "changes", label: "Changes" },
  { id: "stock", label: "Stock" },
  { id: "now", label: "Now" },
  { id: "after", label: "After prints" },
  { id: "brackets", label: "Brackets" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const LIST_ABOUT: Record<"stock" | "now" | "after", string> = {
  stock: "The precon as it came out of the box, with the plan's commander.",
  now: "Every swap whose card is in hand. This is the plan, not what's in your deck box.",
  after: "The full plan once your prints arrive.",
};

/** `/decks/plan/d/:key`: one plan deck. */
export function DeckPlan() {
  const { key = "" } = useParams();
  const { view } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "changes") as TabId;
  const deck = view.deck(key);

  if (!deck) {
    return (
      <>
        <p className="small"><Link to="/decks/plan">Plans</Link></p>
        <p className="empty">There's no plan deck called "{key}" in your plans.</p>
      </>
    );
  }
  const notes = deck.notes;
  const questions = notes.filter((n) => n.kind === "open_question");
  const warnings = [...notes.filter((n) => n.kind === "warning").map((n) => n.text), ...deckWarnings(deck, view.b.head?.warnings ?? [], view.b.head?.export_warnings ?? [])];
  const other = notes.filter((n) => n.kind === "note");

  return (
    <>
      <p className="small"><Link to="/decks/plan">Plans</Link></p>
      <ArtPanel art={view.art(deck)} className="plan-hero">
        <h1>{deck.name}</h1>
        <p className="plan-deck-commander">
          {deck.commander.join(" and ")} <Pips identity={deck.color_identity ?? ""} /> <span className="dim">{identityName(deck.color_identity ?? "")}</span>
        </p>
        <p className="small dim">
          {deck.product ? `${deck.product}. ` : ""}
          {deck.source === "import" ? "Planned outside Yama; read-only here." : "Made in Yama."}
          {deck.status === "proposals_only" ? " Proposals only: no swaps are approved yet, so stock, now and after prints are the same list." : ""}
          {deck.status === "archived" ? " The latest import didn't include this deck." : ""}
        </p>
      </ArtPanel>

      {questions.length > 0 && (
        <section className="plan-notes">
          <h3>Open questions</h3>
          <ul>
            {questions.map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
          </ul>
        </section>
      )}
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
        <ul className="small dim">
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

      {tab === "changes" && <ChangesTab deck={deck} view={view} />}
      {(tab === "stock" || tab === "now" || tab === "after") && <ListTab deck={deck} view={view} state={tab} />}
      {tab === "brackets" && <BracketsTab deck={deck} view={view} />}

      <LinkDeck deck={deck} />
    </>
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────

function ChangesTab({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const swaps = view.swapsOf(deck.key);
  const c = useMemo(() => deckChanges(deck.key, deck.groups, swaps), [deck, swaps]);
  const logs = useMemo(() => deckLogs(deck), [deck]);
  const row = (s: Swap) => <SwapRow key={s.key} s={s} view={view} logs={logs} standins={c.standins.get(s.key) ?? []} />;
  const nothing = !c.now.length && !c.prints.length && !c.optional.length && !c.proposed.length && !c.loose.length;
  return (
    <div className="stack">
      {nothing && <p className="empty">No swaps or proposals for this deck yet.</p>}
      {c.now.length > 0 && (
        <section>
          <h3>Swap in now <span className="dim num">{c.now.length}</span></h3>
          <div className="list">{c.now.map(row)}</div>
        </section>
      )}
      {c.prints.length > 0 && (
        <section>
          <h3>When your prints arrive <span className="dim num">{c.prints.length}</span></h3>
          <div className="list">{c.prints.map(row)}</div>
        </section>
      )}
      {c.loose.length > 0 && (
        <section>
          <h3>Stand-ins <span className="dim num">{c.loose.length}</span></h3>
          <div className="list">{c.loose.map(row)}</div>
        </section>
      )}
      {c.optional.length > 0 && (
        <section>
          <h3>Optional extras <span className="dim num">{c.optional.length}</span></h3>
          <p className="dim small">Cards you have for this deck that the plan doesn't need a slot for.</p>
          <div className="list">{c.optional.map(row)}</div>
        </section>
      )}
      {c.proposed.length > 0 && (
        <section className="stack">
          <h3>Proposed, not in the plan <span className="dim num">{c.proposed.reduce((n, g) => n + g.swaps.length, 0)}</span></h3>
          {deck.source === "import" && (
            <p className="dim small">Answer these in your planner for now. A want joins the plan when the plan is updated there.</p>
          )}
          {c.proposed.length > 1 && deck.groups.length > 1 && (
            <p className="dim small">Each group builds on the ones before it.</p>
          )}
          {c.proposed.map((g) => (
            <div key={g.group?.label ?? "none"}>
              {(g.group || c.proposed.length > 1) && (
                <h4 className="plan-group-head">
                  {g.group ? g.group.label : "Other proposals"}
                  {g.group?.bracket != null && <span className="tag">Bracket {g.group.bracket}</span>}
                </h4>
              )}
              {g.group?.note && <p className="dim small">{g.group.note}</p>}
              <div className="list">{g.swaps.map(row)}</div>
            </div>
          ))}
          <ProposedBuild deck={deck} view={view} />
        </section>
      )}
    </div>
  );
}

function SwapRow({ s, view, logs, standins }: { s: Swap; view: PlanView; logs: ReturnType<typeof deckLogs>; standins: Swap[] }) {
  const status = swapStatus(s, logs, view.deckName);
  const answer = view.answers.get(s.key);
  const market = s.stage === "proposed" && s.src !== "owned" ? view.b.market[view.oracleId(s.in) ?? ""] : undefined;
  const marketKnown = s.stage === "proposed" && s.src !== "owned" && !!view.oracleId(s.in);
  return (
    <div className="swap-row">
      <div className="swap-thumbs">
        {s.out ? <Thumb name={s.out} card={view.card(s.out)} oracleId={view.oracleId(s.out)} dim /> : <span className="plan-thumb-empty" aria-hidden />}
        <span className="swap-arrow" aria-hidden>→</span>
        <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} />
      </div>
      <div className="swap-body">
        <p className="swap-title">
          <b>{s.in}</b>
          {s.out ? <span className="dim"> for {s.out}</span> : <span className="dim"> (no slot)</span>}
        </p>
        <div className="row swap-tags">
          {s.role === "standin" && <span className="tag">Stand-in</span>}
          {s.tier && <span className="tag">{s.tier}</span>}
          {status && <StatusTag {...status} />}
          {s.game_changer && <span className="tag">Game Changer</span>}
          {s.plan_card && s.plan_card !== s.in && <span className="tag">Budget pick for {s.plan_card}</span>}
          {s.upgrade && (s.upgrade.status === "installed" || s.upgrade.status === "skipped") && (
            <span className="tag">Planner says {s.upgrade.status}</span>
          )}
        </div>
        <p className="small dim">{swapSource(s, view.ctx)}</p>
        {s.when && <p className="small">{/^when\b/i.test(s.when) ? s.when : `When: ${s.when}`}</p>}
        {s.advice && <p className="small">{s.advice}</p>}
        {marketKnown && (
          <p className="small dim">
            {market ? `Market ${usd(market.usd)} for ${market.printing}, ${fmtDate(market.date)} (${market.source}).` : "Market: no price in Yama's price data."}
          </p>
        )}
        {s.later_out && <p className="small">Later cut (suggested, not in the plan): {s.later_out}</p>}
        {answer && <AnswerLine s={s} decision={answer.decision} note={answer.note} cut={answer.cut} />}
        {(s.why || s.why_out || s.note) && (
          <details className="small">
            <summary>Why</summary>
            {s.why && <p>{s.why}</p>}
            {s.why_out && <p className="dim">{s.out ? `${s.out}: ` : ""}{s.why_out}</p>}
            {s.note && <p className="dim">Note: {s.note}</p>}
          </details>
        )}
        {standins.map((st) => (
          <div key={st.key} className="swap-standin small">
            <span className="tag">Stand-in</span> <b>{st.in}</b> holds the slot until the print arrives. {swapSource(st, view.ctx)}
            {st.later_out && <> Later cut (suggested, not in the plan): {st.later_out}.</>}
          </div>
        ))}
      </div>
    </div>
  );
}

const DECISION: Record<string, string> = { want: "You want this", unsure: "You're unsure", no: "You said no" };

function AnswerLine({ s, decision, note, cut }: { s: Swap; decision: string | null; note: string | null; cut: string | null }) {
  return (
    <p className="small">
      {decision && <span className={`tag${decision === "want" ? " good" : decision === "no" ? " bad" : ""}`}>{DECISION[decision]}</span>}
      {cut && <> Cut: {cut}.</>}
      {note && <> {note}</>}
      {decision === "no" && s.stage === "planned" && (
        <span className="dim"> Nothing changes until you and your planner decide what to do with this swap.</span>
      )}
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
                    {c.name}
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
  if (builds.length === 1 && bracketGroups.length === 0) {
    return (
      <div className="stack">
        <p className="dim">This plan has no bracket builds.</p>
        {gc && <p className="small">After prints: {gcLine(after)} <span className="faint">{checked}</span></p>}
      </div>
    );
  }
  return (
    <div className="stack">
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
                        <b>{s.in}</b> <span className="dim">back for {s.out}</span>
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
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled: open || !!deck.deck_id });
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
        <p className="dim small">Link the Yama deck you play this as, so games logged with it sit next to the plan.</p>
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
