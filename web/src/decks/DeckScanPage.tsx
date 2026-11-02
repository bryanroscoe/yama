// Scan this deck (/decks/:id/scan): scan the physical deck card by card, fix misreads, compare
// with the deck's current list and its Commander checks, then save the scan as a new version
// (server/src/deck_scan.rs). The scan in progress is kept on this device (deckScan.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError, type DeckView } from "../api";
import { Details, ErrorText, Sheet } from "../components/ui";
import { NameEntry } from "../scanner/NameEntry";
import type { ScanCatalog } from "../scanner";
import {
  addCard, changeText, clearDraft, copies, DECK_SIZE, deviceFlag, fixCard, groups, loadDraft, newDraft, progress, removeCard, scanLines, setDeviceFlag, storeDraft, toggleCommander,
  type ScanChange, type ScanCheck, type ScanDraft, type ScanSaved,
} from "./deckScan";
import "../scanner/scanner.css";
import "./deckScan.css";

// The scanner pulls in OCR; load it only when the camera opens.
const scanner = () => import("../scanner");
const ScannerView = lazy(() => scanner().then((m) => ({ default: m.ScannerView })));
const KEEP_ADDING = "yama.deckScan.keepAdding";
/** The close-up step; the same setting as the collection scanner's. */
const CLOSEUPS = "yama.scan.closeups";

export function DeckScanPage() {
  const { id = "" } = useParams();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: () => api<DeckView>(`/api/decks/${id}`) });
  // A scan left unfinished on this device, else a new one with the deck's commander. Nothing is
  // stored until the first card goes in.
  const [kept, setKept] = useState<ScanDraft | null>(null);
  const draft = kept ?? (deck.data ? (loadDraft(id) ?? newDraft(id, deck.data.cards.filter((c) => c.board === "commander").map((c) => c.name))) : null);
  const [step, setStep] = useState<"scan" | "review" | "saved">("scan");
  const [camera, setCamera] = useState(false);
  const [saved, setSaved] = useState<ScanSaved | null>(null);
  // One op id per list, choice and checked version, kept across Back and Check again: a save
  // whose answer was lost (a phone dropping off wifi) is retried as the same op.
  const ops = useRef(new Map<string, string>());
  const setDraft: SetDraft = (next) =>
    setKept((cur) => {
      const base = cur ?? draft;
      if (!base) return cur;
      const d = next(base);
      storeDraft(d);
      return d;
    });

  if (deck.error) return <main className="page"><ErrorText error={deck.error} /></main>;
  if (!deck.data || !draft) return <main className="page"><p className="dim">Loading the deck…</p></main>;
  const d = deck.data;
  const p = progress(draft);

  return (
    <main className="page deck-scan stack">
      <p className="small"><Link to={`/decks/${d.id}`}>Back to {d.name}</Link></p>
      <h1>Scan {d.name}</h1>
      {step === "scan" && (
        <>
          <p className="dim">
            Scan the full deck, including the commander. Review before saving; earlier versions stay in History.
          </p>
          <ScanProgress draft={draft} setDraft={setDraft} />
          <div className="row deck-scan-start">
            <button className="primary" onClick={() => setCamera(true)}>{p.count ? "Scan more cards" : "Scan with the camera"}</button>
            <NameEntry placeholder="Or type a card's name" onPick={(name) => setDraft((x) => addCard(x, name, { typed: true }))} />
          </div>
          <ScannedList draft={draft} setDraft={setDraft} />
          <div className="row">
            <button className="primary" disabled={!p.count} onClick={() => setStep("review")}>Check the changes</button>
            {p.count > 0 && (
              <button className="quiet" onClick={() => confirm("Start the scan over? The cards scanned so far are cleared.") && setDraft((x) => ({ ...x, cards: [] }))}>
                Start over
              </button>
            )}
          </div>
        </>
      )}
      {step === "review" && (
        <Review
          deck={d}
          draft={draft}
          ops={ops.current}
          onBack={() => setStep("scan")}
          onSaved={(s) => {
            clearDraft(id);
            setKept(null);
            setSaved(s);
            setStep("saved");
          }}
        />
      )}
      {step === "saved" && saved && <Saved deck={d} saved={saved} />}
      {camera && (
        <Camera
          deck={d}
          draft={draft}
          setDraft={setDraft}
          onClose={() => setCamera(false)}
        />
      )}
    </main>
  );
}

function ScanProgress({ draft, setDraft }: { draft: ScanDraft; setDraft: SetDraft }) {
  const p = progress(draft);
  return (
    <div className="deck-scan-progress" role="status">
      <p>
        <b className="num">{p.count}</b> of {DECK_SIZE} cards
        {p.count > DECK_SIZE && <span className="deck-scan-warn">, {p.count - DECK_SIZE} too many</span>}
      </p>
      <progress max={DECK_SIZE} value={Math.min(p.count, DECK_SIZE)} aria-label={`${p.count} of ${DECK_SIZE} cards scanned`} />
      <p className="small">
        {draft.commanders.length === 0
          ? "No commander chosen: tap Change on it in the list."
          : draft.commanders.map((c) => (
              <span key={c} className={p.missingCommanders.includes(c) ? "deck-scan-warn" : "deck-scan-good"}>
                Commander {c}: {p.missingCommanders.includes(c) ? "not scanned yet. " : "scanned. "}
              </span>
            ))}
        {p.duplicates > 0 && <span className="deck-scan-warn">{p.duplicates === 1 ? "One card has" : `${p.duplicates} cards have`} more than one copy: remove any scanned twice.</span>}
      </p>
      {p.missingCommanders.length > 0 && (
        // The commander often lives outside the box, in a sleeve on the table.
        <div className="row">
          {p.missingCommanders.map((n) => (
            <button key={n} className="outline small" onClick={() => setDraft((x) => addCard(x, n, { typed: true }))}>
              Add {n} without scanning
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The list and progress show both on the page and over the camera.
type SetDraft = (next: (d: ScanDraft) => ScanDraft) => void;

function ScannedList({ draft, setDraft }: { draft: ScanDraft; setDraft: SetDraft }) {
  const [fixing, setFixing] = useState<string | null>(null);
  const list = groups(draft);
  if (!list.length) return <p className="dim">No cards scanned yet.</p>;
  return (
    <ul className="deck-scan-list" aria-label="Scanned cards">
      {list.map((g) => {
        const last = g.keys[g.keys.length - 1]!;
        return (
          <li key={g.name} className={g.duplicate ? "is-duplicate" : undefined}>
            <div className="deck-scan-card">
              <span>
                {g.count > 1 && <b className="num">{g.count} </b>}
                {g.name}
                {g.commander && <span className="deck-scan-tag">Commander</span>}
                {g.duplicate && <span className="deck-scan-tag is-warn">{g.count} copies</span>}
              </span>
              <span className="deck-scan-actions">
                <button className="quiet small" onClick={() => setFixing(fixing === last ? null : last)} aria-expanded={fixing === last} aria-label={`Change ${g.name}`}>
                  Change
                </button>
                <button className="quiet small" onClick={() => setDraft((x) => removeCard(x, last))} aria-label={g.count > 1 ? `Remove one ${g.name}` : `Remove ${g.name}`}>
                  {g.count > 1 ? "Remove one" : "Remove"}
                </button>
              </span>
            </div>
            {fixing === last && (
              <div className="deck-scan-fix">
                <span className="small dim">{g.count > 1 ? "Misread? One copy is really:" : "Misread? This card is really:"}</span>
                <NameEntry
                  placeholder="Type the right name"
                  onPick={(name) => {
                    setDraft((x) => fixCard(x, last, name));
                    setFixing(null);
                  }}
                />
                <button
                  className="outline small"
                  onClick={() => {
                    setDraft((x) => toggleCommander(x, g.name));
                    setFixing(null);
                  }}
                >
                  {g.commander ? "It's not the commander" : "Make it the commander"}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Camera({ deck, draft, setDraft, onClose }: { deck: DeckView; draft: ScanDraft; setDraft: SetDraft; onClose: () => void }) {
  const [catalog, setCatalog] = useState<ScanCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [keepAdding, setKeepAdding] = useState(() => deviceFlag(KEEP_ADDING, true));
  const [closeups, setCloseups] = useState(() => deviceFlag(CLOSEUPS, true));
  const names = useRef(deck.cards.map((c) => c.name));
  useEffect(() => {
    let cancelled = false;
    // Only the card matters, so no printing lookups; the deck's own names fill any gaps in the
    // offline card names (a card newer than the download).
    void scanner()
      .then((m) => m.createServerCatalog({ identityOnly: true, extraNames: names.current }))
      .then((c) => !cancelled && setCatalog(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  const p = progress(draft);
  const recent = [...draft.cards].sort((a, b) => b.at - a.at).map((c) => c.name);
  const controls = (
    <div className="scan-choices">
      <p className="scan-note">
        <b>{p.count} of {DECK_SIZE}</b> scanned.{" "}
        {p.missingCommanders.length > 0 ? `Commander ${p.missingCommanders.join(" and ")} not scanned yet.` : draft.commanders.length ? "Commander scanned." : ""}
      </p>
      <label className="scan-keep">
        <input
          type="checkbox"
          checked={keepAdding}
          onChange={(e) => {
            setKeepAdding(e.target.checked);
            setDeviceFlag(KEEP_ADDING, e.target.checked);
          }}
        />
        <span>
          <strong>Keep adding.</strong> Add each card as soon as the scanner knows it, and go on to the next. It still asks when a card looks like another.
        </span>
      </label>
      <label className="scan-keep">
        <input
          type="checkbox"
          checked={closeups}
          onChange={(e) => {
            setCloseups(e.target.checked);
            setDeviceFlag(CLOSEUPS, e.target.checked);
          }}
        />
        <span>
          <strong>Close-ups.</strong> When the scanner can't tell which card it is, ask to bring the camera close to the name. Turn off for a camera that stays put, such as a stand or card feeder.
        </span>
      </label>
    </div>
  );
  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-label={`Scan ${deck.name}`}>
      {catalog ? (
        <Suspense fallback={<p className="dim" style={{ padding: "1rem" }}>Starting the scanner…</p>}>
          <ScannerView
            catalog={catalog}
            identityOnly
            autoAdd={keepAdding}
            closeups={closeups}
            paused={reviewing}
            onAccept={(card) => setDraft((x) => addCard(x, card.name))}
            onClose={onClose}
            addedCount={p.count}
            onShowAdded={() => setReviewing(true)}
            recent={recent}
            controls={controls}
            acceptLabel="Add and scan next"
          />
          {reviewing && (
            <Sheet onClose={() => setReviewing(false)} label="Scanned cards">
              <div className="stack">
                <div className="sheet-head">
                  <h2>Scanned cards</h2>
                  <button className="quiet" onClick={() => setReviewing(false)}>Back to scanning</button>
                </div>
                <ScanProgress draft={draft} setDraft={setDraft} />
                <ScannedList draft={draft} setDraft={setDraft} />
              </div>
            </Sheet>
          )}
        </Suspense>
      ) : (
        <div className="sheet stack">
          <p>{error ?? "Starting the scanner…"}</p>
          <button onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}

function Review({ deck, draft, ops, onBack, onSaved }: { deck: DeckView; draft: ScanDraft; ops: Map<string, string>; onBack: () => void; onSaved: (s: ScanSaved) => void }) {
  const qc = useQueryClient();
  const lines = scanLines(draft);
  const key = JSON.stringify(lines);
  const check = useQuery({
    queryKey: ["deck-scan-check", deck.id, key],
    queryFn: () => api<ScanCheck>(`/api/decks/${deck.id}/scan/check`, { method: "POST", json: { cards: lines } }),
    staleTime: 0,
    gcTime: 0,
  });
  const [makeCurrent, setMakeCurrent] = useState(true);
  const save = useMutation({
    mutationFn: () => {
      const op = `${key}|${makeCurrent}|${check.data?.based_on ?? ""}`;
      const op_id = ops.get(op) ?? ops.set(op, crypto.randomUUID()).get(op)!;
      return api<ScanSaved>(`/api/decks/${deck.id}/scan`, { method: "POST", json: { op_id, cards: lines, make_current: makeCurrent, based_on: check.data?.based_on ?? null } });
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions", deck.id] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      onSaved(s);
    },
  });
  const stale = save.error instanceof ApiError && save.error.status === 409;
  const c = check.data;
  return (
    <section className="stack deck-scan-review" aria-live="polite">
      <h2>Before saving</h2>
      <ErrorText error={check.error} />
      {!c && !check.error && <p className="dim">Comparing with the deck's list…</p>}
      {c && (
        <>
          <Checks check={c} />
          {c.unknown.length > 0 && (
            <p className="error">
              Yama doesn't know {c.unknown.join(", ")}. Go back and fix {c.unknown.length === 1 ? "it" : "them"} before saving.
            </p>
          )}
          {c.same ? (
            <p>The scan matches the deck's current list. There's nothing to save.</p>
          ) : (
            <>
              {c.commander_changed && (
                <p>
                  Commander: {c.commanders_before.join(" and ") || "none"} becomes {c.commanders_after.join(" and ") || "none"}.
                </p>
              )}
              <div className="deck-scan-diff">
                <ChangeList title="In" side="in" sign="+" lines={c.added} empty="Nothing new." />
                <ChangeList title="Out" side="out" sign="−" lines={c.removed} empty="Nothing out." />
              </div>
              {c.unchanged.length > 0 && (
                <Details label={`Unchanged: ${copies(c.unchanged, "same")} cards`}>
                  <ul className="deck-scan-plain">
                    {c.unchanged.map((l) => <li key={l.oracle_id}>{changeText(l, "same")}</li>)}
                  </ul>
                </Details>
              )}
              {c.kept_sideboard > 0 && <p className="small dim">The new version keeps the {c.kept_sideboard} sideboard {c.kept_sideboard === 1 ? "card" : "cards"} of the current list; the scan covers the commander and main deck.</p>}
              <label className="deck-scan-choice">
                <input type="checkbox" checked={makeCurrent} onChange={(e) => setMakeCurrent(e.target.checked)} />
                <span>
                  <strong>Make this the deck's list.</strong>{" "}
                  {makeCurrent
                    ? "The deck page, games and your plan (which swaps are in the deck) read it from now on. The list it replaces stays in History, where Restore this list switches back."
                    : "It's saved in History only. The deck's list and plan don't change; Restore this list in History puts it in later."}
                </span>
              </label>
            </>
          )}
          {stale && (
            <p className="error">
              The deck's list changed since this check, so nothing was saved. <button className="quiet small" onClick={() => { save.reset(); void check.refetch(); }}>Check again</button>
            </p>
          )}
          {!stale && <ErrorText error={save.error} />}
        </>
      )}
      <div className="row">
        {c && !c.same && (
          <button className="primary" disabled={!c || c.unknown.length > 0 || save.isPending || stale} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : makeCurrent ? "Save as the deck's new list" : "Save in History"}
          </button>
        )}
        <button onClick={onBack}>Back to the scan</button>
      </div>
    </section>
  );
}

function Checks({ check }: { check: ScanCheck }) {
  const v = check.validation;
  return (
    <div className="deck-scan-checks">
      <h3>Commander checks</h3>
      <p className={v.ok ? "deck-scan-good" : "deck-scan-warn"}>
        {v.ok ? `Legal: ${v.total} cards, singleton, inside the commander's colors.` : `${v.errors.length === 1 ? "One problem" : `${v.errors.length} problems`}. You can still save it; it's what's in the box.`}
      </p>
      {(v.errors.length > 0 || v.warnings.length > 0) && (
        <ul className="deck-scan-plain">
          {v.errors.map((e) => <li key={e} className="deck-scan-warn">{e}</li>)}
          {v.warnings.map((w) => <li key={w} className="dim">{w}</li>)}
        </ul>
      )}
      <p className="small dim">Legality is from Yama's card data, as of its last card update.</p>
    </div>
  );
}

function ChangeList({ title, side, sign, lines, empty }: { title: string; side: "in" | "out"; sign: string; lines: ScanChange[]; empty: string }) {
  return (
    <section>
      <h3>{title}: {copies(lines, side)}</h3>
      {lines.length ? (
        <ul className="deck-scan-plain">
          {lines.map((l) => (
            <li key={l.oracle_id}>
              <span aria-hidden="true" className={side === "in" ? "deck-scan-good" : "deck-scan-out"}>{sign} </span>
              {changeText(l, side)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small dim">{empty}</p>
      )}
    </section>
  );
}

function Saved({ deck, saved }: { deck: DeckView; saved: ScanSaved }) {
  return (
    <section className="stack" role="status">
      <h2>{!saved.changed ? "Nothing changed" : saved.current ? "Saved as the deck's list" : "Saved in History"}</h2>
      <p>
        {!saved.changed
          ? "The scan matched the deck's list, so no version was added."
          : saved.current
            ? "The scan is a new version and the deck's list now. The list it replaced is in History; Restore this list switches back."
            : "The scan is a new version in History. The deck's list didn't change."}
      </p>
      {saved.changed && saved.current && (
        <p className="small dim">
          Scanning doesn't change your collection.
        </p>
      )}
      <div className="row">
        <Link className="button primary" to={`/decks/${deck.id}`}>Open the deck</Link>
        {saved.changed && saved.current && <Link className="button" to={`/decks/${deck.id}?collect=1`}>Add to my collection</Link>}
      </div>
    </section>
  );
}
