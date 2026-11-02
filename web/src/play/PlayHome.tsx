// Play online, to the Night table artboards (design/screens/Play and PlayPhone): a hero to
// continue your current game on its commanders' art, the new-game seats, joining with a code,
// and your games.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type DeckSummary, type Playgroup } from "../api";
import { ArtMosaic } from "../components/ArtMosaic";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ErrorText } from "../components/ui";
import { AlphaTag, ALPHA_NOTE } from "../components/AlphaTag";
import { OnlineSupport } from "../components/OnlineSupport";
import { BracketChips } from "../components/Bracket";
import { useMe, usePower } from "../auth";
import type { OnlineGame, SeatInfo, ServerMessage } from "./types";
import "./play.css";

const SKILLS = ["Easy", "Medium", "Hard"] as const;

interface SeatPlan {
  kind: "me" | "friend" | "ai";
  deckId: string;
  difficulty: string;
}

type ViewMessage = Extract<ServerMessage, { type: "view" }>;

/** "You, Sam and 2 computers" from a game's seats. */
export function tableWho(seats: SeatInfo[], you: number | null): string {
  const people = seats.filter((s) => !s.ai && s.seat !== you && s.deck_name).map((s) => s.name);
  const open = seats.filter((s) => !s.ai && !s.deck_name).length;
  const ai = seats.filter((s) => s.ai).length;
  const parts = [...(you !== null ? ["You"] : []), ...people, ...(ai ? [ai === 1 ? "a computer" : `${ai} computers`] : [])];
  const list = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return open ? `${list}, ${open} open ${open === 1 ? "seat" : "seats"}` : list;
}

export function ago(iso: string | undefined): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What a game in the list says first: who won, that it's waiting, or that it's under way. */
function gameStatus(g: OnlineGame): { text: string; tone: "" | "warn" | "dim" } {
  if (g.status === "lobby") return { text: `Waiting for players, code ${g.code}`, tone: "warn" };
  if (g.status === "in_progress") return { text: "In progress", tone: "" };
  if (g.winner === null || g.winner === undefined) return { text: g.status === "abandoned" ? "Abandoned" : "Finished", tone: "dim" };
  const w = g.seats.find((s) => s.seat === g.winner);
  const who = !w ? "Someone" : w.seat === g.you ? "You" : w.ai ? "The computer" : w.name;
  return { text: `${who} won${g.turns ? ` on turn ${g.turns}` : ""}`, tone: "dim" };
}

export function PlayHome() {
  const power = usePower();
  const games = useQuery({
    queryKey: ["play"],
    queryFn: ({ signal }) => api<OnlineGame[]>("/api/play", { signal }),
    // Every 10 s while one of your tables waits for players, otherwise every 30 s (only while the
    // page is on screen), and again on coming back to it. It was every 5 s.
    refetchInterval: (q) => (q.state.data?.some((g) => g.status === "lobby") ? 10_000 : 30_000),
    refetchOnWindowFocus: true,
  });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const status = useQuery({ queryKey: ["play-status"], queryFn: () => api<{ enabled: boolean; reason: string | null }>("/api/play/status") });
  const current = games.data?.find((g) => g.status === "in_progress" && g.you !== null);
  const others = games.data?.filter((g) => g !== current) ?? [];
  const listArt = others.flatMap((g) => g.seats.filter((s) => s.commander_art).slice(0, 4));

  return (
    <main className="page play-home">
      <div className="ph-head">
        <h1>
          Play online
          <AlphaTag />
        </h1>
        <p className="dim">{ALPHA_NOTE}</p>
      </div>
      {status.data && !status.data.enabled && <p className="dim">Online play isn't running on this server: {status.data.reason}</p>}
      {current && <ContinueHero game={current} />}
      <div className="ph-cols">
        {status.data?.enabled && <NewGame decks={decks.data ?? []} />}
        <div className="ph-side">
          {status.data?.enabled && <JoinGame decks={decks.data ?? []} />}
          {status.data?.enabled && power && (
            <section className="ph-watch" aria-labelledby="ph-watch-h">
              <h2 id="ph-watch-h">Watch AIs play</h2>
              <p className="dim">Watch your decks or precons play at your pace.</p>
              <Link to="/play/watch" className="button outline">Set up a game</Link>
            </section>
          )}
          <section className="ph-games" aria-labelledby="ph-games-h">
            <h2 id="ph-games-h">{current ? "Earlier games" : "Your games"}</h2>
            <ErrorText error={games.error} />
            {games.data && others.length === 0 && <p className="dim">{current ? "None yet." : "No online games yet."}</p>}
            <ul className="ph-game-list">
              {others.map((g) => {
                const st = gameStatus(g);
                return (
                  <li key={g.id}>
                    <Link to={`/play/${g.id}`} className="ph-game">
                      <ArtMosaic className="ph-game-art" arts={g.seats.map((s) => s.commander_art)} />
                      <span className="ph-game-text">
                        <span className={`ph-game-status ${st.tone}`}>{st.text}</span>
                        <span className="ph-game-who">
                          {tableWho(g.seats, g.you)}
                          <span className="ph-game-who-when">, {ago(g.updated_at ?? g.created_at)}</span>
                        </span>
                      </span>
                      <span className="ph-game-when">{ago(g.updated_at ?? g.created_at)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {listArt.length > 0 && <p className="ph-credit">{artCredits(listArt.map((s) => s.commander_artist))}</p>}
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * Your game in progress, on every seat's commander art. The headline needs the game's board (25 to
 * 100 KB), which used to be asked for every 10 s: now it's asked when the games list says the game
 * moved on (`updated_at`), and otherwise once a minute, since `updated_at` counts whole seconds and
 * two moves in one second look like one.
 */
function ContinueHero({ game }: { game: OnlineGame }) {
  const view = useQuery({
    queryKey: ["play-view", game.id, game.updated_at ?? game.created_at],
    queryFn: ({ signal }) => api<ViewMessage>(`/api/play/${game.id}/view`, { signal }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    // Keeps the last headline while the next one loads.
    placeholderData: (prev) => prev,
  });
  const v = view.data?.view;
  const seats = game.seats.slice(0, 4);
  const yourMove = !!v?.decision && !(v.decision.options.length === 1 && v.decision.options[0]!.label.startsWith("Pass"));
  const active = v ? game.seats.find((s) => s.seat === v.active) : undefined;
  const headline = !v
    ? "Your game"
    : yourMove
      ? `Your move, turn ${v.turn}`
      : v.active === game.you
        ? `Your turn ${v.turn}`
        : `${active?.ai ? "The computer" : active?.name ?? "Someone"}'s move, turn ${v.turn}`;
  // One tile per distinct commander: the same art repeated across seats looked like a tiling bug.
  const tiles = seats.filter((s, i) => !s.commander_art || seats.findIndex((o) => o.commander_art === s.commander_art) === i);
  return (
    <Link to={`/play/${game.id}`} className="ph-hero" aria-label={`Continue your game: ${headline}`} data-n={tiles.length}>
      <span className="ph-hero-art" aria-hidden="true">
        {tiles.map((s) => (s.commander_art ? <img key={s.seat} src={s.commander_art} alt="" /> : <span key={s.seat} className="ph-hero-blank" />))}
      </span>
      <span className="ph-hero-wash" aria-hidden="true" />
      <span className="ph-hero-text">
        <span className="ph-hero-kicker">Continue</span>
        <span className="ph-hero-title">{headline}</span>
        <span className="ph-hero-who">
          {tableWho(game.seats, game.you)}. Last move {ago(game.updated_at)}.
        </span>
      </span>
      <span className="ph-hero-go"><span className="ph-go-long">Open the board</span><span className="ph-go-short">Open</span></span>
      <span className="ph-hero-credit">{artCredits(seats.map((s) => (s.commander_art ? s.commander_artist : null)))}</span>
    </Link>
  );
}

function NewGame({ decks }: { decks: DeckSummary[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const first = decks[0]?.id ?? "";
  const [seats, setSeats] = useState<SeatPlan[]>([
    { kind: "me", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
  ]);
  const [editing, setEditing] = useState<number | null>(null);
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
    return (
      <section className="ph-new">
        <h2>New game</h2>
        <p className="dim">Add a deck to start playing.</p>
      </section>
    );
  }
  const shown = seats.map((s) => (s.kind === "friend" ? undefined : decks.find((d) => d.id === deckOf(s))));
  return (
    <section className="ph-new" aria-labelledby="ph-new-h">
      <div className="ph-new-head">
        <h2 id="ph-new-h">New game</h2>
        {!!groups.data?.length && (
          <label className="ph-group">
            Playgroup
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">None (not in group stats)</option>
              {groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <ol className="ph-seats">
        {seats.map((s, i) => {
          const deck = shown[i];
          const who = i === 0 ? me.data?.display_name ?? "You" : s.kind === "friend" ? "A friend" : "Computer";
          return (
            <li key={i} className={`ph-seat${s.kind === "friend" ? " open" : ""}${editing === i ? " editing" : ""}`}>
              <ArtPanel className="ph-seat-head" art={deck?.commander_image} artist={deck?.commander_artist} wash="bottom" empty={!deck} credit={false}>
                <span className="ph-seat-who">{i === 0 ? "You" : who}</span>
                <span className="ph-seat-n">Seat {i + 1}</span>
              </ArtPanel>
              {/* Phones show a compact row with a Change button; the fields open below it. */}
              <div className="ph-seat-row">
                <span className="ph-seat-thumb" aria-hidden="true">
                  {deck?.commander_image ? <img src={deck.commander_image} alt="" /> : i + 1}
                </span>
                <span className="ph-seat-sum">
                  <b>{i === 0 ? "You" : s.kind === "ai" ? `Computer, ${s.difficulty.toLowerCase()}` : who}</b>
                  <span>{s.kind === "friend" ? "Joins with the code" : deck?.name ?? "No deck"}</span>
                </span>
                <button type="button" className="ph-change" aria-expanded={editing === i} aria-label={`Change seat ${i + 1}`} onClick={() => setEditing(editing === i ? null : i)}>
                  {editing === i ? "Done" : "Change"}
                </button>
              </div>
              <div className="ph-seat-fields">
                {i > 0 && (
                  <div className="segmented ph-kind" role="group" aria-label={`Who plays seat ${i + 1}`}>
                    <button type="button" aria-pressed={s.kind === "ai"} onClick={() => update(i, { kind: "ai" })}>Computer</button>
                    <button type="button" aria-pressed={s.kind === "friend"} onClick={() => update(i, { kind: "friend" })}>A friend</button>
                  </div>
                )}
                {s.kind !== "friend" && (
                  <label>
                    Deck
                    <select value={deckOf(s)} onChange={(e) => update(i, { deckId: e.target.value })}>
                      {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                )}
                {s.kind === "ai" && (
                  <div className="ph-skills" role="group" aria-label={`Skill for seat ${i + 1}`}>
                    {SKILLS.map((k) => (
                      <button key={k} type="button" aria-pressed={s.difficulty === k} onClick={() => update(i, { difficulty: k })}>{k}</button>
                    ))}
                  </div>
                )}
                {s.kind === "friend" && <p className="ph-friend">Joins by code with their own deck.</p>}
                {s.kind !== "friend" && deck && (deck.bracket != null || deck.estimate) && (
                  <div><BracketChips declared={deck.bracket} estimate={deck.estimate} /></div>
                )}
                {s.kind !== "friend" && deckOf(s) && <OnlineSupport deckId={deckOf(s)} versionId={deck?.current_version_id} />}
              </div>
            </li>
          );
        })}
      </ol>
      {shown.some((d) => d?.commander_image) && <p className="ph-credit">{artCredits(shown.map((d) => (d?.commander_image ? d.commander_artist : null)))}</p>}
      <ErrorText error={create.error} />
      <div className="ph-new-foot">
        <span className="ph-seat-buttons">
          {seats.length < 6 && (
            <button type="button" className="outline ph-add" onClick={() => setSeats((a) => [...a, { kind: "ai", deckId: "", difficulty: "Medium" }])}>Add a seat</button>
          )}
          {seats.length > 2 && (
            <button type="button" className="quiet ph-remove" onClick={() => setSeats((a) => a.slice(0, -1))}>Remove the last seat</button>
          )}
        </span>
        <button type="button" className="primary ph-open" onClick={() => create.mutate()} disabled={create.isPending}>
          {seats.some((s) => s.kind === "friend") ? "Open the table" : "Start the game"}
        </button>
      </div>
    </section>
  );
}

function JoinGame({ decks }: { decks: DeckSummary[] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => (params.get("code") ?? "").toUpperCase());
  const [deckId, setDeckId] = useState("");
  const join = useMutation({
    mutationFn: () => api<{ id: string }>("/api/play/join", { method: "POST", json: { code, deck_id: deckId || decks[0]?.id } }),
    onSuccess: (r) => navigate(`/play/${r.id}`),
  });
  if (!decks.length) return null;
  const chosen = decks.find((d) => d.id === (deckId || decks[0]?.id));
  return (
    <section className="ph-join" aria-labelledby="ph-join-h">
      <h2 id="ph-join-h"><span className="ph-join-long">Join a friend's game</span><span className="ph-join-short">Join with a code</span></h2>
      <form className="ph-join-form" onSubmit={(e) => { e.preventDefault(); join.mutate(); }}>
        <label className="ph-code">
          <span className="ph-code-label">Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="Code" />
        </label>
        <label className="ph-join-deck">
          Your deck
          <select value={deckId || decks[0]?.id} onChange={(e) => setDeckId(e.target.value)}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button type="submit" className="ph-join-go" disabled={join.isPending}>Join</button>
      </form>
      {chosen && (chosen.bracket != null || chosen.estimate) && <BracketChips declared={chosen.bracket} estimate={chosen.estimate} />}
      {chosen && <OnlineSupport deckId={chosen.id} versionId={chosen.current_version_id} />}
      <ErrorText error={join.error} />
    </section>
  );
}
