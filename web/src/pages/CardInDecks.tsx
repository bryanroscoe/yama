import { plural, shortDate } from "@yama/core";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link } from "react-router";
import { api, type Combo } from "../api";

/** One of your decks whose current list has the card (GET /api/cards/{id}/mine). */
export interface DeckUse {
  deck_id: string;
  /** The deck's name; a configuration's already says which ("Omo (stock)"). */
  name: string;
  /** Copies in the list, over every board. */
  qty: number;
  board: "commander" | "main" | "side";
  /** Whether Yama has Commander Spellbook's answer for this list. Without one, no combos shown means "not checked yet". */
  checked: boolean;
}

/** A combo Commander Spellbook found in those decks' lists that the card is part of, with every deck it is in. */
export type DeckCombo = Combo & { decks: { deck_id: string; name: string }[]; checked_at: string };

export interface CardInDecksData {
  decks: DeckUse[];
  combos: DeckCombo[];
  /** Combos left out of `combos`. */
  more_combos: number;
}

const SPELLBOOK = "https://commanderspellbook.com/";

/** How a deck uses the card: "its commander", "main deck", "2 in the main deck", "sideboard". */
export function deckUseWords(d: Pick<DeckUse, "qty" | "board">): string {
  if (d.board === "commander") return "its commander";
  const where = d.board === "side" ? "sideboard" : "main deck";
  return d.qty > 1 ? `${d.qty} in the ${where}` : where;
}

/** "Nov 1", or "Nov 1 to Nov 9" when the decks were checked on different days. */
export function checkedSpan(combos: Pick<DeckCombo, "checked_at">[]): string {
  const days = [...new Set(combos.map((c) => c.checked_at.slice(0, 10)))].sort();
  const first = shortDate(days[0]) ?? days[0] ?? "";
  const last = shortDate(days[days.length - 1]) ?? days[days.length - 1] ?? "";
  return first === last ? first : `${first} to ${last}`;
}

/** A requirement that isn't a named card, in the middle of a sentence: only its first letter is lowered ("a way to untap Isochron Scepter"). */
export function templateWords(templates: string[]): string {
  return templates.map((t) => (t ? t[0]!.toLowerCase() + t.slice(1) : t)).join(", ");
}

/**
 * On a card's page: which of your decks run it, and the combos it is part of in them. The
 * combos are the ones Commander Spellbook found when each deck's list was last checked (kept
 * with the deck); nothing is sent anywhere to show them. Nothing to say: nothing is drawn.
 */
export function CardInDecks({ oracleId }: { oracleId: string }) {
  const mine = useQuery({
    queryKey: ["card-in-decks", oracleId],
    queryFn: ({ signal }) => api<CardInDecksData>(`/api/cards/${encodeURIComponent(oracleId)}/mine`, { signal }),
    staleTime: 60_000,
  });
  if (!mine.data) return null;
  return <CardInDecksView data={mine.data} />;
}

export function CardInDecksView({ data }: { data: CardInDecksData }) {
  const { decks, combos } = data;
  if (decks.length === 0) return null;
  // A deck with no answer from Spellbook yet shows no combos: say so, so it doesn't read as "none".
  const unchecked = decks.filter((d) => !d.checked);
  return (
    <section className="cp-decks" aria-label="In your decks">
      <h2>In your decks</h2>
      <ul className="cp-deck-list">
        {decks.map((d) => (
          <li key={d.deck_id}>
            <Link to={`/decks/${encodeURIComponent(d.deck_id)}`}>{d.name}</Link>
            <span className="cp-deck-use">{deckUseWords(d)}</span>
          </li>
        ))}
      </ul>
      {combos.length > 0 && (
        <>
          <h3>Combos with it in your decks</h3>
          <ul className="cp-combo-list">
            {combos.map((c) => (
              <li key={c.id}>
                <span className="cp-combo-cards">
                  {c.cards.join(" + ")}
                  {c.templates.length > 0 ? `, plus ${templateWords(c.templates)}` : ""}
                </span>
                <span className="cp-combo-results">
                  {c.results.slice(0, 4).join(", ")}
                  {c.results.length > 4 ? ", and more" : ""}
                </span>
                <span className="cp-combo-meta">
                  In{" "}
                  {c.decks.map((d, i) => (
                    <Fragment key={d.deck_id}>
                      {i > 0 ? (i === c.decks.length - 1 ? " and " : ", ") : ""}
                      <Link to={`/decks/${encodeURIComponent(d.deck_id)}`}>{d.name}</Link>
                    </Fragment>
                  ))}
                  .{" "}
                  <a href={`${SPELLBOOK}combo/${encodeURIComponent(c.id)}/`} target="_blank" rel="noreferrer">How it works, on Commander Spellbook</a>
                </span>
              </li>
            ))}
          </ul>
          {data.more_combos > 0 && <p className="cp-note">And {plural(data.more_combos, "more combo")} in these decks; each deck's page lists its own.</p>}
          <p className="cp-note">
            Combos from <a href={SPELLBOOK} target="_blank" rel="noreferrer">Commander Spellbook</a>, found in these decks' lists when each was last checked ({checkedSpan(combos)}). A listed combo doesn't say how early it wins.
          </p>
        </>
      )}
      {unchecked.length > 0 && <p className="cp-note">Not checked for combos yet: {unchecked.map((d) => d.name).join(", ")}.</p>}
    </section>
  );
}
