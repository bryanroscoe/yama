import { CardRef } from "../components/CardRef";
import { inForceBundle, swapSheet, takeoutLines, type PlanCard, type SheetDeck, type SheetStep } from "@yama/core/plan";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { SwapInSheet } from "./SwapIn";
import { destination, SwapCardResult, SwapReasons } from "./SwapDetails";
import { prepareSheetForPrint } from "./print";
import type { PlanView } from "./view";
import "./swapsheet.css";
import { Loading, EmptyState, ErrorText } from "../components/ui";

const SwapScanner = lazy(() => import("./SwapScanner"));
const SHEETS = [
  { value: "full", label: "Full swap sheet" },
  { value: "takeout", label: "Take out by deck, A to Z" },
  { value: "alphabetical", label: "All takeouts, A to Z" },
] as const;

/**
 * `/decks/plans/get/swap-sheet`: the swap sheet for when prints arrive, on screen and on paper. Sort the
 * prints into decks, then swap each deck from its now list to its after-prints list, with where each
 * card coming out goes. The same sheet commander-decks prints (mtg-print-swaps.pdf).
 */
export function SwapSheetPage() {
  const { view } = usePlanOutlet();
  // Only plans in force: a plan waiting for your OK has nothing to swap in yet.
  const b = useMemo(() => inForceBundle(view.b, view.planOf, view.answers), [view]);
  const sheet = useMemo(() => swapSheet({ ...b, marks: Object.fromEntries(view.markBy) }), [b, view.markBy]);
  const [swapping, setSwapping] = useState<SheetDeck | null>(null);
  const [params, setParams] = useSearchParams();
  const mode = SHEETS.find((s) => s.value === params.get("sheet"))?.value ?? "full";
  const omitted = new Set((params.get("omit") ?? "").split(","));
  const include = (part: string) => !omitted.has(part);
  const pictures = include("pictures");
  const reasons = params.get("reasons") === "1";
  const hasContent = mode !== "full" || include("instructions") || include("sort") || include("swaps");
  const availableDecks = b.decks.filter((d) => d.status === "active");
  // Repeated deck keys keep existing single-deck links working. The scope flag distinguishes
  // explicitly selecting no decks from the default of every deck.
  const requestedDecks = params.getAll("deck").filter(Boolean);
  const everyDeck = requestedDecks.length === 0 && params.get("deckScope") !== "selected";
  const selectedKeys = new Set(everyDeck ? availableDecks.map((d) => d.key) : requestedDecks);
  const deckKey = selectedKeys.size === 1 ? [...selectedKeys][0] : undefined;
  const selected = deckKey ? view.deck(deckKey) : undefined;
  const shown = sheet.decks.filter((d) => selectedKeys.has(d.deck.key));
  // Include boundary moves so a selected deck still says where an outgoing card must go,
  // even when the receiving deck isn't being printed this time.
  const moves = sheet.moves.filter((m) => selectedKeys.has(m.from.key) || selectedKeys.has(m.to.key));
  const sortLines = sheet.sort.map((l) => ({ ...l, decks: l.decks.filter((d) => selectedKeys.has(d.key)) })).filter((l) => l.decks.length);
  const visibleSheet = { ...sheet, decks: shown, moves, sort: sortLines, prints: sortLines.reduce((n, l) => n + l.decks.length, 0) };
  const takeouts = takeoutLines(visibleSheet);
  const [scanning, setScanning] = useState(() => params.get("scan") === "1");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const print = async () => {
    const root = sheetRef.current;
    if (!root || printing || !hasContent || !shown.length) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await prepareSheetForPrint(root);
      if (sheetRef.current === root && root.isConnected) window.print();
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : String(error));
    } finally {
      setPrinting(false);
    }
  };
  const choices = useMemo(() => [...new Set(view.b.decks.flatMap((d) => Object.values(d.states).flatMap((s) => s?.cards.map((c) => c.name) ?? [])))].sort(), [view.b.decks]);
  const change = (key: string, value: string) => setParams((old) => {
    const next = new URLSearchParams(old);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  });
  const selectDecks = (keys: string[] | null) => setParams((old) => {
    const next = new URLSearchParams(old);
    next.delete("deck");
    next.delete("deckScope");
    if (keys !== null) {
      next.set("deckScope", "selected");
      for (const key of keys) next.append("deck", key);
    }
    return next;
  });
  const toggleDeck = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    selectDecks(availableDecks.filter((d) => next.has(d.key)).map((d) => d.key));
  };
  const togglePart = (part: string) => {
    const next = new Set(omitted);
    if (next.has(part)) next.delete(part); else next.add(part);
    change("omit", [...next].filter(Boolean).join(","));
  };
  return (
    <div className={`swap-sheet${mode === "full" && !include("sort") && !include("instructions") ? " ss-decks-only" : ""}`} ref={sheetRef}>
      <div className="no-print">
        <PlansHead title="Swap sheet" />
        <div className="row ss-actions">
          <button className="primary" disabled={printing} onClick={() => setScanning(true)}>Scan a card</button>
          <button disabled={printing || !hasContent || !shown.length} aria-busy={printing} onClick={() => void print()}>{printing ? (pictures ? "Loading pictures…" : "Preparing print…") : "Print"}</button>
        </div>
        <ErrorText error={printError} />
        <div className="ss-controls">
          <label>Sheet<select value={mode} disabled={printing} onChange={(e) => change("sheet", e.target.value)}>{SHEETS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>

        </div>
        <fieldset className="ss-print-options ss-deck-options" disabled={printing}>
          <legend>Decks to print ({availableDecks.filter((d) => selectedKeys.has(d.key)).length} of {availableDecks.length})</legend>
          <div className="row ss-deck-select-actions">
            <button type="button" className="quiet small" onClick={() => selectDecks(null)}>Select all</button>
            <button type="button" className="quiet small" onClick={() => selectDecks([])}>Clear</button>
          </div>
          {availableDecks.map((d) => <label key={d.key}>
            <input type="checkbox" checked={selectedKeys.has(d.key)} onChange={() => toggleDeck(d.key)} /> {d.name}
          </label>)}
        </fieldset>
        <fieldset className="ss-print-options" disabled={printing}>
          <legend>Include in print</legend>
          {mode === "full" && <>
            <label><input type="checkbox" checked={include("instructions")} onChange={() => togglePart("instructions")} /> Instructions</label>
            <label><input type="checkbox" checked={include("sort")} onChange={() => togglePart("sort")} /> Print sorting checklist</label>
            <label><input type="checkbox" checked={include("swaps")} onChange={() => togglePart("swaps")} /> Deck swap tables</label>
          </>}
          <label><input type="checkbox" checked={pictures} onChange={() => togglePart("pictures")} /> Card pictures</label>
          <label><input type="checkbox" checked={reasons} onChange={() => change("reasons", reasons ? "" : "1")} /> Add and cut reasons</label>
        </fieldset>
        {!hasContent && <p role="status">Choose at least one section to print.</p>}
        <form className="ss-lookup" onSubmit={(e) => { e.preventDefault(); setChecked(name.trim()); }}>
          <label>Check either card by name<input list="ss-card-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="Card coming in or going out" /></label>
          <datalist id="ss-card-names">{choices.map((n) => <option key={n} value={n} />)}</datalist>
          <button type="submit" disabled={!name.trim()}>Check card</button>
        </form>
        {checked && <SwapCardResult name={checked} sheet={visibleSheet} view={view} deckKey={deckKey} />}
      </div>
      <h1 className="print-only">{mode === "full" ? "Prints are here: swap them in" : SHEETS.find((s) => s.value === mode)!.label}{selected ? `: ${selected.name}` : ""}</h1>
      {shown.length === 0 ? (
        <EmptyState>{selectedKeys.size === 0 ? "Choose at least one deck to print." : "No now-to-after-prints changes for the selected decks."}</EmptyState>
      ) : mode !== "full" ? (
        <>
          <p className="ss-lead">{takeouts.length} cards to take out{selected ? ` of ${selected.name}` : ` across ${shown.length} decks`}.</p>
          {mode === "alphabetical" ? <TakeoutTable rows={takeouts} view={view} pictures={pictures} reasons={reasons} withDeck /> : shown.map((d) => (
            <section className="ss-deck ss-takeout-deck" key={d.deck.key}>
              <h2>{d.deck.name}</h2>
              <TakeoutTable rows={takeouts.filter((l) => l.deck.key === d.deck.key)} view={view} pictures={pictures} reasons={reasons} />
            </section>
          ))}
        </>
      ) : (
        <>
          {hasContent && <p className="ss-lead">
            {shown.reduce((n, d) => n + d.prints, 0)} printed cards for {shown.length} {shown.length === 1 ? "deck" : "decks"}.
          </p>}
          {include("instructions") && <ol className="ss-how">
            <li>
              <b>Check and sort</b> the prints into decks: tick a box as each copy goes on its deck's pile. Every box ticked means the order came complete.
            </li>
            {moves.length > 0 && (
              <li>
                <b>{deckKey ? "Check the cards moving between decks." : "Do the decks in this order."}</b> {moves.length === 1 ? "One card changes" : `${moves.length} cards change`} decks:{" "}
                {moves.map((m) => `${m.card} from ${m.from.name} to ${m.to.name}`).join("; ")}. When one comes out, put it straight on the other deck's pile.
              </li>
            )}
            <li>
              <b>Cards coming out:</b> swap bag means keep it in that deck's box, for playing at a lower bracket. Everything else goes in your spares box,
              stand-ins you bought too.
            </li>
            <li>
              <b>GC</b> marks a Game Changer. Mark those sleeves so you can count them for brackets.
            </li>
            <li className="no-print">When a deck is sleeved, use "Swap in the prints" on its section so Yama matches it: the deck's list, its box and the installed ticks.</li>
          </ol>}

          {include("sort") && <section className="ss-sort" aria-labelledby="ss-sort-h">
            <h2 id="ss-sort-h">Check and sort the prints, A to Z</h2>
            <table>
              <thead>
                <tr>
                  <th>Card</th>
                  <th className="num">Copies</th>
                  <th>Pile</th>
                </tr>
              </thead>
              <tbody>
                {sortLines.map((l) => (
                  <tr key={l.card}>
                    <td>
                      <b><CardRef name={l.card} oracleId={view.oracleId(l.card)} image={view.card(l.card)?.image_normal}/></b>
                      {l.gameChanger && <span className="ss-gc">GC</span>}
                      {l.back && <span className="ss-note">double-faced, back is {l.back}</span>}
                    </td>
                    <td className="num">{l.decks.length}</td>
                    <td>
                      {l.decks.map((d, i) => (
                        <span className="ss-chip" key={`${d.key}-${i}`}>
                          <span className="ss-box" aria-hidden="true" />
                          {d.name}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>}

          {include("swaps") && shown.map((d) => (
            <DeckSection key={d.deck.key} d={d} view={view} pictures={pictures} reasons={reasons} onSwap={() => setSwapping(d)} />
          ))}
        </>
      )}
      {swapping && <SwapInSheet deckKey={swapping.deck.key} deckName={swapping.deck.name} onClose={() => setSwapping(null)} />}
      {scanning && <Suspense fallback={<div className="scan-overlay"><div className="sheet stack"><Loading>Starting the scanner…</Loading><button onClick={() => setScanning(false)}>Close</button></div></div>}>
        <SwapScanner sheet={visibleSheet} view={view} deckKey={deckKey} onClose={() => setScanning(false)} />
      </Suspense>}
    </div>
  );
}

function DeckSection({ d, view, onSwap, pictures, reasons }: { d: SheetDeck; view: PlanView; onSwap: () => void; pictures: boolean; reasons: boolean }) {
  const all = d.installed === d.steps.length;
  return (
    <section className="ss-deck" aria-labelledby={`ss-${d.deck.key}`}>
      <div className="ss-deck-head">
        <h2 id={`ss-${d.deck.key}`}>
          {d.deck.name} <span className="dim">{d.deck.commander.join(" and ")}</span>
        </h2>
        <button className={all ? "outline no-print" : "primary no-print"} onClick={onSwap}>
          {all ? "Check it in Yama" : "Swap in the prints"}
        </button>
      </div>
      <p className="ss-lead">
        {d.prints} {d.prints === 1 ? "print" : "prints"}
        {d.moves ? ` and ${d.moves} ${d.moves === 1 ? "card" : "cards"} from another deck` : ""}.
        {d.installed > 0 ? ` ${d.installed} of ${d.steps.length} ticked installed.` : ""}
      </p>
      <table className="ss-steps">
        <thead>
          <tr>
            <th aria-label="Done" />
            <th>Put in</th>
            <th>Take out</th>
            <th>Then</th>
          </tr>
        </thead>
        <tbody>
          {d.steps.map((s, i) => (
            <Step key={`${s.in}-${s.out}-${i}`} s={s} view={view} pictures={pictures} reasons={reasons} />
          ))}
        </tbody>
      </table>
      {d.bagAlreadyOut.length > 0 && <p className="ss-note-line">Also for the swap bag, already out of the deck (in your spares box): {d.bagAlreadyOut.join(", ")}.</p>}
    </section>
  );
}

function Thumb({ name, view }: { name: string; view: PlanView }) {
  return <SheetThumbnail name={name} card={view.card(name)} />;
}

export function SheetThumbnail({ name, card }: { name: string; card: Pick<PlanCard, "image_small" | "image_normal"> | undefined }) {
  const src = card?.image_small || card?.image_normal;
  // Every row can appear in a PDF, including rows that have never been scrolled into view.
  return src ? <img className="ss-thumb" src={src} alt="" data-print-card={name} loading="eager" decoding="async" /> : <span className="ss-thumb" aria-hidden="true" />;
}

function TakeoutTable({ rows, view, withDeck = false, pictures, reasons }: { rows: ReturnType<typeof takeoutLines>; view: PlanView; withDeck?: boolean; pictures: boolean; reasons: boolean }) {
  if (!rows.length) return <p className="dim">No cards to take out.</p>;
  return (
    <table className="ss-takeouts">
      <thead><tr><th aria-label="Done" /><th>Take out</th>{withDeck && <th>Deck</th>}<th>Put in</th><th>Then</th></tr></thead>
      <tbody>{rows.map(({ deck, step: s }, i) => (
        <tr key={`${deck.key}-${i}`} className={s.installed ? "ss-done" : undefined}>
          <td className="ss-tick"><span className={`ss-box${s.installed ? " ss-box-on" : ""}`} aria-label={s.installed ? "Installed" : "Not installed yet"} /></td>
          <td><span className="ss-card">{pictures && <Thumb name={s.out} view={view} />}<b>{s.out&&<CardRef name={s.out} oracleId={view.oracleId(s.out)} image={view.card(s.out)?.image_normal}/>}</b></span>{s.outKind !== "cut" && <span className="ss-sub">{s.outKind === "standin" ? "stand-in" : "basic holding the slot"}</span>}{reasons && <SwapReasons step={s} side="out" />}</td>
          {withDeck && <td>{deck.name}</td>}
          <td>{s.in || "—"}{reasons && s.in && <SwapReasons step={s} side="in" />}</td><td className="ss-then">{destination(s)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function Step({ s, view, pictures, reasons }: { s: SheetStep; view: PlanView; pictures: boolean; reasons: boolean }) {
  const then =
    s.to === "deck" ? (
      <>
        <b>to {s.toDeck?.name}</b>
        {s.toReplaces ? `, in for ${s.toReplaces}` : ""}
      </>
    ) : s.to === "bag" ? (
      <>
        <b>swap bag</b>, back in at {s.bagBracket}
      </>
    ) : s.to === "basics" ? (
      "back to your basics"
    ) : (
      "spares box"
    );
  return (
    <tr className={s.installed ? "ss-done" : undefined}>
      <td className="ss-tick">{s.installed ? <span className="ss-box ss-box-on" aria-label="Installed" /> : <span className="ss-box" aria-label="Not installed yet" />}</td>
      <td>
        {s.in && (
          <span className="ss-card">
            {pictures && <Thumb name={s.in} view={view} />}
            <span>
              <span>
                <b><CardRef name={s.in} oracleId={view.oracleId(s.in)} image={view.card(s.in)?.image_normal}/></b>
                {s.gameChanger && <span className="ss-gc">GC</span>}
              </span>
              <span className="ss-sub">{s.kind === "print" ? "print" : s.kind === "moved" ? `from ${s.fromDeck?.name ?? "another deck"}` : "in hand"}</span>
            </span>
          </span>
        )}
        {s.in && (reasons ? <SwapReasons step={s} side="in" /> : <details className="no-print ss-why"><summary>Why this swap?</summary><SwapReasons step={s} /></details>)}
      </td>
      <td>
        {s.out && (
          <span className="ss-card">
            {pictures && <Thumb name={s.out} view={view} />}
            <span>
              <b>{s.out&&<CardRef name={s.out} oracleId={view.oracleId(s.out)} image={view.card(s.out)?.image_normal}/>}</b>
              {s.outKind !== "cut" && <span className="ss-sub">{s.outKind === "standin" ? "stand-in" : "basic holding the slot"}</span>}
            </span>
          </span>
        )}
        {reasons && s.out && <SwapReasons step={s} side="out" />}
      </td>
      <td className="ss-then">{then}</td>
    </tr>
  );
}
