// The cards added since the scanner opened, newest first, each fixable in place: copies, finish,
// printing, or take it back out. See session.ts for how a fix leaves earlier copies alone.

import { useState } from "react";
import { copyWords, finishesOf, finishName, pickFinish, treatmentLabel } from "@yama/core";
import type { Printing } from "../api";
import { pricesOf } from "./price";
import { printingOptions } from "./printings";
import { removeFix, treatmentOf, type Added, type Finish, type Fix } from "./session";
import { Button, CardThumb, DialogHead, ErrorText, Field, Loading } from "../components/ui";

const PRINTINGS_FIRST = 12;

export interface AddedListProps {
  added: Added[];
  /** Apply a fix; rejects with a message to show. */
  onFix: (a: Added, fix: Fix) => Promise<void>;
  /** Send an entry's unconfirmed write again, unchanged; rejects with a message to show. */
  onRetry: (a: Added) => Promise<void>;
  onClose: () => void;
}

export function AddedList({ added, onFix, onRetry, onClose }: AddedListProps) {
  const copies = added.reduce((n, a) => n + a.copies, 0);
  return (
    <div className="scan-added">
      <DialogHead onClose={onClose}>Added while scanning</DialogHead>
      <p className="dim small">
        {copies === 1 ? "1 card" : `${copies} cards`}, newest first. Fixes change only the copies added here.
      </p>
      {added.length === 0 ? <p className="dim">Nothing added yet.</p> : (
        <ul className="scan-added-list">
          {added.map((a) => <AddedRow key={a.key} a={a} onFix={onFix} onRetry={onRetry} />)}
        </ul>
      )}
    </div>
  );
}

function AddedRow({ a, onFix, onRetry }: { a: Added; onFix: AddedListProps["onFix"]; onRetry: AddedListProps["onRetry"] }) {
  const [working, setWorking] = useState(false);
  // An unconfirmed write (kept on the entry, so it survives closing this list) locks the entry:
  // the only thing to do with a failed one is send it again as it was.
  const busy = working || !!a.pending || !!a.checking;
  const [error, setError] = useState<string | null>(null);
  const [printings, setPrintings] = useState<Printing[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const base: Fix = { scryfall_id: a.scryfall_id, set: a.set, number: a.number, name: a.name, image: a.image, finish: a.finish, finishes: a.finishes, treatment: a.treatment, copies: a.copies, prices: a.prices };
  // The finishes its printing comes in, plus Proxy, and always its own.
  const finishChoices = [...new Set([...finishesOf({ finishes: a.finishes }), "proxy", a.finish])] as Finish[];

  const attempt = async (write: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await write();
      setPrintings(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const run = (fix: Fix) => attempt(() => onFix(a, fix));
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
        <CardThumb className="scan-added-thumb" src={a.image} fallback={<span className="scan-added-thumb card-fallback" aria-hidden="true" />} />
        <div className="scan-added-info">
          <strong>{a.name}</strong>
          <span className="dim small">
            {a.set.toUpperCase()} #{a.number}, {a.finish === "proxy" ? "proxy" : copyWords(a.treatment ?? {}, a.finish)}
            {a.auto ? ", added by Keep adding" : ""}
          </span>
          <div className="scan-added-actions">
            <Field className="scan-copies" label="Copies">
              <select value={a.copies} disabled={busy} onChange={(e) => void run({ ...base, copies: Number(e.target.value) })}>
                {Array.from({ length: Math.max(10, a.copies) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field className="scan-copies" label="Finish">
              <select value={a.finish} disabled={busy} onChange={(e) => void run({ ...base, finish: e.target.value as Finish })}>
                {finishChoices.map((f) => (
                  <option key={f} value={f}>
                    {finishName(f)}
                  </option>
                ))}
              </select>
            </Field>
            <Button className="scan-alt" disabled={busy} onClick={() => void openPrintings()}>
              {printings ? "Keep this printing" : "Wrong printing?"}
            </Button>
            <Button className="scan-alt" disabled={busy} onClick={() => void run(removeFix(a))}>
              Remove
            </Button>
          </div>
        </div>
      </div>
      {a.pending && !a.pending.error && <Loading small quiet>Saving…</Loading>}
      {a.pending?.error && (
        <div className="scan-step is-tap" role="alert">
          <p>
            <strong>{a.pending.fix ? "This change may not have saved." : "This card may not have saved."}</strong> {a.pending.error.replace(/\.$/, "")}. Try again sends the same{" "}
            {a.pending.fix ? "change" : "card"}, so nothing is added twice.
          </p>
          <Button variant="primary" disabled={working} onClick={() => void attempt(() => onRetry(a))}>
            Try again
          </Button>
        </div>
      )}
      {!a.pending?.error && <ErrorText error={error} />}
      {printings && (
        <div className="scan-printings" role="listbox" aria-label={`Printings of ${a.name}`}>
          {(showAll ? printings : printings.slice(0, PRINTINGS_FIRST)).map((p) => (
            <Button
              key={p.scryfall_id}
              role="option"
              aria-selected={p.scryfall_id === a.scryfall_id}
              className={`scan-printing${p.scryfall_id === a.scryfall_id ? " is-chosen" : ""}`}
              disabled={busy}
              onClick={() =>
                // Another printing keeps the finish if it comes that way (a proxy stays a proxy), else takes its own.
                void run({ ...base, scryfall_id: p.scryfall_id, set: p.set_code, number: p.collector_number, name: p.name, image: p.image_small, prices: pricesOf(p), finishes: p.finishes, treatment: treatmentOf(p), finish: a.finish === "proxy" ? "proxy" : (pickFinish(p, a.finish) as Finish) })
              }
            >
              <CardThumb src={p.image_small} fallback={<span className="card-fallback" aria-hidden="true" />} />
              <span className="scan-printing-set">{p.set_name}</span>
              {p.scryfall_id === a.scryfall_id && <span className="scan-misread">Added as this</span>}
              <span className="dim">
                #{p.collector_number}
                {p.released_at ? `, ${p.released_at.slice(0, 4)}` : ""}
                {p.lang !== "en" ? `, ${p.lang}` : ""}
                {treatmentLabel(p) ? `, ${treatmentLabel(p)}` : ""}
              </span>
            </Button>
          ))}
          {!showAll && printings.length > PRINTINGS_FIRST && (
            <Button className="scan-alt" onClick={() => setShowAll(true)}>
              Show all {printings.length}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
