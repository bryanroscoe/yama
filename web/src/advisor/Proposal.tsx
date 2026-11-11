import { CardRef } from "../components/CardRef";
import { Fragment } from "react";
import { Details, ManaCost, ZoomableCard } from "../components/ui";
import type { ProposalCard, ProposalPreview } from "./api";
import { inline, parseAnswer } from "./logic";
import { plural } from "@yama/core";

function InlineText({ text }: { text: string }) {
  return <>{inline(text).map((s, i) => s.bold ? <b key={i}>{s.text}</b> : s.code ? <code key={i}>{s.text}</code> : <Fragment key={i}>{s.text}</Fragment>)}</>;
}

/** A deck list's line: "1 Sol Ring". */
const DECK_LINE = /^\d+x?\s+\S/;
/** A deck list's section line: "Commander", "Deck", "Sideboard:". */
const DECK_SECTION = /^(commanders?|deck|main(board)?|sideboard|companion|maybeboard):?$/i;

/** A pasted deck list, one card a line, would otherwise join into one run-on paragraph. */
function keepDeckLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Inside a ``` fence the lines are kept as they are already.
  let fenced = false;
  const inFence = lines.map((l) => (/^\s*```/.test(l) ? ((fenced = !fenced), true) : fenced));
  const deck = lines.map((l, i) => !inFence[i] && DECK_LINE.test(l.trim()));
  // A deck list is a run under a section line ("Commander", "Deck") or a long run (five or
  // more); two sentences that happen to open with numbers ("3 lands cut.") stay prose.
  const listed = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && deck[j]) j++;
    if (j > i && (j - i >= 5 || DECK_SECTION.test(lines[i - 1]?.trim() ?? ""))) listed.fill(true, i, j);
    i = Math.max(j, i + 1);
  }
  return lines.map((l, i) => (listed[i] ? `- ${l.trim()}` : l)).join("\n");
}

/** Small, text-only Markdown vocabulary; external content is never interpreted as HTML. */
export function ProposalText({ text }: { text: string }) {
  // Older tools put "Why:" before the first numbered reason, hiding its list structure.
  const blocks = parseAnswer(keepDeckLines(text.replace(/^Why:\s*(?=\d+[.)]\s)/, "")));
  return <div className="proposal-text">{blocks.map((b, i) => {
    if (b.kind === "list") {
      const List = b.ordered ? "ol" : "ul";
      const deck = !b.ordered && b.items.every((item) => DECK_LINE.test(item));
      return <List key={i} className={deck ? "proposal-deck-list" : undefined}>{b.items.map((item, n) => <li key={n}><InlineText text={item} /></li>)}</List>;
    }
    if (b.kind === "heading") return <h4 key={i}><InlineText text={b.text} /></h4>;
    if (b.kind === "code" || b.kind === "suggestion") return <pre key={i}>{b.kind === "code" ? b.text : b.raw}</pre>;
    return <p key={i}><InlineText text={b.text} /></p>;
  })}</div>;
}

function CardList({ cards, label }: { cards: ProposalCard[]; label: string }) {
  return <section className="proposal-card-group" aria-label={label}>
    <h4>{label}</h4>
    {cards.length ? <ul className="proposal-cards">{cards.map((c) => <li key={c.oracle_id ?? c.name}>
      {c.image && <ZoomableCard src={c.image} name={c.name} className="proposal-card-image" />}
      <div className="proposal-card-info">
        <p className="proposal-card-name">{c.qty > 1 && <span>{c.qty} × </span>}<CardRef name={c.name} oracleId={c.oracle_id} image={c.image}/></p>
        <ManaCost cost={c.mana_cost} />
        {c.type_line && <p className="small dim">{c.type_line}</p>}
      </div>
    </li>)}</ul> : <p className="dim small">None</p>}
  </section>;
}

export function proposalCounts(preview: ProposalPreview): string {
  const count = (cards: ProposalCard[]) => cards.reduce((n, c) => n + c.qty, 0);
  const words = (n: number) => plural(n, "card");
  return `${words(count(preview.add))} in, ${words(count(preview.remove))} out`;
}

/** Add/remove sets are independent: their array positions do not assert one-to-one swaps. */
export function Proposal({ preview }: { preview: ProposalPreview }) {
  return <div className="proposal">
    <p className="dim small">{preview.kind === "plan_swap" ? "Plan suggestion" : "Deck update"}: {proposalCounts(preview)}</p>
    <div className="proposal-card-columns">
      <CardList cards={preview.add} label="Cards to add" />
      <CardList cards={preview.remove} label="Cards to remove" />
    </div>
    {preview.explanation && <section className="proposal-reasons" aria-label="Why these changes">
      <h4>Why these changes</h4>
      <ProposalText text={preview.explanation} />
    </section>}
    {preview.checks && <Details label="Deck checks"><ul className="proposal-checks">
      {preview.checks.split("\n").filter((line) => line.trim()).map((line, i) => <li key={i}>{line}</li>)}
    </ul></Details>}
  </div>;
}
