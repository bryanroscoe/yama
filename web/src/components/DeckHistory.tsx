import { CardText } from "./CardRef";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffDecks, type DiffLine } from "@yama/core";
import { useEffect, useRef, useState } from "react";
import { api, type DeckVersion, type DeckVersionRow } from "../api";
import { ErrorText, Sheet } from "./ui";
import "./decks.css";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const BOARD: Record<string, string> = { commander: " (commander)", side: " (sideboard)", main: "" };

/** Every saved version of a deck, and what changed between any two of them. */
export function DeckHistory({ deckId, currentVersionId, onClose }: { deckId: string; currentVersionId: string | null; onClose: () => void }) {
  const versions = useQuery({ queryKey: ["deck-versions", deckId, currentVersionId], queryFn: () => api<DeckVersionRow[]>(`/api/decks/${deckId}/versions`) });
  // Restoring saves the old list as a new version, so the one it replaces stays here too.
  const qc = useQueryClient();
  // One op id per version asked for: a retry of that version reuses it, another gets its own.
  const ops = useRef(new Map<string, string>());
  const opFor = (version: string) => ops.current.get(version) ?? ops.current.set(version, crypto.randomUUID()).get(version)!;
  const restore = useMutation({
    mutationFn: (version: string) => api<{ changed: boolean }>(`/api/decks/${deckId}/use`, { method: "POST", json: { version, op_id: opFor(version) } }),
    onSuccess: (_, version) => {
      ops.current.delete(version);
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions", deckId] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
    },
  });
  const list = versions.data ?? [];
  // Newest first. By default compare the current version with the one before it.
  const [fromPick, setFromPick] = useState<string | null>(null);
  const [toPick, setToPick] = useState<string | null>(null);
  useEffect(() => {
    if (list.length && toPick == null) {
      setToPick(list[0]!.id);
      setFromPick(list[1]?.id ?? null);
    }
  }, [list, toPick]);

  const index = (id: string | null) => list.findIndex((v) => v.id === id);
  // Compare in time order (older to newer) whichever way round they were picked.
  const [from, to] = index(fromPick) > index(toPick) ? [fromPick, toPick] : [toPick, fromPick];

  return (
    <Sheet label="Version history" onClose={onClose}>
      <div className="stack deck-history">
        <div className="sheet-head">
          <h2>Version history</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        <ErrorText error={versions.error} />
        {list.length === 1 && <p className="dim">Only one version so far. Each save in Edit deck adds one.</p>}
        {list.length > 1 && (
          <>
            <p className="small dim" style={{ margin: 0 }}>Pick two versions to compare: one in the "from" column, one in the "to" column.</p>
            <div>
              <div className="pick-head" aria-hidden="true">
                <span>From</span>
                <span>To</span>
                <span />
                <span />
              </div>
              <div className="versions">
                {list.map((v, i) => (
                  <div key={v.id} className="version">
                    <input type="radio" name="from" aria-label={`Compare from ${when(v.created_at)}`} checked={fromPick === v.id} onChange={() => setFromPick(v.id)} />
                    <input type="radio" name="to" aria-label={`Compare to ${when(v.created_at)}`} checked={toPick === v.id} onChange={() => setToPick(v.id)} />
                    <span>
                      {v.note || (i === list.length - 1 ? "First version" : "No note")}
                      {v.id === currentVersionId && <span className="dim"> (current)</span>}
                      {v.history_only && <span className="dim"> (scan saved in History)</span>}
                      <br />
                      <span className="when">{when(v.created_at)}</span>
                    </span>
                    {v.id !== currentVersionId && (
                      <button className="quiet small" disabled={restore.isPending} onClick={() => restore.mutate(v.id)}>
                        Restore this list
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <ErrorText error={restore.error} />
            {from && to && from !== to ? <Diff deckId={deckId} from={from} to={to} /> : <p className="small dim">Pick two different versions.</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}

function useVersion(deckId: string, id: string) {
  return useQuery({ queryKey: ["deck-version", deckId, id], queryFn: () => api<DeckVersion>(`/api/decks/${deckId}/versions/${id}`), staleTime: Infinity });
}

function Diff({ deckId, from, to }: { deckId: string; from: string; to: string }) {
  const a = useVersion(deckId, from);
  const b = useVersion(deckId, to);
  if (a.error || b.error) return <ErrorText error={a.error ?? b.error} />;
  if (!a.data || !b.data) return <p className="small dim">Loading…</p>;
  const d = diffDecks(a.data.cards, b.data.cards);
  const none = !d.added.length && !d.removed.length && !d.changed.length;
  return (
    <div className="diff" aria-live="polite">
      <p className="small dim" style={{ margin: 0 }}>
        From {when(a.data.created_at)} to {when(b.data.created_at)}
      </p>
      {none && <p>The two versions have the same cards.</p>}
      <Group title="Added" sign="+" lines={d.added} render={(l) => `${l.after > 1 ? `${l.after} ` : ""}${l.name}${BOARD[l.board]}`} />
      <Group title="Removed" sign="−" lines={d.removed} render={(l) => `${l.before > 1 ? `${l.before} ` : ""}${l.name}${BOARD[l.board]}`} />
      <Group title="Count changed" sign="±" lines={d.changed} render={(l) => `${l.name}${BOARD[l.board]}: ${l.before} to ${l.after}`} />
    </div>
  );
}

function Group({ title, sign, lines, render }: { title: string; sign: string; lines: DiffLine[]; render: (l: DiffLine) => string }) {
  if (!lines.length) return null;
  return (
    <section>
      <h3>{title}: {lines.length}</h3>
      <ul>
        {lines.map((l) => (
          <li key={`${l.board}-${l.name}`}>
            <span className="sign" aria-hidden="true">{sign}</span>
            <CardText text={render(l)} names={[l.name]}/>
          </li>
        ))}
      </ul>
    </section>
  );
}
