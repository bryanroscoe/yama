import { useMutation, useQuery } from "@tanstack/react-query";
import { identityName } from "@yama/core";
import { spares as planSpares } from "@yama/core/plan";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, ApiError, type DeckSummary, type DeckView, type SearchResult } from "../api";
import { useMe } from "../auth";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { CardImage, ErrorText, ManaCost } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
import { offlineSearch } from "../offline/cards";
import type { ExperimentDetail, ExperimentItem, NewExperiment, Pace, PreconDetail, TryPrefill } from "./api";
import { addsAndCuts, changeProblems, listDiff, stillIn, swap, swapCount, swapsFrom, swapText, type InCard, type Swap } from "./changes";
import { ConfidenceLine, ConfidenceNote } from "./confidence";
import { LabHead } from "./LabLayout";
import { experimentLabel, useBaseConfidence } from "./Run";
import { baseConfidence, baseConfidenceSentence, cantJudge, caveat, durationText, expectedSeconds, gameChoices, grouped, hasResults, identityQuery, playedCount, pointsRange, pointsWord, type BaseLine } from "./logic";
import { DeckChooser, defaultField, EnginePicker, EngineSupportNote, engineFields, engineState, engineText, FieldPicker, forgeSeconds, fromDeckSummary, GamesPicker, PLAN_STATES, RunBlockers, useField, usePace, usePlanLists, type Chosen, type EngineState, type FieldState } from "./pickers";
import { usePrecons } from "./Precons";

/** A chosen list with its lines loaded. */
interface LoadedBase extends Chosen {
  lines: BaseLine[];
}

/** A plan swap as the page uses it. */
interface PlanIdea {
  key: string;
  out: string | null;
  in: string;
  stage: string;
  why: string | null;
}

type CardInfo = ((name: string | null | undefined) => { color_identity: string; type_line: string; image_small: string | null; cmc: number } | undefined) | undefined;

function deckLines(d: DeckView): BaseLine[] {
  return d.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, type_line: c.card?.type_line ?? null, cmc: c.card?.cmc ?? null, image_small: c.card?.image_small ?? null, oracle_id: c.oracle_id }));
}

function preconLines(p: PreconDetail): BaseLine[] {
  return p.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, type_line: c.type_line, cmc: c.cmc, image_small: c.image_small, oracle_id: c.oracle_id }));
}

export function TryPage() {
  // Keyed on the query, so the bare "Try a change" link (or another ?precon=) starts afresh.
  const { search } = useLocation();
  return <TryForm key={search} />;
}

function TryForm() {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const prefill = (location.state as { prefill?: TryPrefill } | null)?.prefill;

  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [field, setField] = useState<FieldState>(() => {
    const f = prefill?.field;
    if (!f) return defaultField("precons_top");
    return { kind: f.kind, anchor: f.kind === "precons_near" ? (f.ids[0] ?? "") : "", myDecks: f.kind === "my_decks" ? f.ids : [] };
  });
  const [gamesPicked, setGames] = useState<number | null>(prefill?.games ?? null);
  const [engines, setEngines] = useState<EngineState>(() => engineState(prefill));
  const [name, setName] = useState("");
  const [swapping, setSwapping] = useState<string | null>(null);
  const opId = useRef(crypto.randomUUID());

  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const precons = usePrecons();
  const { lists: planLists, view: plan } = usePlanLists();
  const pace = usePace();
  const choices = gameChoices(pace.data);

  // Where the page starts: "Try again", ?deck=, ?precon= or ?plan=<deck>&state=<state>.
  const pendingPrefill = useRef(true);
  const parse = useMutation({
    mutationFn: (text: string) =>
      api<{ cards: { name: string; qty: number; board: "commander" | "main" | "side"; oracle_id: string }[]; unknown: string[] }>("/api/decks/parse", { method: "POST", json: { text, first_is_commander: true } }),
  });
  useEffect(() => {
    if (!pendingPrefill.current) return;
    const b = prefill?.base;
    const deckId = b?.kind === "deck" ? b.id : params.get("deck");
    const preconId = b?.kind === "precon" ? b.id : params.get("precon");
    const planKey = params.get("plan");
    if (deckId) {
      if (!decks.data) return;
      pendingPrefill.current = false;
      const d = decks.data.find((x) => x.id === deckId);
      if (d) setChosen(fromDeckSummary(d));
    } else if (preconId) {
      if (!precons.data) return;
      pendingPrefill.current = false;
      const p = precons.data.precons.find((x) => x.id === preconId);
      if (p)
        setChosen({
          choice: { kind: "precon", id: p.id },
          key: `precon:${p.id}`,
          label: p.name,
          sub: `${p.set_name ?? p.set_code} precon, stock list`,
          identity: p.color_identity,
          commanders: p.commanders,
          art: p.art ? { url: p.art.url, artist: p.art.artist } : null,
          precon: p.id,
          rated: p.rating?.strength != null,
          deckId: null,
        });
    } else if (planKey) {
      const c = planLists.find((l) => l.key === `plan:${planKey}:${params.get("state") ?? "stock"}`);
      if (c) {
        pendingPrefill.current = false;
        setChosen(c);
      }
    } else if (b?.kind === "list") {
      pendingPrefill.current = false;
      const fromPlan = planLists.find((l) => l.choice.kind === "list" && l.choice.text === b.text);
      if (fromPlan) setChosen(fromPlan);
      else
        parse.mutate(b.text, {
          onSuccess: (r) =>
            setChosen({
              choice: { kind: "list", text: b.text, ...(b.label ? { label: b.label } : {}) },
              key: "list",
              label: b.label ?? "Pasted list",
              sub: "A pasted list",
              identity: null,
              commanders: r.cards.filter((c) => c.board === "commander").map((c) => c.name),
              art: null,
              precon: null,
              rated: false,
              deckId: null,
              lines: r.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, oracle_id: c.oracle_id })),
            }),
        });
    } else pendingPrefill.current = false;
  }, [decks.data, precons.data, planLists]);
  // A prefilled change arrives once the list is known.
  const prefilledChange = useRef(false);
  useEffect(() => {
    if (prefilledChange.current || !prefill || !chosen) return;
    prefilledChange.current = true;
    setSwaps(swapsFrom(prefill.add, prefill.cut, prefill.pairs ?? []));
  }, [chosen]);

  const deck = useQuery({ queryKey: ["deck", chosen?.deckId], queryFn: () => api<DeckView>(`/api/decks/${chosen!.deckId}`), enabled: !!chosen?.deckId });
  const precon = useQuery({ queryKey: ["lab", "precon", chosen?.precon], queryFn: () => api<PreconDetail>(`/api/precons/${chosen!.precon}`), enabled: !!chosen?.precon });

  const base: LoadedBase | null = useMemo(() => {
    if (!chosen) return null;
    if (chosen.lines) return { ...chosen, lines: chosen.lines };
    if (chosen.deckId && deck.data) return { ...chosen, lines: deckLines(deck.data), identity: deck.data.validation.color_identity };
    if (chosen.precon && precon.data) return { ...chosen, lines: preconLines(precon.data) };
    return null;
  }, [chosen, deck.data, precon.data]);

  const choose = (c: Chosen | null) => {
    setSwaps([]);
    setSwapping(null);
    setChosen(c);
  };

  // The plan deck behind the base: a plan list, or one of your decks a plan is linked to.
  const planDeck = useMemo(() => {
    if (!plan || !chosen) return null;
    if (chosen.plan) return plan.deck(chosen.plan.deck) ?? null;
    if (chosen.deckId) return plan.b.decks.find((d) => d.deck_id === chosen.deckId) ?? null;
    return null;
  }, [plan, chosen]);
  const planSwaps: PlanIdea[] = useMemo(
    () => (planDeck && plan ? plan.swapsOf(planDeck.key).filter((s) => !s.retired && s.in && s.out).map((s) => ({ key: s.key, out: s.out, in: s.in, stage: s.stage, why: s.why })) : []),
    [planDeck, plan],
  );
  const planPairs = useMemo(() => planSwaps.map((s) => [s.out!, s.in] as [string, string]), [planSwaps]);
  const spareCards = useMemo(() => {
    if (!plan) return [];
    const sp = planSpares(plan.b, plan.answers);
    const names = new Set<string>();
    for (const s of [...sp.now, ...sp.before, ...sp.extras]) if (s.free) names.add(s.card);
    return [...names];
  }, [plan]);
  const cardInfo: CardInfo = plan ? (n) => plan.card(n) : undefined;

  const count = base ? swapCount(base.lines, swaps) : 0;
  const changed = swaps.length > 0;
  const { blocking, warnings } = base ? changeProblems(base.lines, swaps, base.identity) : { blocking: [], warnings: [] };
  const anchor = base ? { label: base.label, precon: base.precon, rated: base.rated, commanders: base.commanders } : null;
  const fieldPick = useField(field, anchor, base?.deckId ? [base.deckId] : []);
  // Whether the simulator can judge the base at all: said before the run, and beside its verdict.
  const conf = base ? baseConfidence(precons.data?.precons ?? [], { precon: base.precon, commanders: base.commanders }) : null;

  const solo = !!base && !changed;
  const games = gamesPicked != null && choices.includes(gamesPicked) ? gamesPicked : choices.includes(200) ? 200 : (choices[0] ?? 100);
  const phaseEta = expectedSeconds(pace.data, games);
  const forgeEta = forgeSeconds(pace.data, games);
  const eta = engines.mode === "phase" ? phaseEta : engines.mode === "forge" ? forgeEta : phaseEta != null && forgeEta != null ? Math.max(phaseEta, forgeEta) : null;

  const blockers: { text: string; href?: string; link?: string }[] = [];
  if (!chosen) blockers.push({ text: "Choose a list to start from.", href: "#try-1", link: "Step 1" });
  else if (!base) blockers.push({ text: "Loading the list…" });
  else {
    if (changed) for (const b of blocking) blockers.push({ text: b, href: "#try-2", link: "Fix it in step 2" });
    if (base.commanders.length === 0) blockers.push({ text: "The list needs a commander." });
  }
  for (const p of fieldPick.problems) blockers.push({ text: p, href: "#try-3", link: "Step 3" });
  if (pace.data && !pace.data.available) blockers.push({ text: pace.data.message ?? "Simulations can't start on this server right now." });

  const create = useMutation({
    mutationFn: (mode: "change" | "solo") => {
      const body: NewExperiment = {
        op_id: opId.current,
        mode,
        base: base!.choice,
        ...(mode === "change" ? { variant: addsAndCuts(swaps) } : {}),
        field: fieldPick.choice,
        games,
        ...engineFields(engines),
        ...(name.trim() ? { name: name.trim() } : {}),
      };
      return api<ExperimentDetail>("/api/lab/experiments", { method: "POST", json: body });
    },
    onSuccess: (d) => navigate(`/decks/lab/runs/${d.id}`),
  });

  return (
    <>
      <LabHead title="Try a change" />
      <p className="dim lab-try-intro">
        Swap cards in a list, then play the list and the changed copy against the same opponents, seats and shuffles. Or run a list as it is, or <Link to="/decks/lab/compare">compare two decks</Link>. {caveat()}
      </p>

      <div className="phone-only">
        <RunningNow />
      </div>
      <div className="lab-try">
        <div className="lab-try-main">
          <section className="lab-step" aria-labelledby="try-1-h" id="try-1">
            <h2 id="try-1-h">
              <span className="n">1.</span> Start from
            </h2>
            <DeckChooser value={chosen} onChange={choose} paste initial={!decks.data?.length && planLists.length ? "plan" : "deck"} />
            {chosen && !base && (deck.isFetching || precon.isFetching) && <p className="small dim">Loading the list…</p>}
            <ErrorText error={deck.error ?? (precon.error instanceof ApiError && precon.error.status === 404 ? new Error(`No precon has the id "${chosen?.precon}".`) : precon.error)} />
            {conf && conf.confidence.level !== "ok" && (
              <ConfidenceNote level={conf.confidence.level} lead={baseConfidenceSentence(conf, "run")} reasons={conf.confidence.reasons} fold>
                {cantJudge(conf.confidence) && <p>You can still run it; the verdict will carry this warning.</p>}
              </ConfidenceNote>
            )}
          </section>

          {base && (
            <section className="lab-step" aria-labelledby="try-2-h" id="try-2">
              <div className="lab-step-head">
                <h2 id="try-2-h">
                  <span className="n">2.</span> Swap cards
                </h2>
                <span className={`lab-total ${count === 100 ? "ok" : "off"}`} aria-live="polite">
                  {count} cards{count === 100 ? "" : count < 100 ? `, ${100 - count} short` : `, ${count - 100} too many`}
                </span>
              </div>
              {planDeck && <PlanShortcuts deckName={planDeck.name} base={base} planLists={planLists.filter((l) => l.plan?.deck === planDeck.key)} swaps={swaps} setSwaps={setSwaps} planSwaps={planSwaps} pairs={planPairs} />}
              <ChangesPanel base={base} swaps={swaps} setSwaps={setSwaps} warnings={warnings} blocking={changed ? blocking : []} swapping={swapping} setSwapping={setSwapping} planSwaps={planSwaps} spares={spareCards} cardInfo={cardInfo} />
              <DeckList base={base} swaps={swaps} setSwaps={setSwaps} swapping={swapping} setSwapping={setSwapping} planSwaps={planSwaps} spares={spareCards} cardInfo={cardInfo} />
              <details className="lab-cut-list">
                <summary>Add a card without cutting one</summary>
                <CardSearch identity={base.identity} inBase={(n) => base.lines.some((l) => l.name === n)} action="Add" onPick={(n, inCard) => setSwaps((s) => [...s, swap(null, n, { inCard })])} />
              </details>
            </section>
          )}

          <section className="lab-step" aria-labelledby="try-3-h" id="try-3">
            <h2 id="try-3-h">
              <span className="n">{base ? 3 : 2}.</span> Against
            </h2>
            <FieldPicker value={field} onChange={setField} anchor={anchor} excludeDecks={base?.deckId ? [base.deckId] : []} />
            <GamesPicker id="try-games" choices={choices} games={games} setGames={setGames} pace={pace.data} note={solo ? `${games} pods, each played once by the list as it is.` : `${games / 2} pods, each played by both lists.`} />
            <p className="lab-note" style={{ margin: 0 }}>
              <PaceNote pace={pace.data} error={pace.error} />
            </p>
          </section>
        </div>

        <aside className="lab-try-side" aria-label="Run">
          <div className="wide-only">
            <RunningNow />
          </div>
          <section className="lab-run" aria-labelledby="try-run">
            <h2 id="try-run">Run</h2>
            {!base ? (
              <p className="small dim" style={{ margin: 0 }}>
                Pick a list, swap cards in it, and choose who it plays against.
              </p>
            ) : changed ? (
              <p className="small" style={{ margin: 0 }}>
                <b>{base.label}</b>: {swapText(swaps)}. {games} games against {fieldPick.label}, {engineText(engines)}{eta != null ? `, ${durationText(eta)}` : ""}.
              </p>
            ) : (
              <div className="lab-asis">
                <p className="small" style={{ margin: 0 }}>
                  <b>No swaps yet.</b> You can run <b>{base.label}</b> as it is against {fieldPick.label} and see its win rate ({games} games, {engineText(engines)}{eta != null ? `, ${durationText(eta)}` : ""}).
                </p>
                <p className="small dim" style={{ margin: 0 }}>
                  To compare a change, <a href="#try-2">swap a card in step 2</a>. To compare two decks, or play your decks against each other, use <Link to="/decks/lab/compare">Compare decks</Link>.
                </p>
              </div>
            )}
            {conf && cantJudge(conf.confidence) && (
              <ConfidenceLine confidence={conf.confidence} name={conf.precon.name} method={precons.data?.run?.confidence?.method}>
                {baseConfidenceSentence(conf, "run")}
              </ConfidenceLine>
            )}
            {changed && warnings.length > 0 && (
              <ul className="lab-problems dim">
                {warnings.map((w) => (
                  <li key={w}>{w} It still plays; the run notes it.</li>
                ))}
              </ul>
            )}
            <EnginePicker id="try-engine" value={engines} onChange={setEngines} pace={pace.data} games={games} />
            {base && <EngineSupportNote lists={[base.choice]} names={changed ? addsAndCuts(swaps).add : []} mode={engines.mode} />}
            <label>
              <span>
                Name <span className="dim small" style={{ fontWeight: 400 }}>(optional)</span>
              </span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={base ? (changed ? `${base.label}: ${swapText(swaps)}` : `${base.label} as it is`) : "Named after the change"} maxLength={120} />
            </label>
            <CreateError error={create.error} />
            <RunBlockers items={blockers} />
            <button className="primary" onClick={() => create.mutate(solo ? "solo" : "change")} disabled={blockers.length > 0 || create.isPending || !me.data}>
              {create.isPending ? "Starting…" : solo ? `Run ${base!.label} as it is` : changed ? "Run the change" : "Run"}
            </button>
            <p className="lab-note" style={{ margin: 0 }}>
              {solo ? "Every pod is played once." : "Same shuffles and seats for both lists."}{engines.mode === "both" ? " Each engine plays the same pods." : ""} Simulated games, not your table. <Link to="/decks/lab/runs">My runs</Link>
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

/** Quick changes from the plan behind the base: its next list, or chosen planned swaps. */
function PlanShortcuts({
  deckName,
  base,
  planLists,
  swaps,
  setSwaps,
  planSwaps,
  pairs,
}: {
  deckName: string;
  base: LoadedBase;
  planLists: Chosen[];
  swaps: Swap[];
  setSwaps: (f: (s: Swap[]) => Swap[]) => void;
  planSwaps: PlanIdea[];
  pairs: [string, string][];
}) {
  const from = base.plan ? PLAN_STATES.findIndex((x) => x.id === base.plan!.state) : -1;
  const later = from < 0 ? [] : PLAN_STATES.slice(from + 1).filter((st) => planLists.some((l) => l.plan?.state === st.id && l.lines));
  const open = planSwaps.filter((s) => s.out && stillIn(base.lines, [], s.out) > 0 && !base.lines.some((l) => l.name === s.in && l.board !== "side"));
  const isOn = (s: PlanIdea) => swaps.some((x) => x.out === s.out && x.in === s.in);
  if (!later.length && !open.length) return null;
  return (
    <details className="lab-plan" open={swaps.length === 0}>
      <summary>From your plan for {deckName}</summary>
      {later.length > 0 && (
        <>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            {later.map((st) => {
              const target = planLists.find((l) => l.plan?.state === st.id)!;
              return (
                <button key={st.id} type="button" onClick={() => setSwaps(() => listDiff(base.lines, target.lines!, pairs).map((s) => ({ ...s, note: `On the way to your ${st.label.toLowerCase()} list` })))}>
                  {PLAN_STATES[from]!.label} vs {st.label.toLowerCase()}
                </button>
              );
            })}
          </div>
          <p className="lab-note" style={{ margin: 0 }}>
            Fills in every swap between this list and the next one, paired the way your plan pairs them.
          </p>
        </>
      )}
      {open.length > 0 && (
        <fieldset className="seat" style={{ marginTop: 8 }}>
          <legend className="small dim">Or tick swaps from the plan that this list hasn't made yet</legend>
          {open.map((s) => (
            <label key={s.key} className="lab-plan-swap">
              <input
                type="checkbox"
                style={{ width: "auto", minHeight: 0 }}
                checked={isOn(s)}
                onChange={(e) =>
                  setSwaps((cur) => (e.target.checked ? [...cur, swap(s.out, s.in, { note: s.stage === "proposed" ? "Proposed in your plan" : "In your plan" })] : cur.filter((x) => !(x.out === s.out && x.in === s.in))))
                }
              />
              <span>
                {s.out} {"→"} <b>{s.in}</b>
                <span className="dim small">
                  {" "}
                  ({s.stage === "proposed" ? "proposed" : "planned"}){s.why ? `: ${s.why}` : ""}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </details>
  );
}

/** The swaps so far, out → in, with undo, the count and anything to fix. */
function ChangesPanel({
  base,
  swaps,
  setSwaps,
  warnings,
  blocking,
  swapping,
  setSwapping,
  planSwaps,
  spares,
  cardInfo,
}: {
  base: LoadedBase;
  swaps: Swap[];
  setSwaps: (f: (s: Swap[]) => Swap[]) => void;
  warnings: string[];
  blocking: string[];
  swapping: string | null;
  setSwapping: (s: string | null) => void;
  planSwaps: PlanIdea[];
  spares: string[];
  cardInfo: CardInfo;
}) {
  const art = useCardArt(swaps.flatMap((s) => [s.out, s.in].filter((x): x is string => !!x)));
  if (!swaps.length) {
    return <p className="small dim lab-diff-empty">No swaps yet. Tap Swap beside a card below to pick its replacement, or Cut to take it out.</p>;
  }
  const remove = (id: string) => setSwaps((s) => s.filter((x) => x.id !== id));
  return (
    <div className="lab-swaps" aria-live="polite">
      <div className="lab-swaps-head">
        <h3>Changes</h3>
        <button type="button" className="quiet" onClick={() => setSwaps(() => [])}>
          Clear all
        </button>
      </div>
      {swaps.map((s) => (
        <div key={s.id}>
          <div className={`lab-swap ${s.out && s.in ? "pair" : s.out ? "cut" : "add"}`}>
            <span className="lab-swap-side">
              {s.out ? <Crop src={art.get(s.out)?.art} size="md" /> : <span className="crop crop-md lab-swap-none" aria-hidden="true" />}
              <span className="lab-swap-name">{s.out ? <s>{s.out}</s> : <span className="dim">Nothing cut</span>}</span>
            </span>
            <span className="lab-swap-arrow" aria-hidden="true">
              {"→"}
            </span>
            <span className="lab-swap-side">
              {s.in ? <Crop src={art.get(s.in)?.art} size="md" /> : <span className="crop crop-md lab-swap-none" aria-hidden="true" />}
              <span className="lab-swap-name">
                {s.in ? (
                  <b>{s.in}</b>
                ) : (
                  <button type="button" className="quiet" onClick={() => setSwapping(`fill:${s.id}`)}>
                    Pick a replacement
                  </button>
                )}
              </span>
            </span>
            <button type="button" className="lab-diff-undo" aria-label={`Undo ${swapText([s])}`} onClick={() => remove(s.id)}>
              ×
            </button>
          </div>
          {s.note && (
            <p className="lab-note" style={{ margin: "2px 0 0 8px" }}>
              {s.note}
            </p>
          )}
          {swapping === `fill:${s.id}` && (
            <SwapPicker
              out={s.out}
              base={base}
              planSwaps={planSwaps}
              spares={spares}
              cardInfo={cardInfo}
              onClose={() => setSwapping(null)}
              onPick={(name, inCard, note) => {
                setSwaps((cur) => cur.map((x) => (x.id === s.id ? { ...x, in: name, inCard, note } : x)));
                setSwapping(null);
              }}
            />
          )}
        </div>
      ))}
      {art.size > 0 && (
        <p className="small dim" style={{ margin: 0 }}>
          {artCredits(swaps.flatMap((s) => [s.out, s.in]).map((n) => (n ? art.get(n)?.artist : undefined)))}
        </p>
      )}
      {(blocking.length > 0 || warnings.length > 0) && (
        <ul className="lab-problems">
          {blocking.map((b) => (
            <li key={b} className="error">
              {b}
            </li>
          ))}
          {warnings.map((w) => (
            <li key={w} className="dim">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The base list by type; each card has Swap (pick its replacement right there) and Cut. */
function DeckList({
  base,
  swaps,
  setSwaps,
  swapping,
  setSwapping,
  planSwaps,
  spares,
  cardInfo,
}: {
  base: LoadedBase;
  swaps: Swap[];
  setSwaps: (f: (s: Swap[]) => Swap[]) => void;
  swapping: string | null;
  setSwapping: (s: string | null) => void;
  planSwaps: PlanIdea[];
  spares: string[];
  cardInfo: CardInfo;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const lines = base.lines.filter((l) => l.board !== "side" && (!needle || l.name.toLowerCase().includes(needle)));
  const keep = (name: string) =>
    setSwaps((s) => {
      const i = s.map((x) => x.out).lastIndexOf(name);
      return i < 0 ? s : [...s.slice(0, i), ...s.slice(i + 1)];
    });
  return (
    <div className="lab-decklist-try">
      <div className="lab-swaps-head">
        <h3>{base.label}</h3>
        <span className="small dim">{playedCount(base.lines)} cards</span>
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a card in the list" aria-label="Find a card in the list" style={{ marginBottom: "0.4rem" }} />
      <div className="lab-pick lab-pick-tall">
        {grouped(lines).map(([group, items]) => (
          <div key={group}>
            <p className="small dim" style={{ margin: "0.6rem 0 0.1rem", fontWeight: 700 }}>
              {group} <span className="num">{items.reduce((n, l) => n + l.qty, 0)}</span>
            </p>
            {items.map((l) => {
              const left = l.board === "main" ? stillIn(base.lines, swaps, l.name) : 0;
              const cutN = l.board === "main" ? l.qty - left : 0;
              const gone = l.board === "main" && left === 0;
              const planned = planSwaps.some((p) => p.out === l.name);
              return (
                <div key={`${l.name}-${l.board}`}>
                  <div className={`lab-row${gone ? " lab-cut" : ""}`}>
                    <CardImage src={l.image_small} name={l.name} className="thumb" />
                    <span className="name">
                      {l.qty > 1 ? `${l.qty} ` : ""}
                      {l.name}
                      {l.board === "commander" && <span className="lab-cut-mark"> commander</span>}
                      {cutN > 0 && <span className="lab-cut-mark"> {l.qty > 1 ? `${cutN} of ${l.qty} out` : "out"}</span>}
                      {planned && cutN === 0 && <span className="lab-plan-mark"> your plan swaps this</span>}
                    </span>
                    {l.board === "main" && (
                      <span className="lab-row-actions">
                        {left > 0 ? (
                          <>
                            <button type="button" className={swapping === l.name ? "primary" : ""} aria-expanded={swapping === l.name} onClick={() => setSwapping(swapping === l.name ? null : l.name)} aria-label={`Swap ${l.name}`}>
                              Swap
                            </button>
                            <button type="button" className="quiet" onClick={() => setSwaps((s) => [...s, swap(l.name, null)])} aria-label={`Cut ${l.name}`}>
                              Cut
                            </button>
                          </>
                        ) : (
                          <button type="button" className="quiet" onClick={() => keep(l.name)} aria-label={`Keep ${l.name}`}>
                            Keep
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {swapping === l.name && (
                    <SwapPicker
                      out={l.name}
                      base={base}
                      planSwaps={planSwaps}
                      spares={spares}
                      cardInfo={cardInfo}
                      onClose={() => setSwapping(null)}
                      onPick={(name, inCard, note) => {
                        setSwaps((s) => [...s, swap(l.name, name, { inCard, note })]);
                        setSwapping(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {lines.length === 0 && <p className="small dim">No card matches.</p>}
      </div>
    </div>
  );
}

/** Pick what replaces `out`: your plan's ideas and spares first, then any card that fits. */
function SwapPicker({
  out,
  base,
  planSwaps,
  spares,
  cardInfo,
  onPick,
  onClose,
}: {
  out: string | null;
  base: LoadedBase;
  planSwaps: PlanIdea[];
  spares: string[];
  cardInfo: CardInfo;
  onPick: (name: string, inCard: InCard | undefined, note?: string) => void;
  onClose: () => void;
}) {
  const identity = base.identity;
  const inList = (n: string) => base.lines.some((l) => l.board !== "side" && l.name === n);
  const fits = (n: string) => {
    const ci = cardInfo?.(n)?.color_identity;
    if (identity == null || ci == null) return true;
    const allowed = identity.toUpperCase();
    return [...ci.toUpperCase()].every((k) => !"WUBRG".includes(k) || allowed.includes(k));
  };
  const info = (n: string): InCard | undefined => {
    const c = cardInfo?.(n);
    return c ? { color_identity: c.color_identity, type_line: c.type_line, image_small: c.image_small, cmc: c.cmc } : undefined;
  };
  const ideas: { name: string; note: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, note: string) => {
    if (seen.has(name) || inList(name) || !fits(name)) return;
    seen.add(name);
    ideas.push({ name, note });
  };
  for (const p of planSwaps) if (out && p.out === out) add(p.in, p.stage === "proposed" ? "Proposed in your plan for this card" : "Your plan swaps this card for it");
  for (const p of planSwaps) add(p.in, p.stage === "proposed" ? "Proposed in your plan" : "In your plan");
  for (const n of spares) add(n, "A spare: out of one of your decks");
  return (
    <div className="lab-picker" role="group" aria-label={out ? `Replace ${out}` : "Pick a replacement"}>
      <div className="lab-swaps-head">
        <b>{out ? `Replace ${out} with…` : "Pick a card"}</b>
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {ideas.length > 0 && (
        <div className="lab-pick" style={{ maxHeight: "14rem" }}>
          {ideas.slice(0, 8).map((i) => {
            const c = info(i.name);
            return (
              <div key={i.name} className="lab-line" style={{ gridTemplateColumns: "2rem 1fr auto" }}>
                <CardImage src={c?.image_small ?? null} name={i.name} className="thumb" />
                <span className="name">
                  {i.name}
                  <br />
                  <span className="dim small">{i.note}</span>
                </span>
                <button type="button" onClick={() => onPick(i.name, c, i.note)} aria-label={`Use ${i.name}`}>
                  Use
                </button>
              </div>
            );
          })}
        </div>
      )}
      <CardSearch identity={identity} inBase={inList} action="Use" autoFocus onPick={(n, c) => onPick(n, c)} />
    </div>
  );
}

const isNetworkError = (e: unknown) => e instanceof TypeError || !navigator.onLine;

/** Card search (the Cards page's endpoint, offline fallback), with what you own marked. */
function CardSearch({ identity, onPick, inBase, action, autoFocus = false }: { identity: string | null; onPick: (name: string, card: InCard) => void; inBase: (name: string) => boolean; action: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [fits, setFits] = useState(true);
  const [ownedFirst, setOwnedFirst] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(t);
  }, [draft]);
  const idq = fits ? identityQuery(identity) : "";
  const query = q ? `${q} ${idq}`.trim() : "";
  const results = useQuery({
    queryKey: ["search", query, "edhrec", 1],
    queryFn: async (): Promise<SearchResult> => {
      try {
        return await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(query)}&order=edhrec&page=1`);
      } catch (e) {
        if (isNetworkError(e)) return offlineSearch(query, "edhrec", 1);
        throw e;
      }
    },
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
  });
  type Hit = SearchResult["cards"][number] & { owned?: number; owned_in?: string | null };
  const hits = ((results.data?.cards ?? []) as Hit[]).slice(0, 24);
  const shown = (ownedFirst ? [...hits].sort((a, b) => Number((b.owned ?? 0) > 0) - Number((a.owned ?? 0) > 0)) : hits).slice(0, 12);
  return (
    <div>
      <form
        className="stack"
        style={{ gap: "0.4rem" }}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Card name, or Scryfall syntax like t:instant o:destroy" aria-label="Search cards" autoCapitalize="off" autoCorrect="off" autoFocus={autoFocus} />
        <div className="row" style={{ gap: "1rem", flexWrap: "wrap" }}>
          {identity != null && (
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
              <input type="checkbox" checked={fits} onChange={(e) => setFits(e.target.checked)} style={{ width: "auto", minHeight: 0 }} />
              <span className="small">Within the commander's colours ({identityName(identity)})</span>
            </label>
          )}
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" checked={ownedFirst} onChange={(e) => setOwnedFirst(e.target.checked)} style={{ width: "auto", minHeight: 0 }} />
            <span className="small">Cards I own first</span>
          </label>
        </div>
      </form>
      <ErrorText error={results.error} />
      {query && results.data && (
        <div className="lab-pick" style={{ marginTop: "0.5rem" }}>
          {shown.map((c) => (
            <div key={c.oracle_id} className="lab-line" style={{ gridTemplateColumns: "2rem 1fr auto" }}>
              <CardImage src={c.image_small} name={c.name} className="thumb" />
              <span className="name">
                {c.name} <ManaCost cost={c.mana_cost} />
                <br />
                <span className="dim small">
                  {c.type_line}
                  {inBase(c.name) ? ", already in the list" : ""}
                  {(c.owned ?? 0) > 0 ? `, you own ${c.owned}${c.owned_in ? ` (in ${c.owned_in})` : ""}` : ""}
                </span>
              </span>
              <button type="button" onClick={() => onPick(c.name, { type_line: c.type_line, color_identity: c.color_identity, image_small: c.image_small, mana_cost: c.mana_cost, cmc: c.cmc })} aria-label={`${action} ${c.name}`}>
                {action}
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="small dim">No cards match.</p>}
          {results.data.total > 12 && <p className="small dim">{results.data.total.toLocaleString()} cards match; showing the 12 most played. Narrow the search for others.</p>}
        </div>
      )}
    </div>
  );
}

/** Your experiment that's playing now, if any: its progress and its answer so far. */
export function RunningNow() {
  const exps = useQuery({
    queryKey: ["lab", "experiments"],
    queryFn: () => api<ExperimentItem[]>("/api/lab/experiments"),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "queued" || e.status === "running") ? 5000 : false),
  });
  const e = exps.data?.find((x) => x.status === "running") ?? exps.data?.find((x) => x.status === "queued");
  if (!e) return null;
  return <RunningBox e={e} />;
}

function RunningBox({ e }: { e: ExperimentItem }) {
  const p = e.progress;
  const s = e.summary && hasResults(e.summary) ? e.summary : null;
  const conf = useBaseConfidence(e);
  const mode = e.mode ?? "change";
  return (
    <section className="lab-running" aria-label="Running now">
      <h2>{e.status === "running" ? "Running" : "Waiting"}</h2>
      <span className="lab-progress" role="progressbar" aria-label="Games played" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
        <span style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
      </span>
      <span className="small dim">
        {e.name}: {p.done} of {p.total} games{p.eta_seconds != null ? `, ${durationText(p.eta_seconds)} left` : ""}. You can leave this page.
      </span>
      {s && (
        <div className="lab-sofar">
          <span className="small dim">So far</span>
          {mode === "change" && s.paired.delta_win_rate != null ? (
            <>
              <b>{s.verdict.kind === "unclear" ? "Can't tell yet" : s.verdict.kind === "better" ? "Probably better" : "Probably worse"}</b>
              <span className="small">
                {`${pointsWord(s.paired.delta_win_rate)} so far`}
                {s.paired.delta_ci ? `, ${Math.round(s.level * 100)}% interval ${pointsRange(s.paired.delta_ci)}` : ""}.
              </span>
            </>
          ) : (
            <span className="small">{s.verdict.text}.</span>
          )}
          {conf && cantJudge(conf.confidence) && (
            <ConfidenceLine confidence={conf.confidence} name={conf.precon.name}>
              {baseConfidenceSentence(conf, "verdict")}
            </ConfidenceLine>
          )}
        </div>
      )}
      <span className="lab-note">{experimentLabel(e)}.</span>
      <Link className="button outline" to={`/decks/lab/runs/${e.id}`}>
        Open the run
      </Link>
    </section>
  );
}

/** Where the expected times come from, or why there are none. */
export function PaceNote({ pace, error }: { pace: Pace | undefined; error: unknown }) {
  if (error) return <>Couldn't get the lab's pace, so there's no time estimate.</>;
  if (!pace) return null;
  if (pace.threads === 0) return <>The lab plays no games on this server (it's turned off), so there's no time estimate.</>;
  if (pace.estimates.length === 0) return <>No games have been played on this server yet, so there's no time estimate.</>;
  const at = `${pace.threads} ${pace.threads === 1 ? "game" : "games"} at a time`;
  const after = pace.your_pending ? `, after the ${pace.your_pending} games your other runs still have to play` : "";
  const from =
    pace.seconds_per_game != null
      ? `Times are from the lab's ${pace.basis === "recent" ? `pace over the last hour (${pace.sample ?? 0} games)` : "average game length"}, ${at}${after}.`
      : `Times are rough, rounded up to 5 minutes, from how fast the lab has been playing (${at})${after}.`;
  return <>{from} Other people's runs can add to that.</>;
}

/** Errors from creating a run, with the names and problems the server lists per list. */
export function CreateError({ error, names }: { error: unknown; names?: string[] }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : undefined;
  const perList = (key: string) => {
    const v = body?.[key] as { base?: string[]; variant?: string[]; entrants?: Record<string, string[]> } | undefined;
    if (!v) return [];
    const label = (i: number, fallback: string) => names?.[i] ?? fallback;
    return [
      ...(v.base ?? []).map((x) => `${label(0, "Base list")}: ${x}`),
      ...(v.variant ?? []).map((x) => `${label(1, "Changed list")}: ${x}`),
      ...Object.entries(v.entrants ?? {}).flatMap(([i, xs]) => xs.map((x) => `${label(Number(i), `Deck ${Number(i) + 1}`)}: ${x}`)),
    ];
  };
  const details = [...perList("unknown"), ...perList("problems")];
  return (
    <div role="alert">
      <p className="error small" style={{ margin: 0 }}>
        {error instanceof Error ? error.message : String(error)}
      </p>
      {details.length > 0 && (
        <ul className="lab-problems error">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
