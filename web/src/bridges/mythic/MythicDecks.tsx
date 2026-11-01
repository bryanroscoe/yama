import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { ErrorText } from "../../components/ui";
import { deckApplyLabel, deckResultText, deckStatusText, type MythicApplied, type MythicDeckPreview, type MythicDeckRow, type MythicExport } from "./mythic";

/** The import page's decks: each Mythic deck linked to a Yama deck, imported, or skipped. */
export function MythicDecks({ file }: { file: { name: string; data: MythicExport } }) {
  const qc = useQueryClient();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const request = { export: { decks: file.data.decks ?? [] }, choices };
  const preview = useQuery({
    queryKey: ["mythic-deck-preview", file.name, choices],
    queryFn: () => api<MythicDeckPreview>("/api/bridges/mythic/decks/preview", { method: "POST", json: request }),
    retry: false,
  });
  const apply = useMutation({
    mutationFn: () => api<MythicApplied>("/api/bridges/mythic/decks/apply", { method: "POST", json: request }),
    onSuccess: () => {
      setChoices({});
      void qc.invalidateQueries({ queryKey: ["mythic-deck-preview"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
    },
  });
  const p = preview.data;
  if (!file.data.decks) {
    return <p className="dim">This file has no decks: it was saved before the snippet saved them. Copy the snippet again to bring your decks too.</p>;
  }
  return (
    <section className="stack" aria-labelledby="mythic-decks">
      <h2 id="mythic-decks">Decks</h2>
      <p>A Mythic deck with the same commander as one of your Yama decks is linked to it; the others come in as new decks in the Mythic Tools folder. Linked decks update each other: importing again brings Mythic's changes, and a deck's page sends Yama's to Mythic.</p>
      <ErrorText error={preview.error} />
      {preview.isLoading && <p className="dim">Reading the decks…</p>}
      {p && (
        <>
          <ul className="mythic-games">
            {p.decks.map((d) => <DeckLine key={d.mythic_id} d={d} choice={choices[d.mythic_id]} onChoose={(c) => setChoices((m) => ({ ...m, [d.mythic_id]: c }))} />)}
          </ul>
          <div className="row">
            <button disabled={apply.isPending || preview.isFetching || p.decks.every((d) => d.action === "skip")} onClick={() => apply.mutate()}>
              {deckApplyLabel(p.decks)}
            </button>
          </div>
        </>
      )}
      <ErrorText error={apply.error} />
      {apply.data && (
        <div className="stack">
          <p>{deckResultText(apply.data)}</p>
          {apply.data.errors.map((e) => <p key={e.mythic_id} className="error">Mythic deck {e.mythic_id}: {e.error}</p>)}
        </div>
      )}
    </section>
  );
}

function DeckLine({ d, choice, onChoose }: { d: MythicDeckRow; choice: string | undefined; onChoose: (c: string) => void }) {
  const current = choice ?? (d.action === "link" && d.yama_id ? `link:${d.yama_id}` : d.action);
  const about = [d.commanders.join(" and "), d.cards ? `${d.cards} cards` : null].filter(Boolean).join(", ");
  return (
    <li className="stack" style={{ gap: "0.25rem" }}>
      <span>
        <b>{d.name}</b> <span className="dim">{deckStatusText(d)}</span>
      </span>
      {about && <span className="small">{about}</span>}
      {d.unknown.length > 0 && <span className="small dim">Yama doesn't know {d.unknown.join(", ")}; {d.unknown.length === 1 ? "it stays" : "they stay"} out.</span>}
      {d.yama_id && d.status !== "deleted" && d.status !== "new" && <Link className="small" to={`/decks/${d.yama_id}`}>Open the Yama deck</Link>}
      {(d.status === "new" || d.status === "match") && (
        <label className="small">
          <span className="visually-hidden">What to do with this deck</span>
          <select value={current} onChange={(e) => onChoose(e.target.value)}>
            {d.matches.map((m) => <option key={m.id} value={`link:${m.id}`}>It's "{m.name}" in Yama: link them</option>)}
            <option value="import">Import it as a new deck</option>
            <option value="skip">Skip it</option>
          </select>
        </label>
      )}
      {(d.status === "conflict" || d.status === "yama_changed" || d.status === "update") && (
        <label className="small">
          <span className="visually-hidden">Which list to keep</span>
          <select value={current} onChange={(e) => onChoose(e.target.value)}>
            <option value="skip">{d.status === "update" ? "Skip it for now" : "Decide later"}</option>
            {d.status === "conflict" && <option value="keep">Keep the Yama list</option>}
            <option value="update">Take Mythic's list</option>
          </select>
        </label>
      )}
    </li>
  );
}
