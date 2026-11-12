// Play online, to the Night table artboards (design/screens/Play and PlayPhone): a hero to
// continue your current game on its commanders' art, the new-game seats (your decks, friends by
// code, the computer on one of your decks or a precon, and who goes first), joining with a code,
// and your games.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GAME_WORDS, wonText } from "@yama/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type DeckSummary, type Playgroup } from "../api";
import { ArtMosaic } from "../components/ArtMosaic";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Button, ButtonLink, ErrorText, Segmented } from "../components/ui";
import { AlphaTag, ALPHA_NOTE } from "../components/AlphaTag";
import { OnlineSupport } from "../components/OnlineSupport";
import { BracketChips } from "../components/Bracket";
import { useMe, usePower } from "../auth";
import type { OnlineGame, SeatInfo } from "./types";
import type { PreconList } from "../lab/api";
import { SavedDeckPicker, PreconPicker } from "../components/DeckPicker";
import { playRequest, playsPrecon, seatWho, withPrecons, type SeatPlan } from "./setup";
import type { GuestSession } from "../guestPlay";
import { GuestNote } from "./GuestPlay";
import "./play.css";
import { ago } from "@yama/core";

const SKILLS = ["Easy", "Medium", "Hard"] as const;


/** "You, Sam and 2 computers" from a game's seats. */
export function tableWho(seats: SeatInfo[], you: number | null): string {
  const people = seats.filter((s) => !s.ai && s.seat !== you && s.deck_name).map((s) => s.name);
  const open = seats.filter((s) => !s.ai && !s.deck_name).length;
  const ai = seats.filter((s) => s.ai).length;
  const parts = [...(you !== null ? ["You"] : []), ...people, ...(ai ? [ai === 1 ? "a computer" : `${ai} computers`] : [])];
  const list = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return open ? `${list}, ${open} open ${open === 1 ? "seat" : "seats"}` : list;
}

/** What a game in the list says first: who won, that it's waiting, or that it's under way. */
function gameStatus(g: OnlineGame): { text: string; tone: "" | "warn" | "dim" } {
  if (g.status === "lobby") return { text: `Waiting for players, code ${g.code}`, tone: "warn" };
  if (g.status === "in_progress") return { text: GAME_WORDS.going, tone: "" };
  if (g.winner === null || g.winner === undefined) return { text: g.status === "abandoned" ? GAME_WORDS.abandoned : GAME_WORDS.draw, tone: "dim" };
  const w = g.seats.find((s) => s.seat === g.winner);
  const who = !w ? "Someone" : w.seat === g.you ? "You" : w.ai ? "The computer" : w.name;
  return { text: `${wonText(who)}${g.turns ? ` on turn ${g.turns}` : ""}`, tone: "dim" };
}

/** Play online. `guest`: someone playing without an account (GuestPlay.tsx), on precons only. */
export function PlayHome({ guest }: { guest?: GuestSession } = {}) {
  const power = usePower() && !guest;
  const games = useQuery({
    queryKey: guest ? ["play", "guest"] : ["play"],
    queryFn: ({ signal }) => api<OnlineGame[]>("/api/play", { signal }),
    // Every 10 s while one of your tables waits for players, otherwise every 30 s (only while the
    // page is on screen), and again on coming back to it. It was every 5 s.
    refetchInterval: (q) => (q.state.data?.some((g) => g.status === "lobby") ? 10_000 : 30_000),
    refetchOnWindowFocus: "always",
  });
  // A guest has no decks (and asking would only be refused).
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled: !guest });
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
      {guest && <GuestNote session={guest} />}
      {status.data && !status.data.enabled && <p className="dim">Online play isn't running on this server: {status.data.reason}</p>}
      {current && <ContinueHero game={current} />}
      <div className="ph-cols">
        {status.data?.enabled && <NewGame decks={decks.data ?? []} guest={!!guest} />}
        <div className="ph-side">
          {status.data?.enabled && !guest && <JoinGame decks={decks.data ?? []} />}
          {status.data?.enabled && power && (
            <section className="ph-watch" aria-labelledby="ph-watch-h">
              <h2 id="ph-watch-h">Watch AIs play</h2>
              <p className="dim">Watch your decks or precons play at your pace.</p>
              <ButtonLink to="/play/watch" variant="outline">Set up a game</ButtonLink>
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
 * Your game in progress, on every seat's commander art. The games list says the turn, whose turn
 * it is and whether it's your move, so the headline needs no board (25 to 100 KB) of its own; it
 * moves on as the list refreshes.
 */
function ContinueHero({ game }: { game: OnlineGame }) {
  const seats = game.seats.slice(0, 4);
  const active = game.active != null ? game.seats.find((s) => s.seat === game.active) : undefined;
  const headline = game.turn == null
    ? "Your game"
    : game.your_move
      ? `Your move, turn ${game.turn}`
      : game.active === game.you
        ? `Your turn ${game.turn}`
        : `${active?.ai ? "The computer" : active?.name ?? "Someone"}'s move, turn ${game.turn}`;
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
          {tableWho(game.seats, game.you)}.{game.updated_at ? ` Last move ${ago(game.updated_at)}.` : ""}
        </span>
      </span>
      <span className="ph-hero-go"><span className="ph-go-long">Open the board</span><span className="ph-go-short">Open</span></span>
      <span className="ph-hero-credit">{artCredits(seats.map((s) => (s.commander_art ? s.commander_artist : null)))}</span>
    </Link>
  );
}

function NewGame({ decks, guest }: { decks: DeckSummary[]; guest: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const first = decks[0]?.id ?? "";
  const [planned, setSeats] = useState<SeatPlan[]>([
    { kind: "me", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
  ]);
  const [editing, setEditing] = useState<number | null>(null);
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups"), enabled: !guest });
  // Stock precons for the computer's seats, as Watch offers them. Without the catalog the
  // computer plays your decks.
  const precons = useQuery({ queryKey: ["precons"], queryFn: () => api<PreconList>("/api/precons") });
  // Repeats of an earlier list are left out; sorted by name.
  const preconChoices = (precons.data?.precons ?? []).filter((p) => !p.same_list_as).sort((a, b) => a.name.localeCompare(b.name));
  // Without decks of your own (a guest, or a new account), every seat plays a precon.
  const noDecks = decks.length === 0;
  const seats = withPrecons(planned, preconChoices.map((p) => p.id), noDecks);
  const [groupId, setGroupId] = useState("");
  /** The seat that takes the first turn, or null to roll for it as a table would. */
  const [goesFirst, setGoesFirst] = useState<number | null>(null);
  const deckOf = (s: SeatPlan) => s.deckId || first;
  const update = (i: number, patch: Partial<SeatPlan>) => setSeats((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/api/play", { method: "POST", json: playRequest(seats, goesFirst, groupId, first) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["play"] });
      navigate(`/play/${r.id}`);
    },
  });

  if (noDecks && !preconChoices.length) {
    // A guest waits for the precons; an account can add a deck meanwhile.
    if (guest) return <section className="ph-new"><h2>New game</h2><ErrorText error={precons.error} /></section>;
    return (
      <section className="ph-new">
        <h2>New game</h2>
        <p className="dim">Add a deck to start playing.</p>
        <div className="row">
          <ButtonLink variant="primary" to="/decks/import">Add a deck</ButtonLink>
          <ButtonLink variant="outline" to="/lab">Start from a precon</ButtonLink>
        </div>
      </section>
    );
  }
  // Each seat's own deck (yours, or the one the computer plays), or the computer's precon.
  const shown = seats.map((s) => (s.kind === "friend" || playsPrecon(s) ? undefined : decks.find((d) => d.id === deckOf(s))));
  const preconOf = (s: SeatPlan) => (playsPrecon(s) ? preconChoices.find((p) => p.id === s.preconId) : undefined);
  const art = seats.map((s, i) => {
    const p = preconOf(s);
    return p ? { name: p.name, image: p.art?.url ?? null, artist: p.art?.artist ?? null } : shown[i] ? { name: shown[i]!.name, image: shown[i]!.commander_image, artist: shown[i]!.commander_artist } : undefined;
  });
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
      <p className="small dim">Rules engine: Phase. Choose Easy, Medium or Hard for each computer below before starting.</p>
      {noDecks && !guest && (
        <p className="small dim">
          No decks yet, so every seat plays a precon. <Link to="/decks/import">Add a deck</Link> to play your own.
        </p>
      )}
      <ol className="ph-seats">
        {seats.map((s, i) => {
          const deck = shown[i];
          const seatArt = art[i];
          const who = i === 0 ? (guest ? "You" : me.data?.display_name ?? "You") : s.kind === "friend" ? "A friend" : "Computer";
          return (
            <li key={i} className={`ph-seat${s.kind === "friend" ? " open" : ""}${editing === i ? " editing" : ""}`}>
              <ArtPanel className="ph-seat-head" art={seatArt?.image} artist={seatArt?.artist} wash="bottom" empty={!seatArt} credit={false}>
                <span className="ph-seat-who">{i === 0 ? "You" : who}</span>
                <span className="ph-seat-n">Seat {i + 1}</span>
              </ArtPanel>
              {/* Phones show a compact row with a Change button; the fields open below it. */}
              <div className="ph-seat-row">
                <span className="ph-seat-thumb" aria-hidden="true">
                  {seatArt?.image ? <img src={seatArt.image} alt="" /> : i + 1}
                </span>
                <span className="ph-seat-sum">
                  <b>{i === 0 ? "You" : s.kind === "ai" ? `Computer, ${s.difficulty.toLowerCase()}` : who}</b>
                  <span>{s.kind === "friend" ? "Joins with the code" : seatArt?.name ?? "No deck"}</span>
                </span>
                <Button className="ph-change" aria-expanded={editing === i} aria-label={`Change seat ${i + 1}`} onClick={() => setEditing(editing === i ? null : i)}>
                  {editing === i ? "Done" : "Change"}
                </Button>
              </div>
              <div className="ph-seat-fields">
                {i > 0 && !guest && (
                  <Segmented className="ph-kind" label={`Who plays seat ${i + 1}`} value={s.kind} onChange={(kind) => update(i, { kind })} options={[["ai", "Computer"], ["friend", "A friend"]]} />
                )}
                {s.kind !== "friend" && !noDecks && preconChoices.length > 0 && (
                  <Segmented
                    className="ph-kind"
                    label={i === 0 ? "Your deck" : `Deck for the computer in seat ${i + 1}`}
                    value={playsPrecon(s) ? "precon" : "deck"}
                    onChange={(source) => update(i, source === "precon" ? { source, preconId: s.preconId || preconChoices[(i * 37 + 11) % preconChoices.length]!.id } : { source })}
                    options={[["deck", "Your decks"], ["precon", "Precons"]]}
                  />
                )}
                {s.kind !== "friend" && !playsPrecon(s) && (
                  <SavedDeckPicker decks={decks} value={deckOf(s)} onChange={(deckId) => update(i, { deckId })} />
                )}
                {playsPrecon(s) && <PreconPicker precons={preconChoices} value={s.preconId ?? ""} onChange={(preconId) => update(i, { preconId })} />}
                {s.kind === "ai" && (
                  <div className="ph-skills" role="group" aria-label={`Difficulty for seat ${i + 1}`}>
                    {SKILLS.map((k) => (
                      <Button key={k} aria-pressed={s.difficulty === k} onClick={() => update(i, { difficulty: k })}>{k}</Button>
                    ))}
                  </div>
                )}
                {s.kind === "friend" && <p className="ph-friend">Joins by code with their own deck.</p>}
                {s.kind !== "friend" && deck && (deck.bracket != null || deck.estimate) && (
                  <div><BracketChips declared={deck.bracket} estimate={deck.estimate} /></div>
                )}
                {s.kind !== "friend" && !playsPrecon(s) && deckOf(s) && <OnlineSupport deckId={deckOf(s)} versionId={deck?.current_version_id} />}
              </div>
            </li>
          );
        })}
      </ol>
      {art.some((a) => a?.image) && <p className="ph-credit">{artCredits(art.map((a) => (a?.image ? a.artist : null)))}</p>}
      <div className="wh-options">
        <label className="wh-first">
          Goes first
          <select value={goesFirst ?? ""} onChange={(e) => setGoesFirst(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Roll for it, as at a table</option>
            {seats.map((s, i) => <option key={i} value={i}>{seatWho(s, i)}</option>)}
          </select>
        </label>
      </div>
      <ErrorText error={create.error} />
      <div className="ph-new-foot">
        <span className="ph-seat-buttons">
          {seats.length < 6 && (
            <Button variant="outline" className="ph-add" onClick={() => setSeats((a) => [...a, { kind: "ai", deckId: "", difficulty: "Medium" }])}>Add a seat</Button>
          )}
          {seats.length > 2 && (
            <Button
              variant="quiet" className="ph-remove"
              onClick={() => {
                setSeats((a) => a.slice(0, -1));
                // The seat chosen to go first went with it: back to a roll.
                if (goesFirst !== null && goesFirst >= seats.length - 1) setGoesFirst(null);
              }}
            >
              Remove the last seat
            </Button>
          )}
        </span>
        <Button variant="primary" className="ph-open" onClick={() => create.mutate()} disabled={create.isPending}>
          {seats.some((s) => s.kind === "friend") ? "Open the table" : "Start the game"}
        </Button>
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
        <div className="ph-join-deck">
          <SavedDeckPicker label="Your deck" decks={decks} value={deckId || decks[0]!.id} onChange={setDeckId} />
        </div>
        <Button type="submit" className="ph-join-go" disabled={join.isPending}>Join</Button>
      </form>
      {chosen && (chosen.bracket != null || chosen.estimate) && <BracketChips declared={chosen.bracket} estimate={chosen.estimate} />}
      {chosen && <OnlineSupport deckId={chosen.id} versionId={chosen.current_version_id} />}
      <ErrorText error={join.error} />
    </section>
  );
}
