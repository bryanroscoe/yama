import { useMutation, useQuery } from "@tanstack/react-query";
import { identityName } from "@yama/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, ApiError, type DeckCard, type DeckSummary, type DeckView, type SearchResult } from "../api";
import { useMe } from "../auth";
import { CardImage, ErrorText, ManaCost, Pips } from "../components/ui";
import { offlineSearch } from "../offline/cards";
import type { BaseChoice, ExperimentDetail, FieldChoice, NewExperiment, Pace, PreconDetail, TryPrefill } from "./api";
import {
  caveat,
  changeText,
  changedCount,
  cuttable,
  durationText,
  expectedSeconds,
  grouped,
  identityQuery,
  playedCount,
  tally,
  type BaseLine,
} from "./logic";
import { usePrecons } from "./Precons";

type BaseKind = "deck" | "precon" | "list";
type FieldKind = "precons_top" | "precons_near" | "precons_all" | "my_decks";

const GAMES = [100, 200, 400];
const FIELD_N = 20;

/** A loaded base list: its lines, the commander's colours when known, and its label. */
interface LoadedBase {
  choice: BaseChoice;
  label: string;
  lines: BaseLine[];
  identity: string | null;
  commanders: string[];
  /** A precon base's slug, for "similar strength". */
  precon: string | null;
  /** Whether the base is a precon with a simulated strength, so it sets "similar strength" itself. */
  rated: boolean;
  note?: string;
}

function fromDeck(d: DeckView): LoadedBase {
  return {
    choice: { kind: "deck", id: d.id },
    label: d.name,
    lines: d.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, type_line: c.card?.type_line ?? null, cmc: c.card?.cmc ?? null, image_small: c.card?.image_small ?? null, oracle_id: c.oracle_id })),
    identity: d.validation.color_identity,
    commanders: d.cards.filter((c) => c.board === "commander").map((c) => c.name),
    precon: null,
    rated: false,
    note: d.version_id ? "Its latest version" : undefined,
  };
}

function fromPrecon(p: PreconDetail): LoadedBase {
  return {
    choice: { kind: "precon", id: p.precon.id },
    label: p.precon.name,
    lines: p.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, type_line: c.type_line, cmc: c.cmc, image_small: c.image_small, oracle_id: c.oracle_id })),
    identity: p.precon.color_identity,
    commanders: p.precon.commanders,
    precon: p.precon.id,
    rated: p.precon.rating?.strength != null,
    note: `${p.precon.set_name ?? p.precon.set_code} stock list`,
  };
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
  const initialKind: BaseKind = prefill?.base.kind ?? (params.get("deck") ? "deck" : params.get("precon") ? "precon" : "precon");

  const [kind, setKind] = useState<BaseKind>(initialKind);
  const [deckId, setDeckId] = useState(prefill?.base.kind === "deck" ? prefill.base.id : (params.get("deck") ?? ""));
  const [preconId, setPreconId] = useState(prefill?.base.kind === "precon" ? prefill.base.id : (params.get("precon") ?? ""));
  const [pasteText, setPasteText] = useState(prefill?.base.kind === "list" ? prefill.base.text : "");
  const [pasted, setPasted] = useState<{ text: string; cards: DeckCard[]; unknown: string[] } | null>(null);
  const [add, setAdd] = useState<string[]>(prefill?.add ?? []);
  const [cut, setCut] = useState<string[]>(prefill?.cut ?? []);
  const [fieldKind, setFieldKind] = useState<FieldKind>((prefill?.field?.kind as FieldKind) ?? "precons_top");
  const [anchor, setAnchor] = useState(prefill?.field?.kind === "precons_near" ? (prefill.field.ids[0] ?? "") : "");
  const [myDecks, setMyDecks] = useState<string[]>(prefill?.field?.kind === "my_decks" ? prefill.field.ids : []);
  const [games, setGames] = useState(prefill?.games && GAMES.includes(prefill.games) ? prefill.games : 200);
  const [difficulty, setDifficulty] = useState(prefill?.difficulty === "Medium" ? "Medium" : "Easy");
  const [name, setName] = useState("");
  const opId = useRef(crypto.randomUUID());

  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const precons = usePrecons();
  const pace = useQuery({ queryKey: ["lab", "pace"], queryFn: () => api<Pace>("/api/lab/pace"), refetchInterval: 60_000 });
  const deck = useQuery({ queryKey: ["deck", deckId], queryFn: () => api<DeckView>(`/api/decks/${deckId}`), enabled: kind === "deck" && !!deckId });
  const precon = useQuery({ queryKey: ["lab", "precon", preconId], queryFn: () => api<PreconDetail>(`/api/precons/${preconId}`), enabled: kind === "precon" && !!preconId });

  // A pasted list from "Try again" is read once on arrival.
  const parse = useMutation({
    mutationFn: (text: string) => api<{ cards: DeckCard[]; unknown: string[] }>("/api/decks/parse", { method: "POST", json: { text, first_is_commander: true } }),
    onSuccess: (r, text) => setPasted({ text, ...r }),
  });
  useEffect(() => {
    if (prefill?.base.kind === "list" && !pasted) parse.mutate(prefill.base.text);
  }, []);

  const base: LoadedBase | null = useMemo(() => {
    if (kind === "deck" && deck.data) return fromDeck(deck.data);
    if (kind === "precon" && precon.data) return fromPrecon(precon.data);
    if (kind === "list" && pasted)
      return {
        choice: { kind: "list", text: pasted.text },
        label: "Pasted list",
        lines: pasted.cards.map((c) => ({ name: c.name, qty: c.qty, board: c.board, oracle_id: c.oracle_id })),
        identity: null,
        commanders: pasted.cards.filter((c) => c.board === "commander").map((c) => c.name),
        precon: null,
        rated: false,
      };
    return null;
  }, [kind, deck.data, precon.data, pasted]);

  const resetChanges = () => {
    setAdd([]);
    setCut([]);
  };
  const chooseKind = (k: BaseKind) => {
    if (k !== kind) resetChanges();
    setKind(k);
  };

  const count = base ? changedCount(base.lines, add, cut) : 0;
  const changed = add.length + cut.length > 0;
  const rated = useMemo(() => (precons.data?.precons ?? []).filter((p) => p.rating?.strength != null).sort((a, b) => a.name.localeCompare(b.name)), [precons.data]);
  // A rated precon sets "similar strength" itself. Anything else (a deck, a list, a precon added
  // since the last rating run) needs one picked: by default a rated precon with the same commanders.
  const selfAnchor = !!base?.precon && base.rated;
  const sameCommander = useMemo(() => {
    if (!base || selfAnchor) return null;
    const mine = [...base.commanders].sort().join("|");
    return rated.find((p) => p.id !== base.precon && [...p.commanders].sort().join("|") === mine) ?? null;
  }, [base, selfAnchor, rated]);
  const anchorId = selfAnchor ? "" : anchor || sameCommander?.id || "";
  const run = precons.data?.run;
  const preconMissing = kind === "precon" && !!precon.error;

  const field: FieldChoice =
    fieldKind === "precons_top"
      ? { kind: "precons_top", n: FIELD_N }
      : fieldKind === "precons_near"
        ? { kind: "precons_near", n: FIELD_N, ids: anchorId ? [anchorId] : [] }
        : fieldKind === "precons_all"
          ? { kind: "precons_all" }
          : { kind: "my_decks", ids: myDecks.filter((id) => id !== deckId || kind !== "deck") };

  const blockers: string[] = [];
  if (!base) blockers.push("Choose a list to start from.");
  else {
    if (!changed) blockers.push("Make a change: add a card or tap one to cut it.");
    if (count !== 100) blockers.push(`The changed list has ${count} cards; a game needs exactly 100.`);
    if (base.commanders.length === 0) blockers.push("The list needs a commander.");
  }
  if (fieldKind === "precons_near" && base && !selfAnchor && !anchorId) blockers.push("Pick a precon to set the power level.");
  if ((fieldKind === "precons_top" || fieldKind === "precons_near") && precons.data && !run) blockers.push("No rating run is imported yet, so there's no strength to choose by.");
  if (pace.data && !pace.data.available) blockers.push(pace.data.message ?? "Simulations can't start on this server right now.");

  const create = useMutation({
    mutationFn: () => {
      const body: NewExperiment = {
        op_id: opId.current,
        base: base!.choice,
        variant: { add, cut },
        field,
        games,
        difficulty,
        ...(name.trim() ? { name: name.trim() } : {}),
      };
      return api<ExperimentDetail>("/api/lab/experiments", { method: "POST", json: body });
    },
    onSuccess: (d) => navigate(`/decks/lab/runs/${d.id}`),
  });

  const fieldLabel =
    fieldKind === "precons_top"
      ? `the strongest ${FIELD_N} precons`
      : fieldKind === "precons_near"
        ? `the ${FIELD_N} precons nearest in strength`
        : fieldKind === "precons_all"
          ? "all the precons"
          : myDecks.length
            ? `${myDecks.length} of your decks`
            : "your decks";
  const eta = expectedSeconds(pace.data, games);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Try a change</h1>
          <p className="dim" style={{ margin: 0, maxWidth: "62ch" }}>
            Play a list and a changed copy of it against the same opponents, seats and shuffles, then compare. {caveat()}
          </p>
        </div>
      </div>

      <section className="lab-step">
        <h2><span className="n">1</span> Start from</h2>
        <div className="lab-chips" role="radiogroup" aria-label="Start from" style={{ marginBottom: "0.75rem" }}>
          {(
            [
              ["precon", "A precon"],
              ["deck", "One of my decks"],
              ["list", "Paste a list"],
            ] as [BaseKind, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => chooseKind(k)}>
              {label}
            </button>
          ))}
        </div>
        {kind === "precon" && (
          <PreconPicker
            value={preconMissing ? "" : preconId}
            onChange={(id) => {
              resetChanges();
              setPreconId(id);
            }}
          />
        )}
        {kind === "deck" && (
          <label>
            Deck
            <span className="hint">Its latest version is used. Simulations need 100 cards with a commander.</span>
            <select
              value={deckId}
              onChange={(e) => {
                resetChanges();
                setDeckId(e.target.value);
              }}
            >
              <option value="">Choose a deck</option>
              {decks.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.commanders.length ? `, ${d.commanders.join(" and ")}` : ""} ({d.card_count} cards)
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "list" && (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <label>
              Deck list
              <span className="hint">One card per line, like "1 Sol Ring". With no Commander section, the first card is the commander.</span>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
            </label>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  resetChanges();
                  parse.mutate(pasteText);
                }}
                disabled={!pasteText.trim() || parse.isPending}
              >
                Use this list
              </button>
              {pasted && pasted.text !== pasteText && <span className="small dim">The text changed since it was read.</span>}
            </div>
            {pasted && pasted.unknown.length > 0 && <p className="error small">Not found, so left out: {pasted.unknown.join(", ")}</p>}
            <ErrorText error={parse.error} />
          </div>
        )}
        {preconMissing && precon.error instanceof ApiError && precon.error.status === 404 ? (
          <p className="error" role="alert">
            No precon has the id "{preconId}". Find one above.
          </p>
        ) : (
          <ErrorText error={kind === "deck" ? deck.error : kind === "precon" ? precon.error : null} />
        )}
        {base && (
          <div className="row" style={{ marginTop: "0.6rem", justifyContent: "space-between" }}>
            <p style={{ margin: 0 }}>
              <b>{base.label}</b>
              <br />
              <span className="small dim">
                {base.commanders.length ? base.commanders.join(" and ") : "No commander"}
                {base.identity != null && (
                  <>
                    {" "}
                    <Pips identity={base.identity} /> {identityName(base.identity)}
                  </>
                )}
                {base.note ? `. ${base.note}` : ""}. {playedCount(base.lines)} cards.
              </span>
            </p>
            {kind === "precon" && (
              <button
                type="button"
                onClick={() => {
                  resetChanges();
                  setPreconId("");
                }}
              >
                Choose another precon
              </button>
            )}
          </div>
        )}
      </section>

      {base && (
        <section className="lab-step">
          <h2><span className="n">2</span> Change it</h2>
          <Diff base={base} add={add} cut={cut} count={count} setAdd={setAdd} setCut={setCut} />
          <div className="lab-two" style={{ marginTop: "1rem", alignItems: "start" }}>
            <AddSearch identity={base.identity} onAdd={(n) => setAdd((a) => [...a, n])} inBase={(n) => base.lines.some((l) => l.name === n)} />
            <BaseList base={base} cut={cut} setCut={setCut} />
          </div>
        </section>
      )}

      <section className="lab-step">
        <h2><span className="n">3</span> Play against</h2>
        <div className="lab-choices" role="radiogroup" aria-label="Opponents">
          <Choice on={fieldKind === "precons_top"} pick={() => setFieldKind("precons_top")} title={`Strongest ${FIELD_N} precons`}>
            {run ? `The top of rating run ${run.name}.` : "Needs a rating run."}
          </Choice>
          <Choice on={fieldKind === "precons_near"} pick={() => setFieldKind("precons_near")} title="Similar strength">
            {FIELD_N} precons nearest in strength to {selfAnchor ? base!.label : "a precon you pick"}.
          </Choice>
          <Choice on={fieldKind === "precons_all"} pick={() => setFieldKind("precons_all")} title="All precons">
            Every playable precon ({precons.data?.precons.length ?? "…"}); each sits in only a pod or two.
          </Choice>
          <Choice on={fieldKind === "my_decks"} pick={() => setFieldKind("my_decks")} title="My decks">
            Your own decks with 100 cards and a commander.
          </Choice>
        </div>
        {fieldKind === "precons_near" && base && !selfAnchor && (
          <label style={{ marginTop: "0.75rem" }}>
            Similar to
            <span className="hint">
              {base.precon ? `${base.label} has no simulated rating yet, so pick a precon about as strong. ` : ""}
              {sameCommander ? `${sameCommander.name} has the same commander.` : base.precon ? "" : "No rated precon has this commander; pick one about as strong as your list."}
            </span>
            <select value={anchorId} onChange={(e) => setAnchor(e.target.value)}>
              <option value="">Choose a precon</option>
              {rated.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        {fieldKind === "my_decks" && (
          <fieldset className="seat" style={{ marginTop: "0.75rem" }}>
            <legend className="small dim">Leave all unticked to use every deck that can be simulated.</legend>
            {decks.data
              ?.filter((d) => !(kind === "deck" && d.id === deckId))
              .map((d) => (
                <label key={d.id} style={{ display: "flex", gap: "0.6rem", alignItems: "center", fontWeight: 400, minHeight: 44 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", minHeight: 0 }}
                    checked={myDecks.includes(d.id)}
                    onChange={(e) => setMyDecks((m) => (e.target.checked ? [...m, d.id] : m.filter((x) => x !== d.id)))}
                  />
                  {d.name} <span className="dim small">({d.card_count} cards)</span>
                </label>
              ))}
          </fieldset>
        )}
      </section>

      <section className="lab-step">
        <h2><span className="n">4</span> Games</h2>
        <div className="lab-choices" role="radiogroup" aria-label="Games">
          {GAMES.map((g) => {
            const s = expectedSeconds(pace.data, g);
            return (
              <Choice key={g} on={games === g} pick={() => setGames(g)} title={`${g} games`}>
                {g / 2} pods, each played by both lists{s != null ? `. ${durationText(s).replace(/^about/, "About")}` : ""}
              </Choice>
            );
          })}
        </div>
        <p className="lab-note" style={{ marginTop: "0.6rem" }}>
          More games take longer and give a tighter answer. <PaceNote pace={pace.data} error={pace.error} />
        </p>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <label style={{ flex: "0 1 12rem" }}>
            AI level
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option>Easy</option>
              <option>Medium</option>
            </select>
          </label>
          <label style={{ flex: "1 1 18rem" }}>
            <span>
              Name <span className="dim small" style={{ fontWeight: 400 }}>(optional)</span>
            </span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={base && changed ? `${base.label}: ${changeText(add, cut)}` : "Named after the change"} maxLength={120} />
          </label>
        </div>
      </section>

      <div className="lab-run">
        {base && changed && (
          <p className="small" style={{ margin: 0 }}>
            <b>{base.label}</b>: {changeText(add, cut)}. {games} games against {fieldLabel}, {difficulty} AI{eta != null ? `, ${durationText(eta)}` : ""}.
          </p>
        )}
        {blockers.length > 0 && (
          <ul className="lab-problems dim">
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        )}
        <CreateError error={create.error} />
        <div className="row">
          <button className="primary" onClick={() => create.mutate()} disabled={blockers.length > 0 || create.isPending || !me.data}>
            {create.isPending ? "Starting…" : "Run"}
          </button>
          <Link className="button quiet" to="/decks/lab/runs">My runs</Link>
        </div>
      </div>
    </>
  );
}

/** Where the expected times come from, or why there are none. */
function PaceNote({ pace, error }: { pace: Pace | undefined; error: unknown }) {
  if (error) return <>Couldn't get the lab's pace, so there's no time estimate.</>;
  if (!pace) return null;
  if (pace.threads === 0) return <>The lab plays no games on this server (it's turned off), so there's no time estimate.</>;
  if (pace.estimates.length === 0) return <>No games have been played on this server yet, so there's no time estimate.</>;
  const at = `${pace.threads} ${pace.threads === 1 ? "game" : "games"} at a time`;
  const after = pace.your_pending ? `, after the ${pace.your_pending} games your other runs still have to play` : "";
  // Admins get the exact pace; anyone else, times rounded up to 5 minutes.
  const from =
    pace.seconds_per_game != null
      ? `Times are from the lab's ${pace.basis === "recent" ? `pace over the last hour (${pace.sample ?? 0} games)` : "average game length"}, ${at}${after}.`
      : `Times are rough, rounded up to 5 minutes, from how fast the lab has been playing (${at})${after}.`;
  return <>{from} Other people's runs can add to that.</>;
}

function Choice({ on, pick, title, children }: { on: boolean; pick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" className="lab-choice" role="radio" aria-checked={on} onClick={pick}>
      <b>{title}</b>
      <span>{children}</span>
    </button>
  );
}

/** Errors from creating an experiment, with the names and problems the server lists per list. */
function CreateError({ error }: { error: unknown }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : undefined;
  const perList = (key: string) => {
    const v = body?.[key] as { base?: string[]; variant?: string[] } | undefined;
    return v ? [...(v.base ?? []).map((x) => `Base list: ${x}`), ...(v.variant ?? []).map((x) => `Changed list: ${x}`)] : [];
  };
  const details = [...perList("unknown"), ...perList("problems")];
  return (
    <div role="alert">
      <p className="error small" style={{ margin: 0 }}>{error instanceof Error ? error.message : String(error)}</p>
      {details.length > 0 && <ul className="lab-problems error">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  );
}

function PreconPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const precons = usePrecons();
  const [q, setQ] = useState("");
  if (value) return null;
  const needle = q.trim().toLowerCase();
  const matches = (precons.data?.precons ?? []).filter((p) => !needle || [p.name, ...p.commanders].some((s) => s.toLowerCase().includes(needle))).slice(0, 8);
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a precon by name or commander" aria-label="Find a precon" />
      <div className="lab-pick">
        {matches.map((p) => (
          <button key={p.id} type="button" className="lab-line" onClick={() => onChange(p.id)} style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="name">
              <b>{p.name}</b>
              <br />
              <span className="dim small">{p.commanders.join(" and ")}</span>
            </span>
            <Pips identity={p.color_identity} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Diff({ base, add, cut, count, setAdd, setCut }: { base: LoadedBase; add: string[]; cut: string[]; count: number; setAdd: (f: (a: string[]) => string[]) => void; setCut: (f: (c: string[]) => string[]) => void }) {
  const removeOne = (list: string[], name: string) => {
    const i = list.lastIndexOf(name);
    return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
  };
  const ok = count === 100;
  return (
    <div className="lab-diff" aria-live="polite">
      <div className="lab-total">
        <b>{count}</b>
        <span>cards in the changed list</span>
        <div style={{ marginTop: "0.35rem" }}>
          {ok ? <span className="tag good">100, ready to play</span> : <span className="tag warn">{count < 100 ? `${100 - count} short` : `${count - 100} too many`}; a game needs 100</span>}
        </div>
      </div>
      <div>
        <h3>Cutting {cut.length > 0 && <span className="dim num">{cut.length}</span>}</h3>
        {cut.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>Tap a card in {base.label} to cut it.</p>
        ) : (
          <ul>
            {[...tally(cut)].map(([n, k]) => (
              <li key={n}>
                <span>{k > 1 ? `${k} ` : ""}{n}</span>
                <button type="button" onClick={() => setCut((c) => removeOne(c, n))} aria-label={`Keep ${n}`}>Keep</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Adding {add.length > 0 && <span className="dim num">{add.length}</span>}</h3>
        {add.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>Search for a card to add.</p>
        ) : (
          <ul>
            {[...tally(add)].map(([n, k]) => (
              <li key={n}>
                <span>{k > 1 ? `${k} ` : ""}{n}</span>
                <button type="button" onClick={() => setAdd((a) => removeOne(a, n))} aria-label={`Don't add ${n}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const isNetworkError = (e: unknown) => e instanceof TypeError || !navigator.onLine;

/** The card search (same endpoint and offline fallback as the Cards page), with an Add button. */
function AddSearch({ identity, onAdd, inBase }: { identity: string | null; onAdd: (name: string) => void; inBase: (name: string) => boolean }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [fits, setFits] = useState(true);
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
  return (
    <div>
      <h3>Add a card</h3>
      <form className="stack" style={{ gap: "0.4rem" }} role="search" onSubmit={(e) => { e.preventDefault(); setQ(draft.trim()); }}>
        <input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name, or Scryfall syntax like t:instant o:destroy" aria-label="Search cards to add" autoCapitalize="off" autoCorrect="off" />
        {identity != null && (
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" checked={fits} onChange={(e) => setFits(e.target.checked)} style={{ width: "auto", minHeight: 0 }} />
            <span className="small">Only cards within the commander's colours ({identityName(identity)})</span>
          </label>
        )}
      </form>
      <ErrorText error={results.error} />
      {query && results.data && (
        <div className="lab-pick" style={{ marginTop: "0.5rem" }}>
          {results.data.cards.slice(0, 12).map((c) => (
            <div key={c.oracle_id} className="lab-line" style={{ gridTemplateColumns: "2rem 1fr auto" }}>
              <CardImage src={c.image_small} name={c.name} className="thumb" />
              <span className="name">
                {c.name} <ManaCost cost={c.mana_cost} />
                <br />
                <span className="dim small">{c.type_line}{inBase(c.name) ? ", already in the list" : ""}</span>
              </span>
              <button type="button" onClick={() => onAdd(c.name)} aria-label={`Add ${c.name}`}>Add</button>
            </div>
          ))}
          {results.data.cards.length === 0 && <p className="small dim">No cards match.</p>}
          {results.data.total > 12 && <p className="small dim">{results.data.total.toLocaleString()} cards match; showing the 12 most played. Narrow the search for others.</p>}
        </div>
      )}
    </div>
  );
}

/** The base list grouped by type; tap a card to cut a copy, tap again to cut the next or keep them all. */
function BaseList({ base, cut, setCut }: { base: LoadedBase; cut: string[]; setCut: (f: (c: string[]) => string[]) => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const lines = base.lines.filter((l) => l.board !== "side" && (!needle || l.name.toLowerCase().includes(needle)));
  const cuts = tally(cut);
  const tap = (l: BaseLine) => {
    if (l.board !== "main") return;
    if (cuttable(base.lines, cut, l.name) > 0) setCut((c) => [...c, l.name]);
    else setCut((c) => c.filter((n) => n !== l.name));
  };
  return (
    <div>
      <h3>{base.label}</h3>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a card in the list" aria-label="Find a card in the list" style={{ marginBottom: "0.4rem" }} />
      <div className="lab-pick" style={{ maxHeight: "32rem" }}>
        {grouped(lines).map(([group, items]) => (
          <div key={group}>
            <p className="small dim" style={{ margin: "0.6rem 0 0.1rem", fontWeight: 700 }}>
              {group} <span className="num">{items.reduce((n, l) => n + l.qty, 0)}</span>
            </p>
            {items.map((l) => {
              const k = cuts.get(l.name) ?? 0;
              const all = k >= l.qty;
              return (
                <button
                  key={`${l.name}-${l.board}`}
                  type="button"
                  className={`lab-line${all ? " lab-cut" : ""}`}
                  onClick={() => tap(l)}
                  disabled={l.board !== "main"}
                  aria-pressed={k > 0}
                  aria-label={l.board === "main" ? `${k > 0 ? (all ? "Keep" : "Cut another") : "Cut"} ${l.name}` : `${l.name}, the commander`}
                  style={{ opacity: 1 }}
                >
                  <CardImage src={l.image_small} name={l.name} className="thumb" />
                  <span className="name">
                    {l.qty > 1 ? `${l.qty} ` : ""}
                    {l.name}
                  </span>
                  <span className="lab-cut-mark">{l.board === "commander" ? "commander" : k > 0 ? (l.qty > 1 ? `cut ${k} of ${l.qty}` : "cut") : ""}</span>
                </button>
              );
            })}
          </div>
        ))}
        {lines.length === 0 && <p className="small dim">No card matches.</p>}
      </div>
    </div>
  );
}
