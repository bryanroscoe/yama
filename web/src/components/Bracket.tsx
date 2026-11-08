import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { powerEstimate, type PowerEstimate, type PowerFactor } from "@yama/core";
import { useEffect, useMemo, useRef } from "react";
import { api, type Combo, type DeckCheck, type DeckEntry, type Estimated } from "../api";
import { checkStatus, estimateExplanation, estimateValue, gameChangerFloor, localDay, pollAfter, SENDS_LIST, suggestedBracket } from "./deckCheck";
import { statCards } from "./DeckStats";
import { NameList } from "./OnlineSupport";
import { Details, ErrorText } from "./ui";
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
 * The declared bracket and Yama's starting suggestion as two chips side by side. The suggestion
 * is dashed and labelled, so it never passes for what the owner declared.
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
          title={`${estimateValue(estimate.tag, estimate.bracket).sub(estimate.label)}. ${estimateExplanation(estimate.tag)}${estimate.checked_at ? ` Checked ${localDay(estimate.checked_at)}.` : ""}`}
        >
          Suggested <b>{estimateValue(estimate.tag, estimate.bracket).value.toLowerCase()}</b>
        </span>
      )}
    </span>
  );
}

export function useDeckCheck(deckId: string, versionId: string | null) {
  return useQuery({
    queryKey: ["deck-check", deckId, versionId],
    queryFn: ({ signal }) => api<DeckCheck>(`/api/decks/${deckId}/check`, { signal }),
    refetchInterval: (q) => pollAfter(q.state.data),
  });
}

/**
 * The deck page's bracket panel: the declared bracket beside Commander Spellbook's estimate,
 * the cards and combos behind the estimate, and the local Game Changer count when there's no
 * estimate to show.
 */
export function BracketPanel({ deckId, versionId, declared, gameChangers, cards, onCard, onDeclare }: {
  deckId: string;
  versionId: string | null;
  declared: number | null;
  /** From our own card data; null while the flags aren't loaded. */
  gameChangers: string[] | null;
  /** The deck as loaded, for the power-level estimate's card-text factors. */
  cards: DeckEntry[];
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

  // Grouped by Commander Spellbook's own count, which leaves the commander out and counts a
  // notable prerequisite as a piece.
  const twoCard = r?.combos.filter((x) => x.definitely_two_card) ?? [];
  const arguably = r?.combos.filter((x) => !x.definitely_two_card && x.arguably_two_card) ?? [];
  const longer = r?.combos.filter((x) => !x.definitely_two_card && !x.arguably_two_card) ?? [];
  const status = checkStatus(c);
  const shown = r ? estimateValue(r.bracket_tag, r.bracket) : null;
  const power = useMemo(
    () => r && powerEstimate(statCards(cards), {
      bracket: suggestedBracket(r.bracket_tag, r.bracket),
      gameChangers: r.game_changers,
      twoCardCombos: r.combos.filter((x) => x.definitely_two_card).map((x) => x.cards.join(" + ")),
      massLandDenial: r.mld,
      extraTurns: r.extra_turns,
    }),
    [r, cards],
  );

  return (
    <section className="deck-panel" aria-labelledby="bracket-head">
      <div className="deck-panel-head">
        <h2 id="bracket-head">Bracket</h2>
        {c?.enabled && !c.archived && !c.pending && c.version_id && (
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
          <span className="label">Starting suggestion, {r ? `checked ${localDay(r.checked_at)}` : "not checked yet"}</span>
          {r && shown ? (
            <>
              <span className="value">{shown.value}</span>
              <span className="sub">{shown.sub(r.bracket_label)}</span>
            </>
          ) : (
            <span className="value none">None yet</span>
          )}
        </div>
        {power && (
          <div className="bracket-side estimate">
            <span className="label">Older power-level scale</span>
            <span className="value">About {power.score.toFixed(1)} / 10</span>
            <span className="sub">Unofficial Yama estimate</span>
          </div>
        )}
      </div>

      {status && <p className="note" role="status">{status}</p>}
      <ErrorText error={again.error} />
      <Details label={r ? "Why this suggestion?" : "About bracket suggestions"}>
        <p>{r ? estimateExplanation(r.bracket_tag) : "Yama suggests a starting bracket from the card list. Your declared bracket is what you tell the table, based on the deck's speed, consistency and intended play experience."}</p>
        {r && <p>{gameChangerFloor(r.game_changers.length)}</p>}
        {r && <p>Commander Spellbook counts your commander as always available, so it isn't counted as a combo piece. A listed combo doesn't establish how early it wins. Yama uses Core (2) as a provisional starting point when no higher-bracket signals are found.</p>}
      </Details>
      {power && <PowerBreakdown power={power} onCard={onCard} />}
      {r && <button className="name-link small" onClick={onDeclare}>Choose or change your bracket</button>}
      <BracketGuide />

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
            <h3 className="bracket-subhead">Two-card combos: {twoCard.length}</h3>
            {twoCard.length > 0 ? <ComboList combos={twoCard} onCard={onCard} /> : <p className="note">Commander Spellbook found none in this list.</p>}
          </div>
          {arguably.length > 0 && (
            <div>
              <h3 className="bracket-subhead">Arguably two-card: {arguably.length}</h3>
              <p className="note" style={{ margin: "0 0 0.4rem" }}>Two cards, plus one more thing that has to be in place first. How it works says what.</p>
              <ComboList combos={arguably} onCard={onCard} />
            </div>
          )}
          {longer.length > 0 && (
            <details>
              <summary>Combos with more pieces: {longer.length}</summary>
              <ComboList combos={longer} onCard={onCard} />
            </details>
          )}
          <p className="note">
            Card-list signals and combos from <a href={SPELLBOOK} target="_blank" rel="noreferrer">Commander Spellbook</a>.
          </p>
        </>
      ) : (
        <p className="note">
          From our card data:{" "}
          {gameChangers ? gameChangerFloor(gameChangers.length) : "Game Changer flags aren't loaded on this server yet."}
        </p>
      )}
      {c?.enabled && <p className="note">{SENDS_LIST}</p>}
    </section>
  );
}

export function BracketGuide() {
  return (
    <details className="bracket-guide">
      <summary>How Commander brackets work</summary>
      <p className="note">Game Changers set deck-building limits; they don't measure the whole deck. Intent, speed, consistency, game-ending combos, extra-turn chains and mass land denial also matter.</p>
      <p className="note">How Yama suggests a bracket: start provisionally at Core (2) when the check finds no higher-bracket signals. One to three Game Changers suggest at least 3; four or more suggest at least 4. Known combos and other flagged effects can raise the suggestion too. Choose Exhibition (1) yourself for a deliberately theme-first deck, or cEDH (5) for a deck built for that competitive metagame. A suggestion never changes your declared bracket.</p>
      <dl>
        <div><dt>1, Exhibition</dt><dd>Theme over power. No Game Changers by default; thematic exceptions belong in the pregame conversation. Expect at least nine turns before a win or loss.</dd></div>
        <div><dt>2, Core</dt><dd>No Game Changers. Straightforward, unoptimized play with visible, disruptable wins. Expect at least eight turns before a win or loss.</dd></div>
        <div><dt>3, Upgraded</dt><dd>Up to three Game Changers. Strong synergy and interaction. Expect at least six turns before a win or loss.</dd></div>
        <div><dt>4, Optimized</dt><dd>Unlimited Game Changers. Fast, consistent, efficient play. Expect at least four turns before a win or loss.</dd></div>
        <div><dt>5, cEDH</dt><dd>Unlimited Game Changers. Built for the competitive Commander metagame; games can end on any turn.</dd></div>
      </dl>
      <p className="note">These are play expectations, not a rule that one unusually fast win changes your bracket. Precons aren't automatically bracket 2: Wizards removed that benchmark in October 2025. Farewell became a Game Changer in February 2026, including in stock precons that contain it.</p>
      <p className="note">Sources, reviewed October 25, 2026: <a href="https://magic.wizards.com/en/formats/commander" target="_blank" rel="noreferrer">Wizards' bracket overview</a>, <a href="https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025" target="_blank" rel="noreferrer">October 2025 update</a> and <a href="https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026" target="_blank" rel="noreferrer">February 2026 update</a>.</p>
    </details>
  );
}

const signed = (n: number) => `+${n.toFixed(2)}`;

/** How the power-level estimate adds up: the band from the suggestion, then each factor. */
function PowerBreakdown({ power, onCard }: { power: PowerEstimate; onCard: (name: string) => void }) {
  const [lo, hi] = power.band;
  return (
    <Details label="How the power estimate adds up">
      <p>
        Yama's unofficial 1–10 estimate uses this list and its stored Spellbook check. Other sites use different formulas; their numbers aren't directly comparable. The bracket {power.bracket} suggestion sets a {lo}–{hi} range, then the factors below move the score within it. This measures card-list signals, not played performance.
      </p>
      <ul className="power-factors">
        {power.factors.map((f) => (
          <li key={f.key}>
            <span className="power-factor-head">
              <b>{f.label}</b>
              <span className="num">{signed(f.points)}</span>
            </span>
            <span className="note">{f.rule}. {factorCount(f)}</span>
            {f.cards.length > 0 && (
              <span className="names">
                {f.key === "combos" ? f.cards.join(", ") : <NameList names={f.cards} onCard={onCard} />}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p>{lo} plus these factors comes to {power.score.toFixed(1)}.</p>
      {power.unknownCards.length > 0 && (
        <p>Not in Yama's card data, so not counted: <NameList names={power.unknownCards} onCard={onCard} /></p>
      )}
    </Details>
  );
}

function factorCount(f: PowerFactor): string {
  if (f.key === "curve") return f.count ? `This deck: ${f.count.toFixed(2)}.` : "No nonland cards to average.";
  return `This deck: ${f.count}, full credit at ${f.cap}.`;
}

const sameNames = (a: string[], b: string[] | null) =>
  !!b && a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function ComboList({ combos, onCard }: { combos: Combo[]; onCard: (name: string) => void }) {
  return (
    <ul className="deck-combo-list">
      {combos.map((c) => (
        <li key={c.id} className="deck-combo">
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
