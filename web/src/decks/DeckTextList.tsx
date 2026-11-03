import { listText } from "@yama/core";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { DeckView } from "../api";
import { useCopy } from "./ShareDeck";

/** Edits go through the existing import preview and card diff before a version is saved. */
export type TextDrafts = Map<string, { text: string; source: string }>;
export function DeckTextList({ deck, drafts }: { deck: DeckView; drafts: TextDrafts }) {
  const source = listText(deck.cards);
  const [text, setText] = useState(() => drafts.get(deck.id)?.text ?? source);
  const baseline = useRef(drafts.get(deck.id)?.source ?? source);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = source;
    setText((t) => t === previous ? source : t);
  }, [source]);
  const edit = (next: string) => { drafts.set(deck.id, { text: next, source }); setText(next); };
  const [copied, copy] = useCopy();
  const navigate = useNavigate();
  return <section className="deck-text-list" aria-label="Deck list as text">
    <label>Deck list<textarea value={text} onChange={(e) => edit(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" /></label>
    {text !== source && <p className="small dim" role="status">Unsaved list edits</p>}
    <div className="row">
      <button className="primary" onClick={() => navigate(`/decks/import?deck=${deck.id}`, { state: { deckId: deck.id, text } })}>Review changes</button>
      <button onClick={() => void copy(text)}>Copy list</button>
      <button className="quiet" onClick={() => edit(source)}>Reset</button>
    </div>
    {copied && <p className="small" role="status">{copied}</p>}
  </section>;
}
