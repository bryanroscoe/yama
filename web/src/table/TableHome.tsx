import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FORMATS, formatLabel, type FunRating, type PlayerSetup, type TableFormat, type TableSetup, type WinCondition } from "@yama/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api, type DeckSummary, type DeckVersionRow, type GameDetail, type GameRow, type Playgroup } from "../api";
import { useMe } from "../auth";
import { ArtMosaic } from "../components/ArtMosaic";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ErrorText, Pips, Sheet } from "../components/ui";
import { FirstPlayerPicker, FunPicker, WinConditionPicker } from "../components/GameCapture";
import { useCardArt } from "../components/useCardArt";
import { localDay, versionOn } from "./versions";
import { afterRemoving, applySeatPatch, emptySeat, fitSeatsToGroup, patchSeat, personPatch, seatDeckLabel, seatHolds, rebuildForGroup, stillHolds, togglePerson, withHandles, withoutGroup, type SeatDraft, type SeatPatch } from "./seats";
import { discardGame, startGame, sync, useOutbox, usePendingDeletes, useRejected, useSyncStatus, useTable } from "./store";
import { LayoutPicker, LayoutSketch } from "./LayoutPicker";
import { useLayoutChoice } from "./layouts";
import { panelArt, useShowArt } from "./art";
import { recentGameText, winningSeat } from "./recent";
import { resolveDraft, type CommanderDraft, type Person } from "./pickers";
import { availablePeople, deckCommanders, SeatEditor, usePeople } from "./SeatEditor";
import { gameSummary } from "./history";
import { formFromGame, settleRebuilt } from "./logEdit";
import { useInstall } from "../install";
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
            <p className="dim" style={{ margin: 0 }}>{gameSummary(state)}</p>
          </div>
          <ol className="ip-rows" aria-label="Tap anyone to go back to the table">
            {state.players.map((p) => {
              const art = showArt ? panelArt(p) : null;
              return (
                <li key={p.seat}>
                  <button className="ip-row-btn" onClick={() => navigate("/table/play")} aria-label={`${p.name}, ${p.eliminated ? "out" : `${p.life} life`}. Back to the table`}>
                  <ArtPanel as="span" className="ip-row" art={art} artist={p.artist} wash="left" credit={false}>
                    <span className="ip-text">
                      <span className="ip-name">
                        {p.name}
                        {p.colorIdentity && <Pips identity={p.colorIdentity} />}
                      </span>
                      {p.commanderName && <span className="ip-cmdr">{p.commanderName}</span>}
                    </span>
                    <span className="ip-life num">{p.eliminated ? "Out" : p.life}</span>
                  </ArtPanel>
                  </button>
                </li>
              );
            })}
          </ol>
          {showArt && state.players.some((p) => panelArt(p)) && (
            <p className="small dim" style={{ margin: 0 }}>{artCredits(state.players.filter((p) => panelArt(p)).map((p) => p.artist))}</p>
          )}
          <div className="row">
            <button className="primary" onClick={() => navigate("/table/play")}>Back to the table</button>
            <button className="quiet" onClick={() => confirm("Throw this game away? It won't count, and it's deleted from Yama.") && discardGame()}>
              Discard
            </button>
          </div>
        </section>
      ) : (
        <NewGame onStart={(share) => navigate("/table/play", { state: { share, fresh: true } })} />
      )}

      <InstallCard />
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

const INSTALL_DISMISSED = "yama.install.dismissed";

/** Install Yama as an app: it opens full screen at the table. Until it's installed or waved off. */
function InstallCard() {
  const install = useInstall();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(INSTALL_DISMISSED) === "1");
  if (dismissed || !(install.canPrompt || install.fromShareMenu)) return null;
  const dismiss = () => {
    localStorage.setItem(INSTALL_DISMISSED, "1");
    setDismissed(true);
  };
  return (
    <aside className="install-card" aria-label="Install Yama">
      <p>
        <b>Install Yama</b>
        <span className="dim">
          {install.canPrompt
            ? " It opens full screen, without the browser's bars, and works offline at the table."
            : " In Safari, tap Share, then Add to Home Screen. It opens full screen, without the browser's bars."}
        </span>
      </p>
      <div className="row">
        {install.canPrompt && <button className="primary" onClick={() => void install.install()}>Install</button>}
        <button className="quiet" onClick={dismiss}>Not now</button>
      </div>
    </aside>
  );
}

function NewGame({ onStart }: { onStart: (share: boolean) => void }) {
  const me = useMe();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [groupId, setGroupId] = useState<string>("");
  const [life, setLife] = useState(40);
  const [format, setFormat] = useState<TableFormat>("commander");
  /** Everyone keeps their own totals on their own phone: the join code shows as the game opens. */
  const [phones, setPhones] = useState<"one" | "everyone">(() => {
    try {
      return JSON.parse(localStorage.getItem(LAST_SETUP) ?? "null")?.phones === "everyone" ? "everyone" : "one";
    } catch {
      return "one";
    }
  });
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
      if (FORMATS.some((f) => f.key === saved?.format)) setFormat(saved.format);
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
    // A deck page's deck is a Commander deck.
    setFormat("commander");
    setLife((l) => (FORMATS.some((f) => f.key !== "commander" && f.life === l) ? 40 : l));
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
        // A choice until the cards say the two can pair (deckCommanders).
        partnerName: undefined,
        commanderChoices: d.commanders.length > 1 ? d.commanders : undefined,
      });
    });
    void deckCommanders(d).then((c) => c && setSeats((all) => (all[0]?.deckId === d.id ? patchSeat(all, 0, c) : all)));
    navigate(".", { replace: true, state: null });
  }, [wanted, decks.data, me.data, navigate, groupId, groups.data]);

  const group = groups.data?.find((g) => g.id === groupId);
  const update = (i: number, patch: SeatPatch) => setSeats((s) => applySeatPatch(s, i, patch));
  const chooseGroup = (id: string) => {
    setGroupId(id);
    setSeats((s) => fitSeatsToGroup(s, groups.data?.find((g) => g.id === id), me.data));
  };
  const chooseFormat = (f: TableFormat) => {
    setFormat(f);
    setLife(FORMATS.find((x) => x.key === f)!.life);
  };
  const setCount = (n: number) => setSeats((s) => (n > s.length ? [...s, ...Array.from({ length: n - s.length }, emptySeat)] : s.slice(0, n)));
  const shuffle = () => setSeats((s) => shuffled(s));
  const layoutKey = useLayoutChoice(seats.length);
  const seatArt = (i: number) => seats[i]?.art;

  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    // Commanders typed but never picked from the list still get their cards' art and colors.
    // A deck's seat too, when its commander was picked from the deck's list and hasn't answered
    // yet (resolveDraft looks up only a name with no art or colors).
    const ready = format === "commander" ? await Promise.all(seats.map((s) => resolveDraft(s as SeatDraft & CommanderDraft))) : seats;
    const seatsNow = ready as SeatDraft[];
    // Only a Commander game names commanders and Commander decks; a 20-life game left with a
    // seat's last commander would count toward that commander's and deck's results.
    const cmdr = format === "commander";
    const players: PlayerSetup[] = seatsNow.map((s, i) => ({
      seat: i,
      name: s.name.trim() || `Player ${i + 1}`,
      memberId: s.memberId,
      userId: s.userId,
      deckVersionId: cmdr ? s.deckVersionId : undefined,
      deckLabel: (cmdr && seatDeckLabel(s)) || undefined,
      commanderName: (cmdr && s.commanderName) || undefined,
      partnerName: (cmdr && s.partnerName?.trim()) || undefined,
      colorIdentity: cmdr ? s.colorIdentity : "",
      art: cmdr ? s.art : undefined,
      artist: cmdr ? s.artist : undefined,
      partnerArt: cmdr && s.partnerName ? s.partnerArt : undefined,
      partnerArtist: cmdr && s.partnerName ? s.partnerArtist : undefined,
    }));
    const setup: TableSetup = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      format,
      startingLife: life,
      playgroupId: groupId || undefined,
      players,
    };
    localStorage.setItem(LAST_SETUP, JSON.stringify({ seats: seatsNow, groupId, life, format, phones, at: new Date().toISOString() }));
    startGame(setup);
    onStart(phones === "everyone");
  };

  // Tap someone in Who's playing: they take the next open seat, or leave theirs.
  const toggle = (p: Person) => {
    const patch = personPatch(p, group, me.data);
    if (patch) setSeats((s) => togglePerson(s, p, patch, MAX_SEATS));
  };
  const seatProps = (i: number) => {
    const s = seats[i]!;
    return {
      index: i,
      seat: s,
      where: seatWhere(i, seats.length),
      onChange: (p: SeatPatch) => update(i, p),
      group,
      decks: decks.data,
      deckName: decks.data?.find((d) => d.id === s.deckId)?.name ?? s.deckLabel,
      // Not someone already sitting elsewhere: the same member or account, or the same guest name.
      people: availablePeople(people, seats, i),
      seatedHandles: seats.flatMap((o, j) => (j !== i && o.handle ? [o.handle] : [])),
      commander: format === "commander",
    };
  };
  const startLabel = `Start the ${formatLabel(format)} game`;
  const startSub = `${seats.length} ${seats.length === 1 ? "player" : "players"} at ${life} life`;
  const artists = seats.filter((s) => s.art).map((s) => s.artist);
  const people = usePeople(group, groups.data);

  return (
    <section className="new-game2">
      <div className="ng-head">
        <div className="ng-title">
          <h1>New game</h1>
          <p className="dim ng-sub">{restored ? sameSeatsLine(restored.at) : "Pick who's playing and what they brought."}</p>
        </div>
        {wide && (
          <span className="ng-start-wide">
            <button className="primary" onClick={() => void start()} disabled={starting}>{startLabel}</button>
            <span className="small dim">{startSub}</span>
          </span>
        )}
      </div>
      <div className="setup-controls">
        <Choice label="Game" options={FORMATS.map((f) => f.key)} value={format} onChange={chooseFormat} name={(f) => formatLabel(f)} />
        <Choice label="Players" options={Array.from({ length: MAX_SEATS }, (_, i) => i + 1)} value={seats.length} onChange={setCount} />
        <Choice label="Starting life" options={[40, 30, 25, 20]} value={life} onChange={setLife} />
        <Choice label="Phones" options={["one", "everyone"] as ("one" | "everyone")[]} value={phones} onChange={setPhones} name={(v) => (v === "one" ? "Just this one" : "Everyone's own")} />
      </div>
      {phones === "everyone" && (
        <p className="small dim ng-note">The join code shows as soon as the game starts. Friends scan it, pick their seat and keep their own total.</p>
      )}
      <WhoPlaying groups={groups.data ?? []} groupId={groupId} onGroup={chooseGroup} people={people} seats={seats} onToggle={toggle} />
      {!wide && <LayoutPicker n={seats.length} art={seatArt} className="ng-layout" />}
      {wide ? (
        <div className="ng-body">
          <div className="ng-seats">
            {seats.map((_, i) => (
              <SeatEditor key={i} {...seatProps(i)} />
            ))}
          </div>
          <aside className="ng-phone" aria-label="How the panels sit">
            <LayoutSketch n={seats.length} layout={layoutKey} art={seatArt} className="phone-sketch" />
            <LayoutPicker n={seats.length} art={seatArt} className="ng-layout" />
            {seats.length > 2 && <button className="quiet small" onClick={shuffle}>Shuffle the seats</button>}
          </aside>
        </div>
      ) : (
        <>
          <ol className="ng-rows" aria-label="Seats, clockwise from you">
            {seats.map((s, i) => (
              <li key={i}>
                <SeatRow index={i} seat={s} deckName={seatProps(i).deckName} onOpen={() => setEditing(i)} commander={format === "commander"} />
              </li>
            ))}
          </ol>
          {seats.length > 2 && <button className="quiet small ng-shuffle" onClick={shuffle}>Shuffle the seats</button>}
          <p className="small dim ng-note">
            Seats go clockwise from you. Tap a seat to change the player{format === "commander" ? " or commander" : ""}.
            {artists.length > 0 && ` ${artCredits(artists)}`}
          </p>
          <button className="primary ng-start" onClick={() => void start()} disabled={starting}>
            <span>{startLabel}</span>
            <span className="ng-start-sub">{startSub}</span>
          </button>
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

/** Seats a table game can have, as the layouts are drawn. */
const MAX_SEATS = 6;
/** People shown in Who's playing before "more". */
const PEOPLE_SHOWN = 12;

/**
 * Playing with (friends, or one of your playgroups) and Who's playing: tap people to seat them in
 * the order tapped, tap again to take them off. A playgroup's members carry their accounts, so the
 * game counts for them; friends from other groups and past games sit as guests by name.
 */
function WhoPlaying({ groups, groupId, onGroup, people, seats, onToggle }: {
  groups: Playgroup[];
  groupId: string;
  onGroup: (id: string) => void;
  people: Person[];
  seats: SeatDraft[];
  onToggle: (p: Person) => void;
}) {
  const [all, setAll] = useState(false);
  const headId = useId();
  const shown = all ? people : people.slice(0, PEOPLE_SHOWN);
  const full = seats.length >= MAX_SEATS && !seats.some((s) => !s.name.trim() && !s.memberId && !s.userId);
  return (
    <section className="who-playing" aria-labelledby={headId}>
      {groups.length > 0 && (
        <Choice label="Playing with" options={["", ...groups.map((g) => g.id)]} value={groupId} onChange={onGroup} name={(id) => (id ? groups.find((g) => g.id === id)!.name : "Friends")} />
      )}
      <span id={headId} className="field-label">Who's playing</span>
      {people.length > 0 ? (
        <div className="who-chips">
          {shown.map((p) => {
            const on = seats.some((s) => seatHolds(s, p));
            return (
              <button key={p.memberId ?? p.userId ?? `name:${p.name}`} type="button" className="who-chip" aria-pressed={on} disabled={!on && full} onClick={() => onToggle(p)}>
                {p.name}
                {p.sub === "You" && <span className="who-chip-sub"> (you)</span>}
              </button>
            );
          })}
          {people.length > PEOPLE_SHOWN && (
            <button type="button" className="quiet small" onClick={() => setAll((a) => !a)}>{all ? "Fewer" : `${people.length - PEOPLE_SHOWN} more`}</button>
          )}
        </div>
      ) : (
        <p className="small dim" style={{ margin: 0 }}>People from your playgroups and past games show up here.</p>
      )}
      <p className="small dim" style={{ margin: 0 }}>
        {groupId ? "Tap who's here; each takes the next seat. The game goes in the playgroup's stats." : "Tap who's here; each takes the next seat. Friends play as guests; pick a playgroup to put the game in its stats."}
        {full ? ` ${MAX_SEATS} seats is the most.` : ""}
      </p>
    </section>
  );
}

/** A short list of numbers as a segmented control, with its label beside it on phones and above it on laptops. */
function Choice<T extends string | number>({ label, options, value, onChange, name = String }: { label: string; options: T[]; value: T; onChange: (n: T) => void; name?: (v: T) => string }) {
  const id = useId();
  return (
    <div className="setup-choice">
      <span id={id} className="field-label">{label}</span>
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((n) => (
          <button key={n} type="button" aria-pressed={n === value} onClick={() => onChange(n)}>{name(n)}</button>
        ))}
      </div>
    </div>
  );
}

/** A seat on a phone: the commander art washed from the left, name and commander on it. Opens the seat's fields. */
function SeatRow({ index, seat, deckName, onOpen, commander = true }: { index: number; seat: SeatDraft; deckName?: string; onOpen: () => void; commander?: boolean }) {
  const who = seat.name.trim() || `Player ${index + 1}`;
  const cmdr = seat.partnerName ? `${seat.commanderName} and ${seat.partnerName}` : seat.commanderName;
  const what = !commander ? (deckName ?? "Tap to change") : seat.commanderName ? (deckName ? `${deckName}, ${cmdr}` : cmdr) : "Pick a commander";
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

/** The seats in a random order (Fisher-Yates, from the browser's random source). */
export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  const r = new Uint32Array(1);
  for (let i = out.length - 1; i > 0; i--) {
    crypto.getRandomValues(r);
    const j = r[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Recent games to show before "All games and stats": four on a laptop, three on a phone. */
const RECENT_WIDE = 4;
const RECENT_PHONE = 3;

function RecentGames({ waiting }: { waiting: ReactNode }) {
  const games = useQuery({ queryKey: ["games"], queryFn: () => api<(GameRow & { note?: string | null })[]>("/api/games") });
  const [logging, setLogging] = useState(false);
  const wide = useWide();
  // A game deleted while offline stays out of the list until Yama catches up.
  const deleting = usePendingDeletes();
  const shown = games.data?.filter((g) => !deleting.includes(g.id)).slice(0, wide ? RECENT_WIDE : RECENT_PHONE) ?? [];
  // A game with a winner shows the winner's art; one still going, or a draw, shows up to four
  // seats' art as a mosaic. The credit names exactly the art shown.
  const winnerShown = winningSeat;
  const art = useCardArt(shown.flatMap((g) => (winnerShown(g) ? [winnerShown(g)!] : g.seats).map((s) => s.commander_name)));
  const seatArt = (g: GameRow) => g.seats.map((s) => art.get(s.commander_name ?? "")).filter((a) => !!a?.art).slice(0, 4);
  const pictured = (g: GameRow) => (winnerShown(g) ? [art.get(winnerShown(g)!.commander_name ?? "")] : seatArt(g));
  const credited = shown.flatMap(pictured).filter((a) => !!a?.art);
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
          const winner = winnerShown(g);
          const cmdr = winner?.commander_name;
          const a = cmdr ? art.get(cmdr) : undefined;
          const text = recentGameText(g);
          const day = new Date(g.started_at);
          return (
            <li key={g.id}>
              {/* An online game keeps its replay with the online board; a table game has its own page. */}
              <Link className="rg-row" to={g.mode === "in_person" ? `/table/games/${g.id}` : `/play/${g.id}`} aria-label={`${text.title}${text.with ? ` with ${text.with}` : ""}, ${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Details`}>
              {winner ? (
                <span className="rg-art">{a?.art && <img src={a.art} alt="" loading="lazy" />}</span>
              ) : (
                <ArtMosaic className="rg-art" arts={seatArt(g).map((a) => a!.art)} />
              )}
              <span className="rg-text">
                <span className="rg-title">
                  {text.title}
                  {text.with && <span className="rg-with"> with {text.with}</span>}
                </span>
                <span className="rg-sub">{text.sub}</span>
                <span className="rg-sub-short">{text.short}</span>
              </span>
              <span className="rg-when num">
                <span>
                  <span className="rg-weekday">{day.toLocaleDateString("en-US", { weekday: "short" })}, </span>
                  {day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                {g.turns ? <span className="rg-turns">{g.turns} turns</span> : g.status === "in_progress" ? <span className="rg-turns rg-live">Still going</span> : null}
              </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {credited.length > 0 && <p className="small dim rg-credit">{artCredits(credited.map((c) => c!.artist))}</p>}
      <p className="rg-more"><Link to="/group">All games and stats</Link></p>
    </section>
  );
}

/** A new game's answers: nobody has said who won, who went first, how, or how fun it was. */
const UNANSWERED = { turns: "", winner: null, first: null, condition: null, fun: [] as FunRating[] } as const;

/**
 * Log a game played without Yama, or (`editing`) change one logged before: the same form, filled
 * in, saved again under the game's own id. `copyFrom` starts a new log from another game's
 * playgroup, day, players and decks, with nothing answered yet.
 */
export function LogGame({ onClose, editing, copyFrom }: { onClose: () => void; editing?: GameDetail; copyFrom?: GameDetail }) {
  const qc = useQueryClient();
  const me = useMe();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const [form] = useState(() => {
    const from = editing ?? copyFrom;
    if (!from) return null;
    const f = formFromGame(from, qc.getQueryData<DeckSummary[]>(["decks"]));
    return editing ? f : { ...f, ...UNANSWERED };
  });
  const [groupId, setGroupId] = useState(form?.groupId ?? "");
  const format = form?.format ?? "commander";
  const startingLife = form?.startingLife ?? 40;
  const cmdr = format === "commander";
  // The day here, not in UTC: after 7 pm in Texas, UTC is already tomorrow.
  const [date, setDate] = useState(() => form?.date ?? localDay());
  const [turns, setTurns] = useState(form?.turns ?? "");
  /** A seat (its index in the form), "draw", or null while nobody has answered. */
  const [winner, setWinner] = useState<number | "draw" | null>(form?.winner ?? null);
  const [first, setFirst] = useState<number | null>(form?.first ?? null);
  const [condition, setCondition] = useState<WinCondition | null>(form?.condition ?? null);
  const [fun, setFun] = useState<FunRating[]>(form?.fun ?? []);
  // One id per form, so pressing Save again after a failed or slow upload can't log it twice.
  const [gameId, setGameId] = useState(() => editing?.id ?? crypto.randomUUID());
  // Games saved from this form with "Save and log another".
  const [savedHere, setSavedHere] = useState(0);
  const [seats, setSeats] = useState<SeatDraft[]>(() =>
    form?.seats ?? [
      { ...emptySeat(), name: me.data?.display_name ?? "", userId: me.data?.id },
      ...Array.from({ length: 3 }, emptySeat),
    ],
  );
  // An edited game's seats know only their commanders' names: look the cards up again for their
  // art and colors, unless the seat has changed meanwhile.
  useEffect(() => {
    if (!form) return;
    // The seats' keys start as their places in the form.
    form.seats.forEach((s, key) => {
      if (!s.commanderName || s.art) return;
      // The saved game already paired them, so they stay a pair.
      void deckCommanders({ commanders: [s.commanderName, ...(s.partnerName ? [s.partnerName] : [])] }, { checkPair: false }).then(
        (c) => c && updateSeat(key, (now) => (stillHolds(now, s) && !now.art ? settleRebuilt(c, !!s.partnerName, form.savedLabels[key]) : null)),
      );
    });
  }, [form]);
  // A key per seat, so removing one from the middle doesn't hand its fields' state to the next.
  const nextKey = useRef(seats.length);
  const [keys, setKeys] = useState(() => seats.map((_, i) => i));
  // Edits by seat key, not position: a slow lookup for a seat lands on that seat even if one
  // before it was removed meanwhile, and on none if it was removed itself.
  const keysNow = useRef(keys);
  keysNow.current = keys;
  const updateSeat = (key: number, patch: SeatPatch) => setSeats((all) => applySeatPatch(all, keysNow.current.indexOf(key), patch));
  const group = groups.data?.find((g) => g.id === groupId);
  const people = usePeople(group, groups.data);
  const addSeat = () => {
    setSeats((s) => [...s, emptySeat()]);
    setKeys((k) => [...k, nextKey.current++]);
  };
  // The answers about the removed seat go with it; the rest follow their seats up.
  const removeSeat = (i: number) => {
    setSeats((s) => s.filter((_, j) => j !== i));
    setKeys((k) => {
      const next = k.filter((_, j) => j !== i);
      keysNow.current = next;
      return next;
    });
    setWinner((w) => (w === "draw" ? w : afterRemoving(w, i)));
    setFirst((f) => afterRemoving(f, i));
    setFun((all) => all.flatMap((r) => {
      const seat = afterRemoving(r.seat, i);
      return seat === null ? [] : [{ ...r, seat }];
    }));
  };
  const chooseGroup = (id: string) => {
    setGroupId(id);
    setSeats((s) => fitSeatsToGroup(s, groups.data?.find((g) => g.id === id), me.data));
  };
  // Once the playgroups are here: a game copied from someone else's playgroup (you sat in but
  // aren't a member of) is logged without it, its members becoming names; and seats rebuilt from
  // a saved game get their players' handles.
  useEffect(() => {
    if (!groups.data || !me.data) return;
    const all = groups.data;
    if (groupId && !all.some((g) => g.id === groupId)) {
      setGroupId("");
      setSeats((s) => withHandles(withoutGroup(s, me.data), undefined, all));
    } else if (form) {
      const group = all.find((g) => g.id === groupId);
      setSeats((s) => withHandles(rebuildForGroup(s, group, me.data), group, all));
    }
  }, [groups.data, me.data]);
  // Seats left blank are dropped; the rest are numbered in order, and picks follow them.
  const filled = seats.map((s, i) => ({ s, i })).filter(({ s }) => s.name.trim() || s.memberId);
  const seatOf = (i: number | null) => (i === null ? null : filled.findIndex((f) => f.i === i));
  const named = filled.map(({ s, i }) => ({ seat: i, name: s.name.trim() || `Player ${i + 1}` }));

  const save = useMutation({
    mutationFn: async (_another: boolean) => {
      if (filled.length < 1) throw new Error("Add at least one player.");
      // A draw is an answer; no answer isn't a draw.
      if (winner === null) throw new Error("Pick who won, or choose It was a draw.");
      const winnerSeat = winner === "draw" ? null : seatOf(winner);
      if (winnerSeat === -1) throw new Error("The winner's seat needs a name.");
      // An edit that keeps the day keeps the time it was saved with.
      const at = editing && date === form?.date ? editing.started_at : new Date(`${date}T20:00:00`).toISOString();
      // The deck version that was current on the day played, not whatever it is now.
      const versions = await Promise.all(
        // Anyone else's public deck carries its list as it is now; the server keeps it only on its owner's seat.
        // Only a Commander game names Commander decks, as at the table.
        filled.map(async ({ s }) => (!cmdr ? null : s.deckId ? versionOn(await api<DeckVersionRow[]>(`/api/decks/${s.deckId}/versions`), date) : (s.deckVersionId ?? null))),
      );
      return api("/api/games", {
        method: "POST",
        json: {
          id: gameId,
          playgroup_id: groupId || null,
          format,
          starting_life: startingLife,
          started_at: at,
          seats: filled.map(({ s }, n) => ({
            seat: n,
            member_id: s.memberId ?? null,
            user_id: s.userId ?? null,
            guest_name: s.memberId ? null : s.name.trim(),
            deck_version_id: versions[n],
            commander_name: (cmdr && s.commanderName) || null,
            deck_label: (cmdr && seatDeckLabel(s)) || null,
          })),
          finish: {
            winner_seat: winnerSeat,
            turns: turns ? Number(turns) : null,
            ended_at: at,
            first_seat: seatOf(first) !== null && seatOf(first)! >= 0 ? seatOf(first) : null,
            win_condition: winnerSeat === null ? null : condition,
            seats: fun.map((r) => ({ seat: seatOf(r.seat), fun: r.rating })).filter((r) => r.seat !== null && r.seat >= 0),
          },
          note: editing?.note ?? "Logged after the game",
        },
      });
    },
    onSuccess: (_, another) => {
      void qc.invalidateQueries({ queryKey: ["games"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      void qc.invalidateQueries({ queryKey: ["deck-results"] });
      void qc.invalidateQueries({ queryKey: ["game", gameId] });
      if (!another) return onClose();
      // The next game: a new id, the same playgroup, day, players and decks, nothing answered.
      setGameId(crypto.randomUUID());
      setTurns(UNANSWERED.turns);
      setWinner(UNANSWERED.winner);
      setFirst(UNANSWERED.first);
      setCondition(UNANSWERED.condition);
      setFun(UNANSWERED.fun);
      setSavedHere((n) => n + 1);
    },
  });

  return (
    <Sheet label={editing ? "Edit the game" : "Log a game"} onClose={onClose}>
      <form className="stack capture" onSubmit={(e) => { e.preventDefault(); save.mutate(false); }}>
        <div className="sheet-head">
          <h2>{editing ? "Edit the game" : "Log a game"}</h2>
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
        <p className="small dim" style={{ margin: 0 }}>
          {!cmdr && `A ${formatLabel(format)} game at ${startingLife} life, like the game it started from. `}
          List the players clockwise, so turn order counts from whoever went first.
        </p>
        {seats.map((s, i) => (
          <SeatEditor
            key={keys[i] ?? i}
            index={i}
            seat={s}
            onChange={(p) => updateSeat(keys[i] ?? i, p)}
            commander={cmdr}
            group={group}
            decks={decks.data}
            people={people}
            seatedHandles={seats.flatMap((o, j) => (j !== i && o.handle ? [o.handle] : []))}
            footer={
              <>
                <label className="check-row">
                  <input type="radio" name="winner" checked={winner === i} onChange={() => setWinner(i)} />
                  Won this game
                </label>
                {seats.length > 1 && (
                  <button type="button" className="quiet small" onClick={() => removeSeat(i)}>
                    Remove {s.name.trim() || "this player"}
                  </button>
                )}
              </>
            }
          />
        ))}
        <label className="check-row">
          <input type="radio" name="winner" checked={winner === "draw"} onChange={() => { setWinner("draw"); setCondition(null); }} />
          It was a draw
        </label>
        <div className="row">
          <button type="button" onClick={addSeat}>Add a player</button>
        </div>
        {named.length > 0 && (
          <>
            {typeof winner === "number" && <WinConditionPicker value={condition} onChange={setCondition} winner={named.find((n) => n.seat === winner)?.name} />}
            <FirstPlayerPicker key={gameId} seats={named} value={first} onChange={setFirst} />
            <FunPicker seats={named} value={fun.filter((r) => named.some((n) => n.seat === r.seat))} onChange={setFun} />
          </>
        )}
        <ErrorText error={save.error} />
        {savedHere > 0 && !save.isPending && !save.error && (
          <p className="small dim" role="status">
            {savedHere === 1 ? "Saved." : `${savedHere} games saved.`} The same players are ready for the next game: pick who won and what changed.
          </p>
        )}
        <div className="row">
          <button className="primary" disabled={save.isPending}>{editing ? "Save the changes" : "Save the game"}</button>
          {!editing && (
            <button type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>
              Save and log another
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
