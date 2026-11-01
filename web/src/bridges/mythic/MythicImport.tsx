import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Playgroup } from "../../api";
import { useMe } from "../../auth";
import { Details, ErrorText } from "../../components/ui";
import { applyLabel, initialMatches, parseExport, resultText, statusText, useMythicBridge, type MythicApplied, type MythicExport, type MythicGameRow, type MythicPreview } from "./mythic";
import { MYTHIC_SNIPPET } from "./snippet";
import "./mythic.css";

/**
 * Import games from Mythic Tools (ARCHITECTURE.md, "Mythic Tools bridge"): save them on
 * mythic.tools with the snippet, upload the file, check the preview, Apply.
 */
export function MythicImportPage() {
  const enabled = useMythicBridge();
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: () => api<Playgroup[]>("/api/playgroups") });
  const [file, setFile] = useState<{ name: string; data: MythicExport } | null>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [players, setPlayers] = useState<Record<string, string | null>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // A match to a Yama game depends on who's who: changing that drops the matches chosen so far,
  // which the next preview may no longer offer.
  const dropMatches = () => setChoices((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => !v.startsWith("link:"))));
  const group = groups.data?.find((g) => g.id === (groupId ?? groups.data?.[0]?.id)) ?? null;
  const playgroupId = groupId === "" ? null : (group?.id ?? null);

  const request = file && { export: file.data, playgroup_id: playgroupId, me, players: playgroupId ? players : {}, choices };
  const preview = useQuery({
    queryKey: ["mythic-preview", file?.name, playgroupId, me, players, choices],
    queryFn: () => api<MythicPreview>("/api/bridges/mythic/games/preview", { method: "POST", json: request }),
    enabled: !!request,
    retry: false,
  });
  const p = preview.data;
  // The players start on their earlier match or a same-name member; the person changes them here.
  useEffect(() => {
    if (p && Object.keys(players).length === 0 && p.players.length > 0) setPlayers(initialMatches(p.players));
    if (p && me === null && p.me) setMe(p.me);
  }, [p]);

  const apply = useMutation({
    mutationFn: () => api<MythicApplied>("/api/bridges/mythic/games/apply", { method: "POST", json: request }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mythic-preview"] });
      void qc.invalidateQueries({ queryKey: ["games"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  const choose = async (f: File | undefined) => {
    setFileError(null);
    apply.reset();
    if (!f) return;
    try {
      setFile({ name: `${f.name}:${f.lastModified}`, data: parseExport(await f.text()) });
      setPlayers({});
      setChoices({});
      setMe(null);
    } catch (e) {
      setFile(null);
      setFileError(e);
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(MYTHIC_SNIPPET);
    setCopied(true);
  };
  const others = p?.players.filter((x) => x.mythic_id !== me) ?? [];
  const members = group?.members ?? [];
  const account = useMe().data;
  // A member sits at one seat: yours is you, and one matched to a player isn't offered for another.
  const taken = (player: string, member: { id: string; user_id: string | null }) =>
    (!!account && member.user_id === account.id) || others.some((o) => o.mythic_id !== player && players[o.mythic_id] === member.id);

  return (
    <main className="page stack mythic-import">
      <p><Link to="/group">Playgroup</Link></p>
      <h1>Import from Mythic Tools</h1>
      {!enabled ? (
        <p className="dim">The Mythic Tools import isn't switched on for this server.</p>
      ) : (
        <>
          <p>
            Bring the games your playgroup logged in Mythic Tools into Yama. Mythic has no export for games, so you save them on mythic.tools in your own browser and upload the file here; Yama never sees your Mythic sign-in. Mythic's app can change without notice, so this may stop working.
          </p>

          <section className="stack" aria-labelledby="mythic-save">
            <h2 id="mythic-save">1. Save your games on Mythic Tools</h2>
            <ol>
              <li>Open <a href="https://mythic.tools" target="_blank" rel="noreferrer">mythic.tools</a> in this browser on a computer and sign in.</li>
              <li>Open the browser's console there: Ctrl+Shift+J, or Cmd+Option+J on a Mac.</li>
              <li>Paste the snippet and press Enter. It reads your games and saves a mythic-games file. It doesn't change anything in Mythic.</li>
            </ol>
            <div className="row">
              <button onClick={() => void copy()}>{copied ? "Copied" : "Copy the snippet"}</button>
            </div>
            <Details label="What the snippet does">
              <p>It reads Mythic's web settings and your sign-in from the mythic.tools page, asks Mythic for each of your games and the names of the commanders in them, and saves them as a file. Nothing is sent anywhere else.</p>
              <pre className="mythic-snippet small">{MYTHIC_SNIPPET}</pre>
            </Details>
          </section>

          <section className="stack" aria-labelledby="mythic-upload">
            <h2 id="mythic-upload">2. Upload the file</h2>
            <div className="row">
              <label>
                <span className="visually-hidden">Mythic games file</span>
                <input type="file" accept="application/json,.json" onChange={(e) => void choose(e.target.files?.[0])} />
              </label>
              <label>
                Playgroup{" "}
                <select value={groupId ?? group?.id ?? ""} onChange={(e) => { setGroupId(e.target.value); setPlayers({}); dropMatches(); }}>
                  {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  <option value="">No playgroup</option>
                </select>
              </label>
            </div>
            <ErrorText error={fileError ?? groups.error} />
          </section>

          {file && (
            <section className="stack" aria-labelledby="mythic-check">
              <h2 id="mythic-check">3. Check and import</h2>
              <ErrorText error={preview.error} />
              {preview.isLoading && <p className="dim">Reading the file…</p>}
              {p && (
                <>
                  {p.players.length > 0 && (
                    <div className="stack">
                      <label>
                        Which player are you in Mythic?{" "}
                        <select value={me ?? ""} onChange={(e) => { setMe(e.target.value); dropMatches(); }}>
                          {!me && <option value="">Choose</option>}
                          {p.players.map((x) => <option key={x.mythic_id} value={x.mythic_id}>{x.name}</option>)}
                        </select>
                      </label>
                      {playgroupId && others.length > 0 && (
                        <table className="mythic-players">
                          <thead>
                            <tr><th scope="col">In Mythic</th><th scope="col">In {group?.name}</th></tr>
                          </thead>
                          <tbody>
                            {others.map((x) => (
                              <tr key={x.mythic_id}>
                                <td>{x.name} <span className="dim small">{x.games} {x.games === 1 ? "game" : "games"}</span></td>
                                <td>
                                  <select value={players[x.mythic_id] ?? ""} aria-label={`${x.name} in ${group?.name}`} onChange={(e) => { setPlayers((m) => ({ ...m, [x.mythic_id]: e.target.value || null })); dropMatches(); }}>
                                    <option value="">Keep the name {x.name}</option>
                                    {members.map((m) => <option key={m.id} value={m.id} disabled={taken(x.mythic_id, m)}>{m.display_name}</option>)}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  <ul className="mythic-games">
                    {p.games.map((g) => <GameLine key={g.mythic_id} g={g} choice={choices[g.mythic_id]} onChoose={(c) => setChoices((m) => ({ ...m, [g.mythic_id]: c }))} />)}
                  </ul>
                  <div className="row">
                    <button disabled={apply.isPending || preview.isFetching || p.games.every((g) => g.action === "skip")} onClick={() => apply.mutate()}>
                      {applyLabel(p.games)}
                    </button>
                  </div>
                  <ErrorText error={apply.error} />
                  {apply.data && (
                    <div className="stack">
                      <p>{resultText(apply.data)}</p>
                      {apply.data.errors.map((e) => <p key={e.mythic_id} className="error">Mythic game {e.mythic_id}: {e.error}</p>)}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function GameLine({ g, choice, onChoose }: { g: MythicGameRow; choice: string | undefined; onChoose: (c: string) => void }) {
  const day = g.started_at ? new Date(g.started_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "No date";
  const seats = g.seats.map((s) => `${s.name}${s.commander ? ` (${s.commander})` : s.deck ? ` (${s.deck})` : ""}${s.won ? ", won" : ""}`).join("; ");
  const canChoose = g.status === "match";
  if (g.status === "conflict") {
    return (
      <li className="stack" style={{ gap: "0.25rem" }}>
        <span>
          <b>{day}</b> <span className="dim">{statusText(g)}</span>
        </span>
        {seats && <span className="small">Mythic now: {seats}</span>}
        {g.yama_id && <Link className="small" to={`/table/games/${g.yama_id}`}>Open the Yama version</Link>}
        <label className="small">
          <span className="visually-hidden">Which version to keep</span>
          <select value={choice ?? "skip"} onChange={(e) => onChoose(e.target.value)}>
            <option value="skip">Decide later</option>
            <option value="keep">Keep the Yama version</option>
            <option value="update">Replace it with Mythic's version</option>
          </select>
        </label>
      </li>
    );
  }
  return (
    <li className="stack" style={{ gap: "0.25rem" }}>
      <span>
        <b>{day}</b> <span className="dim">{statusText(g)}</span>
      </span>
      {seats && <span className="small">{seats}</span>}
      {g.yama_id && g.action !== "create" && g.status !== "deleted" && <Link className="small" to={`/table/games/${g.yama_id}`}>Open in Yama</Link>}
      {canChoose && (
        <label className="small">
          <span className="visually-hidden">What to do with this game</span>
          <select value={choice ?? "skip"} onChange={(e) => onChoose(e.target.value)}>
            <option value="skip">Skip it for now</option>
            {g.matches.map((m) => (
              <option key={m.id} value={`link:${m.id}`}>
                It's the game on {new Date(m.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} already in Yama, with {m.players.join(", ") || `${m.seats} players`}
              </option>
            ))}
            <option value="import">Import it as its own game</option>
          </select>
        </label>
      )}
    </li>
  );
}

/** Mythic's note and tags for a game the person imported, shown to them alone. */
export function MythicNote({ gameId }: { gameId: string }) {
  const enabled = useMythicBridge();
  const note = useQuery({
    queryKey: ["mythic-note", gameId],
    queryFn: () => api<{ note: string | null; tags: unknown }>(`/api/bridges/mythic/games/${gameId}/note`),
    enabled,
    retry: false,
  });
  const tags = Array.isArray(note.data?.tags) ? (note.data.tags as unknown[]).map((t) => (typeof t === "string" ? t : (t as { name?: string })?.name)).filter(Boolean) : [];
  if (!note.data || (!note.data.note && tags.length === 0)) return null;
  return (
    <p className="small dim">
      From Mythic Tools, only you see this: {note.data.note}
      {tags.length > 0 && ` Tags: ${tags.join(", ")}.`}
    </p>
  );
}

/** The Playgroup page's way in, when the bridge is on. */
export function MythicImportEntry() {
  const enabled = useMythicBridge();
  if (!enabled) return null;
  return (
    <section className="stack" style={{ marginBottom: "2.5rem", gap: "0.6rem" }}>
      <h2 style={{ margin: 0 }}>Import from Mythic Tools</h2>
      <p className="dim" style={{ margin: 0 }}>Bring in games your group logged in Mythic Tools.</p>
      <div className="row">
        <Link className="button" to="/group/mythic">Import games</Link>
      </div>
    </section>
  );
}
