// Why this bracket (deck page SPEC 1b, board Deck): beside the Cards tab's list, the markers that
// set a bracket (Game Changers, two-card combos, mass land denial, extra turns, the Reserve List)
// and the bracket you tell the table. Previewing a lower bracket strikes the Game Changers its
// swap bag takes out. Explanations sit behind one "?".
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import type { DeckView } from "../api";
import { useDeckCheck } from "../components/Bracket";
import { DeclareBracket } from "../components/DeclareBracket";
import { gameChangerFloor, SENDS_LIST } from "../components/deckCheck";
import { HelpPopover } from "../components/HelpPopover";
import { fmtDate } from "@yama/core";

/** The Game Changers at the bracket shown: the list's own, minus any the swap bag takes out. */
export function gameChangersAt(listed: string[] | null, out: ReadonlySet<string>): { name: string; out: boolean }[] {
  return (listed ?? []).map((name) => ({ name, out: out.has(name) }));
}

const n = (count: number, none = "None") => (count ? String(count) : none);

export function WhyBracket({ deck, at, outAt, onCard }: { deck: DeckView; at: number | null; outAt: ReadonlySet<string>; onCard: (name: string) => void }) {
  const check = useDeckCheck(deck.id, deck.version_id);
  const r = check.data?.result ?? null;
  const gcs = gameChangersAt(deck.game_changers, outAt);
  const kept = gcs.filter((g) => !g.out).length;
  const twoCard = r?.combos.filter((x) => x.definitely_two_card) ?? [];
  const reserved = deck.reserved_list ?? null;
  const proxied = new Set(deck.cards.filter((e) => e.proxies > 0 && e.owned === 0).map((e) => e.name));
  const reservedProxies = reserved?.filter((x) => proxied.has(x)).length ?? 0;
  const shown = at ?? deck.bracket;
  // The hero's Bracket tile links here (#why-bracket-head); the router doesn't scroll to a hash.
  const { hash, key } = useLocation();
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (hash === "#why-bracket-head") box.current?.scrollIntoView({ block: "start" });
  }, [hash, key]);
  return (
    <section ref={box} className="why-bracket" aria-labelledby="why-bracket-head">
      <span className="why-bracket-title">
        <h2 id="why-bracket-head">{shown != null ? `Why Bracket ${shown}` : "Why this bracket"}</h2>
        <HelpPopover label="brackets">
          <p>{deck.game_changers ? gameChangerFloor(kept) : "Game Changer flags aren't loaded on this server yet."}</p>
          <p>
            {[
              deck.game_changers_as_of ? `Game Changers: Scryfall, ${fmtDate(deck.game_changers_as_of)}` : null,
              r ? `Combos, land denial and extra turns: Commander Spellbook, ${fmtDate(r.checked_at)}` : null,
            ]
              .filter(Boolean)
              .join(". ")}
          </p>
        </HelpPopover>
      </span>
      <dl className="why-bracket-rows">
        <div>
          <dt>Game Changers</dt>
          <dd>{deck.game_changers ? n(kept) : "Not checked yet"}</dd>
        </div>
        {gcs.length > 0 && (
          <ul className="why-bracket-chips" aria-label="Game Changers">
            {gcs.map((g) => (
              <li key={g.name}>
                <button type="button" className={g.out ? "out" : ""} onClick={() => onCard(g.name)} aria-label={g.out ? `${g.name}, out at Bracket ${at}` : g.name}>
                  {g.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <dt>Two-card combos</dt>
          <dd>{r ? n(twoCard.length, "None found") : "Not checked yet"}</dd>
        </div>
        <div>
          <dt>Mass land denial</dt>
          <dd>{r ? n(r.mld.length) : "Not checked yet"}</dd>
        </div>
        <div>
          <dt>Extra turns</dt>
          <dd>{r ? n(r.extra_turns.length) : "Not checked yet"}</dd>
        </div>
        <div>
          <dt>Reserve List</dt>
          <dd>{reserved ? (reserved.length ? `${reserved.length}${reservedProxies === reserved.length ? ", all proxies" : reservedProxies ? `, ${reservedProxies} proxies` : ""}` : "None") : "Not checked yet"}</dd>
        </div>
      </dl>
      <DeclareBracket deckId={deck.id} declared={deck.bracket} />
      {/* The list goes to an outside service: always say so where its answers show (ARCHITECTURE.md). */}
      {check.data?.enabled && (
        <p className="why-bracket-source dim">
          {SENDS_LIST} Combos and flags from{" "}
          <a href={check.data.source_url || "https://commanderspellbook.com/"} target="_blank" rel="noreferrer">
            Commander Spellbook
          </a>
          .
        </p>
      )}
    </section>
  );
}
