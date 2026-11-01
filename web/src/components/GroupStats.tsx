// The Group page's numbers. Honest by construction: every rate shows what it's out of, rates
// from fewer than `provisional_under` games are faded and marked provisional, win rates sit next
// to the share a player would win by chance, and the page says when it was computed.

import { winConditionLabel } from "@yama/core";
import { useState } from "react";
import type { PlaygroupStats, PodSeats } from "../api";
import "./stats.css";

export const pct = (x: number) => `${Math.round(100 * x)}%`;
const PLACES = ["Went first", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

export const computedAt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Rate({ wins, games, extra }: { wins: number; games: number; extra?: string }) {
  return (
    <span className="rate">
      <b className="num">{games ? pct(wins / games) : "none"}</b>
      <span className="num">{wins} of {games}{extra ? `, ${extra}` : ""}</span>
    </span>
  );
}

function Provisional({ games, under }: { games: number; under: number }) {
  return games < under ? <span className="prov"> provisional</span> : null;
}

/**
 * The Group page's deeper numbers: turn order, how games were won, knockouts, first and last out,
 * and fun, in a grid of sections. The page itself draws the headline figures, the player cards
 * and the commanders (pages/Group.tsx).
 */
export function GroupStats({ s }: { s: PlaygroupStats }) {
  const under = s.provisional_under;
  return (
    <div className="stack group-stats">
      <p className="computed">
        Computed {computedAt(s.computed_at)} from finished games. Rates from fewer than {under} games are faded and marked provisional.
      </p>
      {/* One column on phones; side by side as the window allows on laptops. */}
      <div className="group-stats-grid">
        <TurnOrder s={s} />
        <WinConditions s={s} />
        <Rivalries s={s} />
        <OutOrder s={s} />
        <Fun s={s} />
      </div>
    </div>
  );
}

/** Head-to-head rows shown before "Show all". */
const H2H_PEEK = 5;

function PodTable({ pod, reference, under }: { pod: PodSeats | null; reference: number[] | null; under: number }) {
  const n = pod?.players ?? reference?.length ?? 4;
  const rows = Array.from({ length: n }, (_, i) => i);
  const faded = !pod || pod.games < under;
  return (
    <table className="plain">
      <thead>
        <tr>
          <th>Turn order</th>
          {pod && <th className="r">Win rate</th>}
          <th className="r">By chance</th>
          {reference && <th className="r">playgroup.gg</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i}>
            <td>{PLACES[i] ?? `Seat ${i + 1} in order`}</td>
            {pod && (
              <td className="r" style={faded ? { opacity: 0.55 } : undefined}>
                <Rate wins={pod.positions[i]?.wins ?? 0} games={pod.games} />
              </td>
            )}
            <td className="r num">{pct(1 / n)}</td>
            {reference && <td className="r num reference">{reference[i]?.toFixed(1)}%</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TurnOrder({ s }: { s: PlaygroupStats }) {
  const ref = s.seat_reference;
  const refPod = s.seats.find((p) => p.players === ref.players) ?? null;
  const showRef = (refPod?.games ?? 0) < ref.show_until_games;
  return (
    <section>
      <h2>Turn order</h2>
      <p className="lede">
        Win rate by place in turn order, from games with a winner where the table said who went first (Roll for first, "goes first" in the table menu, or Log a game).
        {s.seats_unknown > 0 && ` ${s.seats_unknown} ${s.seats_unknown === 1 ? "game doesn't" : "games don't"} say who went first.`}
      </p>
      <div className="stack" style={{ gap: "1.25rem" }}>
        {s.seats.map((pod) => (
          <div key={pod.players}>
            <h3>
              {pod.players} players, {pod.games} {pod.games === 1 ? "game" : "games"}
              <Provisional games={pod.games} under={s.provisional_under} />
            </h3>
            <PodTable pod={pod} reference={pod.players === ref.players && showRef ? ref.rates : null} under={s.provisional_under} />
          </div>
        ))}
        {!refPod && showRef && (
          <div>
            <h3>{ref.players} players, no games yet</h3>
            <PodTable pod={null} reference={ref.rates} under={s.provisional_under} />
          </div>
        )}
      </div>
      {showRef && (
        <p className="small dim" style={{ marginTop: "0.6rem" }}>
          The playgroup.gg column is from <a href={ref.url} target="_blank" rel="noreferrer">its turn-order page</a>: {ref.games.toLocaleString()} single-winner 4-player games, computed {new Date(`${ref.computed}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })}. It's shown until this group has {ref.show_until_games} 4-player games of its own with a known first player.
        </p>
      )}
    </section>
  );
}

function WinConditions({ s }: { s: PlaygroupStats }) {
  const w = s.win_conditions;
  const recorded = w.recorded.reduce((a, c) => a + c.games, 0);
  if (w.decided === 0) return null;
  return (
    <section>
      <h2>How games were won</h2>
      {/* Empty, it reads like Knockouts' empty line beside it. */}
      <p className={recorded === 0 ? "dim" : "lede"}>
        {recorded === 0
          ? (w.decided === 1
              ? "The one game with a winner doesn't say how it was won yet."
              : `None of the ${w.decided} games with a winner say how they were won yet.`) + " The finish sheet and Log a game both ask."
          : `Shares of the ${recorded} ${recorded === 1 ? "game" : "games"} where someone said how.${w.not_recorded ? ` ${w.not_recorded} more with a winner didn't say.` : ""}`}
      </p>
      {recorded > 0 && (
        <table className="plain">
          <thead><tr><th>Win condition</th><th className="r">Share</th></tr></thead>
          <tbody>
            {w.recorded.map((c) => (
              <tr key={c.condition} className={recorded < s.provisional_under ? "provisional" : undefined}>
                <td>{winConditionLabel(c.condition) ?? c.condition}</td>
                <td className="r"><Rate wins={c.games} games={recorded} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {recorded > 0 && recorded < s.provisional_under && <p className="small"><span className="prov">Provisional</span> <span className="dim">until {s.provisional_under} games say how they were won.</span></p>}
    </section>
  );
}

function Rivalries({ s }: { s: PlaygroupStats }) {
  const kg = s.knockout_games;
  const nemeses = s.players.filter((p) => p.archnemesis);
  const [allH2h, setAllH2h] = useState(false);
  const h2h = allH2h ? s.head_to_head : s.head_to_head.slice(0, H2H_PEEK);
  return (
    <section>
      <h2>Knockouts</h2>
      {kg === 0 ? (
        <p className="dim">No knockouts recorded yet. On the table, "Knock out" asks who did it, and that's where rivalries come from.</p>
      ) : (
        <div className="stack" style={{ gap: "1.25rem" }}>
          {s.head_to_head.length > 0 && (
            <div>
              <h3>Head to head</h3>
              <p className="lede">Knockouts each way, when the table said who did it.</p>
              <ul className="plain-list">
                {h2h.map((h) => (
                  <li key={`${h.a}|${h.b}`} className="h2h">
                    <span>{h.a_name}</span>
                    <span className="score">{h.a_over_b} to {h.b_over_a}</span>
                    <span>{h.b_name}</span>
                  </li>
                ))}
              </ul>
              {s.head_to_head.length > H2H_PEEK && (
                <button className="small quiet h2h-more" aria-expanded={allH2h} onClick={() => setAllH2h((v) => !v)}>
                  {allH2h ? "Show fewer" : `Show all ${s.head_to_head.length}`}
                </button>
              )}
            </div>
          )}
          {nemeses.length > 0 && (
            <div>
              <h3>Archnemesis</h3>
              <ul className="plain-list">
                {nemeses.map((p) => {
                  const n = p.archnemesis!;
                  return (
                    <li key={p.key} className={n.of < s.provisional_under ? "provisional" : undefined}>
                      <b>{p.name}</b>: {names(n.names)} knocked them out {n.knockouts} of {n.of} {n.of === 1 ? "time" : "times"}{n.names.length > 1 ? " each" : ""}.
                      <Provisional games={n.of} under={s.provisional_under} />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Who goes out first and who lasts longest, from games with a knockout recorded. */
function OutOrder({ s }: { s: PlaygroupStats }) {
  const kg = s.knockout_games;
  if (kg === 0) return null;
  // A player who never sat in a game with a recorded knockout has no answer here, not zeros.
  const koPlayers = s.players.filter((p) => p.knockout_games > 0);
  const faded = kg < s.provisional_under;
  return (
    <section>
      <h2>
        First out and last out
        <Provisional games={kg} under={s.provisional_under} />
      </h2>
      <p className="lede">
        From {kg} {kg === 1 ? "game" : "games"} with a knockout recorded. Each count is out of that player's own games with a knockout recorded (for last
        out, ones with a winner too). Last out means the last losers standing; ties count for everyone tied.
        {koPlayers.length < s.players.length && " Players with no knockout recorded in their games aren't listed."}
      </p>
      <table className="plain">
        <thead><tr><th>Player</th><th className="r">First out</th><th className="r">Last out</th><th className="r">Knockouts</th></tr></thead>
        <tbody>
          {koPlayers.map((p) => (
            <tr key={p.key} className={faded || p.knockout_games < s.provisional_under ? "provisional" : undefined}>
              <td>{p.name}</td>
              <td className="r num">{p.first_out} of {p.knockout_games}</td>
              <td className="r num">{p.last_out_games > 0 ? `${p.last_out} of ${p.last_out_games}` : "–"}</td>
              <td className="r num">{p.knockouts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Fun({ s }: { s: PlaygroupStats }) {
  const rated = s.players.filter((p) => p.fun !== null);
  if (rated.length === 0) return null;
  return (
    <section>
      <h2>Fun</h2>
      <p className="lede">Average fun rating, 1 to 5, from the end-of-game question.</p>
      <table className="plain">
        <thead><tr><th>Player</th><th className="r">Average</th><th className="r">Ratings</th></tr></thead>
        <tbody>
          {rated.map((p) => (
            <tr key={p.key} className={p.fun_ratings < s.provisional_under ? "provisional" : undefined}>
              <td>{p.name}<Provisional games={p.fun_ratings} under={s.provisional_under} /></td>
              <td className="r num">{p.fun!.toFixed(1)}</td>
              <td className="r num">{p.fun_ratings}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
