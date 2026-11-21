import { plural, shortDate } from "@yama/core";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { api, type Combo } from "../api";
import { ShowMore } from "../components/ui";

/** One of your decks whose current list has the card (GET /api/cards/{id}/mine). */
export interface DeckUse {
  deck_id: string;
  /** The deck's name; a configuration's already says which ("Omo (stock)"). */
  name: string;
  /** For one of a deck's other lists: the deck it belongs to, that deck's name, and this list's label ("stock"). */
  parent_id?: string | null;
  parent_name?: string | null;
  configuration?: string | null;
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

/** A deck with its other lists that run the card, as one line of "In your decks". */
export interface DeckGroup {
  /** The deck's own name. */
  name: string;
  /** The deck itself, when its own list runs the card. */
  main: DeckUse | null;
  /** Its other lists that do, each by what the list is called ("stock", "Bracket 3"). */
  lists: { label: string; use: DeckUse }[];
}

/**
 * The decks with each deck's lists gathered under it, in the order given. A list says which deck
 * it belongs to (`parent_id`), so nothing is read from what names look like: two decks called
 * "Atraxa (Poison)" and "Atraxa (Counters)" are two decks. When only one of a deck's other lists
 * runs the card, and the deck itself doesn't, that list is a line of its own under its full name.
 */
export function groupDecks(decks: DeckUse[]): DeckGroup[] {
  const groups: DeckGroup[] = [];
  const byDeck = new Map<string, DeckGroup>();
  for (const d of decks) {
    const root = d.parent_id ?? d.deck_id;
    let g = byDeck.get(root);
    if (!g) {
      g = { name: d.parent_id ? (d.parent_name ?? d.name) : d.name, main: null, lists: [] };
      byDeck.set(root, g);
      groups.push(g);
    }
    if (d.parent_id) g.lists.push({ label: d.configuration?.trim() || d.name, use: d });
    else {
      g.main = d;
      g.name = d.name;
    }
  }
  return groups.map((g) => (!g.main && g.lists.length === 1 ? { name: g.lists[0]!.use.name, main: g.lists[0]!.use, lists: [] } : g));
}

/** Decks listed before "Show all": a staple is in every deck, and the price and printings sit below. */
const DECKS_SHOWN = 5;

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
  const groups = groupDecks(decks);
  const [all, setAll] = useState(false);
  return (
    <section className="cp-decks" aria-label="In your decks">
      <h2>In your decks</h2>
      <ul className="cp-deck-list">
        {groups.slice(0, all ? undefined : DECKS_SHOWN).map((g) => {
          const first = g.main ?? g.lists[0]!.use;
          const use = deckUseWords(first);
          // Lists that use it another way (one has it in the sideboard) say so beside their name.
          const same = g.lists.every((l) => deckUseWords(l.use) === use);
          const deck = g.main ? <Link to={`/decks/${encodeURIComponent(g.main.deck_id)}`}>{g.name}</Link> : <span className="cp-deck-name">{g.name}</span>;
          return (
            <li key={first.deck_id}>
              {g.lists.length === 0 ? deck : (
                <span className="cp-deck-names">
                  {deck}
                  <span className="cp-deck-lists">
                    {g.main ? "Also in its lists: " : "In its lists: "}
                    {g.lists.map((l, i) => (
                      <Fragment key={l.use.deck_id}>
                        {i > 0 ? ", " : ""}
                        <Link to={`/decks/${encodeURIComponent(l.use.deck_id)}`} aria-label={l.use.name}>{l.label}</Link>
                        {same ? "" : ` (${deckUseWords(l.use)})`}
                      </Fragment>
                    ))}
                  </span>
                </span>
              )}
              <span className="cp-deck-use">{use}</span>
            </li>
          );
        })}
      </ul>
      {groups.length > DECKS_SHOWN && <ShowMore total={groups.length} noun="decks" expanded={all} onToggle={() => setAll((a) => !a)} />}
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
