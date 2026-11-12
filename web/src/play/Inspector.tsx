// Reading a card (design/screens/GInspector, GInspectorPhone; the review's build plan section 10).
// Right-click or long-press opens it anywhere on the board; hover shows a large copy after 150 ms.
// Three tabs: the card's Oracle text, what it is now on the battlefield, and its rulings from
// Yama's card data. Keyword chips, a Flip button for a two-faced card, and the same options the
// rail offers for it. Only the card's real text: nothing written about it by Yama.

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { cardDetailQuery } from "../cardDetail";
import { Button, Dialog, Loading } from "../components/ui";
import { faceOf, inspectorFacts, inspectorTabs, type InspectorTab, type Names } from "./feed";
import type { CardMeta, CardView, OptionView, View } from "./types";
import { fmtDate } from "@yama/core";
import { useModalLayer } from "../components/Dialog";

const SOURCES: Record<string, string> = { wotc: "Wizards of the Coast", scryfall: "Scryfall" };

export function CardReader(props: {
  card: CardView;
  meta?: CardMeta;
  view: View;
  names: Names;
  cardById: Map<number, CardView>;
  options: OptionView[];
  onChoose: (o: OptionView) => void;
  onClose: () => void;
  disabled: boolean;
  /** More things to do with it (a trigger on the stack: always pass for it). */
  extra?: React.ReactNode;
  /** A laptop: a dialog over the table. A phone: a sheet from the bottom. */
  wide: boolean;
}) {
  const { card, meta, wide, onClose } = props;
  const body = <InspectorBody {...props} />;
  if (!wide) return <Dialog label={card.name} onClose={onClose}>{body}</Dialog>;
  return (
    <WideOverlay onClose={onClose}>
      <section className="gi-dialog" role="dialog" aria-modal="true" aria-label={card.name} onClick={(e) => e.stopPropagation()}>
        {body}
      </section>
    </WideOverlay>
  );
}

function InspectorBody({ card, meta, view, names, cardById, options, onChoose, onClose, disabled, extra, wide }: Parameters<typeof CardReader>[0]) {
  const onField = view.battlefield.some((c) => c.id === card.id);
  const tabs = inspectorTabs(card, onField);
  const [tab, setTab] = useState<InspectorTab>("text");
  // A transformed card starts on its back face.
  const [back, setBack] = useState(!!card.transformed);
  const face = meta ? faceOf(meta.oracle_text, meta.type_line, back) : null;
  const twoFaced = !!meta && (!!meta.back_image || (face?.faces ?? 1) > 1);
  const image = back && meta?.back_image ? meta.back_image : meta?.image;
  // A back face has its own cost only on a modal two-faced card; a transforming card's has none.
  const costs = (meta?.mana_cost ?? "").split(" // ");
  const cost = back ? (costs.length > 1 ? costs[1] : "") : costs[0];
  const tax = card.tax ?? 0;
  const whose = card.owner === names.you ? "Your" : `${names.Who(card.owner)}'s`;
  const chips = [
    card.power !== null && card.toughness !== null && card.id >= 0 ? `${card.power}/${card.toughness}` : null,
    ...(card.keywords ?? []),
    card.commander ? `${whose} commander` : null,
    card.face_down ? (card.under || card.name !== "Face-down card" ? "Face down: only you can see what it is" : "Face down") : null,
    onField ? (card.tapped ? "Tapped" : "Untapped") : null,
    onField && card.sick ? "Summoning sick" : null,
  ].filter((c): c is string => !!c);
  const shown = tabs.some((t) => t.id === tab) ? tab : "text";
  return (
    <div className={`gi${wide ? " wide" : ""}`}>
      <div className="gi-card">
        {image ? <img src={image} alt={card.name} /> : <span className="gi-blank">{card.name}</span>}
        {meta?.artist && <span className="gi-credit">Art: {meta.artist}, © Wizards of the Coast. Image from Scryfall.</span>}
        {twoFaced && (
          <Button variant="outline" className="gi-flip" onClick={() => setBack((b) => !b)} aria-pressed={back}>
            Flip
          </Button>
        )}
      </div>
      <div className="gi-main">
        <div className="gi-head">
          <span>
            <h2>{card.name}</h2>
            {face && (
              <span className="dim">
                {twoFaced && back ? "Back face: " : ""}
                {face.type}
                {cost ? `. ${cost}` : ""}
              </span>
            )}
          </span>
          <Button className="gi-close" aria-label="Close" onClick={onClose}>×</Button>
        </div>
        {chips.length > 0 && (
          <div className="gi-chips">
            {chips.map((c) => (
              <span key={c} className="gi-chip">{c}</span>
            ))}
          </div>
        )}
        {!!card.imprinted?.length && <p className="gi-imprint">Imprinted: {card.imprinted.join(", ")}{card.mana_colors?.length ? `. Mana colors: ${card.mana_colors.join(" / ")}` : ""}</p>}
        <div role="tablist" aria-label="About this card" className="gi-tabs">
          {tabs.map((t) => (
            <Button key={t.id} role="tab" aria-selected={shown === t.id} className={shown === t.id ? "on" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </Button>
          ))}
        </div>
        <div className="gi-panel" role="tabpanel">
          {shown === "text" &&
            (face?.text ? (
              <div className="gi-oracle">
                {face.text.split("\n").map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
                <span className="dim small">Oracle text, from Scryfall.</span>
              </div>
            ) : (
              <p className="dim">{card.face_down ? "A face-down card has no text you can see." : "No rules text."}</p>
            ))}
          {shown === "now" && (
            <dl className="gi-facts">
              {inspectorFacts(card, view, names, cardById, tax).map((r) => (
                <div key={r.k}>
                  <dt>{r.k}</dt>
                  <dd>{r.v}</dd>
                </div>
              ))}
            </dl>
          )}
          {shown === "rulings" && <RulingsList oracleId={meta?.oracle_id} />}
        </div>
        <div className="gi-do">
          <b>What you can do with it</b>
          {options.length > 0 ? (
            <div className="inspector-options">
              {options.map((o, i) => (
                <Button key={o.index} variant={i === 0 && options.length === 1 ? "primary" : "outline"} onClick={() => onChoose(o)} disabled={disabled}>
                  {o.label}
                </Button>
              ))}
            </div>
          ) : (
            !extra && <span className="gi-nothing">Nothing right now.</span>
          )}
          {extra}
        </div>
      </div>
    </div>
  );
}

/** The card's rulings as Yama stores them from Scryfall, each with its date and source. */
function RulingsList({ oracleId }: { oracleId?: string }) {
  const detail = useQuery({ ...cardDetailQuery(oracleId ?? ""), enabled: !!oracleId });
  if (!oracleId) return <p className="dim">No rulings for this card.</p>;
  if (detail.isLoading) return <Loading>Loading rulings…</Loading>;
  const rulings = detail.data?.rulings;
  if (rulings === undefined) return <p className="dim">Rulings aren't on this device.</p>;
  if (rulings === null) return <p className="dim">Rulings aren't loaded on this server yet.</p>;
  if (!rulings.length) return <p className="dim">No rulings for this card.</p>;
  return (
    <ol className="gi-rulings">
      {rulings.map((r, i) => (
        <li key={i}>
          <p>{r.comment}</p>
          <span className="dim small">
            {fmtDate(r.published_at)}, {SOURCES[r.source] ?? r.source}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A laptop's dialog over the table (the card reader, a zone's cards): a modal layer like the
 * phone's sheet, so Escape closes the one on top and Tab stays in it.
 */
export function WideOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useModalLayer(root, onClose);
  return (
    <div ref={root} className="gi-overlay" tabIndex={-1} style={{ outline: "none" }} onClick={onClose} {...layer}>
      {children}
    </div>
  );
}
