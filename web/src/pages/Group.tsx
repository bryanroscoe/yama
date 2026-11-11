import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, API_BASE, type GameRow, type GameSeat, type PlayerStat, type PlaygroupStats, type Playgroup } from "../api";
import { useMe } from "../auth";
import { ErrorText, EmptyState } from "../components/ui";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { GroupStats } from "../components/GroupStats";
import { Members } from "./GroupMembers";
import { streakText } from "../components/statsText";
import { useCardArt } from "../components/useCardArt";
import "./group.css";
import { MythicImportEntry } from "../bridges/mythic/MythicImport";
import { HelpPopover } from "../components/HelpPopover";
import { exportLink } from "../download";
import { percent, fmtMonth } from "@yama/core";

export function GroupPage() {
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: ({ signal }) => api<Playgroup[]>("/api/playgroups", { signal }) });
  const [selected, setSelected] = useState<string | null>(null);
  const group = groups.data?.find((g) => g.id === selected) ?? groups.data?.[0];

  return (
    <main className="page group-page">
      <Link to="/table/games">Game history</Link>
      <ErrorText error={groups.error} />
      {groups.data?.length === 0 && (
        <>
          <h1>Playgroup</h1>
          <EmptyState>No playgroup yet.</EmptyState>
        </>
      )}
      {group && (
        <GroupDetail
          group={group}
          switcher={
            groups.data && groups.data.length > 1 ? (
              <select className="grp-switch" value={group.id} onChange={(e) => setSelected(e.target.value)} aria-label="Playgroup">
                {groups.data.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            ) : null
          }
        />
      )}
      <div className="grp-pair">
        {/* Keyed by group: a name being typed or an error shown never carries over to another group. */}
        {group && <Members key={group.id} group={group} />}
        <section className="grp-section" id="sharing"><h2>You</h2><Link className="button outline" to="/profile">Your profile and account</Link></section>
      </div>
      <ExportGames group={group} />
      <MythicImportEntry />
      <GroupActions />
    </main>
  );
}

/** Who sat in a seat, as the stats key players: the member row, else the account, else the name. */
const seatKey = (s: GameSeat) => s.member_id ?? s.user_id ?? `guest:${s.guest_name ?? s.display_name ?? "?"}`;
/** "Terra" from "Terra, Herald of Hope". */
const shortName = (name: string) => name.split(",")[0]!.trim();
const listNames = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

interface Rival {
  key: string;
  name: string;
  shared: number;
  mine: number;
  theirs: number;
}

/**
 * From the group's finished games: each player's most-played commander, who played each
 * commander, and your record against each other player in the games you both sat in.
 */
function readGames(games: GameRow[], me: string | undefined) {
  const played = new Map<string, Map<string, number>>();
  const byCommander = new Map<string, Map<string, string>>();
  const rivals = new Map<string, Rival>();
  for (const g of games) {
    if (g.status !== "finished") continue;
    const winner = g.seats.find((s) => s.seat === g.winner_seat);
    for (const s of g.seats) {
      const k = seatKey(s);
      if (s.commander_name) {
        const m = played.get(k) ?? new Map<string, number>();
        m.set(s.commander_name, (m.get(s.commander_name) ?? 0) + 1);
        played.set(k, m);
        const who = byCommander.get(s.commander_name) ?? new Map<string, string>();
        who.set(k, s.display_name ?? s.guest_name ?? "?");
        byCommander.set(s.commander_name, who);
      }
    }
    if (!me || !g.seats.some((s) => seatKey(s) === me)) continue;
    for (const s of g.seats) {
      const k = seatKey(s);
      if (k === me) continue;
      const r = rivals.get(k) ?? { key: k, name: s.display_name ?? s.guest_name ?? "?", shared: 0, mine: 0, theirs: 0 };
      r.shared += 1;
      if (winner && seatKey(winner) === me) r.mine += 1;
      if (winner && seatKey(winner) === k) r.theirs += 1;
      rivals.set(k, r);
    }
  }
  const favourite = (k: string) => [...(played.get(k) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const list = [...rivals.values()];
  const beatsMe = list.filter((r) => r.theirs > r.mine).sort((a, b) => b.theirs - b.mine - (a.theirs - a.mine) || b.theirs - a.theirs)[0];
  const iBeat = list.filter((r) => r.mine > r.theirs).sort((a, b) => b.mine - b.theirs - (a.mine - a.theirs) || b.mine - a.mine)[0];
  return { favourite, players: (c: string) => [...(byCommander.get(c)?.values() ?? [])], beatsMe, iBeat };
}

function GroupDetail({ group, switcher }: { group: Playgroup; switcher: ReactNode }) {
  const me = useMe().data;
  const stats = useQuery({ queryKey: ["stats", group.id], queryFn: ({ signal }) => api<PlaygroupStats>(`/api/playgroups/${group.id}/stats`, { signal }) });
  const games = useQuery({ queryKey: ["games", "group", group.id], queryFn: ({ signal }) => api<GameRow[]>(`/api/games?playgroup=${group.id}`, { signal }) });
  const [shared, setShared] = useState(false);
  const s = stats.data;
  const myKey = group.members.find((m) => m.user_id && m.user_id === me?.id)?.id ?? me?.id;
  const read = readGames(games.data ?? [], myKey);
  const playerKey = (p: PlayerStat) => p.member_id ?? p.key;
  const favourites = new Map((s?.players ?? []).map((p) => [p.key, read.favourite(playerKey(p))]));
  const rivalArt = (r?: Rival) => (r ? read.favourite(r.key) : null);
  const art = useCardArt([...favourites.values(), ...(s?.commanders ?? []).map((c) => c.commander), rivalArt(read.beatsMe), rivalArt(read.iBeat)]);
  const artOf = (name: string | null | undefined) => (name ? art.get(name) : undefined);
  // Too few to say (design/tokens.md): players under 10 games, commanders under 5, or the server's
  // provisional floor if that's higher.
  const under = Math.max(10, s?.provisional_under ?? 0);
  const commanderFloor = Math.max(5, s?.provisional_under ?? 0);
  // The first game the list goes back to, when it holds every game (the server sends up to 200).
  const first = games.data && games.data.length < 200 ? games.data.filter((g) => g.status === "finished").at(-1)?.started_at : undefined;
  const since = first ? fmtMonth(first) : null;
  const credited = [
    ...[...favourites.values()].map(artOf),
    ...(s?.commanders ?? []).map((c) => artOf(c.commander)),
    artOf(rivalArt(read.beatsMe)),
    artOf(rivalArt(read.iBeat)),
  ].filter((a) => !!a);
  const share = async () => {
    const text = `Join ${group.name} on Yama with the code ${group.join_code}.`;
    try {
      if ("share" in navigator) await navigator.share({ title: group.name, text });
      else {
        await (navigator as Navigator).clipboard.writeText(group.join_code);
        setShared(true);
      }
    } catch {
      /* the share sheet was closed */
    }
  };

  return (
    <>
      <div className="grp-head">
        <div className="grp-title">
          <div className="grp-name">
            <h1>{group.name}</h1>
            {switcher}
          </div>
          {s && s.games > 0 && (
            <div className="grp-figures">
              <span className="grp-figure"><b className="num">{s.games}</b><span>{since ? <><span className="grp-wide">games since {since}</span><span className="grp-narrow">games</span></> : "games"}</span></span>
              {s.average_turns && (
                <span className="grp-figure" title={`From ${s.average_turns.games} games`}>
                  <b className="num">{s.average_turns.value.toFixed(1)}</b>
                  <span><span className="grp-wide">turns on average</span><span className="grp-narrow">turns, average</span></span>
                </span>
              )}
              {s.average_minutes && (
                <span className="grp-figure" title={`From ${s.average_minutes.games} timed games`}>
                  <b className="num">{Math.round(s.average_minutes.value)}</b>
                  <span><span className="grp-wide">minutes on average</span><span className="grp-narrow">minutes, average</span></span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="grp-code">
          <span className="grp-code-text">
            <span>Join code</span>
            <b>{group.join_code}</b>
          </span>
          <button onClick={() => void share()}>{shared ? "Copied" : "Share"}</button>
        </div>
      </div>

      <ErrorText error={stats.error ?? games.error} />
      {s && s.games === 0 && <p className="dim">No finished games yet.</p>}
      {s && s.games > 0 && (
        <>
          <section className="grp-section" aria-labelledby="grp-players">
            <div className="grp-section-head">
              <h2 id="grp-players">Players</h2>
              <span className="grp-wide grp-hint">The line marks an even share: 25% at a 4-player table. Fewer than {under} games is too few to say.</span>
            </div>
            <ul className="grp-players">
              {s.players.map((p) => {
                const fav = favourites.get(p.key) ?? null;
                const a = artOf(fav);
                const few = p.games < under;
                const rate = p.games ? p.wins / p.games : 0;
                const guest = !p.member_id || !group.members.find((m) => m.id === p.member_id)?.user_id;
                const record = `${p.games} ${p.games === 1 ? "game" : "games"}, ${p.wins} ${p.wins === 1 ? "win" : "wins"}${p.draws ? `, ${p.draws} ${p.draws === 1 ? "draw" : "draws"}` : ""}`;
                const bar = (
                  <span className="grp-bar" role="img" aria-label={`${p.name} wins ${percent(rate)} of ${p.games} games; an even share is ${percent(p.expected)}`}>
                    <span className="grp-bar-fill" style={{ width: `${Math.min(100, (rate / 0.6) * 100)}%` }} />
                    <span className="grp-bar-even" style={{ left: `${Math.min(100, (p.expected / 0.6) * 100)}%` }} />
                  </span>
                );
                return (
                  <li key={p.key} className={`grp-player${few ? " few" : ""}`}>
                    <ArtPanel className="grp-player-art" art={a?.art} artist={a?.artist} wash="bottom" credit={false}>
                      <span className="grp-player-name">{p.name}</span>
                      <span className="grp-player-rate num">{few ? "Too few" : percent(rate)}</span>
                    </ArtPanel>
                    {/* Phones: the art as a circle beside the name. */}
                    <span className="grp-player-dot">{a?.art && <img src={a.art} alt="" />}</span>
                    <div className="grp-player-body">
                      <span className="grp-player-top">
                        <b>{p.name}{guest ? <span className="grp-narrow">, guest</span> : null}</b>
                        <span>{p.games} {p.games === 1 ? "game" : "games"}</span>
                      </span>
                      {bar}
                      <span className="grp-player-meta">
                        <span>{record}</span>
                        <span className="grp-fav">{fav ? `Mostly ${shortName(fav)}` : guest ? "Guest" : ""}</span>
                      </span>
                      {p.streak && <span className="grp-streak">{streakText(p.streak)}</span>}
                    </div>
                    <span className="grp-player-rate-narrow num">{few ? "Few" : percent(rate)}</span>
                  </li>
                );
              })}
            </ul>
            <p className="grp-narrow grp-hint">The line marks 25%. Under {under} games is too few to say.</p>
          </section>

          <div className="grp-pair">
            <section className="grp-section grp-commanders" aria-labelledby="grp-cmdrs">
              <h2 id="grp-cmdrs">Commanders</h2>
              <table className="grp-table">
                <thead>
                  <tr>
                    <th>Commander</th>
                    <th className="r">Games</th>
                    <th className="r">Wins</th>
                    <th className="r">Even share</th>
                    <th className="r">Win rate</th>
                  </tr>
                </thead>
                <tbody>
                  {s.commanders.map((c) => {
                    const a = artOf(c.commander);
                    const few = c.games < commanderFloor;
                    const who = listNames(read.players(c.commander));
                    return (
                      <tr key={c.commander} className={few ? "few" : undefined}>
                        <td>
                          <span className="grp-cmdr">
                            <span className="grp-cmdr-art">{a?.art && <img src={a.art} alt="" loading="lazy" />}</span>
                            <span className="grp-cmdr-text">
                              <b>{c.commander}</b>
                              <span>
                                {who}
                                {/* The count stays together: "7" and "games" split across lines. */}
                                <span className="grp-narrow">{who ? ", " : ""}<span style={{ whiteSpace: "nowrap" }}>{c.games} {c.games === 1 ? "game" : "games"}</span></span>
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="r num">{c.games}</td>
                        <td className="r num">{c.wins}</td>
                        <td className="r num">{percent(c.expected)}</td>
                        <td className="r num grp-cmdr-rate">{few ? "Too few" : percent(c.wins / c.games)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="grp-section grp-rivals" aria-labelledby="grp-rivals">
              <h2 id="grp-rivals">Your rivalries</h2>
              {read.beatsMe || read.iBeat ? (
                <div className="grp-rival-list">
                  {read.beatsMe && (
                    <div className="grp-rival">
                      <span className="grp-rival-art">{artOf(rivalArt(read.beatsMe))?.art && <img src={artOf(rivalArt(read.beatsMe))!.art!} alt="" />}</span>
                      <span className="grp-rival-text">
                        <b>{read.beatsMe.name} beats you most</b>
                        <span>
                          {read.beatsMe.name} won {read.beatsMe.theirs} of the {read.beatsMe.shared} games you both played. You won {read.beatsMe.mine}.
                        </span>
                      </span>
                    </div>
                  )}
                  {read.iBeat && (
                    <div className="grp-rival">
                      <span className="grp-rival-art">{artOf(rivalArt(read.iBeat))?.art && <img src={artOf(rivalArt(read.iBeat))!.art!} alt="" />}</span>
                      <span className="grp-rival-text">
                        <b>You beat {read.iBeat.name} most</b>
                        <span>
                          You won {read.iBeat.mine} of {read.iBeat.shared} shared games. {read.iBeat.name} won {read.iBeat.theirs}.
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="dim">{myKey ? "No rivalry edge yet." : "Join a game to see your rivalries."}</p>
              )}
              {games.data && games.data.length >= 200 && <p className="small dim">From the group's last 200 games.</p>}
            </section>
          </div>
          {credited.length > 0 && <p className="small dim grp-credit">{artCredits(credited.map((c) => c!.artist))}</p>}
          <GroupStats s={s} />
        </>
      )}
    </>
  );
}

/** Game history as JSON (one record per game) or CSV, one row per seat. */
function ExportGames({ group }: { group?: Playgroup }) {
  // The browser's time zone, so each game's date is the local day it was played, with daylight
  // saving as it was that day. The offset is the fallback if the server doesn't know the zone.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();
  const link = (ext: "json" | "csv", playgroup?: string) =>
    exportLink(`/api/games/export.${ext}?offset=${offset}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}${playgroup ? `&playgroup=${encodeURIComponent(playgroup)}` : ""}`, `yama-games.${ext}`);
  return (
    <section className="stack" style={{ marginBottom: "2.5rem", gap: "0.6rem" }}>
      <div className="help-heading">
        <h2 style={{ margin: 0 }}>Export games</h2>
        <HelpPopover label="Export contents and formats">
          <p>Finished games with seats, players, deck versions, who went first, the winner and how, knockouts and fun ratings.</p>
          <p>The JSON has one record per game with its seats; the CSV has one row per seat.</p>
        </HelpPopover>
      </div>
      {/* One grid for both rows, so the JSON and CSV buttons line up in columns. */}
      <div className="grp-export">
        {group && (
          <>
            <span>{group.name}</span>
            <a className="button" {...link("json", group.id)} download>JSON</a>
            <a className="button" {...link("csv", group.id)} download>CSV</a>
          </>
        )}
        <span>Every game you played or recorded</span>
        <a className="button" {...link("json")} download>JSON</a>
        <a className="button" {...link("csv")} download>CSV</a>
      </div>
    </section>
  );
}

function GroupActions() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: ["playgroups"] });
  const create = useMutation({ mutationFn: () => api("/api/playgroups", { method: "POST", json: { name } }), onSuccess: () => { setName(""); done(); } });
  const join = useMutation({ mutationFn: () => api("/api/playgroups/join", { method: "POST", json: { code } }), onSuccess: () => { setCode(""); done(); } });
  return (
    <section className="stack" style={{ marginBottom: "2.5rem" }}>
      <h2>Start or join a playgroup</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Playgroup name" maxLength={60} required style={{ flex: "1 1 12rem" }} />
        <button disabled={create.isPending}>Start playgroup</button>
      </form>
      <form className="row" onSubmit={(e) => { e.preventDefault(); join.mutate(); }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Join code" required style={{ flex: "1 1 12rem" }} autoCapitalize="characters" />
        <button disabled={join.isPending}>Join</button>
      </form>
      <ErrorText error={create.error ?? join.error} />
    </section>
  );
}
