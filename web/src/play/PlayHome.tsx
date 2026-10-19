import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type DeckSummary, type Playgroup } from "../api";
import { ArtPanel } from "../components/ArtPanel";
import { ErrorText, Pips } from "../components/ui";
import type { OnlineGame } from "./types";

const DIFFICULTIES = [
  { value: "Easy", label: "Easy" },
  { value: "Medium", label: "Medium" },
  { value: "Hard", label: "Hard" },
];

interface SeatPlan {
  kind: "me" | "friend" | "ai";
  deckId: string;
  difficulty: string;
}

export function PlayHome() {
  const games = useQuery({ queryKey: ["play"], queryFn: () => api<OnlineGame[]>("/api/play"), refetchInterval: 5000 });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const status = useQuery({ queryKey: ["play-status"], queryFn: () => api<{ enabled: boolean; reason: string | null }>("/api/play/status") });

  return (
    <main className="page">
      <div className="page-head">
        <h1>Play online</h1>
      </div>
      {status.data && !status.data.enabled && <p className="dim">Online play isn't running on this server: {status.data.reason}</p>}
      {status.data?.enabled && (
        <>
          <NewGame decks={decks.data ?? []} />
          <JoinGame decks={decks.data ?? []} />
        </>
      )}
      <section style={{ marginTop: "2rem" }}>
        <h2>Your games</h2>
        <ErrorText error={games.error} />
        {games.data?.length === 0 && <p className="dim">No online games yet.</p>}
        <div className="list">
          {games.data?.map((g) => (
            <Link key={g.id} to={`/play/${g.id}`} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>
                <span className="title">{g.seats.map((s) => s.name).join(", ")}</span>
                <br />
                <span className="dim small">
                  {g.status === "lobby" ? `Waiting for players. Code ${g.code}` : g.status === "in_progress" ? "In progress" : "Finished"}
                </span>
              </span>
              <span className="dim small">{new Date(g.created_at).toLocaleDateString()}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}

function NewGame({ decks }: { decks: DeckSummary[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const first = decks[0]?.id ?? "";
  const [seats, setSeats] = useState<SeatPlan[]>([
    { kind: "me", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
  ]);
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const [groupId, setGroupId] = useState("");
  const deckOf = (s: SeatPlan) => s.deckId || first;
  const update = (i: number, patch: Partial<SeatPlan>) => setSeats((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/play", {
        method: "POST",
        json: {
          playgroup_id: groupId || null,
          seats: seats.map((s) => ({
            kind: s.kind,
            deck_id: s.kind === "friend" ? null : deckOf(s),
            difficulty: s.kind === "ai" ? s.difficulty : null,
          })),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["play"] });
      navigate(`/play/${r.id}`);
    },
  });

  if (!decks.length) {
    return <p className="dim">Add a deck first (Decks tab); each seat plays one.</p>;
  }
  return (
    <section className="stack">
      <h2>New game</h2>
      <p className="dim small">Seat 1 is you. Friends join with a code; the computer plays the AI seats with your decks.</p>
      {!!groups.data?.length && (
        <label style={{ maxWidth: "24rem" }}>
          Playgroup
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">None (not counted in group stats)</option>
            {groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      )}
      <div className="seats">
      {seats.map((s, i) => {
        const deck = s.kind === "friend" ? undefined : decks.find((d) => d.id === deckOf(s));
        const who = i === 0 ? "You" : s.kind === "friend" ? "A friend" : `Computer, ${s.difficulty.toLowerCase()}`;
        return (
        <fieldset key={i} className="seat seat-card">
          <legend className="visually-hidden">Seat {i + 1}</legend>
          {/* The deck's commander art; a friend's seat stays an empty slot until they join. */}
          <ArtPanel className="seat-head" art={deck?.commander_image} artist={deck?.commander_artist} wash="left" empty={!deck}>
            <span className="seat-n">Seat {i + 1}</span>
            <span className="seat-name">{who}</span>
            <span className="seat-what">
              <span className="seat-cmdr">{deck ? deck.name : "Joins with the code"}</span>
              {deck && <Pips identity={deck.color_identity} label={false} />}
            </span>
          </ArtPanel>
          <div className="row seat-fields" style={{ alignItems: "end" }}>
            {i > 0 && (
              <label style={{ flex: "0 1 10rem" }}>
                Who
                <select value={s.kind} onChange={(e) => update(i, { kind: e.target.value as SeatPlan["kind"] })}>
                  <option value="ai">Computer</option>
                  <option value="friend">A friend</option>
                </select>
              </label>
            )}
            {s.kind !== "friend" && (
              <label style={{ flex: "1 1 12rem" }}>
                Deck
                <select value={deckOf(s)} onChange={(e) => update(i, { deckId: e.target.value })}>
                  {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            {s.kind === "ai" && (
              <label style={{ flex: "0 1 8rem" }}>
                Skill
                <select value={s.difficulty} onChange={(e) => update(i, { difficulty: e.target.value })}>
                  {DIFFICULTIES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </label>
            )}
          </div>
        </fieldset>
        );
      })}
      </div>
      <div className="row">
        {seats.length < 6 && <button onClick={() => setSeats((a) => [...a, { kind: "ai", deckId: "", difficulty: "Medium" }])}>Add a seat</button>}
        {seats.length > 2 && <button className="quiet" onClick={() => setSeats((a) => a.slice(0, -1))}>Remove the last seat</button>}
      </div>
      <ErrorText error={create.error} />
      <div className="row">
        <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          {seats.some((s) => s.kind === "friend") ? "Open the table" : "Start the game"}
        </button>
      </div>
    </section>
  );
}

function JoinGame({ decks }: { decks: DeckSummary[] }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [deckId, setDeckId] = useState("");
  const join = useMutation({
    mutationFn: () => api<{ id: string }>("/api/play/join", { method: "POST", json: { code, deck_id: deckId || decks[0]?.id } }),
    onSuccess: (r) => navigate(`/play/${r.id}`),
  });
  if (!decks.length) return null;
  return (
    <section className="stack" style={{ marginTop: "2rem" }}>
      <h2>Join a friend's game</h2>
      <form className="row" style={{ alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); join.mutate(); }}>
        <label style={{ flex: "0 1 9rem" }}>
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} required autoCapitalize="characters" />
        </label>
        <label style={{ flex: "1 1 12rem" }}>
          Your deck
          <select value={deckId || decks[0]?.id} onChange={(e) => setDeckId(e.target.value)}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button disabled={join.isPending}>Join</button>
      </form>
      <ErrorText error={join.error} />
    </section>
  );
}
