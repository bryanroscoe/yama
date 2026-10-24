// While someone else's table-wide decision runs (GTogether), the rail on a laptop and the dock on a
// phone show its public part: the votes cast and who votes next, the piles, who has faced a
// villainous choice, or the cards a clash revealed. The deciding player's own dialog shows the same
// beside their choice (Decide.tsx). Words are in together.ts.

import { facingWord, pilesLine, tally, voterState } from "./together";
import { shortcutCount } from "./rare";
import type { CardMeta, SeenCard, TogetherView } from "./types";

const seatDot = (tone: string | undefined): React.CSSProperties | undefined => (tone ? ({ ["--seat" as string]: `var(--${tone})` } as React.CSSProperties) : undefined);

function Cards({ cards, meta }: { cards: SeenCard[]; meta: Record<string, CardMeta> }) {
  return (
    <span className="together-cards">
      {cards.map((c, i) => {
        const img = c.name ? meta[c.name]?.image : null;
        return img ? <img key={i} src={img} alt={c.name} title={c.name} /> : <span key={i} className="blank" title={c.name ?? "A card"} />;
      })}
    </span>
  );
}

export function TogetherBody({ t, meta, Who, tone, you, compact }: {
  t: TogetherView;
  meta: Record<string, CardMeta>;
  Who: (seat: number) => string;
  tone: (seat: number) => string | undefined;
  you: number | null;
  compact: boolean;
}) {
  const src = t.source.name ? meta[t.source.name] : undefined;
  const whose = (seat: number) => (seat === you ? "Your" : `${Who(seat)}'s`);
  const owner = t.kind === "vote" || t.kind === "branch" ? t.controller : t.kind === "piles" ? t.chooser : t.kind === "shortcut" ? t.shortcut.proposer : undefined;
  const head = (
    <span className="together-head">
      {src?.art ? <img src={src.art} alt="" /> : <span />}
      <span>
        <b>{owner !== undefined ? `${whose(owner)} ` : ""}{t.source.name ?? "A card"}</b>
        {src?.art && <span>Art: {src.artist ?? "unknown"}</span>}
      </span>
    </span>
  );
  const row = (seat: number, text: string, now = false) => (
    <span key={seat} className={`together-row${now ? " now" : ""}`} style={seatDot(tone(seat))}>
      <span className="seat-dot" aria-hidden="true" />
      <b>{seat === you ? "You" : Who(seat)}</b>
      <span>{text}</span>
    </span>
  );
  switch (t.kind) {
    case "vote": {
      const lead = tally(t);
      return (
        <div className="together" aria-label="The vote">
          {head}
          <span className="together-rows">{t.voters.map((v) => row(v.seat, voterState(t, v.seat), v.state === "voting"))}</span>
          {lead.length > 0 && (
            <span className="together-tally" aria-label="Votes so far">
              {lead.map((x) => (
                <span key={x.name}>
                  {x.name} {x.votes}
                </span>
              ))}
            </span>
          )}
          {t.secret && <span className="dim small">The votes are secret until everyone has voted.</span>}
        </div>
      );
    }
    case "piles":
      return (
        <div className="together" aria-label="The piles">
          {head}
          <span className="small">{pilesLine(t, Who, you)}</span>
          {t.split ? (
            <>
              <span className="together-pile">
                <b>Pile A, {t.pile_a?.length ?? 0}</b>
                <Cards cards={t.pile_a ?? []} meta={meta} />
              </span>
              <span className="together-pile">
                <b>Pile B, {t.pile_b?.length ?? 0}</b>
                <Cards cards={t.pile_b ?? []} meta={meta} />
              </span>
            </>
          ) : (
            <Cards cards={t.cards ?? []} meta={meta} />
          )}
          {!compact && <span className="pb-credit">Card images from Scryfall, © Wizards of the Coast.</span>}
        </div>
      );
    case "branch":
      return (
        <div className="together" aria-label="The villainous choice">
          {head}
          <span className="small dim">Each player faces it in turn. Everyone sees who has chosen, not what.</span>
          <span className="together-rows">{t.facing.map(([seat, state]) => row(seat, facingWord[state], state === "choosing"))}</span>
        </div>
      );
    case "shortcut": {
      // A proposed loop shortcut (GRareRules): what repeats and how often, and who has answered.
      const s = t.shortcut;
      const word = { answered: "Answered", deciding: "Deciding", next: "Next" } as const;
      return (
        <div className="together" aria-label="The shortcut">
          {head}
          <span className="small">
            {s.proposer === you ? "You propose" : `${Who(s.proposer)} proposes`} repeating it {shortcutCount(s.count)}.
            {s.grows?.length ? ` Grows without limit: ${s.grows.join(", ")}.` : ""}
          </span>
          <span className="together-rows">{s.responders.map(([seat, state]) => row(seat, word[state], state === "deciding"))}</span>
        </div>
      );
    }
    case "clash":
      return (
        <div className="together" aria-label="The clash">
          {head}
          <span className="together-rows">
            {t.cards.map(([seat, card]) => (
              <span key={seat} className={`together-row${seat === t.placing ? " now" : ""}`} style={seatDot(tone(seat))}>
                <span className="seat-dot" aria-hidden="true" />
                <b>{seat === you ? "You" : Who(seat)}</b>
                <span>{card.name ?? "A card"}{seat === t.placing ? ", placing it" : ""}</span>
              </span>
            ))}
          </span>
          <Cards cards={t.cards.map(([, c]) => c)} meta={meta} />
          {!compact && <span className="pb-credit">Card images from Scryfall, © Wizards of the Coast.</span>}
        </div>
      );
  }
}
