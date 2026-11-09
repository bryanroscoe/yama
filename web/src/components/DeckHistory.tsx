// The deck page's History tab, /decks/:id/history (deck page SPEC 0b; boards Deck and PhoneDeck,
// History state): every saved list, one open at a time with its changes as card pairs and Put this
// list back, then the games played with the deck.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanCard } from "@yama/core/plan";
import { useState } from "react";
import { api, type Card, type DeckVersion, type DeckVersionRow } from "../api";
import { cardDetailQuery } from "../cardDetail";
import { baseOf, versionPairs, type VersionPair } from "../decks/versionPairs";
import { SwapPair, Thumb } from "../plan/parts";
import { DeckGames } from "./DeckGames";
import { ErrorText } from "./ui";
import "../plan/plans.css";
import "../decks/deckTabs.css";

/** Pairs shown before "Show all". */
const PAIRS_SHOWN = 8;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const versionsQuery = (deckId: string, currentVersionId: string | null) => ({
  queryKey: ["deck-versions", deckId, currentVersionId] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => api<DeckVersionRow[]>(`/api/decks/${deckId}/versions`, { signal }),
});

/** The History tab's note: how many lists the deck has saved. */
export function HistoryTabNote({ deckId, currentVersionId }: { deckId: string; currentVersionId: string | null }) {
  const n = useQuery(versionsQuery(deckId, currentVersionId)).data?.length;
  return n ? <>{n === 1 ? "1 list" : `${n} lists`}</> : null;
}

export function DeckHistoryBody({ deckId, currentVersionId }: { deckId: string; currentVersionId: string | null }) {
  const versions = useQuery(versionsQuery(deckId, currentVersionId));
  const list = versions.data ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const selected = list.find((v) => v.id === pick) ?? list.find((v) => v.id === currentVersionId) ?? list[0];
  return (
    <div className="deck-history-grid">
      <section className="deck-tab-section deck-history-lists" aria-labelledby="deck-history-lists">
        <h2 id="deck-history-lists">Earlier lists</h2>
        <ErrorText error={versions.error} />
        {versions.isPending && <p className="dim">Loading…</p>}
        {list.length > 0 && (
          <div className="deck-tab-rows">
            {list.map((v, i) => {
              const now = v.id === currentVersionId;
              return (
                <button key={v.id} type="button" className="deck-history-version" aria-pressed={v.id === selected?.id} onClick={() => setPick(v.id)}>
                  <b>{v.note || (i === list.length - 1 ? "The first list" : "A saved list")}</b>
                  <span className="dim">{now ? `Now, ${day(v.created_at)}` : v.history_only ? `Scan, ${day(v.created_at)}` : day(v.created_at)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      <div className="deck-history-main">
        {selected && (
          <VersionChanges
            key={selected.id}
            deckId={deckId}
            version={selected}
            base={baseOf(list, selected.id)}
            current={selected.id === currentVersionId}
            onRestored={() => setPick(null)}
          />
        )}
        <DeckGames deckId={deckId} versionId={currentVersionId} />
      </div>
    </div>
  );
}

function useVersion(deckId: string, id: string | undefined) {
  return useQuery({
    queryKey: ["deck-version", deckId, id],
    queryFn: ({ signal }) => api<DeckVersion>(`/api/decks/${deckId}/versions/${id}`, { signal }),
    staleTime: Infinity,
    enabled: !!id,
  });
}

/** The card pictures for the pairs on screen, by name, as SwapPair reads them. */
function usePairCards(pairs: VersionPair[]) {
  const cards = pairs.flatMap((p) => [p.in, p.out]).filter((c): c is NonNullable<typeof c> => !!c);
  const ids = [...new Set(cards.map((c) => c.oracle_id))];
  const details = useQueries({ queries: ids.map((id) => ({ ...cardDetailQuery(id), staleTime: Infinity })) });
  const byName = new Map<string, { oracle_id: string; card?: Card }>();
  for (const c of cards) byName.set(c.name, { oracle_id: c.oracle_id, card: details[ids.indexOf(c.oracle_id)]?.data?.card });
  return {
    oracleId: (name: string) => byName.get(name)?.oracle_id,
    card: (name: string): PlanCard | undefined => {
      const c = byName.get(name)?.card;
      return c ? { name: c.name, type_line: c.type_line, cmc: c.cmc, color_identity: c.color_identity, layout: c.layout, image_small: c.image_small, image_art_crop: c.image_art_crop, image_normal: c.image_normal, faces: null } : undefined;
    },
  };
}

function VersionChanges({ deckId, version, base, current, onRestored }: { deckId: string; version: DeckVersionRow; base: DeckVersionRow | null; current: boolean; onRestored: () => void }) {
  const qc = useQueryClient();
  const a = useVersion(deckId, base?.id);
  const b = useVersion(deckId, base ? version.id : undefined);
  const pairs = a.data && b.data ? versionPairs(a.data.cards, b.data.cards) : [];
  const [all, setAll] = useState(false);
  const shown = all ? pairs : pairs.slice(0, PAIRS_SHOWN);
  const view = usePairCards(shown);
  const [confirming, setConfirming] = useState(false);
  // One op id for this version: a retry reuses it, so the server applies it once.
  const [op] = useState(() => crypto.randomUUID());
  const restore = useMutation({
    mutationFn: () => api<{ changed: boolean }>(`/api/decks/${deckId}/use`, { method: "POST", json: { version: version.id, op_id: op } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions", deckId] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      onRestored();
    },
  });
  const loading = !!base && (a.isPending || b.isPending);
  return (
    <section className="deck-tab-section" aria-labelledby="deck-history-changes">
      <h2 id="deck-history-changes">{base ? "Changes" : "The first list"}</h2>
      <ErrorText error={a.error ?? b.error} />
      {loading && <p className="dim">Loading…</p>}
      {base && !loading && !a.error && !b.error && !pairs.length && <p className="dim">The same cards as the list before.</p>}
      {shown.length > 0 && (
        <ul className="plans-rows">
          {shown.map((p, i) => (
            <li key={i} className="plans-row">
              <PairRow pair={p} view={view} />
            </li>
          ))}
        </ul>
      )}
      {pairs.length > shown.length && (
        <button type="button" className="quiet small deck-tab-more" onClick={() => setAll(true)}>
          Show all {pairs.length}
        </button>
      )}
      {!current &&
        (confirming ? (
          <div className="deck-history-confirm" role="group" aria-label="Put this list back">
            <span>The current list stays in History.</span>
            <div className="row">
              <button type="button" className="primary" disabled={restore.isPending} onClick={() => restore.mutate()}>
                Put it back
              </button>
              <button type="button" className="quiet" disabled={restore.isPending} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
            <ErrorText error={restore.error} />
          </div>
        ) : (
          <button type="button" className="deck-tab-action" onClick={() => setConfirming(true)}>
            Put this list back
          </button>
        ))}
    </section>
  );
}

const copies = (n: number, name: string) => (n > 1 ? `${n} ${name}` : name);

function PairRow({ pair, view }: { pair: VersionPair; view: ReturnType<typeof usePairCards> }) {
  const { in: cin, out, qty } = pair;
  if (!cin) {
    return (
      <>
        <span className="plan-pair">
          <span className="plan-pair-empty" aria-hidden="true" />
          <svg className="plan-pair-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          <Thumb name={out!.name} card={view.card(out!.name)} oracleId={out!.oracle_id} />
        </span>
        <span className="plans-row-main">
          <span>
            <b>{copies(qty, out!.name)}</b> <span className="dim">taken out</span>
          </span>
        </span>
      </>
    );
  }
  return (
    <>
      <SwapPair cardIn={cin.name} cardOut={out?.name} view={view} />
      <span className="plans-row-main">
        <span>
          <b>{copies(qty, cin.name)}</b> <span className="dim">{out ? `replaces ${copies(qty, out.name)}` : "added"}</span>
        </span>
      </span>
    </>
  );
}
