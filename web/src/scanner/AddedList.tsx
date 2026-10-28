// The cards added since the scanner opened, newest first, each fixable in place: copies, finish,
// printing, or take it back out. See session.ts for how a fix leaves earlier copies alone.

import { useState } from "react";
import type { Printing } from "../api";
import { printingOptions } from "./printings";
import type { Added, Finish, Fix } from "./session";

const FINISH_LABEL: Record<Finish, string> = { nonfoil: "regular", foil: "foil", proxy: "proxy" };
const PRINTINGS_FIRST = 12;

export interface AddedListProps {
  added: Added[];
  /** Apply a fix; rejects with a message to show. */
  onFix: (a: Added, fix: Fix) => Promise<void>;
  onClose: () => void;
}

export function AddedList({ added, onFix, onClose }: AddedListProps) {
  const copies = added.reduce((n, a) => n + a.copies, 0);
  return (
    <div className="scan-added">
      <div className="sheet-head">
        <div>
          <h2>Added while scanning</h2>
          <p className="dim small">
            {copies === 1 ? "1 card" : `${copies} cards`}, newest first. Fixes change only the copies added here.
          </p>
        </div>
        <button onClick={onClose}>Back to scanning</button>
      </div>
      {added.length === 0 ? <p className="dim">Nothing added yet.</p> : (
        <ul className="scan-added-list">
          {added.map((a) => <AddedRow key={a.key} a={a} onFix={onFix} />)}
        </ul>
      )}
    </div>
  );
}

function AddedRow({ a, onFix }: { a: Added; onFix: AddedListProps["onFix"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printings, setPrintings] = useState<Printing[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const base: Fix = { scryfall_id: a.scryfall_id, set: a.set, number: a.number, name: a.name, image: a.image, finish: a.finish, copies: a.copies };

  const run = async (fix: Fix) => {
    setBusy(true);
    setError(null);
    try {
      await onFix(a, fix);
      setPrintings(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const openPrintings = async () => {
    if (printings) return setPrintings(null);
    try {
      setPrintings((await printingOptions({ name: a.name })).printings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <li className="scan-added-row">
      <div className="scan-added-card">
        {a.image ? <img className="scan-added-thumb" src={a.image} alt="" loading="lazy" /> : <span className="scan-added-thumb card-fallback">{a.name}</span>}
        <div className="scan-added-info">
          <strong>{a.name}</strong>
          <span className="dim small">
            {a.set.toUpperCase()} #{a.number}, {FINISH_LABEL[a.finish]}
            {a.auto ? ", added by Keep adding" : ""}
          </span>
          <div className="scan-added-actions">
            <label className="scan-copies">
              Copies
              <select value={a.copies} disabled={busy} onChange={(e) => void run({ ...base, copies: Number(e.target.value) })}>
                {Array.from({ length: Math.max(10, a.copies) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="scan-copies">
              Finish
              <select value={a.finish} disabled={busy} onChange={(e) => void run({ ...base, finish: e.target.value as Finish })}>
                <option value="nonfoil">Regular</option>
                <option value="foil">Foil</option>
                <option value="proxy">Proxy</option>
              </select>
            </label>
            <button className="scan-alt" disabled={busy} onClick={() => void openPrintings()}>
              {printings ? "Keep this printing" : "Change printing"}
            </button>
            <button className="scan-alt" disabled={busy} onClick={() => void run({ ...base, copies: 0 })}>
              Remove
            </button>
          </div>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {printings && (
        <div className="scan-printings" role="listbox" aria-label={`Printings of ${a.name}`}>
          {(showAll ? printings : printings.slice(0, PRINTINGS_FIRST)).map((p) => (
            <button
              key={p.scryfall_id}
              role="option"
              aria-selected={p.scryfall_id === a.scryfall_id}
              className={`scan-printing${p.scryfall_id === a.scryfall_id ? " is-chosen" : ""}`}
              disabled={busy}
              onClick={() => void run({ ...base, scryfall_id: p.scryfall_id, set: p.set_code, number: p.collector_number, name: p.name, image: p.image_small })}
            >
              {p.image_small ? <img src={p.image_small} alt="" loading="lazy" /> : <span className="card-fallback">{p.name}</span>}
              <span className="scan-printing-set">{p.set_name}</span>
              <span className="dim">
                #{p.collector_number}
                {p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}
                {p.lang !== "en" ? `, ${p.lang}` : ""}
              </span>
            </button>
          ))}
          {!showAll && printings.length > PRINTINGS_FIRST && (
            <button className="scan-alt" onClick={() => setShowAll(true)}>
              Show all {printings.length}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
