// One table game: who played what, how it ended, and everything that happened, turn by turn. A
// game still going can be followed live from another device, or carried on here.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatLabel, GAME_WORDS, noteText, wonText, winConditionLabel, WIN_CONDITIONS, type LoggedEvent, type TableEvent, type TableFormat, type TableSetup, fmtDateTime, fmtTime } from "@yama/core";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, type DeckSummary, type GameDetail, type GameSeat } from "../api";
import { MythicNote } from "../bridges/mythic/MythicImport";
import { ArtMosaic } from "../components/ArtMosaic";
import { artCredits } from "../components/ArtPanel";
import { BackLink, Button, ButtonLink, CardThumb, ErrorText, Loading } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
import { history } from "./history";
import { useLoggedQueue } from "./loggedQueue";
import { turnsText } from "./recent";
import { isLoggedGame, splitPair } from "./logEdit";
import { cardNamed, unionIdentity } from "./pickers";
import { deleteGame, resumeGame, useOutbox, useTable } from "./store";
import { LogGame } from "./TableHome";
import { isViewing } from "../viewingFlag";
import { joinFragment } from "./share";
import { clockFacts } from "./TableClock";
import "./home.css";
import { ask } from "../components/confirm";

const FORMAT_KEYS: TableFormat[] = ["commander", "standard", "other"];

const seatName = (s: GameSeat) => s.display_name ?? s.guest_name ?? `Player ${s.seat + 1}`;

/** The game as this device's table keeps it, from what the server stored. Art and colors come later. */
export function setupFromServer(g: GameDetail): { setup: TableSetup; log: LoggedEvent[] } {
  const log: LoggedEvent[] = g.events
    .filter((e) => !!e.payload && typeof e.payload === "object" && "type" in (e.payload as object))
    .map((e) => ({ seq: e.seq, at: e.created_at ?? g.started_at, event: e.payload as TableEvent }));
  // Finished-game facts may have been corrected after the table uploaded its events.
  // Reconcile the displayed terminal result, keeping the persisted event log untouched.
  if (g.status === "finished") {
    // Preserve mid-game player changes, but reconcile the final player at each seat.
    // Earlier names (including `was`) still describe who was there at that point.
    for (const seat of g.seats) {
      const last = log.findLastIndex(({ event }) => event.type === "player" && event.seat === seat.seat);
      const row = log[last];
      if (row?.event.type === "player") {
        log[last] = { ...row, event: {
          ...row.event,
          name: seatName(seat),
          memberId: seat.member_id ?? undefined,
          userId: seat.user_id ?? undefined,
        } };
      }
    }
    const terminal = log.findLastIndex(({ event }) => event.type === "finish");
    const row = log[terminal];
    if (row?.event.type === "finish") {
      log[terminal] = { ...row, event: {
        ...row.event,
        winnerSeat: g.winner_seat,
        winCondition: g.winner_seat === null ? undefined : WIN_CONDITIONS.find((c) => c.key === g.win_condition)?.key,
      } };
    }
  }
  // The server keeps a seat's newest commander; a seat that changed says what it started with.
  const started = new Map<number, { commanderName?: string; partnerName?: string }>();
  for (const { event: e } of log) if (e.type === "seat" && e.was && !started.has(e.seat)) started.set(e.seat, e.was);
  // Its newest player too: a seat someone else took says who sat there first. The replay's
  // "player" event puts the newest one (member and account included) back.
  const firstPlayer = new Map<number, string>();
  for (const { event: e } of log) if (e.type === "player" && e.was && !firstPlayer.has(e.seat)) firstPlayer.set(e.seat, e.was.name);
  const setup: TableSetup = {
    id: g.id,
    startedAt: g.started_at,
    format: FORMAT_KEYS.includes(g.format as TableFormat) ? (g.format as TableFormat) : "commander",
    startingLife: g.starting_life ?? 40,
    playgroupId: g.playgroup_id ?? undefined,
    players: g.seats.map((s) => {
      const now = splitPair(s);
      const before = started.get(s.seat);
      const { commander, partner } = before ? { commander: before.commanderName, partner: before.partnerName } : now;
      const firstName = firstPlayer.get(s.seat);
      return {
        seat: s.seat,
        name: firstName ?? seatName(s),
        memberId: firstName === undefined ? (s.member_id ?? undefined) : undefined,
        userId: firstName === undefined ? (s.user_id ?? undefined) : undefined,
        deckVersionId: before ? undefined : (s.deck_version_id ?? undefined),
        deckLabel: before ? commander : (s.deck_label ?? commander),
        commanderName: commander,
        partnerName: partner,
        colorIdentity: "",
      };
    }),
  };
  return { setup, log };
}

export function GameDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { history?: string } | null)?.history;
  const back = from?.startsWith("/table/games?") ? from : "/";
  const local = useTable();
  const game = useQuery({ queryKey: ["game", id], queryFn: ({ signal }) => api<GameDetail>(`/api/games/${id}`, { signal }) });
  const g = game.data;
  const outbox = useOutbox();
  // An edit of this logged game saved while Yama couldn't be reached (loggedQueue.ts).
  const waitingEdit = useLoggedQueue().find((q) => q.body.id === id);
  const here = local.game?.setup.id === id;
  const busyElsewhere = !!local.game && !here;
  // Finished on this device and still uploading: it isn't going any more, whatever the server says.
  const uploading = outbox.some((o) => o.setup.id === id);
  const going = g?.status === "in_progress" && !uploading;
  // Viewing as someone, nothing this device records is theirs to upload.
  const mayContinue = !!g?.can_continue && !uploading && !isViewing();
  const live = useQuery({
    queryKey: ["table-live", id],
    queryFn: ({ signal }) => api<{ hosting: boolean; key?: string; relay?: "edge" | "server" }>(`/api/table/${id}/live`, { signal }),
    enabled: mayContinue,
    refetchInterval: 15_000,
  });
  const art = useCardArt(g?.seats.flatMap((s) => [splitPair(s).commander]) ?? []);
  /** The Log a game sheet: editing this game, or a new log starting from it. */
  const [sheet, setSheet] = useState<"edit" | "copy" | null>(null);
  // Both name the seats' decks from your list, so they open once that's here.
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }), enabled: game.data?.mode === "in_person" });

  const carryOn = useMutation({
    mutationFn: async () => {
      const { setup, log } = setupFromServer(g!);
      // Art and colors for each seat, looked up again (the server keeps only the names).
      const players = await Promise.all(
        setup.players.map(async (p) => {
          const [c, partner] = await Promise.all([p.commanderName ? cardNamed(p.commanderName) : null, p.partnerName ? cardNamed(p.partnerName) : null]);
          return {
            ...p,
            colorIdentity: unionIdentity(c?.color_identity, partner?.color_identity),
            art: c?.image_art_crop ?? undefined,
            artist: c?.artist ?? undefined,
            partnerArt: partner?.image_art_crop ?? undefined,
            partnerArtist: partner?.artist ?? undefined,
          };
        }),
      );
      resumeGame({ ...setup, players }, log);
    },
    onSuccess: () => navigate("/table/play"),
  });

  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteGame(id),
    // Offline, it's gone from this device now and from Yama once the connection is back.
    onSuccess: () => {
      for (const key of ["games", "stats", "deck-results", "game"]) void qc.invalidateQueries({ queryKey: [key] });
      navigate(back, { replace: true });
    },
  });

  if (game.isLoading) return <Loading page>Loading the game…</Loading>;
  if (!g) {
    return (
      <main className="page">
        <p><Link to={back}>{back === "/" ? "Life counter" : "Game history"}</Link></p>
        <ErrorText error={game.error ?? new Error("That game isn't here.")} />
      </main>
    );
  }

  const winner = g.seats.find((s) => s.seat === g.winner_seat);
  const first = g.seats.find((s) => s.seat === g.first_seat);
  const shown = g.seats.map((s) => art.get(splitPair(s).commander ?? "")).filter((a) => !!a?.art);
  const { setup, log } = setupFromServer(g);
  const lines = history(setup, log);
  const turns: { turn: number; lines: typeof lines }[] = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.turn === l.turn) last.lines.push(l);
    else turns.push({ turn: l.turn, lines: [l] });
  }
  // A table that never passed the turn has one long "turn": no headings for it.
  const counted = log.some((l) => l.event.type === "pass_turn");
  const how = winConditionLabel(g.win_condition);
  // Logged after it was played (Log a game): finished, with nothing from the table. A note
  // doesn't say so; any game can carry one.
  const logged = isLoggedGame(g);
  const title = going ? GAME_WORDS.going : winner ? wonText(seatName(winner)) : g.status === "finished" ? GAME_WORDS.draw : "Game";
  const facts = [
    `${fmtDateTime(g.started_at, { weekday: "long", year: false })}.`,
    `${formatLabel(setup.format)}, ${g.seats.length} players at ${setup.startingLife} life.`,
    g.turns ? `${turnsText(g)}.` : null,
    how ? `Won by ${how.toLowerCase()}.` : null,
    first ? `${seatName(first)} went first.` : null,
    // How long it ran, from the times its record keeps (nothing for a game logged afterwards).
    // Turn figures only when every pass carries its own time (an old record's may not).
    ...(logged ? [] : clockFacts(setup, log, g.events.every((e) => e.kind !== "pass_turn" || !!e.created_at))),
    // What the table wrote, as written (the old fixed "Logged after the game" isn't a note).
    noteText(g.note),
  ].filter(Boolean);

  return (
    <main className="page game-detail">
      <BackLink inline to={back} label={back === "/" ? "Back to the life counter" : "Back to game history"} text={back === "/" ? "Life counter" : "Game history"} />
      <header className="gd-head">
        <ArtMosaic className="gd-art" arts={(winner ? [art.get(splitPair(winner).commander ?? "")] : shown).filter((a) => !!a?.art).slice(0, 4).map((a) => a!.art)} />
        <div className="gd-title">
          <h1>{title}</h1>
          <p className="dim">{facts.join(" ")}</p>
          {g.mode === "in_person" && <MythicNote gameId={g.id} />}
          {waitingEdit && (
            <p className="small dim" role="status">
              An edit to this game made on this device hasn't reached Yama yet{waitingEdit.error ? ` (${waitingEdit.error})` : ""}. This page shows what Yama has; the edit uploads on its own.
            </p>
          )}
          {g.mode === "in_person" && !going && !isViewing() && (
            <div className="row">
              {g.can_edit && <Button disabled={!decks.data && !decks.isError} onClick={() => setSheet("edit")}>Edit this game</Button>}
              <Button disabled={!decks.data && !decks.isError} onClick={() => setSheet("copy")}>Log another like this</Button>
            </div>
          )}
        </div>
      </header>
      {sheet && <LogGame editing={sheet === "edit" ? g : undefined} copyFrom={sheet === "copy" ? g : undefined} onClose={() => setSheet(null)} />}

      {going && (
        <section className="gd-going" aria-label="This game is still going">
          {here ? (
            <Button variant="primary" onClick={() => navigate("/table/play")}>Back to the table</Button>
          ) : mayContinue ? (
            <>
              <div className="row">
                {live.data?.hosting && (
                  <ButtonLink variant="primary" to={`/table/join/${g.id}${live.data.key ? joinFragment(live.data.key, live.data.relay ?? "edge") : ""}`}>Follow it live</ButtonLink>
                )}
                <Button className={live.data?.hosting ? "" : "primary"} disabled={busyElsewhere || carryOn.isPending} onClick={() => carryOn.mutate()}>
                  {carryOn.isPending ? "Opening…" : "Continue on this device"}
                </Button>
              </div>
              <p className="small dim">
                {busyElsewhere
                  ? "This device already has a game going. Finish or discard it first."
                  : live.data?.hosting
                    ? "Your other device is sharing this game right now. Follow it to see and change totals there; continue here only if that device is done with it."
                    : "Picks up from the last change Yama saved. If the other device is still running the game, its newest taps may not be here yet."}
              </p>
              <ErrorText error={carryOn.error} />
            </>
          ) : (
            <p className="small dim">Whoever started this game can carry it on from their devices.</p>
          )}
        </section>
      )}

      <section aria-labelledby="gd-seats">
        <h2 id="gd-seats">Players</h2>
        <ol className="gd-seats">
          {g.seats.map((s) => {
            const { commander, partner } = splitPair(s);
            const a = art.get(commander ?? "");
            const by = g.seats.find((o) => o.seat === s.eliminated_by_seat);
            const result = s.seat === g.winner_seat
              ? "Won"
              : s.eliminated_turn != null
                ? `Out on turn ${s.eliminated_turn}${by ? `, by ${seatName(by)}` : ""}`
                : s.final_life != null
                  ? `${s.final_life} life at the end`
                  : going
                    ? "Still in"
                    : "";
            return (
              <li key={s.seat} className="gd-seat">
                <span className="gd-seat-art">{a?.art && <CardThumb src={a.art} />}</span>
                <span className="gd-seat-text">
                  <span className="gd-seat-name">{seatName(s)}</span>
                  <span className="small dim">{commander ? (partner ? `${commander} and ${partner}` : commander) : "No commander saved"}</span>
                </span>
                <span className="gd-seat-result">
                  <span>{result}</span>
                  {s.fun != null && <span className="small dim">Fun {s.fun} of 5</span>}
                </span>
              </li>
            );
          })}
        </ol>
        {shown.length > 0 && <p className="small dim">{artCredits(shown.map((a) => a!.artist))}</p>}
      </section>

      <section aria-labelledby="gd-history">
        <h2 id="gd-history">What happened</h2>
        {turns.length === 0 ? (
          <p className="dim">{logged ? "Logged after the game, so there's no play-by-play." : "Nothing saved yet."}</p>
        ) : (
          <ol className="gd-turns">
            {turns.map((t, i) => (
              <li key={`${t.turn}:${i}`}>
                {counted && <h3>Turn {t.turn}</h3>}
                <ul>
                  {t.lines.map((l) => (
                    <li key={l.seq}>
                      <span className="gd-time num">{fmtTime(l.at)}</span>
                      {l.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      {g.can_delete && !isViewing() && (
        <section className="gd-delete" aria-label="Delete this game">
          <Button
            variant="outline" className="bad"
            disabled={remove.isPending}
            onClick={async () => (await ask({ title: "Delete this game from Yama?", body: "It comes out of the history and stats for everyone who played. This can't be undone.", confirm: "Delete game", danger: true })) && remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : "Delete this game"}
          </Button>
          <p className="small dim">Only you can, since you recorded it. Use it for a test game or one entered by mistake.</p>
          <ErrorText error={remove.error} />
        </section>
      )}
    </main>
  );
}
