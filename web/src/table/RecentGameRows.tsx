// The rows of a list of recent games (the life counter's setup page and Home): who won with
// what, over whom, and when. A game with a winner shows the winner's art; one still going, or a
// draw, shows up to four seats' art as a mosaic. A row with no commander named carries its players'
// initials instead of an empty block. The credit names exactly the art shown.
import { GAME_WORDS, fmtDate, fmtWeekday, shortDate } from "@yama/core";
import { Link } from "react-router";
import type { GameRow, GameSeat } from "../api";
import { ArtMosaic } from "../components/ArtMosaic";
import { artCredits } from "../components/ArtPanel";
import { CardThumb } from "../components/CardThumb";
import { useCardArt } from "../components/useCardArt";
import { recentGameText, turnsText, winningSeat } from "./recent";
import "./home.css";

/** Up to four players' first letters ("BCMK"), standing in where a row has no art to show. */
export function initials(seats: Pick<GameSeat, "display_name">[]): string {
  return seats
    .map((s) => Array.from(s.display_name?.trim() ?? "")[0]?.toUpperCase() ?? "")
    .filter(Boolean)
    .slice(0, 4)
    .join("");
}

/**
 * `from`: where a game's page goes back to, when that isn't the life counter's setup.
 * `linked={false}`: games with no page of their own (ones kept only on this device).
 */
export function RecentGameRows({ games: shown, from, linked = true }: { games: GameRow[]; from?: string; linked?: boolean }) {
  const winnerShown = winningSeat;
  const art = useCardArt(shown.flatMap((g) => (winnerShown(g) ? [winnerShown(g)!] : g.seats).map((s) => s.commander_name)));
  const seatArt = (g: GameRow) => g.seats.map((s) => art.get(s.commander_name ?? "")).filter((a) => !!a?.art).slice(0, 4);
  const pictured = (g: GameRow) => (winnerShown(g) ? [art.get(winnerShown(g)!.commander_name ?? "")] : seatArt(g));
  const credited = shown.flatMap(pictured).filter((a) => !!a?.art);
  return (
    <>
      <ol className="rg-list">
        {shown.map((g) => {
          const winner = winnerShown(g);
          const cmdr = winner?.commander_name;
          const a = cmdr ? art.get(cmdr) : undefined;
          const text = recentGameText(g);
          const row = (
            <>
              {/* No commander named, so no art will come: initials. A named one keeps the plain
                  block while its art loads, rather than letters that flick to a picture. */}
              {!(winner ? [winner] : g.seats).some((s) => s.commander_name) ? (
                <span className="rg-art rg-initials" aria-hidden="true">{initials(winner ? [winner] : g.seats)}</span>
              ) : winner ? (
                <span className="rg-art">{a?.art && <CardThumb src={a.art} />}</span>
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
                  <span className="rg-weekday">{fmtWeekday(g.started_at)}, </span>
                  {shortDate(g.started_at)}
                </span>
                {g.turns ? <span className="rg-turns">{turnsText(g)}</span> : g.status === "in_progress" ? <span className="rg-turns rg-live">{GAME_WORDS.going}</span> : null}
              </span>
            </>
          );
          return (
            <li key={g.id}>
              {linked ? (
                // An online game keeps its replay with the online board; a table game has its own page.
                <Link className="rg-row" state={from ? { history: from } : undefined} to={g.mode === "in_person" ? `/table/games/${g.id}` : `/play/${g.id}`} aria-label={`${text.title}${text.with ? ` with ${text.with}` : ""}, ${fmtDate(g.started_at, { year: false })}. Details`}>
                  {row}
                </Link>
              ) : (
                <div className="rg-row">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
      {credited.length > 0 && <p className="small dim rg-credit">{artCredits(credited.map((c) => c!.artist))}</p>}
    </>
  );
}
