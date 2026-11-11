// Real games played with each version of a deck: "This version: 3-2, 5 games", then earlier
// versions with their notes. Under the provisional mark a record is faded and says so.

import { useQuery } from "@tanstack/react-query";
import { api, type DeckResults as Results } from "../api";
import { queryFailure, RefreshFailed } from "./QueryError";
import { Details, ErrorText } from "./ui";
import { recordText } from "./statsText";
import "./stats.css";
import { fmtDate } from "@yama/core";

type VersionResult = Results["versions"][number];


export function DeckResults({ deckId, versionId }: { deckId: string; versionId: string | null }) {
  const q = useQuery({ queryKey: ["deck-results", deckId, versionId], queryFn: ({ signal }) => api<Results>(`/api/decks/${deckId}/results`, { signal }) });
  const r = q.data;
  if (queryFailure(q) === "page") return <ErrorText error={q.error} />;
  if (!r) return null;
  const current = r.versions.find((v) => v.current);
  const earlier = r.versions.filter((v) => !v.current);
  const under = r.provisional_under;
  const faded = (v: VersionResult) => (v.games > 0 && v.games < under ? "provisional" : undefined);
  return (
    <section className="deck-results">
      <h2>Results</h2>
      <RefreshFailed query={q} what="these results" />
      <p className={`this-version ${current ? (faded(current) ?? "") : ""}`}>
        This version: <b className="num">{current ? recordText(current) : "no games yet"}</b>
        {current && current.games > 0 && current.games < under && <span className="prov"> provisional</span>}
      </p>
      {earlier.length > 0 && (
        <ul>
          {earlier.map((v) => (
            <li key={v.id} className={faded(v)}>
              Version {v.number}{v.note ? `, "${v.note}"` : ""}: <span className="num">{recordText(v)}</span>
              {v.games < under && <span className="prov"> provisional</span>}
              <br />
              <span className="when">Saved {fmtDate(v.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <Details label="Which games count">
        <p>Finished games where you played this deck, at the table or in Log a game. Records show wins and losses; under {under} games is provisional.</p>
      </Details>
    </section>
  );
}
