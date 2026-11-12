import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { Button, CheckRow, Details } from "../components/ui";
import type { ComparePrefill, ExperimentDetail, NewExperiment } from "./api";
import { LabHead } from "./LabLayout";
import { caveat, durationText, expectedSeconds, gameChoices } from "./logic";
import { DeckChooser, defaultField, FieldPicker, fromDeckSummary, GamesPicker, RunBlockers, useField, usePace, type Chosen, type FieldState, EnginePicker, EngineSupportNote, engineFields, engineState, engineText, forgeSeconds, type EngineState } from "./pickers";
import { usePrecons } from "./Precons";
import { CreateError, PaceNote, RunningNow } from "./Try";
import { count } from "@yama/core";

type Mode = "compare" | "versus" | "tournament";

export function ComparePage() {
  const { search, state } = useLocation();
  return <CompareForm key={search + JSON.stringify((state as { prefill?: unknown } | null)?.prefill ?? null)} />;
}

function CompareForm() {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as { prefill?: ComparePrefill } | null)?.prefill;
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<Mode>(prefill?.mode ?? (params.get("mode") === "tournament" ? "tournament" : params.get("mode") === "versus" ? "versus" : "compare"));
  const [picked, setPicked] = useState<(Chosen | null)[]>([null, null]);
  const [pod, setPod] = useState<number>(prefill?.pod ?? 4);
  const [field, setField] = useState<FieldState>(() => {
    const f = prefill?.field;
    if (!f) return defaultField("precons_near");
    return { kind: f.kind, anchor: f.kind === "precons_near" ? (f.ids[0] ?? "") : "", myDecks: f.kind === "my_decks" ? f.ids : [] };
  });
  const [gamesPicked, setGames] = useState<number | null>(prefill?.games ?? null);
  const [engines, setEngines] = useState<EngineState>(() => engineState(prefill));
  const [includePrecons, setIncludePrecons] = useState(prefill?.mode === "tournament" && prefill.field?.kind === "precons_all");
  const [name, setName] = useState("");
  const opId = useRef(crypto.randomUUID());
  const pace = usePace();
  const choices = gameChoices(pace.data);
  const games = gamesPicked != null && choices.includes(gamesPicked) ? gamesPicked : choices.includes(200) ? 200 : (choices[0] ?? 100);
  const tournament = mode === "tournament";
  const phaseEta = tournament ? null : expectedSeconds(pace.data, games);
  const forgeEta = tournament ? null : forgeSeconds(pace.data, games);
  const eta = engines.mode === "phase" ? phaseEta : engines.mode === "forge" ? forgeEta : phaseEta != null && forgeEta != null ? Math.max(phaseEta, forgeEta) : null;

  // "Edit and run again" brings decks back: yours by id, precons by slug (lists can't come back).
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const precons = usePrecons();
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !prefill || !decks.data || !precons.data) return;
    restored.current = true;
    const back = prefill.decks.map((c): Chosen | null => {
      if (c.kind === "deck") {
        const d = decks.data!.find((x) => x.id === c.id);
        return d ? fromDeckSummary(d) : null;
      }
      if (c.kind === "precon") {
        const p = precons.data!.precons.find((x) => x.id === c.id);
        return p
          ? { choice: c, key: `precon:${p.id}`, label: p.name, sub: `${p.set_name ?? p.set_code} precon, stock list`, identity: p.color_identity, commanders: p.commanders, art: p.art ? { url: p.art.url, artist: p.art.artist } : null, precon: p.id, rated: p.rating?.strength != null, deckId: null }
          : null;
      }
      return null;
    });
    while (back.length < 2) back.push(null);
    setPicked(back);
  }, [decks.data, precons.data]);

  const chosen = picked.filter((c): c is Chosen => !!c);
  const first = chosen[0] ?? null;
  const anchor = first ? { label: first.label, precon: first.precon, rated: first.rated, commanders: first.commanders } : null;
  const excludeDecks = chosen.flatMap((c) => (c.deckId ? [c.deckId] : []));
  const fieldPick = useField(field, anchor, excludeDecks);
  const versus = mode === "versus";
  const fillers = versus ? Math.max(0, pod - chosen.length) : 0;
  const needField = !tournament && (!versus || fillers > 0);
  const fieldSize = chosen.length + (tournament && includePrecons ? (precons.data?.precons.length ?? 0) : 0);
  const tournamentGames = 4 * Math.ceil(fieldSize * Math.ceil(games / 4) / 4);

  const setAt = (i: number, c: Chosen | null) => setPicked((p) => p.map((x, j) => (j === i ? c : x)));
  const switchMode = (m: Mode) => {
    setMode(m);
    if (m === "tournament") setPod(4);
    if (m === "versus") setPicked((p) => p.slice(0, 4));
    if (m === "compare") setPicked((p) => [p[0] ?? null, p[1] ?? null]);
  };

  const blockers: { text: string; href?: string; link?: string }[] = [];
  if (tournament && (chosen.length < 1 || fieldSize < 4)) blockers.push({ text: "Pick at least four decks, or add the stock precon field." });
  if (!tournament && chosen.length < 2) blockers.push({ text: versus ? "Pick at least two decks." : "Pick both decks.", href: "#cmp-decks", link: "Step 1" });
  if (versus && pod === 2 && chosen.length !== 2) blockers.push({ text: "1v1 needs exactly two decks." });
  if (needField) for (const p of fieldPick.problems) blockers.push({ text: p, href: "#cmp-field", link: "Step 2" });
  if (pace.data && !pace.data.available) blockers.push({ text: pace.data.message ?? "Simulations can't start on this server right now." });

  const create = useMutation({
    mutationFn: () => {
      const body: NewExperiment = tournament
        ? { op_id: opId.current, mode: "tournament", entrants: chosen.map((c) => c.choice), pod: 4, ...(includePrecons ? { field: { kind: "precons_all" as const } } : {}), games, ...engineFields(engines) }
        : versus
        ? { op_id: opId.current, mode: "versus", entrants: chosen.map((c) => c.choice), pod, ...(fillers > 0 ? { field: fieldPick.choice } : {}), games, ...engineFields(engines) }
        : { op_id: opId.current, mode: "compare", base: chosen[0]!.choice, other: chosen[1]!.choice, field: fieldPick.choice, games, ...engineFields(engines) };
      if (name.trim()) body.name = name.trim();
      return api<ExperimentDetail>("/api/lab/experiments", { method: "POST", json: body });
    },
    onSuccess: (d) => navigate(`/lab/runs/${d.id}`),
  });

  const labels = chosen.map((c) => c.label);
  return (
    <>
      <LabHead title="Compare decks" />
      <div className="lab-chips lab-modes" role="radiogroup" aria-label="How to compare">
        <Button role="radio" aria-checked={mode === "compare"} onClick={() => switchMode("compare")}>
          Against the same opponents
        </Button>
        <Button role="radio" aria-checked={versus} onClick={() => switchMode("versus")}>
          Head to head
        </Button>
        <Button role="radio" aria-checked={tournament} onClick={() => switchMode("tournament")}>
          Tournament
        </Button>
      </div>
      <Details label="How this comparison works" className="lab-try-intro">
        <p>
        {tournament ? "Four-player pods balance appearances, opponents and seats across the field." : versus
          ? "Your decks play each other, rotating seats."
          : "Both lists face the same opponents, seats and shuffles."}
        </p>
        <p>{caveat()}</p>
      </Details>

      <div className="phone-only">
        <RunningNow />
      </div>
      <div className="lab-try">
        <div className="lab-try-main">
          <section className="lab-step" aria-labelledby="cmp-decks-h" id="cmp-decks">
            <h2 id="cmp-decks-h">
              <span className="n">1.</span> {tournament || versus ? "Decks" : "The two decks"}
            </h2>
            {tournament ? <>
              <Button variant="outline" onClick={() => setPicked((decks.data ?? []).map(fromDeckSummary))}>Select all my saved decks</Button>
              <p className="small dim">Identical lists count once.</p>
              <ul>{chosen.map((c) => <li key={c.key}>{c.label} <Button variant="quiet" aria-label={`Remove ${c.label}`} onClick={() => setPicked((p) => p.filter((x) => x?.key !== c.key))}>Remove</Button></li>)}</ul>
              {chosen.length < 256 && <DeckChooser value={null} onChange={(c) => c && setPicked((p) => [...p.filter(Boolean), c])} exclude={chosen.map((c) => c.key)} />}
              <CheckRow checked={includePrecons} onChange={(e) => setIncludePrecons(e.target.checked)}>Include all supported stock precons as tournament entrants</CheckRow>
            </> : <>{picked.map((c, i) => (
              <div key={i} className="lab-cmp-slot">
                <div className="lab-swaps-head">
                  <h3>{versus ? `Deck ${i + 1}` : i === 0 ? "First deck" : "Second deck"}</h3>
                  {versus && picked.length > 2 && (
                    <Button variant="quiet" onClick={() => setPicked((p) => p.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </div>
                <DeckChooser value={c} onChange={(x) => setAt(i, x)} exclude={chosen.filter((x) => x !== c).map((x) => x.key)} />
              </div>
            ))}</>}
            {versus && picked.length < 4 && pod === 4 && (
              <Button variant="outline" onClick={() => setPicked((p) => [...p, null])}>
                Add another deck
              </Button>
            )}
            {versus && (
              <fieldset className="seat">
                <legend className="small dim">Table</legend>
                <div className="lab-chips" role="radiogroup" aria-label="Table size">
                  <Button role="radio" aria-checked={pod === 4} onClick={() => setPod(4)}>
                    Four players
                  </Button>
                  <Button
                    role="radio"
                    aria-checked={pod === 2}
                    disabled={picked.length > 2}
                    onClick={() => {
                      setPod(2);
                      setPicked((p) => p.slice(0, 2));
                    }}
                  >
                    1v1
                  </Button>
                </div>
                <p className="small dim" style={{ margin: "0.4rem 0 0" }}>
                  {pod === 2
                    ? "Two decks, one on one; each goes first in half the games."
                    : fillers > 0
                      ? `With ${chosen.length || "fewer than four"} decks, precons fill the other ${fillers === 1 ? "seat" : `${fillers} seats`}.`
                      : "Four decks fill the table."}
                </p>
              </fieldset>
            )}
          </section>

          <section className="lab-step" aria-labelledby="cmp-field-h" id="cmp-field">
            <h2 id="cmp-field-h">
              <span className="n">2.</span> {tournament ? "Games per deck" : versus ? (fillers > 0 ? "Who fills the empty seats" : "Games") : "Against"}
            </h2>
            {needField && <FieldPicker value={field} onChange={setField} anchor={anchor} excludeDecks={excludeDecks} />}
            <GamesPicker
              id="cmp-games"
              choices={choices}
              games={games}
              setGames={setGames}
              pace={pace.data}
              label={tournament ? "Games per deck, per engine" : "Games"}
              estimateGames={tournament ? tournamentGames : undefined}
              note={tournament ? `At least ${games} appearances per unique deck. Up to about ${count(tournamentGames)} four-player games per engine before duplicate and unsupported precons are removed. Counts are rounded up for equal seat rotations.` : versus ? `${games} games, every deck in each one.` : `${games / 2} pods, each played by both decks.`}
            />
            <p className="lab-note" style={{ margin: 0 }}>
              <PaceNote pace={pace.data} error={pace.error} />
            </p>
          </section>
        </div>

        <aside className="lab-try-side" aria-label="Run">
          <div className="wide-only">
            <RunningNow />
          </div>
          <section className="lab-run" aria-labelledby="cmp-run">
            <h2 id="cmp-run">Run</h2>
            <p className="small" style={{ margin: 0 }}>
              {chosen.length >= (tournament ? 1 : 2) ? (
                <>
                  <b>{tournament ? `Tournament with ${chosen.length} selected lists${includePrecons ? " and the precon field" : ""}` : labels.join(versus ? ", " : " vs ")}</b>
                  {tournament ? "" : versus ? (pod === 2 ? ", 1v1" : fillers > 0 ? `, with ${fieldPick.label} filling ${fillers === 1 ? "a seat" : `${fillers} seats`}` : "") : ` against ${fieldPick.label}`}. {games} {tournament ? "games per deck per engine" : "games"}, {engineText(engines)}
                  {eta != null ? `, ${durationText(eta)}` : ""}.
                </>
              ) : (
                <span className="dim">Pick the decks, then who they play against.</span>
              )}
            </p>
            <EnginePicker id="cmp-engine" value={engines} onChange={setEngines} pace={pace.data} games={tournament ? tournamentGames : games} />
            {chosen.length >= (tournament ? 1 : 2) && <EngineSupportNote lists={chosen.map((c) => c.choice)} names={[]} mode={engines.mode} />}
            <label>
              <span>
                Name <span className="dim small" style={{ fontWeight: 400 }}>(optional)</span>
              </span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={labels.length >= 2 ? labels.join(" vs ") : "Named after the decks"} maxLength={120} />
            </label>
            <CreateError error={create.error} names={labels} />
            <RunBlockers items={blockers} />
            <Button variant="primary" onClick={() => create.mutate()} disabled={blockers.length > 0 || create.isPending || !me.data}>
              {create.isPending ? "Starting…" : tournament ? "Start tournament" : versus ? "Play them head to head" : "Compare them"}
            </Button>
            <p className="lab-note" style={{ margin: 0 }}>
              AI simulations. To test swaps, use <Link to="/lab/try">Try a change</Link>. <Link to="/lab/runs">My runs</Link>
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
