// One table game: who played what, how it ended, and everything that happened, turn by turn. A
// game still going can be followed live from another device, or carried on here.

import { useMutation, useQuery } from "@tanstack/react-query";
import { formatLabel, winConditionLabel, type LoggedEvent, type TableEvent, type TableFormat, type TableSetup } from "@yama/core";
import { Link, useNavigate, useParams } from "react-router";
import { api, type GameDetail, type GameSeat } from "../api";
import { ArtMosaic } from "../components/ArtMosaic";
import { artCredits } from "../components/ArtPanel";
import { ErrorText } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
import { history } from "./history";
import { cardNamed, unionIdentity } from "./pickers";
import { resumeGame, useTable } from "./store";
import "./home.css";

const FORMAT_KEYS: TableFormat[] = ["commander", "standard", "other"];

/** "Tana and Tymna" on the server's label, back into a commander and a partner. */
function splitPair(s: GameSeat): { commander?: string; partner?: string } {
  const commander = s.commander_name ?? undefined;
  const label = s.deck_label ?? "";
  const partner = commander && label.startsWith(`${commander} and `) ? label.slice(commander.length + 5) : undefined;
  return { commander, partner };
}

const seatName = (s: GameSeat) => s.display_name ?? s.guest_name ?? `Player ${s.seat + 1}`;

/** The game as this device's table keeps it, from what the server stored. Art and colors come later. */
export function setupFromServer(g: GameDetail): { setup: TableSetup; log: LoggedEvent[] } {
  const setup: TableSetup = {
    id: g.id,
    startedAt: g.started_at,
    format: FORMAT_KEYS.includes(g.format as TableFormat) ? (g.format as TableFormat) : "commander",
    startingLife: g.starting_life ?? 40,
    playgroupId: g.playgroup_id ?? undefined,
    players: g.seats.map((s) => {
      const { commander, partner } = splitPair(s);
      return {
        seat: s.seat,
        name: seatName(s),
        memberId: s.member_id ?? undefined,
        userId: s.user_id ?? undefined,
        deckVersionId: s.deck_version_id ?? undefined,
        deckLabel: s.deck_label ?? commander,
        commanderName: commander,
        partnerName: partner,
        colorIdentity: "",
      };
    }),
  };
  const log: LoggedEvent[] = g.events
    .filter((e) => !!e.payload && typeof e.payload === "object" && "type" in (e.payload as object))
    .map((e) => ({ seq: e.seq, at: e.created_at ?? g.started_at, event: e.payload as TableEvent }));
  return { setup, log };
}

export function GameDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const local = useTable();
  const game = useQuery({ queryKey: ["game", id], queryFn: () => api<GameDetail>(`/api/games/${id}`) });
  const g = game.data;
  const going = g?.status === "in_progress";
  const live = useQuery({
    queryKey: ["table-live", id],
    queryFn: () => api<{ hosting: boolean }>(`/api/table/${id}/live`),
    enabled: !!g?.can_continue,
    refetchInterval: 15_000,
  });
  const art = useCardArt(g?.seats.flatMap((s) => [splitPair(s).commander]) ?? []);
  const here = local.game?.setup.id === id;
  const busyElsewhere = !!local.game && !here;

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

  if (game.isLoading) return <main className="page"><p className="dim">Loading the game…</p></main>;
  if (!g) {
    return (
      <main className="page">
        <p><Link to="/">Table</Link></p>
        <ErrorText error={game.error ?? new Error("That game isn't here.")} />
      </main>
    );
  }

  const winner = g.seats.find((s) => s.seat === g.winner_seat);
  const first = g.seats.find((s) => s.seat === g.first_seat);
  const day = new Date(g.started_at);
  const shown = g.seats.map((s) => art.get(splitPair(s).commander ?? "")).filter((a) => !!a?.art);
  const { setup, log } = setupFromServer(g);
  const lines = history(setup, log);
  const turns: { turn: number; lines: typeof lines }[] = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.turn === l.turn) last.lines.push(l);
    else turns.push({ turn: l.turn, lines: [l] });
  }
  const how = winConditionLabel(g.win_condition);
  const title = going ? "Still going" : winner ? `${seatName(winner)} won` : g.status === "finished" ? "A draw" : "Game";
  const facts = [
    `${day.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}, ${day.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`,
    `${formatLabel(setup.format)}, ${g.seats.length} players at ${setup.startingLife} life.`,
    g.turns ? `${g.turns} turns.` : null,
    how ? `Won by ${how.toLowerCase()}.` : null,
    first ? `${seatName(first)} went first.` : null,
    g.note ? `${g.note}.` : null,
  ].filter(Boolean);

  return (
    <main className="page game-detail">
      <p className="gd-back"><Link to="/">Table</Link></p>
      <header className="gd-head">
        <ArtMosaic className="gd-art" arts={(winner ? [art.get(splitPair(winner).commander ?? "")] : shown).filter((a) => !!a?.art).slice(0, 4).map((a) => a!.art)} />
        <div className="gd-title">
          <h1>{title}</h1>
          <p className="dim">{facts.join(" ")}</p>
        </div>
      </header>

      {going && (
        <section className="gd-going" aria-label="This game is still going">
          {here ? (
            <button className="primary" onClick={() => navigate("/table/play")}>Back to the table</button>
          ) : g.can_continue ? (
            <>
              <div className="row">
                {live.data?.hosting && (
                  <Link className="button primary" to={`/table/join/${g.id}`}>Follow it live</Link>
                )}
                <button className={live.data?.hosting ? "" : "primary"} disabled={busyElsewhere || carryOn.isPending} onClick={() => carryOn.mutate()}>
                  {carryOn.isPending ? "Opening…" : "Continue on this device"}
                </button>
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
                <span className="gd-seat-art">{a?.art && <img src={a.art} alt="" loading="lazy" />}</span>
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
          <p className="dim">{g.note ? "Logged after the game, so there's no play-by-play." : "Nothing saved yet."}</p>
        ) : (
          <ol className="gd-turns">
            {turns.map((t, i) => (
              <li key={`${t.turn}:${i}`}>
                <h3>Turn {t.turn}</h3>
                <ul>
                  {t.lines.map((l) => (
                    <li key={l.seq}>
                      <span className="gd-time num">{new Date(l.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                      {l.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
