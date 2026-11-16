// The cards added since the scanner opened, newest first, each fixable in place: copies, finish,
// printing, or take it back out. See session.ts for how a fix leaves earlier copies alone.
// `ScannedCard` is one of them large, opened from its tile in the scanner's strip (Bryan, 16 Nov
// 2026: "Being able to tap them to see them bigger, to make sure you get the right printing").

import { useState } from "react";
import { copyWords, finishesOf, finishName, pickFinish, shortDate, treatmentLabel, usd } from "@yama/core";
import type { Printing } from "../api";
import { playLine, PLAY_WORD, playTag, usePlayability } from "./playable";
import { priceFor, pricesOf } from "./price";
import { printingOptions } from "./printings";
import { removeFix, treatmentOf, type Added, type Finish, type Fix } from "./session";
import { ActionBar, Button, CardThumb, DialogHead, ErrorText, Field, Loading, Segmented, ZoomableCard } from "../components/ui";

const PRINTINGS_FIRST = 12;

export interface AddedListProps {
  added: Added[];
  /** Apply a fix; rejects with a message to show. */
  onFix: (a: Added, fix: Fix) => Promise<void>;
  /** Send an entry's unconfirmed write again, unchanged; rejects with a message to show. */
  onRetry: (a: Added) => Promise<void>;
  onClose: () => void;
  /** Open one card large (its ScannedCard). */
  onOpen?: (a: Added) => void;
}

export function AddedList({ added, onFix, onRetry, onClose, onOpen }: AddedListProps) {
  const copies = added.reduce((n, a) => n + a.copies, 0);
  return (
    <div className="scan-added">
      <DialogHead onClose={onClose}>Added while scanning</DialogHead>
      <p className="dim small">
        {copies === 1 ? "1 card" : `${copies} cards`}, newest first. Fixes change only the copies added here.
      </p>
      {added.length === 0 ? <p className="dim">Nothing added yet.</p> : (
        <ul className="scan-added-list">
          {added.map((a) => <AddedRow key={a.key} a={a} onFix={onFix} onRetry={onRetry} onOpen={onOpen} />)}
        </ul>
      )}
    </div>
  );
}

/** Scryfall's normal-size picture for the small one an entry keeps. */
export const normalOf = (src: string | null): string | null => (src ? src.replace(/\/small\//, "/normal/") : null);

/** The fixes an entry offers, shared by its row in the list and its large view. */
function useFixes(a: Added, onFix: AddedListProps["onFix"], onRetry: AddedListProps["onRetry"]) {
  const [working, setWorking] = useState(false);
  // An unconfirmed write (kept on the entry, so it survives closing this list) locks the entry:
  // the only thing to do with a failed one is send it again as it was.
  const busy = working || !!a.pending || !!a.checking;
  const [error, setError] = useState<string | null>(null);
  const [printings, setPrintings] = useState<Printing[] | null>(null);
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
  // Another printing keeps the finish if it comes that way (a proxy stays a proxy), else takes its own.
  const toPrinting = (p: Printing) =>
    void run({ ...base, scryfall_id: p.scryfall_id, set: p.set_code, number: p.collector_number, name: p.name, image: p.image_small, prices: pricesOf(p), finishes: p.finishes, treatment: treatmentOf(p), finish: a.finish === "proxy" ? "proxy" : (pickFinish(p, a.finish) as Finish) });
  const retry = () => void attempt(() => onRetry(a));
  return { working, busy, error, printings, base, finishChoices, run, openPrintings, toPrinting, retry };
}

type Fixes = ReturnType<typeof useFixes>;

/** Saving, or the failed write with Try again, or the last fix's error. */
function EntryState({ a, f }: { a: Added; f: Fixes }) {
  return (
    <>
      {a.pending && !a.pending.error && <Loading small quiet>Saving…</Loading>}
      {a.pending?.error && (
        <div className="scan-step is-tap" role="alert">
          <p>
            <strong>{a.pending.fix ? "This change may not have saved." : "This card may not have saved."}</strong> {a.pending.error.replace(/\.$/, "")}. Try again sends the same{" "}
            {a.pending.fix ? "change" : "card"}, so nothing is added twice.
          </p>
          <Button variant="primary" disabled={f.working} onClick={f.retry}>
            Try again
          </Button>
        </div>
      )}
      {!a.pending?.error && <ErrorText error={f.error} />}
    </>
  );
}

/** The card's printings, to move its copies to the right one. */
function PrintingChoices({ a, f }: { a: Added; f: Fixes }) {
  const [showAll, setShowAll] = useState(false);
  if (!f.printings) return null;
  return (
    <div className="scan-printings" role="listbox" aria-label={`Printings of ${a.name}`}>
      {(showAll ? f.printings : f.printings.slice(0, PRINTINGS_FIRST)).map((p) => (
        <Button
          key={p.scryfall_id}
          role="option"
          aria-selected={p.scryfall_id === a.scryfall_id}
          className={`scan-printing${p.scryfall_id === a.scryfall_id ? " is-chosen" : ""}`}
          disabled={f.busy}
          onClick={() => f.toPrinting(p)}
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
      {!showAll && f.printings.length > PRINTINGS_FIRST && (
        <Button size="small" onClick={() => setShowAll(true)}>
          Show all {f.printings.length}
        </Button>
      )}
    </div>
  );
}

function FinishChoice({ a, f, compact = false }: { a: Added; f: Fixes; compact?: boolean }) {
  return (
    <Segmented
      label="Finish"
      compact={compact}
      value={a.finish}
      disabled={f.busy}
      options={f.finishChoices.map((x) => [x, finishName(x)] as const)}
      onChange={(x) => {
        if (x !== a.finish) void f.run({ ...f.base, finish: x });
      }}
    />
  );
}

function AddedRow({ a, onFix, onRetry, onOpen }: { a: Added; onFix: AddedListProps["onFix"]; onRetry: AddedListProps["onRetry"]; onOpen?: AddedListProps["onOpen"] }) {
  const f = useFixes(a, onFix, onRetry);
  const thumb = <CardThumb className="scan-added-thumb" src={a.image} fallback={<span className="scan-added-thumb card-fallback" aria-hidden="true" />} />;
  return (
    <li className="scan-added-row">
      <div className="scan-added-card">
        {onOpen ? (
          <Button className="scan-added-open" onClick={() => onOpen(a)} aria-label={`Show ${a.name} larger`}>
            {thumb}
          </Button>
        ) : (
          thumb
        )}
        <div className="scan-added-info">
          <strong>{a.name}</strong>
          <span className="dim small">
            {a.set.toUpperCase()} #{a.number}, {a.finish === "proxy" ? "proxy" : copyWords(a.treatment ?? {}, a.finish)}
            {a.finish !== "proxy" ? `, ${usd(priceFor(a.prices, a.finish))}` : ""}
            {a.auto ? ", added by Keep adding" : ""}
          </span>
          <div className="scan-added-actions">
            <Field className="scan-copies" label="Copies">
              <select value={a.copies} disabled={f.busy} onChange={(e) => void f.run({ ...f.base, copies: Number(e.target.value) })}>
                {Array.from({ length: Math.max(10, a.copies) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <FinishChoice a={a} f={f} compact />
          </div>
          <div className="scan-added-actions">
            <Button size="small" disabled={f.busy} onClick={() => void f.openPrintings()}>
              {f.printings ? "Keep this printing" : "Wrong printing?"}
            </Button>
            <Button size="small" variant="quiet" danger disabled={f.busy} onClick={() => void f.run(removeFix(a))}>
              Remove
            </Button>
          </div>
        </div>
      </div>
      <EntryState a={a} f={f} />
      <PrintingChoices a={a} f={f} />
    </li>
  );
}

/**
 * One scanned card large, from its tile in the strip: the picture (tap it for full size), its
 * printing, its price in each finish it comes in, whether it sees play, and the same fixes as its
 * row in the Added list. Removing it closes the view.
 */
export function ScannedCard({ a, onFix, onRetry, onClose }: { a: Added; onFix: AddedListProps["onFix"]; onRetry: AddedListProps["onRetry"]; onClose: () => void }) {
  const f = useFixes(a, onFix, onRetry);
  const play = usePlayability([a.oracle_id]).get(a.oracle_id ?? "");
  const tag = playTag(play);
  const line = playLine(play);
  const price = priceFor(a.prices, a.finish);
  const others = (finishesOf({ finishes: a.finishes }) as Finish[]).filter((x) => x !== a.finish && x !== "proxy");
  const date = shortDate(a.prices?.date ?? null);
  return (
    <div className="scan-big">
      <DialogHead onClose={onClose}>{a.name}</DialogHead>
      <div className="scan-big-body">
        <div className="scan-big-card">
          <ZoomableCard src={normalOf(a.image)} name={a.name} />
        </div>
        <div className="scan-big-info">
          <p className="scan-big-printing">
            {a.set.toUpperCase()} #{a.number}, {a.finish === "proxy" ? "proxy" : copyWords(a.treatment ?? {}, a.finish)}
            {a.copies > 1 ? `, ${a.copies} copies` : ""}
          </p>
          {a.finish !== "proxy" && (
            <p className="scan-big-price">
              <strong>{usd(price)}</strong>
              {price != null && <span className="dim"> market{a.copies > 1 ? " each" : ""}, {date ?? "date unknown"}</span>}
            </p>
          )}
          {others.length > 0 && (
            <p className="scan-note">
              {others.map((x) => `${finishName(x)} ${usd(priceFor(a.prices, x))}`).join(", ")}
            </p>
          )}
          {tag && <span className={`scan-play-tag is-${tag}`}>{PLAY_WORD[tag]}</span>}
          {line && <p className="scan-note">{line}</p>}
          {a.auto && <p className="scan-note">Added by Keep adding.</p>}
        </div>
      </div>
      <EntryState a={a} f={f} />
      <div className="scan-big-fixes">
        <FinishChoice a={a} f={f} />
        <Field className="scan-copies" label="Copies">
          <select value={a.copies} disabled={f.busy} onChange={(e) => void f.run({ ...f.base, copies: Number(e.target.value) })}>
            {Array.from({ length: Math.max(10, a.copies) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ActionBar align="between">
        <Button disabled={f.busy} onClick={() => void f.openPrintings()}>
          {f.printings ? "Keep this printing" : "Wrong printing?"}
        </Button>
        <Button variant="quiet" danger disabled={f.busy} onClick={() => void f.run(removeFix(a))}>
          Remove
        </Button>
      </ActionBar>
      <PrintingChoices a={a} f={f} />
    </div>
  );
}
