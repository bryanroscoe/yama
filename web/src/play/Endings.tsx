// Knockouts and the end of a game (design/screens/GKnockout, GRareRules' "You're out" and "Drawn
// game", GGameOver and GGameOverPhone; the review's build plan section 11).
//
// The engine says who is out but not why, so a cause Yama read from the board (commander damage,
// poison, life, an empty library) carries a label saying so. The game-over numbers are the
// engine's events counted (play/src/feed.rs); group stats are read-only, chosen when the game was
// made.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { GAME_WORDS, NOTE_MAX, WIN_CONDITIONS, winConditionLabel, wonText, type WinCondition } from "@yama/core";
import { api } from "../api";
import { useMe } from "../auth";
import { usePlayerId } from "../guestPlay";
import { ask } from "../components/confirm";
import { FunPicker, WinConditionPicker } from "../components/GameCapture";
import { serialQueue } from "./saveQueue";
import { INFERRED, lastOut, list, outText, standings, whyText, type Names } from "./feed";
import type { OnlineGame, Out, SeatInfo, Stats, View } from "./types";
import { ErrorText } from "../components/ui";

type Art = (seat: number) => { art: string | null; artist: string | null };
/** What a player has answered on the game-over screen; a key left out hasn't been answered here. */
type Answers = { how?: WinCondition | null; fun?: number | null };
type Tone = (seat: number) => string | undefined;

const seatStyle = (tone: string | undefined) => (tone ? ({ ["--seat" as string]: `var(--${tone})` } as React.CSSProperties) : undefined);

/** A cause in sentence case, for a line of its own: "21 commander damage from your Éowyn." */
const sentence = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}.` : "");

/**
 * Players knocked out, as one-line strips across the top in the order they went out, so the order
 * is never lost (GKnockout). The players still in widen to fill the room.
 */
export function OutStrips({ outs, except, names, art, tone, label }: { outs: Out[]; except: number; names: Names; art: Art; tone: Tone; label: (seat: number) => string }) {
  // The seat at the bottom of the board has its own place there.
  const shown = outs.filter((o) => o.seat !== except);
  if (!shown.length) return null;
  return (
    <div className="pb-outs" aria-label="Knocked out">
      {shown.map((o) => {
        const a = art(o.seat);
        return (
          <article key={o.seat} className="out-strip" style={seatStyle(tone(o.seat))} aria-label={`${label(o.seat)}, out`}>
            {a.art && <img src={a.art} alt="" />}
            <span className="out-wash" aria-hidden="true" />
            <span className="out-body">
              <span className="seat-ring" aria-hidden="true" />
              <b>{label(o.seat)}</b>
              <span className="out-how">{outText(o, names)}</span>
              {o.inferred && <span className="out-inferred">{INFERRED}</span>}
              <span className="out-side">
                Final life {o.life}
                {a.art && a.artist ? `. Art: ${a.artist}` : ""}
              </span>
            </span>
          </article>
        );
      })}
    </div>
  );
}

/** The moment another player goes out (GKnockout's status card). It stays until dismissed. */
export function KnockoutNote({ out, view, names, art, onClose }: { out: Out; view: View; names: Names; art: Art; onClose: () => void }) {
  const left = view.players.filter((p) => !p.eliminated).length;
  const a = art(out.seat);
  const cause = whyText(out.why, names);
  return (
    <div className="ko-note" role="status">
      <span className="ko-art">{a.art ? <img src={a.art} alt="" /> : null}</span>
      <span className="ko-text">
        <b>{out.why.kind === "conceded" ? `${names.Who(out.seat)} conceded` : `${names.Who(out.seat)} is out`}</b>
        {out.why.kind !== "conceded" && cause && <span>{sentence(cause)}</span>}
        {out.inferred && <span className="dim small">{INFERRED}.</span>}
        <span className="dim small">
          Everything they owned has left the game. {left === 1 ? "One player left." : `${left} players left.`}
        </span>
        {a.art && a.artist && <span className="ko-art-credit">Art: {a.artist}, © Wizards of the Coast</span>}
      </span>
      <button type="button" className="gi-close" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}

/**
 * You're out, and the game goes on (GRareRules, "You're out"): watch on with every hand hidden, or
 * leave. Leaving doesn't end the game for anyone else. The rail's (or dock's) main button keeps
 * watching and its partner leaves; this panel only says where things stand.
 */
export function YouAreOut({ out, view, names, art, tone, label, wide }: { out: Out | undefined; view: View; names: Names; art: Art; tone: Tone; label: (seat: number) => string; wide: boolean }) {
  const me = names.you ?? 0;
  const a = art(me);
  const rows = standings(view.players, view.outs ?? [], view.winner, view.over, names);
  const conceded = out?.why.kind === "conceded";
  const cause = out && !conceded ? whyText(out.why, names) : "";
  return (
    <div className="ko-overlay">
      <section className={`ko-you${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={conceded ? "You conceded" : "You're out"}>
        <div className="ko-hero">
          {a.art && <img src={a.art} alt="" />}
          <span className="ko-hero-wash" aria-hidden="true" />
          <span className="ko-hero-text">
            <b>{conceded ? "You conceded" : "You're out"}</b>
            <span>
              Turn {out?.turn ?? view.turn}. {cause ? sentence(cause) : ""} Your cards have left the game; the others play on.
            </span>
            {out?.inferred && <span className="ko-inferred">{INFERRED}.</span>}
          </span>
          {a.art && a.artist && <span className="ko-credit">Art: {a.artist}, © Wizards of the Coast</span>}
        </div>
        <ol className="ko-standings">
          {rows.map((r) => (
            <li key={r.seat} style={seatStyle(tone(r.seat))}>
              <b className="num">{r.place}</b>
              <span className="seat-dot" aria-hidden="true" />
              <span>{r.seat === me ? "You" : label(r.seat)}</span>
              <span className="dim">{r.how}</span>
            </li>
          ))}
        </ol>
        <p className="dim small">Keep watching with every hand hidden, or leave. Leaving doesn't end the game for anyone else.</p>
      </section>
    </div>
  );
}

/** "1 h 12" or "38 min" between two timestamps, if both are known. */
export function lengthText(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${min} min`;
}

/**
 * The end of the game (GGameOver): who won, everyone's place and how they went out, the game's
 * numbers, whether it counts toward a group's stats (read-only), and Rematch for the host.
 */
export function GameOver(props: {
  id: string;
  view: View;
  seats: SeatInfo[];
  names: Names;
  art: Art;
  tone: Tone;
  label: (seat: number) => string;
  wide: boolean;
  onLog: () => void;
  onBoard: () => void;
}) {
  const { id, view, seats, names, art, tone, label, wide } = props;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [game, setGame] = useState<OnlineGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What this player has answered on this screen. Until they do, the saved answers show: the
  // engine's reading of how the game was won, and a rating given earlier.
  const [answers, setAnswers] = useState<Answers>({});
  /** The answers Yama has confirmed from this screen (undefined: whatever the game came with). */
  const confirmed = useRef<Answers>({});
  const enqueue = useRef(serialQueue()).current;
  // The host's note: what's typed here, until it's saved (undefined: showing the saved one).
  const [noteDraft, setNoteDraft] = useState<string | undefined>(undefined);
  const [savedNote, setSavedNote] = useState<string | null | undefined>(undefined);
  const [noteSaving, setNoteSaving] = useState(false);
  // The host by account, not by seat: a table whose host chose who goes first is numbered from
  // that player, so the host isn't always seat 1.
  const me = useMe();
  const playerId = usePlayerId();
  const host = !!game && !!playerId && game.host === playerId;
  // The game's record: its group, when it started and ended, and a rematch once the host starts one.
  useEffect(() => {
    let stop = false;
    let t: number | null = null;
    const load = () =>
      api<OnlineGame>(`/api/play/${id}`).then(
        (g) => {
          if (stop) return;
          setGame(g);
          // Found the rematch: nothing more to wait for.
          if (g.rematch && t !== null) window.clearInterval(t);
        },
        () => undefined,
      );
    load();
    // The others look for the host's rematch every 10 seconds while this screen is up.
    if (!host) t = window.setInterval(load, 10_000);
    return () => {
      stop = true;
      if (t !== null) window.clearInterval(t);
    };
  }, [id, host]);
  const outs = view.outs ?? [];
  const rows = standings(view.players, outs, view.winner, !view.abandoned, names).map((r) => view.abandoned ? { ...r, place: "", how: r.out ? r.how : "Game ended" } : r);
  const winner = view.winner;
  const hero = winner === null ? art(rows[0]?.seat ?? 0) : art(winner);
  const title = view.abandoned ? "Game ended" : winner === null ? GAME_WORDS.draw : wonText(winner === names.you ? "You" : names.Who(winner));
  const deck = (seat: number) => seats.find((s) => s.seat === seat)?.commander ?? seats.find((s) => s.seat === seat)?.deck_name ?? null;
  const last = lastOut(outs.filter((o) => o.seat !== winner), names);
  const length = lengthText(game?.started_at, game?.ended_at);
  const stats: Stats | undefined = view.stats;
  const mine = stats?.seats.find((s) => s.seat === (names.you ?? -1));
  const tiles = [
    length ? { v: length, k: "Length" } : null,
    { v: `${stats?.turns ?? view.turn}`, k: "Turns" },
    mine ? (mine.commander_damage > 0 ? { v: `${mine.commander_damage}`, k: "Commander damage you dealt" } : { v: `${mine.damage}`, k: "Damage you dealt" }) : null,
    mine ? { v: `${mine.spells}`, k: "Spells you cast" } : null,
  ].filter((t): t is { v: string; k: string } => !!t);
  const rematch = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api<{ id: string }>(`/api/play/${id}/rematch`, { method: "POST" });
      navigate(`/play/${made.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const join = async () => {
    if (!game?.rematch) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api<{ id: string }>(`/api/play/join`, { method: "POST", json: { code: game.rematch.code, deck_id: game.rematch.deck_id } });
      navigate(`/play/${made.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  // The host may delete a finished game, as whoever recorded a table game may: a test game, or
  // one that shouldn't count.
  const remove = async () => {
    if (!(await ask({ title: "Delete this game from Yama?", body: "It comes out of the history and stats for everyone who played. This can't be undone.", confirm: "Delete game", danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/play/${id}`, { method: "DELETE" });
      for (const key of ["play", "games", "stats", "deck-results"]) void qc.invalidateQueries({ queryKey: [key] });
      navigate("/play", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  // The table's finish sheet questions, for a seated player once the game has a result (GameCapture).
  // Each answer saves as it's given; a refusal puts the answer back as it was.
  const canAnswer = names.you !== null && !view.abandoned && !!game && game.status === "finished";
  const how = answers.how !== undefined ? answers.how : (WIN_CONDITIONS.find((w) => w.key === game?.win_condition)?.key ?? null);
  const fun = answers.fun !== undefined ? answers.fun : (game?.fun ?? null);
  // Saves go one at a time in the order given, so the last answer tapped is the one Yama keeps.
  // A refusal puts back only that question's last saved answer, and only if nothing newer has
  // been given since.
  const answer = <K extends "how" | "fun">(field: K, value: Answers[K]) => {
    setAnswers((a) => ({ ...a, [field]: value }));
    setError(null);
    enqueue(() => api(`/api/play/${id}/result`, { method: "POST", json: field === "how" ? { win_condition: value } : { fun: value } })).then(
      () => {
        confirmed.current = { ...confirmed.current, [field]: value };
        for (const key of ["stats", "games"]) void qc.invalidateQueries({ queryKey: [key] });
      },
      (e: unknown) => {
        setAnswers((a) => (a[field] === value ? { ...a, [field]: confirmed.current[field] } : a));
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  // The game's note, as the table's finish sheet keeps one. The host writes it; everyone reads it.
  const note = savedNote !== undefined ? savedNote : (game?.note ?? null);
  const saveNote = () => {
    if (noteDraft === undefined || noteSaving) return;
    const submitted = noteDraft;
    setNoteSaving(true);
    setError(null);
    enqueue(() => api<{ note: string | null }>(`/api/play/${id}/result`, { method: "POST", json: { note: submitted } }))
      .then(
        (saved) => {
          setSavedNote(saved.note);
          // Anything typed while it was saving stays in the box, still to be saved.
          setNoteDraft((d) => (d === submitted ? undefined : d));
          void qc.invalidateQueries({ queryKey: ["games"] });
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setNoteSaving(false));
  };
  const ai = seats.some((s) => s.ai);
  // A playgroup's stats compare its people: a game one person played against the computer is
  // kept in the group's history and left out of its figures.
  const counted = !view.abandoned && !!game?.playgroup && seats.filter((s) => !s.ai).length >= 2;
  const credits = list([...new Set(rows.map((r) => art(r.seat)).filter((a) => a.art && a.artist).map((a) => a.artist!))]);
  return (
    <div className={`go${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="go-hero">
        {hero.art && <img src={hero.art} alt="" />}
        <span className="go-wash" aria-hidden="true" />
        <div className="go-title">
          <span className="go-meta">
            {wide ? `Commander game, ${view.players.length} players, ended on turn ${view.turn}` : `Turn ${view.turn}${length ? `, ${length}` : ""}`}
          </span>
          <h1>{title}</h1>
          <span>
            {winner === null ? "Nobody won." : deck(winner) ? `With ${deck(winner)}.` : ""}
            {last ? ` Last one out: ${last}.` : ""}
          </span>
        </div>
        {hero.art && hero.artist && <span className="go-credit">Art: {hero.artist}, © Wizards of the Coast</span>}
      </header>
      <div className="go-body">
        <section className="go-standings" aria-label="Standings">
          {wide && <h2>Standings</h2>}
          {rows.map((r) => {
            const a = art(r.seat);
            return (
              <div key={r.seat} className={`go-row${r.place === "1" || r.place === "=1" ? " top" : ""}`} style={seatStyle(tone(r.seat))}>
                <b className="go-place">{r.place}</b>
                {a.art ? <img src={a.art} alt="" /> : <span className="go-blank" />}
                <span className="go-who">
                  <b>
                    <span className="seat-dot" aria-hidden="true" />
                    {r.seat === names.you ? "You" : label(r.seat)}
                  </b>
                  <span className="dim">{wide ? deck(r.seat) ?? "" : r.how}</span>
                </span>
                {wide && <span className={r.how === "Winner" ? "good" : "dim"}>{r.how}</span>}
                <b className="go-life num">{r.life}</b>
                {r.out?.inferred && wide && <span className="go-inferred">{INFERRED}</span>}
              </div>
            );
          })}
          <span className="small dim">
            Last column: life at the end, or when they went out.
            {credits ? ` Commander art: ${credits}, © Wizards of the Coast.` : ""}
          </span>
        </section>
        <aside className="go-side">
          {/* A phone keeps to the design's short page: the turn and length are in the heading. */}
          <div className={`go-tiles${wide ? "" : " small"}`}>
            {tiles.map((t) => (
              <span key={t.k} className="go-tile">
                <b>{t.v}</b>
                <span>{t.k}</span>
              </span>
            ))}
          </div>
          {canAnswer && (
            <section className="capture stack" aria-label="About this game">
              {/* Anyone who played can say how it was won while nothing is recorded. Once the
                  engine or a player has said, the host is the one who can change it. */}
              {winner !== null && (host || !game?.win_condition) && (
                <WinConditionPicker value={how} onChange={(v) => answer("how", v)} winner={winner === names.you ? "you" : names.Who(winner)} />
              )}
              {winner !== null && !host && game?.win_condition && winConditionLabel(game.win_condition) && (
                <p className="small dim">Won by {winConditionLabel(game.win_condition)!.toLowerCase()}. The host can change that.</p>
              )}
              <FunPicker
                seats={[{ seat: names.you!, name: "You" }]}
                value={fun === null ? [] : [{ seat: names.you!, rating: fun }]}
                onChange={(v) => answer("fun", v[0]?.rating ?? null)}
              />
              {host ? (
                <div className="question">
                  <p>Notes <span className="optional">(optional)</span></p>
                  <textarea
                    className="capture-note"
                    rows={2}
                    maxLength={NOTE_MAX}
                    aria-label="Notes about this game"
                    value={noteDraft ?? note ?? ""}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    // Leaving the box saves it, so Rematch or going back never drops what was typed.
                    onBlur={() => noteDraft !== undefined && noteDraft.trim() !== (note ?? "") && saveNote()}
                  />
                  {noteDraft !== undefined && noteDraft.trim() !== (note ?? "") && (
                    <button type="button" className="small" style={{ justifySelf: "start" }} onClick={saveNote} disabled={noteSaving}>{noteSaving ? "Saving…" : "Save the note"}</button>
                  )}
                </div>
              ) : (
                note && <p className="small dim">{note}</p>
              )}
            </section>
          )}
          <div className="go-group">
            <b>{counted ? `Counts toward ${game!.playgroup}'s stats` : "Not counted toward a group's stats"}</b>
            <span className="dim small">
              {!view.abandoned && game?.playgroup && !counted
                ? `A game against only the computer stays in ${game.playgroup}'s history and out of its stats.`
                : `Chosen when the game was made${ai ? "; a computer played in it" : ""}.`}
            </span>
          </div>
          <ErrorText small error={error} />
          <div className="go-buttons">
            <button type="button" className="outline" onClick={props.onLog}>Game log</button>
            <button type="button" className="outline" onClick={props.onBoard}>See the final board</button>
            <Link to="/play" className="button outline">Back to Play online</Link>
            {host ? (
              <button type="button" className="primary" onClick={rematch} disabled={busy}>Set up rematch</button>
            ) : game?.rematch ? (
              <button type="button" className="primary" onClick={join} disabled={busy}>Join the rematch</button>
            ) : null}
          </div>
          {host && <span className="small dim">Rematch makes a new table with the same seats and decks; the others join it from here or with its code.</span>}
          {host && (
            <button type="button" className="quiet small" style={{ alignSelf: "flex-start" }} onClick={remove} disabled={busy}>
              Delete this game
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The bar that brings the game-over screen back after looking at the final board. */
export function GameOverBar({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <div className="go-bar" role="status">
      <b>{text}</b>
      <button type="button" className="outline small" onClick={onOpen}>Show the result</button>
    </div>
  );
}

