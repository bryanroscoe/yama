import { EXPORT_FORMATS, exportDeck, exportFileName, type ExportFormat } from "@yama/core";
import { useMemo, useState } from "react";
import type { DeckView } from "../api";
import { saveFile } from "../download";
import { Dialog } from "./ui";
import "./decks.css";
import { CopyButton } from "./CopyButton";

const LAST_FORMAT = "yama.deck.exportFormat";

/** Copy or download the deck as text in one of the common formats. */
export function DeckExport({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>(() => {
    const saved = localStorage.getItem(LAST_FORMAT);
    return EXPORT_FORMATS.some((f) => f.value === saved) ? (saved as ExportFormat) : "names";
  });
  const text = useMemo(
    () =>
      exportDeck(
        deck.cards.map((e) => ({
          name: e.name,
          qty: e.qty,
          board: e.board,
          layout: e.card?.layout ?? null,
          setCode: e.printing?.set_code ?? null,
          collectorNumber: e.printing?.collector_number ?? null,
          finish: e.printing?.finish ?? null,
        })),
        format,
      ),
    [deck, format],
  );
  const fromDefault = deck.cards.filter((e) => e.board !== "side" && e.printing?.from === "default").length;
  const noPrinting = deck.cards.filter((e) => !e.printing).length;

  const pick = (f: ExportFormat) => {
    setFormat(f);
    localStorage.setItem(LAST_FORMAT, f);
  };
  const download = () => void saveFile(new Blob([text], { type: "text/plain;charset=utf-8" }), exportFileName(deck.name, format));

  return (
    <Dialog title="Export deck" onClose={onClose}>
      <div className="stack deck-export">
        <fieldset className="formats" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small dim" style={{ marginBottom: "0.4rem" }}>Format</legend>
          {EXPORT_FORMATS.map((f) => (
            <label key={f.value}>
              <input type="radio" name="export-format" checked={format === f.value} onChange={() => pick(f.value)} />
              {f.label}
              <span className="hint">{f.hint}</span>
            </label>
          ))}
        </fieldset>
        {format === "moxfield" && (fromDefault > 0 || noPrinting > 0) && (
          <p className="small dim" style={{ margin: 0 }}>
            {fromDefault > 0 && `${fromDefault} ${fromDefault === 1 ? "card isn't" : "cards aren't"} in your collection, so ${fromDefault === 1 ? "it names a paper printing" : "they name paper printings"}, Scryfall's default where that is one. `}
            {noPrinting > 0 && `${noPrinting} ${noPrinting === 1 ? "card has" : "cards have"} no paper printing on file and ${noPrinting === 1 ? "goes" : "go"} by name only.`}
          </p>
        )}
        <label>
          List
          <textarea readOnly value={text} onFocus={(e) => e.currentTarget.select()} aria-label="Deck list to copy" />
        </label>
        <div className="row">
          <CopyButton className="primary" text={text} label="Copy" />
          <button onClick={download}>Download .txt</button>
        </div>
      </div>
    </Dialog>
  );
}
