import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityName, winConditionLabel, type FunRating, type PlayerSetup, type TableSetup, type WinCondition } from "@yama/core";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type DeckSummary, type DeckVersionRow, type GameRow, type Playgroup, type SearchResult } from "../api";
import { useMe } from "../auth";
import { ErrorText, Pips, Sheet } from "../components/ui";
import { BracketChips } from "../components/Bracket";
import { FirstPlayerPicker, FunPicker, WinConditionPicker } from "../components/GameCapture";
import { localDay, versionOn } from "./versions";
import { emptySeat, fitSeatsToGroup, NOT_AN_ACCOUNT, patchSeat, renameSeat, type SeatDraft } from "./seats";
import { discardGame, startGame, sync, useOutbox, useRejected, useSyncStatus, useTable } from "./store";
import "./seats.css";

const LAST_SETUP = "yama.table.lastSetup";

export function TableHome() {
  const { game, state } = useTable();
  const outbox = useOutbox();
  const rejected = useRejected();
  const syncStatus = useSyncStatus();
  const navigate = useNavigate();

  return (
    <main className="page">
      {game && state ? (
        <section className="stack" style={{ marginBottom: "2rem" }}>
          <div className="page-head">
            <h1>Game in progress</h1>
          </div>
          <div className="list">
            {state.players.map((p) => (
              <div key={p.seat} className="list-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <Pips identity={p.colorIdentity} />
                <span>
                  <span className="title">{p.name}</span>
                  {p.commanderName && <span className="dim"> playing {p.commanderName}</span>}
                </span>
                <span className="num" style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: "var(--t-lg)" }}>
                  {p.eliminated ? "out" : p.life}
                </span>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="primary" onClick={() => navigate("/table/play")}>Back to the table</button>
            <button className="quiet" onClick={() => confirm("Throw this game away? It won't be saved.") && discardGame()}>
              Discard
            </button>
          </div>
        </section>
      ) : (
        <NewGame onStart={() => navigate("/table/play")} />
      )}

      {outbox.length > 0 && (
        <p className="dim small">
          {outbox.length} finished {outbox.length === 1 ? "game is" : "games are"} waiting to upload.{" "}
          <button className="quiet small" onClick={() => void sync()} disabled={syncStatus.syncing}>
            Upload now
          </button>
          {syncStatus.error && <span className="error"> {syncStatus.error}</span>}
        </p>
      )}
      {rejected.length > 0 && (
        <p className="small error">
          {rejected.length} finished {rejected.length === 1 ? "game" : "games"} couldn't be saved to Yama ({rejected[rejected.length - 1]!.error}). They're kept on this phone.
        </p>
      )}
      <RecentGames />
    </main>
  );
}

function NewGame({ onStart }: { onStart: () => void }) {
  const me = useMe();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [groupId, setGroupId] = useState<string>("");
  const [life, setLife] = useState(40);
  const [seats, setSeats] = useState<SeatDraft[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_SETUP) ?? "null");
      if (saved?.seats?.length) return saved.seats;
    } catch {
      /* ignore */
    }
    return [
      { ...emptySeat(), name: me.data?.display_name ?? "Me", userId: me.data?.id },
      emptySeat(),
      emptySeat(),
      emptySeat(),
    ];
  });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_SETUP) ?? "null");
      if (saved?.groupId) setGroupId(saved.groupId);
      if (saved?.life) setLife(saved.life);
    } catch {
      /* ignore */
    }
  }, []);

  const group = groups.data?.find((g) => g.id === groupId);
  const update = (i: number, patch: Partial<SeatDraft>) => setSeats((s) => patchSeat(s, i, patch));
  const chooseGroup = (id: string) => {
    setGroupId(id);
    setSeats((s) => fitSeatsToGroup(s, groups.data?.find((g) => g.id === id), me.data));
  };
  const setCount = (n: number) => setSeats((s) => (n > s.length ? [...s, ...Array.from({ length: n - s.length }, emptySeat)] : s.slice(0, n)));

  const start = () => {
    const players: PlayerSetup[] = seats.map((s, i) => ({
      seat: i,
      name: s.name.trim() || `Player ${i + 1}`,
      memberId: s.memberId,
      userId: s.userId,
      deckVersionId: s.deckVersionId,
      deckLabel: s.commanderName || undefined,
      commanderName: s.commanderName || undefined,
      colorIdentity: s.colorIdentity,
      art: s.art,
      artist: s.artist,
    }));
    const setup: TableSetup = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      format: "commander",
      startingLife: life,
      playgroupId: groupId || undefined,
      players,
    };
    localStorage.setItem(LAST_SETUP, JSON.stringify({ seats, groupId, life }));
    startGame(setup);
    onStart();
  };

  return (
    <section className="stack">
      <div className="page-head">
        <h1>New game</h1>
      </div>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: "1 1 12rem" }}>
          Playgroup
          <select value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
            <option value="">None (not counted in group stats)</option>
            {groups.data?.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: "0 1 8rem" }}>
          Players
          <select value={seats.length} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label style={{ flex: "0 1 8rem" }}>
          Starting life
          <select value={life} onChange={(e) => setLife(Number(e.target.value))}>
            {[40, 30, 25, 20].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <p className="small dim">Seats go clockwise from the person holding the phone.</p>
      <div className="stack">
        {seats.map((s, i) => (
          <SeatEditor key={i} index={i} seat={s} onChange={(p) => update(i, p)} group={group} decks={s.userId && s.userId === me.data?.id ? decks.data : undefined} />
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={start}>Start the game</button>
      </div>
    </section>
  );
}

function SeatEditor({ index, seat, onChange, group, decks }: { index: number; seat: SeatDraft; onChange: (p: Partial<SeatDraft>) => void; group?: Playgroup; decks?: DeckSummary[] }) {
  const me = useMe().data;
  const listId = useId();
  const [error, setError] = useState<unknown>(null);
  const chosen = decks?.find((d) => d.id === seat.deckId);
  const suggestions = useQuery({
    queryKey: ["autocomplete", seat.commanderName],
    queryFn: () => api<string[]>(`/api/cards/autocomplete?q=${encodeURIComponent(seat.commanderName)}`),
    enabled: seat.commanderName.length >= 3 && !seat.colorIdentity,
  });

  const pickCommander = async (name: string) => {
    onChange({ commanderName: name });
    try {
      const r = await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(`!"${name}"`)}`);
      const card = r.cards[0];
      if (card) onChange({ commanderName: card.name, colorIdentity: card.color_identity, art: card.image_art_crop ?? undefined, artist: card.artist ?? undefined });
      setError(null);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <fieldset className="seat">
      <legend className="small dim">Seat {index + 1}</legend>
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ flex: "1 1 10rem" }}>
          Player
          {group ? (
            <select
              value={seat.memberId ?? ""}
              onChange={(e) => {
                const m = group.members.find((x) => x.id === e.target.value);
                // Your deck stays only on your own seat.
                if (m) onChange({ ...NOT_AN_ACCOUNT, memberId: m.id, userId: m.user_id ?? undefined, name: m.display_name, ...(m.user_id && m.user_id === seat.userId ? { deckId: seat.deckId, deckVersionId: seat.deckVersionId } : {}) });
                else onChange({ ...NOT_AN_ACCOUNT, memberId: undefined, name: "" });
              }}
            >
              <option value="">Someone else…</option>
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name}</option>
              ))}
            </select>
          ) : (
            <input value={seat.name} onChange={(e) => onChange(renameSeat(seat, e.target.value, me))} placeholder={`Player ${index + 1}`} />
          )}
        </label>
        {group && !seat.memberId && (
          <label style={{ flex: "1 1 10rem" }}>
            Name
            <input value={seat.name} onChange={(e) => onChange(renameSeat(seat, e.target.value, me))} placeholder="Guest" />
          </label>
        )}
        {!group && me && (
          <label className="check-row seat-me">
            <input
              type="checkbox"
              checked={seat.userId === me.id}
              onChange={(e) => onChange(e.target.checked ? { userId: me.id, name: me.display_name } : NOT_AN_ACCOUNT)}
            />
            This is me
          </label>
        )}
        {decks && decks.length > 0 && (
          <label style={{ flex: "1 1 12rem" }}>
            Deck
            <select
              value={seat.deckId ?? ""}
              onChange={(e) => {
                const d = decks.find((x) => x.id === e.target.value);
                if (!d) return onChange({ deckId: undefined, deckVersionId: undefined });
                onChange({
                  deckId: d.id,
                  deckVersionId: d.current_version_id ?? undefined,
                  colorIdentity: d.color_identity,
                  art: d.commander_image ?? undefined,
                  artist: d.commander_artist ?? undefined,
                });
                if (d.commanders[0]) void pickCommander(d.commanders[0]);
              }}
            >
              <option value="">Not one of my decks</option>
              {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        <label style={{ flex: "2 1 14rem" }}>
          Commander
          <input
            list={listId}
            value={seat.commanderName}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ commanderName: v, colorIdentity: "", art: undefined, artist: undefined });
              if (suggestions.data?.includes(v)) void pickCommander(v);
            }}
            onBlur={() => seat.commanderName && !seat.colorIdentity && void pickCommander(seat.commanderName)}
            placeholder="Start typing a name"
          />
          <datalist id={listId}>{suggestions.data?.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <span title={identityName(seat.colorIdentity)} style={{ paddingBottom: "0.7rem" }}>
          <Pips identity={seat.colorIdentity} />
        </span>
      </div>
      {chosen && (chosen.bracket != null || chosen.estimate) && (
        <div style={{ marginTop: "0.5rem" }}>
          <BracketChips declared={chosen.bracket} estimate={chosen.estimate} />
        </div>
      )}
      <ErrorText error={error} />
    </fieldset>
  );
}

function RecentGames() {
  const games = useQuery({ queryKey: ["games"], queryFn: () => api<GameRow[]>("/api/games") });
  const [logging, setLogging] = useState(false);
  return (
    <section style={{ marginTop: "2.5rem" }}>
      <div className="page-head" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Recent games</h2>
        <button onClick={() => setLogging(true)}>Log a game played without Yama</button>
      </div>
      {logging && <LogGame onClose={() => setLogging(false)} />}
      {!games.data?.length && <p className="dim">No games yet.</p>}
      <div className="list">
        {games.data?.slice(0, 10).map((g) => {
          const winner = g.seats.find((s) => s.seat === g.winner_seat);
          return (
            <div key={g.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>
                <span className="title">
                  {g.status === "finished" ? (winner ? `${winner.display_name} won` : "Draw") : "In progress"}
                  {g.status === "finished" && winner && winConditionLabel(g.win_condition) && (
                    <span className="dim" style={{ fontWeight: 400 }}> by {winConditionLabel(g.win_condition)!.toLowerCase()}</span>
                  )}
                </span>
                <span className="dim small">
                  {" "}
                  {g.seats.map((s) => s.commander_name ?? s.display_name).filter(Boolean).join(", ")}
                </span>
              </span>
              <span className="dim small num">
                {new Date(g.started_at).toLocaleDateString()}
                {g.turns ? `, ${g.turns} turns` : ""}
              </span>
            </div>
          );
        })}
      </div>
      <p className="small"><Link to="/group">Playgroup stats</Link></p>
    </section>
  );
}

function LogGame({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [groupId, setGroupId] = useState("");
  // The day here, not in UTC: after 7 pm in Texas, UTC is already tomorrow.
  const [date, setDate] = useState(() => localDay());
  const [turns, setTurns] = useState("");
  /** A seat (its index in the form), "draw", or null while nobody has answered. */
  const [winner, setWinner] = useState<number | "draw" | null>(null);
  const [first, setFirst] = useState<number | null>(null);
  const [condition, setCondition] = useState<WinCondition | null>(null);
  const [fun, setFun] = useState<FunRating[]>([]);
  // One id per form, so pressing Save again after a failed or slow upload can't log it twice.
  const [gameId] = useState(() => crypto.randomUUID());
  const [seats, setSeats] = useState<SeatDraft[]>(() => [
    { ...emptySeat(), name: me.data?.display_name ?? "", userId: me.data?.id },
    ...Array.from({ length: 3 }, emptySeat),
  ]);
  const group = groups.data?.find((g) => g.id === groupId);
  const update = (i: number, patch: Partial<SeatDraft>) => setSeats((s) => patchSeat(s, i, patch));
  const chooseGroup = (id: string) => {
    setGroupId(id);
    setSeats((s) => fitSeatsToGroup(s, groups.data?.find((g) => g.id === id), me.data));
  };
  // Seats left blank are dropped; the rest are numbered in order, and picks follow them.
  const filled = seats.map((s, i) => ({ s, i })).filter(({ s }) => s.name.trim() || s.memberId);
  const seatOf = (i: number | null) => (i === null ? null : filled.findIndex((f) => f.i === i));
  const named = filled.map(({ s, i }) => ({ seat: i, name: s.name.trim() || `Player ${i + 1}` }));

  const save = useMutation({
    mutationFn: async () => {
      if (filled.length < 1) throw new Error("Add at least one player.");
      // A draw is an answer; no answer isn't a draw.
      if (winner === null) throw new Error("Pick who won, or choose It was a draw.");
      const winnerSeat = winner === "draw" ? null : seatOf(winner);
      if (winnerSeat === -1) throw new Error("The winner's seat needs a name.");
      const at = new Date(`${date}T20:00:00`).toISOString();
      // The deck version that was current on the day played, not whatever it is now.
      const versions = await Promise.all(
        filled.map(async ({ s }) => (s.deckId ? versionOn(await api<DeckVersionRow[]>(`/api/decks/${s.deckId}/versions`), date) : null)),
      );
      return api("/api/games", {
        method: "POST",
        json: {
          id: gameId,
          playgroup_id: groupId || null,
          started_at: at,
          seats: filled.map(({ s }, n) => ({
            seat: n,
            member_id: s.memberId ?? null,
            user_id: s.userId ?? null,
            guest_name: s.memberId ? null : s.name.trim(),
            deck_version_id: versions[n],
            commander_name: s.commanderName || null,
            deck_label: s.commanderName || null,
          })),
          finish: {
            winner_seat: winnerSeat,
            turns: turns ? Number(turns) : null,
            ended_at: at,
            first_seat: seatOf(first) !== null && seatOf(first)! >= 0 ? seatOf(first) : null,
            win_condition: winnerSeat === null ? null : condition,
            seats: fun.map((r) => ({ seat: seatOf(r.seat), fun: r.rating })).filter((r) => r.seat !== null && r.seat >= 0),
          },
          note: "Logged after the game",
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["games"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      void qc.invalidateQueries({ queryKey: ["deck-results"] });
      onClose();
    },
  });

  return (
    <Sheet label="Log a game" onClose={onClose}>
      <form className="stack capture" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sheet-head">
          <h2>Log a game</h2>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
        </div>
        <div className="row" style={{ alignItems: "end" }}>
          <label style={{ flex: "1 1 12rem" }}>
            Playgroup
            <select value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
              <option value="">None</option>
              {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label style={{ flex: "1 1 9rem" }}>
            Played on
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label style={{ flex: "0 1 6rem" }}>
            Turns
            <input inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <p className="small dim" style={{ margin: 0 }}>List the players clockwise, so turn order counts from whoever went first.</p>
        {seats.map((s, i) => (
          <div key={i} className="stack" style={{ gap: "0.4rem" }}>
            <SeatEditor index={i} seat={s} onChange={(p) => update(i, p)} group={group} decks={s.userId && s.userId === me.data?.id ? decks.data : undefined} />
            <label className="check-row">
              <input type="radio" name="winner" checked={winner === i} onChange={() => setWinner(i)} />
              Won this game
            </label>
          </div>
        ))}
        <label className="check-row">
          <input type="radio" name="winner" checked={winner === "draw"} onChange={() => { setWinner("draw"); setCondition(null); }} />
          It was a draw
        </label>
        <div className="row">
          <button type="button" onClick={() => setSeats((s) => [...s, emptySeat()])}>Add a player</button>
        </div>
        {named.length > 0 && (
          <>
            {typeof winner === "number" && <WinConditionPicker value={condition} onChange={setCondition} winner={named.find((n) => n.seat === winner)?.name} />}
            <FirstPlayerPicker seats={named} value={first} onChange={setFirst} />
            <FunPicker seats={named} value={fun.filter((r) => named.some((n) => n.seat === r.seat))} onChange={setFun} />
          </>
        )}
        <ErrorText error={save.error} />
        <div className="row">
          <button className="primary" disabled={save.isPending}>Save the game</button>
        </div>
      </form>
    </Sheet>
  );
}
