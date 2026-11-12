// Why this bracket (deck page SPEC 1b, board Deck): beside the Cards tab's list, the markers that
// set a bracket (Game Changers, two-card combos, mass land denial, extra turns, the Reserve List)
// with the power level from the Stats tab on top, and the bracket you tell the table. Previewing a lower bracket strikes the Game Changers its
// swap bag takes out. Explanations sit behind one "?".
import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { useDeckAnalysis } from "./DeckAnalysis";
import { playsLike } from "./statsTab";
import type { DeckAnalysis, DeckCheckResult, DeckView } from "../api";
import { SPELLBOOK, useDeckCheck } from "../components/Bracket";
import { DeclareBracket } from "../components/DeclareBracket";
import { gameChangerFloor, SENDS_LIST } from "../components/deckCheck";
import { CardHover } from "../components/CardRef";
import { HelpPopover } from "../components/HelpPopover";
import { fmtDate } from "@yama/core";
import { Button } from "../components/ui";

/** The Game Changers at the bracket shown: the list's own, minus any the swap bag takes out. */
export function gameChangersAt(listed: string[] | null, out: ReadonlySet<string>): { name: string; out: boolean }[] {
  return (listed ?? []).map((name) => ({ name, out: out.has(name) }));
}

/** What a combo does, short enough for the side column: its first two results. */
export function comboResult(results: string[]): string {
  if (!results.length) return "";
  const head = results.slice(0, 2).join(", ");
  return `${head}${results.length > 2 ? ", and more" : ""}.`;
}

const n = (count: number, none = "None") => (count ? String(count) : none);

export function WhyBracket({ deck, at, outAt, onCard }: { deck: DeckView; at: number | null; outAt: ReadonlySet<string>; onCard: (name: string) => void }) {
  const check = useDeckCheck(deck.id, deck.version_id);
  const power = useDeckAnalysis(deck.id, deck.version_id).data?.current ?? null;
  return (
    <WhyBracketPanel deck={deck} result={check.data?.result ?? null} power={power} statsHref={`/decks/${deck.id}/stats`} at={at} outAt={outAt} onCard={onCard}>
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
    </WhyBracketPanel>
  );
}

/**
 * The panel itself, from what it is given: a saved deck's stored check and analysis (WhyBracket),
 * or an unsaved list's (the Check a deck page), which has no outside check behind it: `unchecked`
 * is then what its combo rows say.
 */
export function WhyBracketPanel({
  deck,
  result: r,
  power,
  statsHref,
  at,
  outAt,
  onCard,
  unchecked = "Not checked yet",
  children,
}: {
  deck: Pick<DeckView, "bracket" | "cards" | "game_changers" | "game_changers_as_of" | "reserved_list">;
  result: DeckCheckResult | null;
  power: DeckAnalysis | null;
  statsHref: string;
  at: number | null;
  outAt: ReadonlySet<string>;
  onCard: (name: string) => void;
  unchecked?: string;
  children?: ReactNode;
}) {
  const gcs = gameChangersAt(deck.game_changers, outAt);
  const kept = gcs.filter((g) => !g.out).length;
  const twoCard = r?.combos.filter((x) => x.definitely_two_card) ?? [];
  const reserved = deck.reserved_list ?? null;
  const proxied = new Set(deck.cards.filter((e) => e.proxies > 0 && e.owned === 0).map((e) => e.name));
  const reservedProxies = reserved?.filter((x) => proxied.has(x)).length ?? 0;
  const shown = at ?? deck.bracket;
  // Rolling over a chip shows the card, the same preview as card names elsewhere.
  const imageOf = (name: string) => deck.cards.find((e) => e.name === name)?.card?.image_normal ?? null;
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
        {power && (
          <>
            <div>
              <dt>Power level, 1 to 10</dt>
              <dd>
                {power.power.toFixed(1)} <span className="dim">±{power.margin.toFixed(1)}</span>
              </dd>
            </div>
            <p className="why-bracket-note dim">
              {playsLike(power)}. <Link to={statsHref}>The dial and what moves it</Link>
            </p>
          </>
        )}
        <div>
          <dt>Game Changers</dt>
          <dd>{deck.game_changers ? n(kept) : "Not checked yet"}</dd>
        </div>
        {gcs.length > 0 && (
          <ul className="why-bracket-chips" aria-label="Game Changers">
            {gcs.map((g) => (
              <li key={g.name}>
                <Button className={g.out ? "out" : ""} onClick={() => onCard(g.name)} aria-label={g.out ? `${g.name}, out at Bracket ${at}` : g.name}>
                  <CardHover name={g.name} image={imageOf(g.name)} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <dt>Two-card combos</dt>
          <dd>{r ? n(twoCard.length, "None found") : unchecked}</dd>
        </div>
        {twoCard.length > 0 && (
          <ul className="why-bracket-combos" aria-label="Two-card combos">
            {twoCard.map((c) => (
              <li key={c.id}>
                <ul className="why-bracket-chips" aria-label={c.cards.join(" and ")}>
                  {c.cards.map((name) => (
                    <li key={name}>
                      <Button onClick={() => onCard(name)}>
                        <CardHover name={name} image={imageOf(name)} />
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="dim">
                  {c.templates.length > 0 && <>Plus {c.templates.join(", ").toLowerCase()}. </>}
                  {comboResult(c.results)}{" "}
                  <a href={`${SPELLBOOK}combo/${encodeURIComponent(c.id)}/`} target="_blank" rel="noreferrer">
                    How it works
                  </a>
                </p>
              </li>
            ))}
          </ul>
        )}
        <div>
          <dt>Mass land denial</dt>
          <dd>{r ? n(r.mld.length) : unchecked}</dd>
        </div>
        <div>
          <dt>Extra turns</dt>
          <dd>{r ? n(r.extra_turns.length) : unchecked}</dd>
        </div>
        <div>
          <dt>Reserve List</dt>
          <dd>{reserved ? (reserved.length ? `${reserved.length}${reservedProxies === reserved.length ? ", all proxies" : reservedProxies ? `, ${reservedProxies} proxies` : ""}` : "None") : "Not checked yet"}</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}
