// The deck page's header (design: deck page SPEC sections 0 and 0b; boards Deck and PhoneDeck):
// the status pill and line, the Bracket, Value and Record tiles, and the List picker that switches
// between the list in the box, saved lists and older snapshots.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type ConfigurationRef, type DeckSummary, type DeckView } from "../api";
import { bracketName } from "../components/Bracket";
import { neededCost } from "../components/DeckPrices";
import { MenuSeparator, MoreMenu } from "../components/MoreMenu";
import { Button, ErrorText } from "../components/ui";
import { configurationLabel, legacyConfiguration } from "./buildCatalog";
import { deckLists, listLabel } from "./DeckLists";
import { shortDate, usd } from "@yama/core";

type Tone = "good" | "warn" | "bad" | "dim";

/** The one status pill and its plain line under the title. */
export function deckStatus(d: Pick<DeckView, "id" | "parent_id" | "configurations" | "acquisition_status" | "validation" | "ownership">): { tone: Tone; pill: string; line: string } {
  const v = d.validation;
  const o = d.ownership;
  const lists = deckLists(d);
  const proxies = o.proxies ?? 0;
  const real = proxies ? `${o.owned} real, ${proxies} ${proxies === 1 ? "proxy" : "proxies"}` : o.owned >= o.cards ? `All ${o.cards} real` : `${o.owned} of ${o.cards} real`;
  const legal = v.ok ? "Commander-legal" : v.errors[0] ?? "Not legal yet";
  if (lists?.here === "other") return { tone: "dim", pill: "Saved list", line: "Not the list in your box" };
  if (d.acquisition_status === "planned") return { tone: "dim", pill: "Planned deck", line: v.ok ? "Commander-legal" : legal };
  if (!v.ok) return { tone: "bad", pill: "Not legal yet", line: legal };
  if (o.needed > 0) {
    // What's left costs, with its date; unknown stays unknown (never $0).
    const cost = neededCost(o);
    const day = shortDate(o.price_date);
    const left = cost != null ? `. ${usd(cost)} to finish${o.needed_without_price ? `, ${o.needed_without_price} without a price` : ""}${day ? `, ${day}` : ""}` : "";
    return { tone: "warn", pill: `Need ${o.needed} ${o.needed === 1 ? "card" : "cards"}`, line: `Commander-legal. ${real}${left}` };
  }
  return { tone: "good", pill: "Ready to play", line: `Commander-legal. ${real}` };
}

/** "3 wins in 7 games", or null before the first game. */
export function recordLine(s: Pick<DeckSummary, "games" | "wins"> | undefined): { big: string; line: string } {
  if (!s?.games) return { big: "0", line: "No games yet" };
  const wins = s.wins ?? 0;
  return { big: String(wins), line: `${wins === 1 ? "win" : "wins"} in ${s.games} ${s.games === 1 ? "game" : "games"}` };
}

/** The three tiles on the hero's right (under it on a phone). Each opens its detail. */
export function DeckTiles({ deck, summary, measures, hrefFor }: { deck: DeckView; summary: DeckSummary | undefined; measures: number | null; hrefFor: (tab: string) => string }) {
  const value = deck.singles_value;
  const rec = recordLine(summary);
  const declared = deck.bracket;
  const measured = measures != null ? `measures ${measures}` : null;
  return (
    <div className="deck-head-tiles">
      <Link className="deck-head-tile" to={`${hrefFor("cards")}#why-bracket-head`}>
        <span className="deck-head-tile-label">Bracket</span>
        <b className="num">{declared ?? "None"}</b>
        <span className="deck-head-tile-note">
          {declared != null ? [bracketName(declared), measured].filter(Boolean).join(", ") : measured ? `Not declared, ${measured}` : "Not declared"}
        </span>
      </Link>
      <Link className="deck-head-tile" to={hrefFor("stats")}>
        <span className="deck-head-tile-label">Value</span>
        <b className="num">{value?.usd != null ? usd(value.usd) : "No price"}</b>
        <span className="deck-head-tile-note">
          {[value?.usd != null && value.unpriced_copies > 0 ? `Partial, ${value.unpriced_copies} without a price` : null, value?.newest_date ? `${value.source}, ${shortDate(value.newest_date)}` : "Market, singles"].filter(Boolean).join(". ")}
        </span>
      </Link>
      <Link className="deck-head-tile" to={hrefFor("history")}>
        <span className="deck-head-tile-label">Record</span>
        <b className="num">{rec.big}</b>
        <span className="deck-head-tile-note">{rec.line}</span>
      </Link>
    </div>
  );
}

/** The picker's groups, in order: the list in the box, saved lists, then older snapshots. */
export function pickerGroups(deck: Pick<DeckView, "id" | "parent_id" | "configurations">): { box: ConfigurationRef; saved: ConfigurationRef[]; older: ConfigurationRef[] } {
  const lists = deckLists(deck);
  const box = lists?.main ?? deck.configurations.find((c) => c.id === deck.id) ?? { id: deck.id, name: "", configuration: null, visibility: "private", share_token: null };
  const others = lists?.others ?? [];
  return { box, saved: others.filter((c) => !legacyConfiguration(c.configuration)), older: others.filter((c) => legacyConfiguration(c.configuration)) };
}

/**
 * One List picker (SPEC 0b): which list of this deck you're looking at. Replaces the hero's
 * configuration pills, Older snapshots and the Lists panel.
 */
export function ListPicker({
  deck,
  shownId,
  onPrefetch,
  onNewList,
  variants,
  brackets = [],
  boxBracket = null,
  at = null,
  atHref,
}: {
  deck: DeckView;
  /** The list the page is opening (differs from `deck.id` while the next one loads). */
  shownId: string;
  onPrefetch: (id: string) => void;
  onNewList: () => void;
  variants: { id: string; label: string; href: string }[];
  /** The brackets the plan's swap bags reach from the box, with how many swaps each takes. */
  brackets?: { bracket: number; count: number }[];
  /** The bracket the box is kept at, from the plan. */
  boxBracket?: number | null;
  /** The bracket being previewed with the swap bag, if any. */
  at?: number | null;
  atHref?: (bracket: number | null) => string;
}) {
  const { box, saved, older } = pickerGroups(deck);
  const current = deck.configurations.find((c) => c.id === shownId);
  const onBox = !current || current.id === box.id;
  const boxName = configurationLabel(box.configuration, box.name, true);
  const atBracket = (b: number | null) => (b != null ? `${boxName}, Bracket ${b}` : boxName);
  const label = !onBox ? listLabel(current!, false) : atBracket(at ?? boxBracket);
  const item = (c: ConfigurationRef, main: boolean, note?: string) => (
    <Link
      key={c.id}
      to={`/decks/${c.id}`}
      aria-current={c.id === shownId ? "page" : undefined}
      onMouseEnter={() => onPrefetch(c.id)}
      onFocus={() => onPrefetch(c.id)}
    >
      <span>{main ? configurationLabel(c.configuration, c.name, true) : listLabel(c, false)}</span>
      {note && <span className="more-menu-note">{note}</span>}
    </Link>
  );
  return (
    <div className="deck-list-picker">
      <span className="deck-list-picker-label" aria-hidden="true">List</span>
      <MoreMenu className="deck-list-picker-button" label={<span><span className="phone-only dim">List </span>{label}</span>} title="Which list">
        <span className="more-menu-head">In the box</span>
        {onBox && atHref ? (
          <Link to={atHref(null)} aria-current={at == null ? "page" : undefined}><span>{atBracket(boxBracket)}</span></Link>
        ) : (
          item(box, true)
        )}
        {onBox && atHref && brackets.length > 0 && <MenuSeparator />}
        {onBox && atHref && brackets.length > 0 && <span className="more-menu-head">With the swap bag</span>}
        {onBox && atHref && brackets.map((b) => (
          <Link key={b.bracket} to={atHref(b.bracket)} aria-current={at === b.bracket ? "page" : undefined}>
            <span>{atBracket(b.bracket)}</span>
            <span className="more-menu-note">{b.count} {b.count === 1 ? "swap" : "swaps"}</span>
          </Link>
        ))}
        {saved.length > 0 && <MenuSeparator />}
        {saved.length > 0 && <span className="more-menu-head">Saved lists</span>}
        {saved.map((c) => item(c, false))}
        {older.length > 0 && <MenuSeparator />}
        {older.length > 0 && <span className="more-menu-head">Older snapshots</span>}
        {older.map((c) => item(c, false))}
        {variants.length > 0 && <MenuSeparator />}
        {variants.length > 0 && <span className="more-menu-head">Playgroup variants</span>}
        {variants.map((v) => <Link key={v.id} to={v.href}>{v.label}</Link>)}
        <MenuSeparator />
        <Button onClick={onNewList}>Save a copy as a new list</Button>
        <Link to={`/decks/builds?savedDeck=${box.id}`}>Print swap cards</Link>
      </MoreMenu>
    </div>
  );
}

/** Looking at a saved list: one line and "Put this list in the box", confirmed inline. */
export function SavedListBar({ deck }: { deck: DeckView }) {
  const lists = deckLists(deck);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  // One op id per list asked for: a retry reuses it.
  const ops = useRef(new Map<string, string>());
  const opFor = (target: string) => ops.current.get(target) ?? ops.current.set(target, crypto.randomUUID()).get(target)!;
  const use = useMutation({
    mutationFn: (from: string) => api<{ version_id: string | null; changed: boolean }>(`/api/decks/${lists!.main.id}/use`, { method: "POST", json: { from, op_id: opFor(from) } }),
    onSuccess: (_, from) => {
      ops.current.delete(from);
      setAsking(false);
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions"] });
      // Installed swaps are read from the main deck's list.
      void qc.invalidateQueries({ queryKey: ["plan"] });
      navigate(`/decks/${lists!.main.id}`);
    },
  });
  if (!lists || lists.here !== "other") return null;
  return (
    <section className="deck-saved-bar" aria-label="This saved list">
      <span>
        A saved list, not the one in your box. <Link to={`/decks/${lists.main.id}`}>Open the list in the box</Link>
      </span>
      {!asking ? (
        <Button onClick={() => { use.reset(); setAsking(true); }}>Put this list in the box</Button>
      ) : (
        <span className="deck-saved-confirm" role="group" aria-label="Confirm">
          <span>The current list stays in History.</span>
          <Button variant="primary" disabled={use.isPending} onClick={() => use.mutate(deck.id)}>{use.isPending ? "Putting it in…" : "Put it in"}</Button>
          <Button variant="quiet" onClick={() => setAsking(false)}>Cancel</Button>
        </span>
      )}
      <ErrorText error={use.error} />
    </section>
  );
}
