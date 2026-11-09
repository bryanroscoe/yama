// Games with this deck, on its History tab: the record across every list, and the current list's
// when it differs. The Stats tab's Results keeps the per-version breakdown; both read one query.

import { useQuery } from "@tanstack/react-query";
import { api, type DeckResults } from "../api";
import { recordText } from "./statsText";
import { ErrorText } from "./ui";

export function gamesTotal(versions: DeckResults["versions"]) {
  return versions.reduce((t, v) => ({ games: t.games + v.games, wins: t.wins + v.wins, losses: t.losses + v.losses, draws: t.draws + v.draws }), { games: 0, wins: 0, losses: 0, draws: 0 });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function DeckGames({ deckId, versionId }: { deckId: string; versionId: string | null }) {
  const q = useQuery({ queryKey: ["deck-results", deckId, versionId], queryFn: ({ signal }) => api<DeckResults>(`/api/decks/${deckId}/results`, { signal }) });
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data) return null;
  const total = gamesTotal(q.data.versions);
  const now = q.data.versions.find((v) => v.current);
  return (
    <section className="deck-tab-section" aria-labelledby="deck-history-games">
      <h2 id="deck-history-games">Games with this deck</h2>
      <span className="num">{cap(recordText(total))}</span>
      {now && now.games > 0 && now.games < total.games && <span className="dim">This list: {recordText(now)}</span>}
    </section>
  );
}
