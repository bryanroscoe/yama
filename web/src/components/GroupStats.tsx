// The Group page's numbers. Honest by construction: every rate shows what it's out of, rates
// from fewer than `provisional_under` games are faded and marked provisional, win rates sit next
// to the share a player would win by chance, and the page says when it was computed.

import { winConditionLabel } from "@yama/core";
import type { PlaygroupStats, PodSeats } from "../api";
import { streakText } from "./statsText";
import "./stats.css";

const pct = (x: number) => `${Math.round(100 * x)}%`;
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

export function GroupStats({ s }: { s: PlaygroupStats }) {
  const under = s.provisional_under;
  return (
    <div className="stack group-stats">
      <div>
        <div className="figures" style={{ marginBottom: "0.5rem" }}>
          <div className="figure"><b className="num">{s.games}</b><span>games recorded</span></div>
          {s.average_turns && (
            <div className="figure">
              <b className="num">{s.average_turns.value.toFixed(1)}</b>
              <span>turns on average, from {s.average_turns.games} {s.average_turns.games === 1 ? "game" : "games"}</span>
            </div>
          )}
          {s.average_minutes && (
            <div className="figure">
              <b className="num">{Math.round(s.average_minutes.value)}</b>
              <span>minutes on average, from {s.average_minutes.games} timed {s.average_minutes.games === 1 ? "game" : "games"}</span>
            </div>
          )}
        </div>
        <p className="computed">
          Computed {computedAt(s.computed_at)} from finished games. Rates from fewer than {under} games are faded and marked provisional.
        </p>
      </div>

      <Players s={s} />
      <TurnOrder s={s} />
      <WinConditions s={s} />
      <Rivalries s={s} />
      <Fun s={s} />
      <Commanders s={s} />
    </div>
  );
}

function Players({ s }: { s: PlaygroupStats }) {
  return (
    <section>
      <h2>Players</h2>
      <p className="lede">"By chance" is the share each player would win if every seat were equal: one in four in a 4-player game, averaged over their games.</p>
      <table className="plain">
        <thead><tr><th>Player</th><th className="r">Win rate</th><th className="r">By chance</th><th>Streak</th></tr></thead>
        <tbody>
          {s.players.map((p) => (
            <tr key={p.key} className={p.games < s.provisional_under ? "provisional" : undefined}>
              <td>{p.name}<Provisional games={p.games} under={s.provisional_under} /></td>
              <td className="r"><Rate wins={p.wins} games={p.games} extra={p.draws ? `${p.draws} ${p.draws === 1 ? "draw" : "draws"}` : undefined} /></td>
              <td className="r num">{pct(p.expected)}</td>
              <td className="small">{streakText(p.streak)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

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
      <p className="lede">
        {recorded === 0
          ? `None of the ${w.decided} games with a winner say how yet. The finish sheet and Log a game ask.`
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
  const faded = kg < s.provisional_under;
  return (
    <section>
      <h2>Rivalries</h2>
      {kg === 0 ? (
        <p className="dim">No knockouts recorded yet. On the table, "Knock out" asks who did it, and that's where rivalries come from.</p>
      ) : (
        <div className="stack" style={{ gap: "1.25rem" }}>
          {s.head_to_head.length > 0 && (
            <div>
              <h3>Head to head</h3>
              <p className="lede">Knockouts each way, when the table said who did it.</p>
              <ul className="plain-list">
                {s.head_to_head.map((h) => (
                  <li key={`${h.a}|${h.b}`} className="h2h">
                    <span>{h.a_name}</span>
                    <span className="score">{h.a_over_b} to {h.b_over_a}</span>
                    <span>{h.b_name}</span>
                  </li>
                ))}
              </ul>
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
          <div>
            <h3>First out and last out<Provisional games={kg} under={s.provisional_under} /></h3>
            <p className="lede">
              Out of {kg} {kg === 1 ? "game" : "games"} with a knockout recorded. Last out means the last losers standing; ties count for everyone tied.
            </p>
            <table className="plain">
              <thead><tr><th>Player</th><th className="r">First out</th><th className="r">Last out</th><th className="r">Knockouts</th></tr></thead>
              <tbody>
                {s.players.map((p) => (
                  <tr key={p.key} className={faded ? "provisional" : undefined}>
                    <td>{p.name}</td>
                    <td className="r num">{p.first_out}</td>
                    <td className="r num">{p.last_out}</td>
                    <td className="r num">{p.knockouts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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

function Commanders({ s }: { s: PlaygroupStats }) {
  return (
    <section>
      <h2>Commanders</h2>
      <table className="plain">
        <thead><tr><th>Commander</th><th className="r">Win rate</th><th className="r">By chance</th></tr></thead>
        <tbody>
          {s.commanders.map((c) => (
            <tr key={c.commander} className={c.games < s.provisional_under ? "provisional" : undefined}>
              <td>{c.commander}<Provisional games={c.games} under={s.provisional_under} /></td>
              <td className="r"><Rate wins={c.wins} games={c.games} /></td>
              <td className="r num">{pct(c.expected)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
