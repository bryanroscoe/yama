import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { winConditionLabel, type FunRating, type PlayerSetup, type TableSetup, type WinCondition } from "@yama/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api, type DeckSummary, type DeckVersionRow, type GameRow, type Playgroup, type SearchResult } from "../api";
import { useMe } from "../auth";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ErrorText, Pips, Sheet } from "../components/ui";
import { BracketChips } from "../components/Bracket";
import { FirstPlayerPicker, FunPicker, WinConditionPicker } from "../components/GameCapture";
import { useCardArt } from "../components/useCardArt";
import { localDay, versionOn } from "./versions";
import { emptySeat, fitSeatsToGroup, NOT_AN_ACCOUNT, patchSeat, renameSeat, type SeatDraft } from "./seats";
import { discardGame, startGame, sync, useOutbox, useRejected, useSyncStatus, useTable } from "./store";
import { layout } from "./TablePlay";
import { panelArt, useShowArt } from "./art";
import "./seats.css";
import "./home.css";

const LAST_SETUP = "yama.table.lastSetup";

/** Laptop layout (the rail and inline seat cards) from 900 px, as in styles.css. */
function useWide(): boolean {
  const query = "(min-width: 900px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Where a seat sits, going clockwise from the person holding the phone (the life counter's layout). */
export function seatWhere(i: number, n: number): string {
  if (i === 0) return "holding the phone";
  if (n === 2) return "across";
  if (i === n - 1) return "right";
  if (i === 1 && n >= 4) return "left";
  return "across";
}

/** "Riders of Rohan" or the commander, and the art credit line under a seat's fields. */
function seatCredit(seat: SeatDraft, deckName?: string): string {
  if (!seat.commanderName) return "Pick a commander and their art fills this seat.";
  if (!seat.art) return seat.commanderName;
  const by = seat.artist ? `Art by ${seat.artist}, © Wizards of the Coast.` : "Art © Wizards of the Coast.";
  return deckName ? `${seat.commanderName}. ${by}` : by;
}

/** "Same seats as last Thursday" when the last setup is from this past week, else its date. */
function sameSeatsLine(at: string | undefined): string {
  if (!at) return "Same seats as last time. Change anyone who swapped decks.";
  const then = new Date(at);
  const days = (Date.now() - then.getTime()) / 86_400_000;
  const when =
    days < 1 ? "earlier today" : days < 7 ? `last ${then.toLocaleDateString("en-US", { weekday: "long" })}` : `on ${then.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return `Same seats as ${when}. Change anyone who swapped decks.`;
}

export function TableHome() {
  const { game, state } = useTable();
  const outbox = useOutbox();
  const rejected = useRejected();
  const syncStatus = useSyncStatus();
  const navigate = useNavigate();
  const showArt = useShowArt();

  return (
    <main className="page table-home">
      {game && state ? (
        <section className="stack" style={{ marginBottom: "2rem" }}>
          <div className="page-head">
            <h1>Game in progress</h1>
          </div>
          <ol className="ip-rows">
            {state.players.map((p) => {
              const art = showArt ? panelArt(p) : null;
              return (
                <li key={p.seat}>
                  <ArtPanel className="ip-row" art={art} artist={p.artist} wash="left" credit={false}>
                    <span className="ip-text">
                      <span className="ip-name">
                        {p.name}
                        {p.colorIdentity && <Pips identity={p.colorIdentity} />}
                      </span>
                      {p.commanderName && <span className="ip-cmdr">{p.commanderName}</span>}
                    </span>
                    <span className="ip-life num">{p.eliminated ? "Out" : p.life}</span>
                  </ArtPanel>
                </li>
              );
            })}
          </ol>
          {showArt && state.players.some((p) => panelArt(p)) && (
            <p className="small dim" style={{ margin: 0 }}>{artCredits(state.players.filter((p) => panelArt(p)).map((p) => p.artist))}</p>
          )}
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

      <RecentGames
        waiting={
          outbox.length > 0 ? (
            <span className="rg-waiting" role="status">
              <span className="status-dot warn" aria-hidden="true" />
              {outbox.length} {outbox.length === 1 ? "game" : "games"} waiting to upload
              <button className="quiet small" onClick={() => void sync()} disabled={syncStatus.syncing}>
                Upload now
              </button>
            </span>
          ) : null
        }
      />
      {syncStatus.error && outbox.length > 0 && <p className="small error">{syncStatus.error}</p>}
      {rejected.length > 0 && (
        <p className="small error">
          {rejected.length} finished {rejected.length === 1 ? "game" : "games"} couldn't be saved to Yama ({rejected[rejected.length - 1]!.error}). They're kept on this phone.
        </p>
      )}
    </main>
  );
}

function NewGame({ onStart }: { onStart: () => void }) {
  const me = useMe();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [groupId, setGroupId] = useState<string>("");
  const [life, setLife] = useState(40);
  const wide = useWide();
  const [editing, setEditing] = useState<number | null>(null);
  // When the seats came back from the last game set up on this phone, and when that was.
  const [restored] = useState<{ at?: string } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_SETUP) ?? "null");
      return saved?.seats?.length ? { at: saved.at } : null;
    } catch {
      return null;
    }
  });
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

  // "Play this deck" on a deck page: put that deck in your seat.
  const location = useLocation();
  const navigate = useNavigate();
  const wanted = (location.state as { deckId?: string } | null)?.deckId;
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const d = wanted ? decks.data?.find((x) => x.id === wanted) : undefined;
    if (!d || applied.current === d.id) return;
    // With a playgroup chosen, your seat is your member row (see seats.ts), so wait for the list.
    if (groupId && !groups.data) return;
    applied.current = d.id;
    const myRow = groups.data?.find((g) => g.id === groupId)?.members.find((m) => m.user_id && m.user_id === me.data?.id);
    setSeats((all) => {
      const x = all[0]!;
      const mine = !!me.data && x.userId === me.data.id && !!x.name;
      // patchSeat takes you (and your member row) off any other seat: a person sits once.
      return patchSeat(all, 0, {
        ...(mine ? {} : { name: myRow?.display_name ?? me.data?.display_name ?? x.name, memberId: myRow?.id }),
        userId: me.data?.id,
        deckId: d.id,
        deckVersionId: d.current_version_id ?? undefined,
        commanderName: d.commanders[0] ?? "",
        colorIdentity: d.color_identity,
        art: d.commander_image ?? undefined,
        artist: d.commander_artist ?? undefined,
      });
    });
    navigate(".", { replace: true, state: null });
  }, [wanted, decks.data, me.data, navigate, groupId, groups.data]);

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
    localStorage.setItem(LAST_SETUP, JSON.stringify({ seats, groupId, life, at: new Date().toISOString() }));
    startGame(setup);
    onStart();
  };

  const groupSelect = (className: string, label: boolean) => (
    <label className={className}>
      <span className={label ? undefined : "visually-hidden"}>Playgroup</span>
      <select value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
        <option value="">{label ? "None (not counted in group stats)" : "No playgroup"}</option>
        {groups.data?.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
    </label>
  );
  const seatProps = (i: number) => {
    const s = seats[i]!;
    return {
      index: i,
      seat: s,
      where: seatWhere(i, seats.length),
      onChange: (p: Partial<SeatDraft>) => update(i, p),
      group,
      decks: s.userId && s.userId === me.data?.id ? decks.data : undefined,
      deckName: decks.data?.find((d) => d.id === s.deckId)?.name,
    };
  };
  const artists = seats.filter((s) => s.art).map((s) => s.artist);

  return (
    <section className="new-game2">
      <div className="ng-head">
        <div className="ng-title">
          <h1>New game</h1>
          <p className="dim ng-sub">{restored ? sameSeatsLine(restored.at) : "Pick who's playing and what they brought."}</p>
        </div>
        {/* Phones: the playgroup sits beside the title, as a quiet picker. */}
        {!wide && groupSelect("ng-group-quiet", false)}
        {wide && (
          <button className="primary" onClick={start}>Start the game</button>
        )}
      </div>
      <div className="setup-controls">
        {wide && groupSelect("setup-group", true)}
        <Choice label="Players" options={[1, 2, 3, 4, 5, 6]} value={seats.length} onChange={setCount} />
        <Choice label="Starting life" options={[40, 30, 25, 20]} value={life} onChange={setLife} />
      </div>
      {wide ? (
        <div className="ng-body">
          <div className="ng-seats">
            {seats.map((_, i) => (
              <SeatEditor key={i} {...seatProps(i)} />
            ))}
          </div>
          <aside className="ng-phone" aria-label="How the phone sits">
            <PhoneSketch seats={seats} />
            <p>Seats go clockwise from whoever holds the phone. Each panel faces its player.</p>
          </aside>
        </div>
      ) : (
        <>
          <ol className="ng-rows" aria-label="Seats, clockwise from you">
            {seats.map((s, i) => (
              <li key={i}>
                <SeatRow index={i} seat={s} deckName={seatProps(i).deckName} onOpen={() => setEditing(i)} />
              </li>
            ))}
          </ol>
          <p className="small dim ng-note">
            Seats go clockwise from you. Tap a seat to change the player or commander.
            {artists.length > 0 && ` ${artCredits(artists)}`}
          </p>
          <button className="primary ng-start" onClick={start}>Start the game</button>
          {editing !== null && seats[editing] && (
            <Sheet label={`Seat ${editing + 1}`} onClose={() => setEditing(null)}>
              <div className="stack">
                <SeatEditor {...seatProps(editing)} />
                <button className="primary" onClick={() => setEditing(null)}>Done</button>
              </div>
            </Sheet>
          )}
        </>
      )}
    </section>
  );
}

/** A short list of numbers as a segmented control, with its label beside it on phones and above it on laptops. */
function Choice({ label, options, value, onChange }: { label: string; options: number[]; value: number; onChange: (n: number) => void }) {
  const id = useId();
  return (
    <div className="setup-choice">
      <span id={id} className="field-label">{label}</span>
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((n) => (
          <button key={n} type="button" aria-pressed={n === value} onClick={() => onChange(n)}>{n}</button>
        ))}
      </div>
    </div>
  );
}

/** The life counter's panels in miniature, each with its seat's art and number, facing its player. */
function PhoneSketch({ seats }: { seats: SeatDraft[] }) {
  const { cols, rows, cells } = layout(seats.length);
  return (
    <div className="phone-sketch" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {cells.map(({ seat, rot, area }) => {
        const s = seats[seat];
        return (
          <span key={seat} className={`sketch-cell${s?.art ? " has-art" : ""}`} style={{ gridArea: area }}>
            {s?.art && <img src={s.art} alt="" />}
            <span className="sketch-n">
              <span style={{ transform: `rotate(${rot}deg)` }}>{seat + 1}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** A seat on a phone: the commander art washed from the left, name and commander on it. Opens the seat's fields. */
function SeatRow({ index, seat, deckName, onOpen }: { index: number; seat: SeatDraft; deckName?: string; onOpen: () => void }) {
  const who = seat.name.trim() || `Player ${index + 1}`;
  const what = seat.commanderName ? (deckName ? `${deckName}, ${seat.commanderName}` : seat.commanderName) : "Pick a commander";
  return (
    <button className="seat-row" onClick={onOpen} aria-label={`Seat ${index + 1}: ${who}, ${what}. Change`}>
      <ArtPanel as="span" className="seat-row-art" art={seat.art} artist={seat.artist} wash="left" empty={!seat.commanderName} credit={false}>
        <span className="seat-row-text">
          <span className="seat-row-n">Seat {index + 1}</span>
          <span className="seat-row-name">{who}</span>
          <span className="seat-row-what">{what}</span>
        </span>
        {seat.commanderName && <Pips identity={seat.colorIdentity} label={false} />}
      </ArtPanel>
    </button>
  );
}

function SeatEditor({ index, seat, onChange, group, decks, deckName, where }: { index: number; seat: SeatDraft; onChange: (p: Partial<SeatDraft>) => void; group?: Playgroup; decks?: DeckSummary[]; deckName?: string; where?: string }) {
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

  const who = seat.name.trim() || `Player ${index + 1}`;
  const pips = seat.colorIdentity ? <span className="field-pips"><Pips identity={seat.colorIdentity} /></span> : null;
  return (
    <fieldset className="seat seat-card2">
      <legend className="visually-hidden">Seat {index + 1}</legend>
      {/* Commander art once a commander is picked; a raised block until then. The credit is the line under the fields. */}
      <ArtPanel className="seat-head2" art={seat.art} artist={seat.artist} wash="bottom" credit={false}>
        <span className="seat-name">{who}</span>
        <span className="seat-where">Seat {index + 1}{where ? `, ${where}` : ""}</span>
      </ArtPanel>
      <div className="seat-fields2">
        <div className="seat-player">
          <label>
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
                <option value="">Someone else</option>
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name}{me && m.user_id === me.id ? " (you)" : ""}</option>
                ))}
              </select>
            ) : (
              <input value={seat.name} onChange={(e) => onChange(renameSeat(seat, e.target.value, me))} placeholder={`Player ${index + 1}`} />
            )}
          </label>
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
        </div>
        {group && !seat.memberId && (
          <label>
            Name
            <input value={seat.name} onChange={(e) => onChange(renameSeat(seat, e.target.value, me))} placeholder="Guest" />
          </label>
        )}
        {decks && decks.length > 0 && (
          <label>
            Deck
            <span className="field-wrap">
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
              {chosen && pips}
            </span>
          </label>
        )}
        {/* With one of your decks chosen, the deck names the commander. */}
        {!chosen && (
          <label>
            Commander
            <span className="field-wrap">
              <input
                list={listId}
                value={seat.commanderName}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({ commanderName: v, colorIdentity: "", art: undefined, artist: undefined });
                  if (suggestions.data?.includes(v)) void pickCommander(v);
                }}
                onBlur={() => seat.commanderName && !seat.colorIdentity && void pickCommander(seat.commanderName)}
                placeholder="Search for a commander"
              />
              {pips}
            </span>
            <datalist id={listId}>{suggestions.data?.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
        )}
        <span className="seat-credit">{seatCredit(seat, chosen ? deckName : undefined)}</span>
        {chosen && (chosen.bracket != null || chosen.estimate) && <BracketChips declared={chosen.bracket} estimate={chosen.estimate} />}
        <ErrorText error={error} />
      </div>
    </fieldset>
  );
}

/** "Terra" from "Terra, Herald of Hope": the name a table calls a commander by. */
const shortName = (name: string) => name.split(",")[0]!.trim();
const listNames = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function RecentGames({ waiting }: { waiting: ReactNode }) {
  const games = useQuery({ queryKey: ["games"], queryFn: () => api<(GameRow & { note?: string | null })[]>("/api/games") });
  const [logging, setLogging] = useState(false);
  const shown = games.data?.slice(0, 10) ?? [];
  const winnerOf = (g: GameRow) => g.seats.find((s) => s.seat === g.winner_seat);
  const art = useCardArt(shown.map((g) => winnerOf(g)?.commander_name));
  const credited = shown.map((g) => art.get(winnerOf(g)?.commander_name ?? "")).filter((a) => !!a);
  return (
    <section className="recent-games">
      <div className="rg-head">
        <h2>Recent games</h2>
        <span className="rg-actions">
          {waiting}
          <button className="outline rg-log" onClick={() => setLogging(true)}>
            <span className="rg-log-long">Log a game played without Yama</span>
            <span className="rg-log-short">Log a game</span>
          </button>
        </span>
      </div>
      {logging && <LogGame onClose={() => setLogging(false)} />}
      {games.data && !games.data.length && <p className="dim">No games yet.</p>}
      <ol className="rg-list">
        {shown.map((g) => {
          const winner = winnerOf(g);
          const finished = g.status === "finished";
          const cmdr = winner?.commander_name;
          const a = cmdr ? art.get(cmdr) : undefined;
          const title = !finished ? "In progress" : winner ? `${winner.display_name} won` : "Draw";
          const others = g.seats.filter((s) => s !== winner).map((s) => s.commander_name ?? s.display_name ?? "").filter(Boolean);
          const how = finished && winner ? winConditionLabel(g.win_condition) : null;
          const sub = [how, winner ? `Over ${listNames(others)}` : listNames(g.seats.map((s) => shortName(s.commander_name ?? s.display_name ?? "")).filter(Boolean)), g.note]
            .filter(Boolean)
            .join(". ");
          const day = new Date(g.started_at);
          return (
            <li key={g.id} className="rg-row">
              <span className="rg-art">{a?.art && <img src={a.art} alt="" loading="lazy" />}</span>
              <span className="rg-text">
                <span className="rg-title">
                  {title}
                  {winner && cmdr && cmdr !== winner.display_name && <span className="rg-with"> with {shortName(cmdr)}</span>}
                </span>
                <span className="rg-sub">{sub}</span>
                <span className="rg-sub-short">
                  {[cmdr && shortName(cmdr), g.turns ? `${g.turns} turns` : null].filter(Boolean).join(", ") || sub}
                </span>
              </span>
              <span className="rg-when num">
                <span>
                  <span className="rg-weekday">{day.toLocaleDateString("en-US", { weekday: "short" })}, </span>
                  {day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                {g.turns ? <span className="rg-turns">{g.turns} turns</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {credited.length > 0 && <p className="small dim rg-credit">{artCredits(credited.map((c) => c!.artist))}</p>}
      <p className="rg-more"><Link to="/group">All games and stats</Link></p>
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
