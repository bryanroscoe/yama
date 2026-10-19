import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, type Combo, type DeckCheck, type Estimated } from "../api";
import { NameList } from "./OnlineSupport";
import { day } from "./Rulings";
import { ErrorText } from "./ui";
import "./decks.css";

/** The Commander brackets, as Wizards names them. */
export const BRACKETS: { value: number; name: string }[] = [
  { value: 1, name: "Exhibition" },
  { value: 2, name: "Core" },
  { value: 3, name: "Upgraded" },
  { value: 4, name: "Optimized" },
  { value: 5, name: "cEDH" },
];

export const bracketName = (n: number) => BRACKETS.find((b) => b.value === n)?.name ?? "";

const SPELLBOOK = "https://commanderspellbook.com/";

/**
 * The declared bracket and the outside estimate as two chips side by side. The estimate's chip
 * is dashed and says "estimate", so it never passes for what the owner declared.
 */
export function BracketChips({ declared, estimate }: { declared: number | null | undefined; estimate?: Estimated | null }) {
  if (declared == null && !estimate) return null;
  return (
    <span className="bracket-chips">
      {declared != null && (
        <span className="bracket-chip declared" title={`Declared bracket: ${declared}, ${bracketName(declared)}`}>
          Bracket <b>{declared}</b>
        </span>
      )}
      {estimate && (
        <span
          className="bracket-chip estimate"
          title={`Commander Spellbook's estimate: ${estimate.label}${estimate.checked_at ? `, checked ${day(estimate.checked_at.slice(0, 10))}` : ""}`}
        >
          Estimate <b>{estimate.bracket ?? "banned"}</b>
        </span>
      )}
    </span>
  );
}

export function useDeckCheck(deckId: string, versionId: string | null) {
  return useQuery({
    queryKey: ["deck-check", deckId, versionId],
    queryFn: () => api<DeckCheck>(`/api/decks/${deckId}/check`),
    // The check runs in the background after a save; ask until it has answered.
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });
}

/** How far a Game Changer count alone pushes a deck, by the brackets' limits (none in 1 and 2,
 *  up to three in 3). The offline answer when there's no outside estimate. */
export function gameChangerFloor(count: number): string {
  if (count === 0) return "No Game Changers, so they don't rule out any bracket.";
  if (count <= 3) return `${count} Game ${count === 1 ? "Changer" : "Changers"}, so bracket 3 or higher (brackets 1 and 2 allow none).`;
  return `${count} Game Changers, so bracket 4 or higher (bracket 3 allows up to three).`;
}

/**
 * The deck page's bracket panel: the declared bracket beside Commander Spellbook's estimate,
 * the cards and combos behind the estimate, and the local Game Changer count when there's no
 * estimate to show.
 */
export function BracketPanel({ deckId, versionId, declared, gameChangers, onCard, onDeclare }: {
  deckId: string;
  versionId: string | null;
  declared: number | null;
  /** From our own card data; null while the flags aren't loaded. */
  gameChangers: string[] | null;
  onCard: (name: string) => void;
  onDeclare: () => void;
}) {
  const qc = useQueryClient();
  const check = useDeckCheck(deckId, versionId);
  const again = useMutation({
    mutationFn: () => api<DeckCheck>(`/api/decks/${deckId}/check`, { method: "POST" }),
    onSuccess: (d) => qc.setQueryData(["deck-check", deckId, versionId], d),
  });
  const c = check.data;
  const r = c?.result ?? null;

  // A fresh answer changes the estimate chip on the deck list.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (r && seen.current !== null && seen.current !== r.checked_at) void qc.invalidateQueries({ queryKey: ["decks"] });
    seen.current = r?.checked_at ?? "";
  }, [r, qc]);

  const twoCard = r?.combos.filter((x) => x.two_card) ?? [];
  const longer = r?.combos.filter((x) => !x.two_card) ?? [];

  let status: string | null = null;
  if (c && !c.enabled) status = "Outside checks are off on this server.";
  else if (c?.pending) status = r ? "Checking again with Commander Spellbook." : "Checking with Commander Spellbook. This takes a few seconds after a save.";
  else if (c?.error) status = `${r ? "The last re-check failed" : "Couldn't check yet"}: ${c.error}.${c.gave_up ? " Stopped trying until you ask again." : " Trying again later."}`;
  else if (c && !c.result && !c.requested_at) status = "Not checked yet.";

  return (
    <section className="deck-panel" aria-labelledby="bracket-head">
      <div className="deck-panel-head">
        <h2 id="bracket-head">Bracket</h2>
        {c?.enabled && !c.pending && c.version_id && (
          <button className="quiet small" onClick={() => again.mutate()} disabled={again.isPending}>Check again</button>
        )}
      </div>

      <div className="bracket-pair">
        <div className="bracket-side">
          <span className="label">Declared by you</span>
          {declared != null ? (
            <>
              <span className="value">{declared}</span>
              <span className="sub">{bracketName(declared)}</span>
            </>
          ) : (
            <>
              <span className="value none">Not declared</span>
              <button className="name-link sub" style={{ justifySelf: "start" }} onClick={onDeclare}>Declare a bracket</button>
            </>
          )}
        </div>
        <div className="bracket-side estimate">
          <span className="label">Estimate, {r ? `checked ${day(r.checked_at.slice(0, 10))}` : "not checked yet"}</span>
          {r ? (
            <>
              <span className="value">{r.bracket ?? "Banned"}</span>
              <span className="sub">{r.bracket == null ? "A card is banned in Commander" : `Commander Spellbook's "${r.bracket_label}"`}</span>
            </>
          ) : (
            <span className="value none">None yet</span>
          )}
        </div>
      </div>

      {status && <p className="note" role="status">{status}</p>}
      <ErrorText error={again.error} />

      {r ? (
        <>
          <ul className="flag-list">
            <li>
              <b>Game Changers: {r.game_changers.length}</b>
              {r.game_changers.length > 0 &&
                (sameNames(r.game_changers, gameChangers) ? (
                  <>, the same cards as Scryfall's list above</>
                ) : (
                  <>. <NameList names={r.game_changers} onCard={onCard} /></>
                ))}
            </li>
            <li>
              <b>Mass land denial:</b> {r.mld.length ? <NameList names={r.mld} onCard={onCard} /> : "none"}
            </li>
            <li>
              <b>Extra turns:</b> {r.extra_turns.length ? <NameList names={r.extra_turns} onCard={onCard} /> : "none"}
            </li>
            {r.unrecognized.length > 0 && (
              <li>
                Commander Spellbook didn't know {r.unrecognized.length === 1 ? "this card" : `these ${r.unrecognized.length} cards`}, so the estimate leaves {r.unrecognized.length === 1 ? "it" : "them"} out: <NameList names={r.unrecognized} onCard={onCard} />
              </li>
            )}
          </ul>
          <div>
            <h3 style={{ fontSize: "var(--t-base)", margin: "0 0 0.4rem" }}>Two-card combos: {twoCard.length}</h3>
            {twoCard.length > 0 ? <ComboList combos={twoCard} onCard={onCard} /> : <p className="note">Commander Spellbook found none in this list.</p>}
          </div>
          {longer.length > 0 && (
            <details>
              <summary>Combos with more pieces: {longer.length}</summary>
              <ComboList combos={longer} onCard={onCard} />
            </details>
          )}
          <p className="note">
            Bracket estimate, flags and combos from <a href={SPELLBOOK} target="_blank" rel="noreferrer">Commander Spellbook</a>. It's an estimate from the card list; the bracket you declare is yours to set.
          </p>
        </>
      ) : (
        <p className="note">
          From our card data:{" "}
          {gameChangers ? gameChangerFloor(gameChangers.length) : "Game Changer flags aren't loaded on this server yet."}
        </p>
      )}
    </section>
  );
}

const sameNames = (a: string[], b: string[] | null) =>
  !!b && a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function ComboList({ combos, onCard }: { combos: Combo[]; onCard: (name: string) => void }) {
  return (
    <ul className="combo-list">
      {combos.map((c) => (
        <li key={c.id} className="combo">
          <span className="cards">
            <NameList names={c.cards} onCard={onCard} />
            {c.templates.length > 0 && <span className="meta">, plus {c.templates.join(", ").toLowerCase()}</span>}
          </span>
          <span className="results">{c.results.slice(0, 4).join(", ")}{c.results.length > 4 ? ", and more" : ""}</span>
          <span className="meta">
            {c.flags.length > 0 && <>Counts toward a higher bracket: {c.flags.join(", ")}. </>}
            <a href={`${SPELLBOOK}combo/${encodeURIComponent(c.id)}/`} target="_blank" rel="noreferrer">How it works</a>
          </span>
        </li>
      ))}
    </ul>
  );
}
