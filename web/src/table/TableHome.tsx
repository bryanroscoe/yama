import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityName, type PlayerSetup, type TableSetup } from "@yama/core";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type DeckSummary, type GameRow, type Playgroup, type SearchResult } from "../api";
import { useMe } from "../auth";
import { ErrorText, Pips, Sheet } from "../components/ui";
import { discardGame, startGame, sync, useOutbox, useRejected, useSyncStatus, useTable } from "./store";

interface SeatDraft {
  name: string;
  memberId?: string;
  userId?: string;
  deckId?: string;
  deckVersionId?: string;
  commanderName: string;
  colorIdentity: string;
  art?: string;
}

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
      { name: me.data?.display_name ?? "Me", userId: me.data?.id, commanderName: "", colorIdentity: "" },
      { name: "", commanderName: "", colorIdentity: "" },
      { name: "", commanderName: "", colorIdentity: "" },
      { name: "", commanderName: "", colorIdentity: "" },
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
  const update = (i: number, patch: Partial<SeatDraft>) => setSeats((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setCount = (n: number) =>
    setSeats((s) => (n > s.length ? [...s, ...Array.from({ length: n - s.length }, () => ({ name: "", commanderName: "", colorIdentity: "" }))] : s.slice(0, n)));

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
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
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
          <SeatEditor key={i} index={i} seat={s} onChange={(p) => update(i, p)} group={group} decks={s.userId === me.data?.id ? decks.data : undefined} />
        ))}
      </div>
      <div className="row">
        <button className="primary" onClick={start}>Start the game</button>
      </div>
    </section>
  );
}

function SeatEditor({ index, seat, onChange, group, decks }: { index: number; seat: SeatDraft; onChange: (p: Partial<SeatDraft>) => void; group?: Playgroup; decks?: DeckSummary[] }) {
  const listId = useId();
  const [error, setError] = useState<unknown>(null);
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
      if (card) onChange({ commanderName: card.name, colorIdentity: card.color_identity, art: card.image_art_crop ?? undefined });
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
              value={seat.memberId ?? (seat.userId ? `user:${seat.userId}` : "")}
              onChange={(e) => {
                const m = group.members.find((x) => x.id === e.target.value);
                if (m) onChange({ memberId: m.id, userId: m.user_id ?? undefined, name: m.display_name });
                else onChange({ memberId: undefined, userId: undefined, name: "" });
              }}
            >
              <option value="">Someone else…</option>
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name}</option>
              ))}
            </select>
          ) : (
            <input value={seat.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={`Player ${index + 1}`} />
          )}
        </label>
        {group && !seat.memberId && (
          <label style={{ flex: "1 1 10rem" }}>
            Name
            <input value={seat.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Guest" />
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
                onChange({ deckId: d.id, deckVersionId: d.current_version_id ?? undefined, colorIdentity: d.color_identity, art: d.commander_image ?? undefined });
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
              onChange({ commanderName: v, colorIdentity: "" });
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
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const [groupId, setGroupId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [turns, setTurns] = useState("");
  const [winner, setWinner] = useState<number | null>(null);
  const [seats, setSeats] = useState<SeatDraft[]>(() =>
    Array.from({ length: 4 }, () => ({ name: "", commanderName: "", colorIdentity: "" })),
  );
  const group = groups.data?.find((g) => g.id === groupId);
  const update = (i: number, patch: Partial<SeatDraft>) => setSeats((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = useMutation({
    mutationFn: () => {
      const players = seats.filter((s) => s.name.trim() || s.memberId);
      if (players.length < 1) throw new Error("Add at least one player.");
      const at = new Date(`${date}T20:00:00`).toISOString();
      return api("/api/games", {
        method: "POST",
        json: {
          id: crypto.randomUUID(),
          playgroup_id: groupId || null,
          started_at: at,
          seats: players.map((s, i) => ({
            seat: i,
            member_id: s.memberId ?? null,
            user_id: s.userId ?? null,
            guest_name: s.memberId ? null : s.name.trim(),
            commander_name: s.commanderName || null,
            deck_label: s.commanderName || null,
          })),
          finish: { winner_seat: winner, turns: turns ? Number(turns) : null, ended_at: at, seats: [] },
          note: "Logged after the game",
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["games"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      onClose();
    },
  });

  return (
    <Sheet label="Log a game" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sheet-head">
          <h2>Log a game</h2>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
        </div>
        <div className="row" style={{ alignItems: "end" }}>
          <label style={{ flex: "1 1 12rem" }}>
            Playgroup
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
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
        {seats.map((s, i) => (
          <div key={i} className="stack" style={{ gap: "0.4rem" }}>
            <SeatEditor index={i} seat={s} onChange={(p) => update(i, p)} group={group} />
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
              <input type="radio" name="winner" checked={winner === i} onChange={() => setWinner(i)} style={{ width: "auto", minHeight: 0 }} />
              Won this game
            </label>
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setSeats((s) => [...s, { name: "", commanderName: "", colorIdentity: "" }])}>Add a player</button>
          <button type="button" className="quiet" onClick={() => setWinner(null)}>It was a draw</button>
        </div>
        <ErrorText error={save.error} />
        <div className="row">
          <button className="primary" disabled={save.isPending}>Save the game</button>
        </div>
      </form>
    </Sheet>
  );
}
