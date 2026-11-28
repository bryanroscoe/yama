import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, ApiError, API_BASE, errorMessage, type GameRow, type PlaygroupStats, type Playgroup } from "../api";
import { useAdvanced, useMe } from "../auth";
import { Button, ButtonLink, CardThumb, ErrorText, Field } from "../components/ui";
import { ShowMore } from "../components/Pager";
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
import { foldCommanders, playerKeys, readGames, type Rival } from "./groupGames";
import { BugButton } from "../bugs/BugButton";

export function GroupPage() {
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: ({ signal }) => api<Playgroup[]>("/api/playgroups", { signal }) });
  const [selected, setSelected] = useState<string | null>(null);
  const group = groups.data?.find((g) => g.id === selected) ?? groups.data?.[0];
  const advanced = useAdvanced();
  const none = groups.data?.length === 0;
  // Export is offered once there is a game to export: one of yours, or one of this playgroup's
  // (the same lists the life counter and the stats below read).
  const myGames = useQuery({ queryKey: ["games"], queryFn: ({ signal }) => api<GameRow[]>("/api/games", { signal }), enabled: !groups.isPending });
  const groupGames = useQuery({ queryKey: ["games", "group", group?.id], queryFn: ({ signal }) => api<GameRow[]>(`/api/games?playgroup=${group!.id}`, { signal }), enabled: !!group });

  return (
    <main className="page group-page">
      <Link to="/table/games">Game history</Link>
      <ErrorText error={groups.error} />
      {none && (
        <>
          <div className="head-with-bug"><h1>Playgroup</h1><BugButton /></div>
          <p className="grp-intro">A playgroup keeps your table's games and stats together. Start one and share its code, or enter a friend's code.</p>
          <GroupActions />
        </>
      )}
      {group && (
        <GroupDetail
          key={group.id}
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
        {/* Beside the members; with no playgroup the page is only about starting or joining one. */}
        {!none && <section className="grp-section" id="sharing"><h2>You</h2><ButtonLink variant="outline" to="/profile">Your profile and account</ButtonLink></section>}
      </div>
      {(!!myGames.data?.length || !!groupGames.data?.length) && <ExportGames group={group} />}
      {/* Mythic Tools is a Workshop page: offered here only with Advanced on. */}
      {advanced && <MythicImportEntry />}
      {/* With no playgroup, starting or joining one sits at the top instead. While the list is
          still loading the form is in neither place, so it can't move under someone typing; a
          list that never loaded gets it here. A failed refresh keeps the list it had. */}
      {(groups.data ? groups.data.length > 0 : groups.isError) && <GroupActions />}
    </main>
  );
}

/** "Terra" from "Terra, Herald of Hope". */
const shortName = (name: string) => name.split(",")[0]!.trim();
const listNames = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function GroupDetail({ group, switcher }: { group: Playgroup; switcher: ReactNode }) {
  const me = useMe().data;
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const stats = useQuery({ queryKey: ["stats", group.id, playerCount], queryFn: ({ signal }) => api<PlaygroupStats>(`/api/playgroups/${group.id}/stats${playerCount === null ? "" : `?player_count=${playerCount}`}`, { signal }) });
  const games = useQuery({ queryKey: ["games", "group", group.id], queryFn: ({ signal }) => api<GameRow[]>(`/api/games?playgroup=${group.id}`, { signal }) });
  const [shared, setShared] = useState(false);
  const s = stats.data;
  const keys = playerKeys(group.members);
  const myKey = keys.account(me?.id);
  const sizedGames = (games.data ?? []).filter((g) => playerCount === null || g.seats.length === playerCount);
  const read = readGames(sizedGames, myKey, keys.seat);
  const playerKey = keys.player;
  const favourites = new Map((s?.players ?? []).map((p) => [p.key, read.favourite(playerKey(p))]));
  const rivalArt = (r?: Rival) => (r ? read.favourite(r.key) : null);
  // Too few to say (design/tokens.md): players under 10 games, commanders under 5, or the server's
  // provisional floor if that's higher.
  const under = Math.max(10, s?.provisional_under ?? 0);
  const commanderFloor = Math.max(5, s?.provisional_under ?? 0);
  // Commanders with enough games to have a win rate come first; the rest ("Too few") wait behind
  // a button, so two dozen rows that say nothing don't sit above the rest of the page. A group
  // where none has enough yet shows its first few.
  const [allCommanders, setAllCommanders] = useState(false);
  const { shown: commanders, more: moreCommanders, enough: enoughCommanders } = foldCommanders(s?.commanders ?? [], commanderFloor, allCommanders);
  // Art for what the page shows: the commanders behind the fold are looked up when it opens.
  const art = useCardArt([...favourites.values(), ...commanders.map((c) => c.commander), rivalArt(read.beatsMe), rivalArt(read.iBeat)]);
  const artOf = (name: string | null | undefined) => (name ? art.get(name) : undefined);
  // The first game the list goes back to, when it holds every game (the server sends up to 200).
  const first = games.data && games.data.length < 200 ? sizedGames.filter((g) => g.status === "finished").at(-1)?.started_at : undefined;
  const since = first ? fmtMonth(first) : null;
  const credited = [
    ...[...favourites.values()].map(artOf),
    ...commanders.map((c) => artOf(c.commander)),
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
            <BugButton className="head-bug" />
          </div>
          {s && s.games > 0 && (
            <div className="grp-figures">
              <span className="grp-figure"><b className="num">{s.games}</b><span>{since ? <><span className="grp-wide">games since {since}</span><span className="grp-narrow">games</span></> : "games"}</span></span>
              {s.average_turns && (
                <span className="grp-figure" title={`From ${s.average_turns.games} games at the table or logged afterwards`}>
                  <b className="num">{s.average_turns.value.toFixed(1)}</b>
                  <span><span className="grp-wide">turns on average</span><span className="grp-narrow">turns, average</span></span>
                </span>
              )}
              {/* Online games count every player's turn, so they aren't averaged with the table's rounds. */}
              {s.average_online_turns && (
                <span className="grp-figure" title={`From ${s.average_online_turns.games} online games, counting every player's turn`}>
                  <b className="num">{s.average_online_turns.value.toFixed(1)}</b>
                  <span><span className="grp-wide">player turns on average online</span><span className="grp-narrow">player turns, online</span></span>
                </span>
              )}
              {/* The median, not the mean (stats.rs): a game left open overnight would count as a day long. */}
              {s.average_minutes && (
                <span className="grp-figure" title={`The middle length of ${s.average_minutes.games} timed ${s.average_minutes.games === 1 ? "game" : "games"}`}>
                  <b className="num">{Math.round(s.average_minutes.value)}</b>
                  <span><span className="grp-wide">minutes for a typical game</span><span className="grp-narrow">minutes, typical</span></span>
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
          <Button onClick={() => void share()}>{shared ? "Copied" : "Share"}</Button>
        </div>
      </div>

      <Field label="Players per game">
        <select value={playerCount ?? "all"} onChange={(e) => { setPlayerCount(e.target.value === "all" ? null : Number(e.target.value)); setAllCommanders(false); }}>
          <option value="all">All table sizes</option>
          {(s?.player_counts ?? (playerCount === null ? [] : [{ players: playerCount, games: 0 }])).map((size) => (
            <option key={size.players} value={size.players}>{size.players} players ({size.games} {size.games === 1 ? "game" : "games"})</option>
          ))}
        </select>
      </Field>
      <p className="small dim">All stats below use this table size, including computer seats.</p>
      <ErrorText error={stats.error ?? games.error} />
      {s && s.games === 0 && <p className="dim">{playerCount === null ? "No finished games yet." : `No finished ${playerCount}-player games yet.`}</p>}
      {s && s.games > 0 && (
        <>
          <section className="grp-section" aria-labelledby="grp-players">
            <div className="grp-section-head">
              <h2 id="grp-players">Players</h2>
              <span className="grp-wide grp-hint">The line marks an even share: 25% at a 4-player table. Fewer than {under} games is too few to say. The computer isn't listed, and a game it wins is a loss for everyone.</span>
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
                    <span className="grp-player-dot">{a?.art && <CardThumb src={a.art} eager />}</span>
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
            <p className="grp-narrow grp-hint">The line marks an even share. Under {under} games is too few to say. The computer isn't listed.</p>
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
                  {commanders.map((c) => {
                    const a = artOf(c.commander);
                    const few = c.games < commanderFloor;
                    const who = listNames(read.players(c.commander));
                    return (
                      <tr key={c.commander} className={few ? "few" : undefined}>
                        <td>
                          <span className="grp-cmdr">
                            <span className="grp-cmdr-art">{a?.art && <CardThumb src={a.art} />}</span>
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
              {moreCommanders > 0 && (
                <p className="grp-more">
                  {enoughCommanders && !allCommanders && <span>{moreCommanders} more with fewer than {commanderFloor} games.</span>}
                  <ShowMore total={s.commanders.length} noun="commanders" expanded={allCommanders} onToggle={() => setAllCommanders((v) => !v)} />
                </p>
              )}
            </section>

            <section className="grp-section grp-rivals" aria-labelledby="grp-rivals">
              <h2 id="grp-rivals">Your rivalries</h2>
              {read.beatsMe || read.iBeat ? (
                <div className="grp-rival-list">
                  {read.beatsMe && (
                    <div className="grp-rival">
                      <span className="grp-rival-art">{artOf(rivalArt(read.beatsMe))?.art && <CardThumb src={artOf(rivalArt(read.beatsMe))!.art!} eager />}</span>
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
                      <span className="grp-rival-art">{artOf(rivalArt(read.iBeat))?.art && <CardThumb src={artOf(rivalArt(read.iBeat))!.art!} eager />}</span>
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
            <ButtonLink {...link("json", group.id)} download>JSON</ButtonLink>
            <ButtonLink {...link("csv", group.id)} download>CSV</ButtonLink>
          </>
        )}
        <span>Every game you played or recorded</span>
        <ButtonLink {...link("json")} download>JSON</ButtonLink>
        <ButtonLink {...link("csv")} download>CSV</ButtonLink>
      </div>
    </section>
  );
}

/** Start a playgroup by naming it, or join one with a friend's code: each with its own label and its own error. */
function GroupActions() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  // The field left empty when its button was pressed: said under it, instead of nothing happening.
  const [blank, setBlank] = useState<"name" | "code" | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ["playgroups"] });
  const create = useMutation({ mutationFn: () => api("/api/playgroups", { method: "POST", json: { name } }), onSuccess: () => { setName(""); done(); } });
  const join = useMutation({ mutationFn: () => api("/api/playgroups/join", { method: "POST", json: { code } }), onSuccess: () => { setCode(""); done(); } });
  const start = () => {
    join.reset();
    if (!name.trim()) return setBlank("name");
    setBlank(null);
    create.mutate();
  };
  const enter = () => {
    create.reset();
    if (!code.trim()) return setBlank("code");
    setBlank(null);
    join.mutate();
  };
  const nameError = blank === "name" ? "Give the playgroup a name first." : create.error ? errorMessage(create.error) : null;
  // The server's own words for a code nobody has are "playgroup with that code not found".
  const codeError =
    blank === "code"
      ? "Enter the code a friend shared."
      : join.error instanceof ApiError && join.error.status === 404
        ? "No playgroup has that code. Check it with whoever shared it."
        : join.error
          ? errorMessage(join.error)
          : null;
  return (
    <section className="stack grp-start">
      <h2>Start or join a playgroup</h2>
      <form className="grp-guest" noValidate onSubmit={(e) => { e.preventDefault(); start(); }}>
        <Field label="Name a new playgroup">
          <input value={name} onChange={(e) => { setName(e.target.value); if (blank === "name") setBlank(null); }} placeholder="Thursday night" maxLength={60} aria-invalid={nameError ? true : undefined} />
        </Field>
        <Button type="submit" disabled={create.isPending}>Start playgroup</Button>
        <ErrorText small error={nameError} />
      </form>
      <form className="grp-guest" noValidate onSubmit={(e) => { e.preventDefault(); enter(); }}>
        <Field label="Code a friend shared">
          <input value={code} onChange={(e) => { setCode(e.target.value); if (blank === "code") setBlank(null); }} placeholder="ABC234" autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-invalid={codeError ? true : undefined} />
        </Field>
        <Button type="submit" disabled={join.isPending}>Join</Button>
        <ErrorText small error={codeError} />
      </form>
    </section>
  );
}
