// Pieces the Lab's run pages share: choosing a deck (yours, a plan list, a precon, a pasted list),
// choosing the opponents, and the games and AI level.

import { useMutation, useQuery } from "@tanstack/react-query";
import { identityName, listText } from "@yama/core";
import { planView } from "../plan/view";
import { usePlan } from "../plan/store";
import { useMemo, useState, type ReactNode } from "react";
import { api, type DeckCard, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { ArtPanel, artCredit } from "../components/ArtPanel";
import { ErrorText, Pips, Segmented } from "../components/ui";
import { FORGE_PROFILES, type BaseChoice, type EngineMode, type EngineSupport, type FieldChoice, type Pace } from "./api";
import { forgeSeconds, type EngineState } from "./engines";
import { contactHref } from "../components/PowerOnly";
import { allowanceText, durationText, expectedSeconds, type BaseLine } from "./logic";
import { usePrecons } from "./Precons";

/** A list someone picked to play: what to send, and what the page shows about it. */
export interface Chosen {
  choice: BaseChoice;
  /** Unique per list: "deck:<id>", "precon:<slug>", "plan:<deck>:<state>" or "list". */
  key: string;
  label: string;
  /** Where it came from, in a few words. */
  sub: string;
  identity: string | null;
  commanders: string[];
  art: { url: string; artist: string | null } | null;
  /** A precon's slug. */
  precon: string | null;
  /** Whether it's a precon with a simulated strength (it sets "similar strength" itself). */
  rated: boolean;
  /** One of your decks. */
  deckId: string | null;
  /** A list from your plan. */
  plan?: { deck: string; state: PlanStateName };
  /** Its lines, when the page already has them (plan and pasted lists). */
  lines?: BaseLine[];
}

export type PlanStateName = "stock" | "now" | "after";
export const PLAN_STATES: { id: PlanStateName; label: string }[] = [
  { id: "stock", label: "Stock" },
  { id: "now", label: "Now" },
  { id: "after", label: "After prints" },
];

export function fromDeckSummary(d: DeckSummary): Chosen {
  return {
    choice: { kind: "deck", id: d.id },
    key: `deck:${d.id}`,
    label: d.name,
    sub: "One of your decks, its latest version",
    identity: d.color_identity ?? null,
    commanders: d.commanders,
    art: d.commander_image ? { url: d.commander_image, artist: d.commander_artist } : null,
    precon: null,
    rated: false,
    deckId: d.id,
  };
}

/** The plan's lists as choices: every plan deck's stock, now and after-prints lists. */
export function usePlanLists(): { lists: Chosen[]; view: ReturnType<typeof planView> | null } {
  const me = useMe();
  const plan = usePlan(me.data?.id);
  return useMemo(() => {
    if (!plan.bundle) return { lists: [], view: null };
    const view = planView(plan.bundle);
    const lists: Chosen[] = [];
    for (const deck of plan.bundle.decks) {
      if (deck.status === "archived") continue;
      for (const st of PLAN_STATES) {
        const state = deck.states[st.id];
        if (!state?.cards.length) continue;
        const lines: BaseLine[] = state.cards.map((c) => {
          const card = view.card(c.name);
          return { name: c.name, qty: c.qty, board: c.board, type_line: card?.type_line ?? null, cmc: card?.cmc ?? null, image_small: card?.image_small ?? null, oracle_id: view.oracleId(c.name) ?? null };
        });
        const art = view.art(deck);
        const artist = deck.commander.map((n) => view.card(n)).find((c) => c?.image_art_crop)?.artist ?? null;
        lists.push({
          choice: { kind: "list", text: listText(state.cards.map((c) => ({ qty: c.qty, name: c.name, board: c.board }))), label: `${deck.name}, ${st.label.toLowerCase()}` },
          key: `plan:${deck.key}:${st.id}`,
          label: `${deck.name}, ${st.label.toLowerCase()}`,
          sub: `Your plan's ${st.label.toLowerCase()} list`,
          identity: deck.color_identity,
          commanders: deck.commander,
          art: art ? { url: art, artist } : null,
          precon: null,
          rated: false,
          deckId: null,
          plan: { deck: deck.key, state: st.id },
          lines,
        });
      }
    }
    return { lists, view };
  }, [plan.bundle]);
}

type Source = "deck" | "plan" | "precon" | "list";

/**
 * Choose one list: one of your decks, a list from your plan, a precon, or (with `paste`) a pasted
 * list. Once chosen it shows as a card on the commander's art with a Change button.
 */
export function DeckChooser({
  value,
  onChange,
  exclude = [],
  paste = false,
  title,
  initial = "deck",
}: {
  value: Chosen | null;
  onChange: (c: Chosen | null) => void;
  /** Keys that can't be picked (already picked elsewhere). */
  exclude?: string[];
  paste?: boolean;
  title?: string;
  initial?: Source;
}) {
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const precons = usePrecons();
  const { lists: planLists } = usePlanLists();
  const [source, setSource] = useState<Source>(initial);
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const parse = useMutation({
    mutationFn: (t: string) => api<{ cards: DeckCard[]; unknown: string[] }>("/api/decks/parse", { method: "POST", json: { text: t, first_is_commander: true } }),
    onSuccess: (r, t) => {
      const lines: BaseLine[] = r.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, oracle_id: c.oracle_id }));
      onChange({
        choice: { kind: "list", text: t },
        key: "list",
        label: "Pasted list",
        sub: r.unknown.length ? `A pasted list. Not found, so left out: ${r.unknown.join(", ")}` : "A pasted list",
        identity: null,
        commanders: r.cards.filter((c) => c.board === "commander").map((c) => c.name),
        art: null,
        precon: null,
        rated: false,
        deckId: null,
        lines,
      });
    },
  });

  if (value) {
    return (
      <div className="lab-base">
        <ArtPanel art={value.art?.url} artist={value.art?.artist} wash="left" className="lab-base-art" credit={false}>
          <span className="lab-base-text">
            <b>{value.label}</b>
            <span>
              {value.sub}. {value.commanders.length ? value.commanders.join(" and ") : "No commander"}
              {value.identity != null && <> ({identityName(value.identity)})</>}.
            </span>
          </span>
          <button type="button" className="lab-base-change" onClick={() => onChange(null)}>
            Change
          </button>
        </ArtPanel>
        {value.art && <span className="small dim">{artCredit(value.art.artist)}</span>}
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const match = (...s: (string | null | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const sources: [Source, string][] = [
    ["deck", "My decks"],
    ...(planLists.length ? ([["plan", "Plan lists"]] as [Source, string][]) : []),
    ["precon", "Precons"],
    ...(paste ? ([["list", "Paste a list"]] as [Source, string][]) : []),
  ];
  const rows: Chosen[] =
    source === "deck"
      ? (decks.data ?? []).filter((d) => match(d.name, ...d.commanders)).map(fromDeckSummary)
      : source === "plan"
        ? planLists.filter((l) => match(l.label, ...l.commanders))
        : source === "precon"
          ? (precons.data?.precons ?? [])
              .filter((p) => match(p.name, ...p.commanders))
              .map((p) => ({
                choice: { kind: "precon", id: p.id } as BaseChoice,
                key: `precon:${p.id}`,
                label: p.name,
                sub: `${p.set_name ?? p.set_code} precon, stock list`,
                identity: p.color_identity,
                commanders: p.commanders,
                art: p.art ? { url: p.art.url, artist: p.art.artist } : null,
                precon: p.id,
                rated: p.rating?.strength != null,
                deckId: null,
              }))
          : [];
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      {title && <span className="lab-games-label">{title}</span>}
      <div className="lab-chips" role="radiogroup" aria-label={title ?? "Choose a deck"}>
        {sources.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={source === k} onClick={() => setSource(k)}>
            {label}
          </button>
        ))}
      </div>
      {source === "list" ? (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <label>
            Deck list
            <span className="hint">One card per line: "1 Sol Ring". Put the commander first or under a Commander heading.</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" onClick={() => parse.mutate(text)} disabled={!text.trim() || parse.isPending}>
              Use this list
            </button>
          </div>
          <ErrorText error={parse.error} />
        </div>
      ) : (
        <>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={source === "precon" ? "Find a precon by name or commander" : "Find a deck by name or commander"} aria-label="Find a deck" />
          <div className="lab-pick">
            {rows.slice(0, needle ? 30 : 12).map((c) => {
              const taken = exclude.includes(c.key);
              return (
                <button key={c.key} type="button" className="lab-line" onClick={() => onChange(c)} disabled={taken} style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="name">
                    <b>{c.label}</b>
                    <br />
                    <span className="dim small">
                      {c.commanders.join(" and ")}
                      {taken ? ", already picked" : ""}
                    </span>
                  </span>
                  {c.identity != null ? <Pips identity={c.identity} /> : <span />}
                </button>
              );
            })}
            {rows.length === 0 && (
              <p className="small dim">
                {source === "deck" ? (decks.isPending ? "Loading your decks…" : "No decks match.") : source === "precon" ? (precons.isPending ? "Loading the precons…" : "No precons match.") : "No plan lists match."}
              </p>
            )}
            {!needle && rows.length > 12 && <p className="small dim">{rows.length} to choose from; search to narrow them.</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ── opponents ────────────────────────────────────────────────────────────────

export type FieldKind = "precons_top" | "precons_near" | "precons_all" | "my_decks";
export const FIELD_N = 20;

export interface FieldState {
  kind: FieldKind;
  /** The precon that sets "similar strength" when the list has no rating of its own. */
  anchor: string;
  /** Your decks to play against (empty: all of them that can be simulated). */
  myDecks: string[];
}

export const defaultField = (kind: FieldKind = "precons_near"): FieldState => ({ kind, anchor: "", myDecks: [] });

/** The list that sets "similar strength", with what the page knows about it. */
export interface Anchor {
  label: string;
  precon: string | null;
  rated: boolean;
  commanders: string[];
}

/** A rated precon with the same commanders as `a`, for "similar strength" by default. */
function useAnchor(state: FieldState, a: Anchor | null) {
  const precons = usePrecons();
  const rated = useMemo(() => (precons.data?.precons ?? []).filter((p) => p.rating?.strength != null).sort((x, y) => x.name.localeCompare(y.name)), [precons.data]);
  const selfAnchor = !!a?.precon && a.rated;
  const same = useMemo(() => {
    if (!a || selfAnchor) return null;
    const mine = [...a.commanders].sort().join("|");
    return rated.find((p) => p.id !== a.precon && [...p.commanders].sort().join("|") === mine) ?? null;
  }, [a, selfAnchor, rated]);
  const anchorId = selfAnchor ? "" : state.anchor || same?.id || "";
  return { rated, selfAnchor, same, anchorId, run: precons.data?.run ?? null, count: precons.data?.precons.length };
}

/** The opponents to send, and what's missing before they can be sent. */
export function useField(state: FieldState, a: Anchor | null, excludeDecks: string[]): { choice: FieldChoice; problems: string[]; label: string } {
  const { selfAnchor, anchorId, run } = useAnchor(state, a);
  const precons = usePrecons();
  const choice: FieldChoice =
    state.kind === "precons_top"
      ? { kind: "precons_top", n: FIELD_N }
      : state.kind === "precons_near"
        ? { kind: "precons_near", n: FIELD_N, ids: anchorId ? [anchorId] : [] }
        : state.kind === "precons_all"
          ? { kind: "precons_all" }
          : { kind: "my_decks", ids: state.myDecks.filter((id) => !excludeDecks.includes(id)) };
  const problems: string[] = [];
  if (state.kind === "precons_near" && a && !selfAnchor && !anchorId) problems.push("Pick a precon to set the power level, under Similar power.");
  if ((state.kind === "precons_top" || state.kind === "precons_near") && precons.data && !run) problems.push("No rating run is imported yet, so there's no strength to choose by. Pick All precons or Your decks.");
  const picked = choice.kind === "my_decks" ? choice.ids.length : 0;
  const label =
    state.kind === "precons_top"
      ? `the strongest ${FIELD_N} precons`
      : state.kind === "precons_near"
        ? `the ${FIELD_N} precons nearest in strength`
        : state.kind === "precons_all"
          ? "all the precons"
          : picked
            ? picked < 3
              ? `${picked === 1 ? "one of your decks" : "two of your decks"} in every pod, with similar precons filling the other seats`
              : `${picked} of your decks`
            : "your decks";
  return { choice, problems, label };
}

/** Who the lists play against: similar power, the strongest, all precons, or your own decks. */
export function FieldPicker({
  value,
  onChange,
  anchor,
  excludeDecks = [],
  heading,
}: {
  value: FieldState;
  onChange: (f: FieldState) => void;
  anchor: Anchor | null;
  excludeDecks?: string[];
  heading?: ReactNode;
}) {
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const { rated, selfAnchor, same, anchorId, run, count } = useAnchor(value, anchor);
  const set = (patch: Partial<FieldState>) => onChange({ ...value, ...patch });
  const mine = (decks.data ?? []).filter((d) => !excludeDecks.includes(d.id));
  const picked = value.myDecks.filter((id) => !excludeDecks.includes(id)).length;
  return (
    <>
      {heading}
      <div className="lab-choices" role="radiogroup" aria-label="Opponents">
        <Choice on={value.kind === "precons_near"} pick={() => set({ kind: "precons_near" })} title="Similar power">
          {FIELD_N} precons nearest in strength to {selfAnchor ? anchor!.label : "a precon you pick"}.
        </Choice>
        <Choice on={value.kind === "precons_top"} pick={() => set({ kind: "precons_top" })} title={`Strongest ${FIELD_N}`}>
          {run ? `The top of the precon table (run ${run.name}).` : "Needs a rating run."}
        </Choice>
        <Choice on={value.kind === "precons_all"} pick={() => set({ kind: "precons_all" })} title="All precons">
          Every playable precon ({count ?? "…"}); each sits in only a pod or two.
        </Choice>
        <Choice on={value.kind === "my_decks"} pick={() => set({ kind: "my_decks" })} title="Your decks">
          {mine.length ? `${mine.slice(0, 3).map((d) => d.commanders[0] ?? d.name).join(", ")}${mine.length > 3 ? " and more" : ""}` : "Your own decks with 100 cards and a commander."}
        </Choice>
      </div>
      {value.kind === "precons_near" && anchor && !selfAnchor && (
        <label style={{ marginTop: "0.75rem" }}>
          Similar to
          <span className="hint">
            {anchor.precon ? `${anchor.label} has no simulated rating yet, so pick a precon about as strong. ` : ""}
            {same ? `${same.name} has the same commander.` : anchor.precon ? "" : "No rated precon has this commander; pick one about as strong as your list."}
          </span>
          <select value={anchorId} onChange={(e) => set({ anchor: e.target.value })}>
            <option value="">Choose a precon</option>
            {rated.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.kind === "my_decks" && (
        <fieldset className="seat" style={{ marginTop: "0.75rem" }}>
          <legend className="small dim">
            Leave all unticked to use every deck that can be simulated. Pods need three opponents: tick one or two and they sit in every pod, with precons of similar power filling the other seats.
          </legend>
          {mine.map((d) => (
            <label key={d.id} style={{ display: "flex", gap: "0.6rem", alignItems: "center", fontWeight: 400, minHeight: 44 }}>
              <input
                type="checkbox"
                style={{ width: "auto", minHeight: 0 }}
                checked={value.myDecks.includes(d.id)}
                onChange={(e) => set({ myDecks: e.target.checked ? [...value.myDecks, d.id] : value.myDecks.filter((x) => x !== d.id) })}
              />
              {d.name} <span className="dim small">({d.card_count} cards)</span>
            </label>
          ))}
          {picked > 0 && picked < 3 && <p className="small" style={{ margin: "0.4rem 0 0" }}>Your {picked === 1 ? "pick sits" : "picks sit"} in every pod; similar precons fill the other {picked === 1 ? "two seats" : "seat"}.</p>}
        </fieldset>
      )}
    </>
  );
}

export function Choice({ on, pick, title, children }: { on: boolean; pick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" className="lab-choice" role="radio" aria-checked={on} onClick={pick}>
      <b>{title}</b>
      <span>{children}</span>
    </button>
  );
}

// ── games and AI level ───────────────────────────────────────────────────────

/** Game counts this account may run (the server says), and the lab's pace. */
export function usePace() {
  return useQuery({ queryKey: ["lab", "pace"], queryFn: ({ signal }) => api<Pace>("/api/lab/pace", { signal }), refetchInterval: 60_000 });
}

export function GamesPicker({ choices, games, setGames, pace, note, id, label = "Games", estimateGames }: { choices: number[]; games: number; setGames: (g: number) => void; pace: Pace | undefined; note: ReactNode; id: string; label?: string; estimateGames?: number }) {
  const eta = expectedSeconds(pace, estimateGames ?? games);
  return (
    <div className="lab-games">
      <span id={id} className="lab-games-label">
        {label}
      </span>
      <Segmented labelledBy={id} value={games} onChange={setGames} options={choices.map((g) => [g, g] as const)} />
      <span className="lab-note">
        {note} More games narrow the uncertainty.
        {eta != null ? ` ${durationText(eta).replace(/^about/, "About")}.` : ""}
      </span>
      {pace?.allowance && (
        <span className="lab-note">
          {allowanceText(pace.allowance)} <a href={contactHref()}>Ask for a larger allowance</a>.
        </span>
      )}
    </div>
  );
}

/**
 * Why Run can't start yet, said beside the button rather than as a silently disabled button. Each
 * reason can carry a link to the step that fixes it.
 */
export function RunBlockers({ items }: { items: { text: string; href?: string; link?: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="lab-run-why" role="status">
      <b>Can't run yet</b>
      <ul>
        {items.map((b) => (
          <li key={b.text}>
            {b.text}
            {b.href && (
              <>
                {" "}
                <a href={b.href}>{b.link ?? "Show me"}</a>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── engines ──────────────────────────────────────────────────────────────────

export { engineFields, engineState, engineText, forgeSeconds, type EngineState } from "./engines";

const ENGINE_OPTIONS: { id: EngineMode; label: string }[] = [
  { id: "phase", label: "Phase" },
  { id: "forge", label: "Forge" },
  { id: "both", label: "Both" },
];

export function EnginePicker({ value, onChange, pace, games, id }: { value: EngineState; onChange: (e: EngineState) => void; pace: Pace | undefined; games: number; id: string }) {
  const forge = pace?.forge;
  const forgeOk = !!forge?.configured;
  const weight = pace?.forge_weight ?? 2;
  const fs = forgeSeconds(pace, games);
  const note =
    value.mode === "phase"
      ? "Phase: Yama's own rules engine. Fast."
      : value.mode === "forge"
        ? `Forge: a separate rules engine with its own AI. Its games take longer${fs != null ? ` (this run: ${durationText(fs)})` : ""}, and each counts as ${weight} against your daily games.`
        : `Every pod on each engine, side by side, with a flag when the two disagree. Each Forge game counts as ${weight} against your daily games.`;
  return (
    <div className="lab-games lab-engine">
      <span id={id} className="lab-games-label">
        Engine
      </span>
      <Segmented
        labelledBy={id}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        options={ENGINE_OPTIONS.map((o) => ({ value: o.id, label: o.label, disabled: o.id !== "phase" && !forgeOk }))}
      />
      <span className="lab-note">{forgeOk ? note : "Phase: Yama's own rules engine. Forge isn't set up on this server, so Phase is the only engine here."}</span>
      {forgeOk && value.mode !== "phase" && !forge?.online && <span className="lab-note lab-warn">The Forge worker isn't answering right now. You can still start the run; its Forge games wait until the worker is back.</span>}
      <div className="lab-engine-ai">
        {value.mode !== "forge" && (
          <label>
            {value.mode === "both" ? "Phase AI level" : "AI level"}
            <select value={value.difficulty} onChange={(e) => onChange({ ...value, difficulty: e.target.value })}>
              <option>Easy</option>
              <option>Medium</option>
            </select>
          </label>
        )}
        {value.mode !== "phase" && (
          <label>
            Forge AI
            <select value={value.forgeAi} onChange={(e) => onChange({ ...value, forgeAi: e.target.value })}>
              {FORGE_PROFILES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

/** Which cards of the lists a run would test each engine can't play (asked only when Forge plays). */
export function useEngineSupport(lists: BaseChoice[], names: string[], mode: EngineMode) {
  const key = JSON.stringify({ lists, names: [...names].sort() });
  return useQuery({
    queryKey: ["lab", "engine-support", key],
    queryFn: () => api<EngineSupport>("/api/lab/engines/check", { method: "POST", json: { lists, names } }),
    enabled: mode !== "phase" && lists.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** Before a run: the cards Forge (and phase) can't play in the lists it would test. */
export function EngineSupportNote({ lists, names, mode }: { lists: BaseChoice[]; names: string[]; mode: EngineMode }) {
  const q = useEngineSupport(lists, names, mode);
  if (mode === "phase" || !q.data) return null;
  const rows = [...q.data.lists, q.data.extra].filter((l) => (l.forge?.length ?? 0) > 0 || l.phase.length > 0);
  if (!rows.length && !q.data.forge_note) {
    return <p className="lab-note lab-ok">Forge knows every card in {lists.length === 1 ? "this list" : "these lists"}.</p>;
  }
  return (
    <div className="lab-note lab-support" role="status">
      {q.data.forge_note && <p>{q.data.forge_note}.</p>}
      {rows.map((l) => (
        <p key={l.label}>
          <b>{l.label}</b>
          {l.forge?.length ? `: Forge can't play ${l.forge.join(", ")}.` : ""}
          {l.phase.length ? ` Phase can't play ${l.phase.join(", ")}.` : ""}
        </p>
      ))}
      {rows.some((l) => l.forge?.length) && <p>A run with these cards on Forge is refused; swap them out, or run on Phase only.</p>}
    </div>
  );
}
