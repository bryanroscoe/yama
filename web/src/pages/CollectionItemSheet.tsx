import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError, placeName, type CollectionItem, type Container, type Printing } from "../api";
import { CardRef } from "../components/CardRef";
import { Button, CardImage, Dialog, ErrorText, Field, Loading, Segmented } from "../components/ui";
import type { ScanCandidate } from "../scanner";
import { changeDone, changeOps, CONDITION_CODES, conditionLabel, conditionWord, finishChoices, finishFor, finishWord, languageChoices, markDone, markOps, markWords, opIds, printingLabel, reprintOps, sameCopy, worthLine, type CopyChange, type Mark, type Op, type Scope } from "./collectionEdit";
// The scan choices and their notes, shown here outside the scanner too.
import "../scanner/scanner.css";
import { plural, shortDate, treatmentLabel, usd } from "@yama/core";
import { optionLabel, placeLabel, treeOrder } from "./containerTree";

// The scanner pulls in OCR; load it only when someone rescans.
const ScannerView = lazy(() => import("../scanner").then((m) => ({ default: m.ScannerView })));



const priceOf = (p: Printing, finish: string) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);

/**
 * One collection row: its copies, where they live, its printing, and deleting it. A change is
 * saved as it is made and the sheet stays open, saying what it did, so several changes to one
 * card take one opening. `onClose` gets a line to show on the page when the row is gone (deleted,
 * or its last copy removed).
 */
export function CollectionItemSheet({ item: opened, containers, onClose }: { item: CollectionItem; containers: Container[]; onClose: (done?: string) => void }) {
  const qc = useQueryClient();
  // The row as this sheet last knew it: each saved change is applied here at once, then the row
  // is read again from the server (it may have merged into a matching row, with that row's count).
  const [item, setItem] = useState(opened);
  /** What the last change did, said in the sheet. */
  const [said, setSaid] = useState<string | null>(null);
  const reads = useRef(0);
  // The newest row, for a save that lands after the row was read again meanwhile.
  const latest = useRef(item);
  latest.current = item;
  // A save that lands after this sheet closed mustn't close the next card's sheet.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [picking, setPicking] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  // Signed, altered and language are usually true of one copy in a row, so they ask which and
  // start at one: a tick that marked the whole row could merge it into another for good.
  const [markScope, setMarkScope] = useState<Scope>(item.qty > 1 ? "one" : "all");
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const copies = item.qty === 1 ? "this copy" : scope === "all" ? `all ${item.qty} copies` : "one copy";

  // One op id per change until the server confirms it: tapping again after a failed save (its
  // answer may only have been lost) sends the same op, never a second copy.
  const [ids] = useState(() => opIds());
  const send = useMutation({
    mutationFn: (ops: Op[]) => api("/api/collection/ops", { method: "POST", json: ops }),
    onSuccess: () => {
      ids.saved();
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" });
    },
  });
  const busy = send.isPending;
  const name = item.name ?? "The card";
  const where = (i: CollectionItem) => (i.spares_of_deck ? placeName(i, "your collection") : (placeLabel(i.container_id, containers) ?? placeName(i, "your collection")));
  /** Read the row again after a change: its count and id are the server's (the newest read wins). */
  const reread = async (want: CollectionItem) => {
    const mine = ++reads.current;
    try {
      const q = new URLSearchParams({ container: want.container_id ?? "none" });
      if (want.name) q.set("q", want.name);
      const rows = await api<CollectionItem[]>(`/api/collection?${q}`);
      const row = rows.find((r) => sameCopy(r, want));
      if (row && alive.current && mine === reads.current) setItem(row);
    } catch {
      // The sheet keeps what it worked out itself.
    }
  };
  /** A saved change: the row as it is now (null: the change was to copies split off it), and what to say. */
  const landed = (now: Partial<CollectionItem> | null, done: string) => {
    if (!alive.current) return;
    const next = now ? { ...latest.current, ...now } : { ...latest.current, qty: latest.current.qty - 1 };
    setItem(next);
    setSaid(done);
    void reread(next);
  };
  const save = (ops: Op[], now: Partial<CollectionItem> | null, done: string) => send.mutate(ops, { onSuccess: () => landed(now, done) });
  /** Whether a change is for one copy split off the row (the row itself then only loses a copy). */
  const splits = (s: Scope) => s === "one" && item.qty > 1;
  const change = (c: CopyChange) => {
    const place = c.container_id ? placeLabel(c.container_id, containers) : null;
    // A row moved to another place is shown as that place's from now on.
    const moved = c.container_id !== undefined ? { container_name: containers.find((x) => x.id === c.container_id)?.name ?? null, container_kind: containers.find((x) => x.id === c.container_id)?.kind ?? null } : {};
    save(changeOps(item, c, scope, () => ids.idFor(`update:${JSON.stringify(c)}:${scope}`)), splits(scope) ? null : { ...c, ...moved }, changeDone(item, c, scope, place));
  };
  const adjust = (delta: number) => {
    const op: Op = { op_id: ids.idFor(`adjust:${delta}`), kind: "adjust", item_id: item.id, delta };
    const left = item.qty + delta;
    // The last copy gone, the row is gone: the page says so.
    if (left <= 0) send.mutate([op], { onSuccess: () => alive.current && onClose(`Removed the last ${name} from ${where(item)}.`) });
    else save([op], { qty: left }, delta > 0 ? `Added one: ${plural(left, "copy", "copies")} now.` : `Removed one: ${plural(left, "copy", "copies")} left.`);
  };
  const reprintId = (p: Printing) => () => ids.idFor(`reprint:${p.scryfall_id}:${scope}`);
  const nowIs = (p: Printing) => `${splits(scope) ? `One ${name}` : name} is now ${printingLabel(p, finishFor(item, p))}.`;
  /** The row filed under another printing of its card, as the page will show it. */
  const asPrinting = (p: Printing): Partial<CollectionItem> => {
    const finish = finishFor(item, p);
    return {
      scryfall_id: p.scryfall_id, set_code: p.set_code, set_name: p.set_name, collector_number: p.collector_number, lang: p.lang, finish, rarity: p.rarity,
      image_small: p.image_small, image_normal: p.image_normal, promo_types: p.promo_types, frame_effects: p.frame_effects, border_color: p.border_color, full_art: p.full_art,
      unit_price_usd: priceOf(p, finish) ?? null, price_date: p.price_date,
    };
  };
  // Every printing of this card, newest first: the picker's list, the check on a rescan, and the
  // finishes this row's printing comes in.
  const printings = useQuery({
    queryKey: ["printings-of", item.scryfall_id],
    queryFn: ({ signal }) => api<{ printings: Printing[] }>(`/api/scan/printings?id=${encodeURIComponent(item.scryfall_id)}`, { signal }).then((r) => r.printings),
    staleTime: 60 * 60 * 1000,
  });
  const finishes = finishChoices(item.finish, printings.data?.find((p) => p.scryfall_id === item.scryfall_id)?.finishes);
  const mark = (m: Mark) => {
    const ops = markOps(item, m, markScope, () => ids.idFor(`mark:${JSON.stringify(m)}:${markScope}`));
    if (ops.length > 0) save(ops, splits(markScope) ? null : m, markDone(item, m, markScope));
  };
  const reprint = (p: Printing) => {
    const ops = reprintOps(item, p, scope, reprintId(p));
    setPicking(false);
    if (ops.length === 0) setSaid(`That's the printing you have: ${printingLabel(p, finishFor(item, p))}.`);
    else save(ops, splits(scope) ? null : asPrinting(p), nowIs(p));
  };

  /** A rescanned card: the same card in another printing replaces this row's (or one copy's). */
  const rescanned = async (c: ScanCandidate): Promise<boolean> => {
    if (!c.scryfall_id) throw new Error(`Pick the printing of ${c.name} first`);
    // One change per rescan: the scanner goes on looking while a save is out.
    if (send.isPending) return false;
    let list = printings.data;
    if (!list) {
      const r = await printings.refetch();
      if (r.error instanceof ApiError && r.error.status === 404) {
        // This row's printing isn't in our card data, so there's no card to check the scan
        // against: the scanned printing replaces it (the server still checks it's a known one).
        // The scanned printing's own finishes, so a foil row doesn't land on a nonfoil-only printing.
        const known = await api<{ printings: Printing[] }>(`/api/scan/printings?id=${encodeURIComponent(c.scryfall_id)}`);
        const p = known.printings.find((x) => x.scryfall_id === c.scryfall_id);
        if (!p) throw new Error(`Couldn't find that printing of ${c.name}. Nothing was changed.`);
        await send.mutateAsync(reprintOps(item, p, scope, reprintId(p)));
        setRescanning(false);
        landed(splits(scope) ? null : { ...asPrinting(p), name: c.name, oracle_id: p.oracle_id }, `${splits(scope) ? `One ${c.name}` : c.name} is now ${printingLabel(p, finishFor(item, p))}.`);
        return true;
      }
      if (r.error) throw new Error(`Couldn't load the printings of ${item.name ?? "this card"} to check the scan. Nothing was changed; try again.`);
      list = r.data ?? [];
    }
    const p = list.find((x) => x.scryfall_id === c.scryfall_id);
    if (!p) throw new Error(`That's ${c.name}, not ${item.name ?? "this card"}. Nothing was changed.`);
    if (p.scryfall_id === item.scryfall_id) {
      setRescanning(false);
      setScanNote(`It's the printing you have: ${printingLabel(p, finishFor(item, p))}.`);
      return true;
    }
    await send.mutateAsync(reprintOps(item, p, scope, reprintId(p)));
    setRescanning(false);
    landed(splits(scope) ? null : asPrinting(p), nowIs(p));
    return true;
  };

  if (rescanning) {
    return (
      <div className="scan-overlay">
        <Suspense fallback={<Loading padded>Starting the scanner…</Loading>}>
          <ScannerView
            onAccept={(c) =>
              rescanned(c).catch((e: unknown) => {
                setScanError(e);
                return false;
              })
            }
            onClose={() => setRescanning(false)}
            finish={item.finish === "foil" ? "foil" : "nonfoil"}
            single
            paused={busy}
            acceptLabel="Use this printing"
            addedWord="Changed"
            controls={
              <div className="scan-choices">
                <p className="scan-note">
                  Scan your {item.name ?? "card"}. The printing you confirm replaces {item.set_code?.toUpperCase() ?? "the printing"} #{item.collector_number} for {copies}.
                </p>
                <ErrorText error={scanError ?? send.error} />
              </div>
            }
          />
        </Suspense>
      </div>
    );
  }

  return (
    <Dialog label={item.name ?? "Card"} title={<>{item.name && <CardRef name={item.name} oracleId={item.oracle_id} image={item.image_small} />}</>} onClose={() => onClose()}>
      <div className="stack coll-sheet">
        <div style={{ maxWidth: 260 }}>
          <CardImage src={item.image_normal} name={item.name ?? ""} />
        </div>
        {/* How many and what one is worth, with the price's source and date, then which copy it is. */}
        <div className="coll-sheet-about">
          <p>{worthLine(item)}</p>
          <p className="dim">
            {[`${item.set_name} #${item.collector_number}`, treatmentLabel(item, item.finish), finishWord(item.finish), conditionWord(item.condition), ...markWords(item)].filter(Boolean).join(", ")}
            {item.purchase_price != null ? `. Paid ${usd(item.purchase_price)}` : ""}
          </p>
        </div>
        <div className="row">
          <Button disabled={busy} onClick={() => adjust(-1)}>Remove one</Button>
          <Button disabled={busy} onClick={() => adjust(1)}>Add one more</Button>
        </div>

        {item.qty > 1 && (
          <div className="coll-sheet-scope">
            <Segmented label="Which copies to change" value={scope} onChange={setScope} options={[["all", `All ${item.qty} copies`], ["one", "Just one"]]} />
            <p className="small dim">For where they're kept, their condition, finish, proxy and printing.</p>
          </div>
        )}
        {/* For one copy the row itself stays as it is, so each control says it acts on one. */}
        <Field label={splits(scope) ? "Move one copy to" : "Kept in"}>
          <select value={item.container_id ?? ""} disabled={busy} onChange={(e) => change({ container_id: e.target.value || null })}>
            <option value="">Not filed anywhere</option>
            {treeOrder(containers).map((c) => <option key={c.id} value={c.id}>{optionLabel(c, containers)}</option>)}
          </select>
        </Field>
        <Field label={splits(scope) ? "One copy's condition" : "Condition"}>
          <select value={item.condition} disabled={busy} onChange={(e) => change({ condition: e.target.value })}>
            {(CONDITION_CODES.includes(item.condition) ? CONDITION_CODES : [item.condition, ...CONDITION_CODES]).map((c) => <option key={c} value={c}>{conditionLabel(c)}</option>)}
          </select>
        </Field>
        <Field label={splits(scope) ? "One copy's finish" : "Finish"}>
          <select value={item.finish} disabled={busy} onChange={(e) => change({ finish: e.target.value })}>
            {finishes.map((f) => <option key={f} value={f}>{finishWord(f).replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
        </Field>
        {splits(scope) ? (
          // A tick box would spring back: the row keeps its other copies as they are.
          <div className="row">
            <Button disabled={busy} onClick={() => change({ proxy: !item.proxy })}>{item.proxy ? "Mark one as a real card" : "Mark one as a proxy"}</Button>
          </div>
        ) : (
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" checked={item.proxy} disabled={busy} style={{ width: "auto", minHeight: 0 }} onChange={(e) => change({ proxy: e.target.checked })} />
            {item.qty > 1 ? "These are proxies" : "This is a proxy"}
          </label>
        )}

        <section className="coll-printing stack" aria-label="Printing">
          <h3>Wrong printing?</h3>
          <div className="row">
            <Button aria-expanded={picking} onClick={() => setPicking(!picking)}>Change printing</Button>
            <Button
              disabled={busy}
              onClick={() => {
                setScanError(null);
                setScanNote(null);
                setRescanning(true);
              }}
            >
              Rescan this card
            </Button>
          </div>
          {scanNote && <p className="small" role="status">{scanNote}</p>}
          {picking && (
            <>
              {printings.isPending && <Loading small>Finding the printings…</Loading>}
              {printings.error instanceof ApiError && printings.error.status === 404 ? (
                <p className="dim small">Yama's card data doesn't have this printing, so it can't list the others. Rescan this card instead.</p>
              ) : (
                <ErrorText error={printings.error} />
              )}
              <ul className="coll-printings">
                {printings.data?.map((p) => {
                  const current = p.scryfall_id === item.scryfall_id;
                  // The finish this printing would be saved in, and its price on its own date.
                  const finish = finishFor(item, p);
                  const day = shortDate(p.price_date);
                  return (
                    <li key={p.scryfall_id}>
                      <Button className="coll-printing-choice" aria-current={current} disabled={busy} onClick={() => reprint(p)}>
                        <CardImage src={p.image_small} name={p.name} className="coll-printing-img" />
                        <span className="coll-printing-text">
                          <span>{printingLabel(p, finish)}</span>
                          <span className="small dim">
                            {[
                              p.released_at?.slice(0, 4),
                              p.artist ? `art by ${p.artist}` : null,
                              finish !== item.finish ? `only ${finish}` : null,
                              current ? "the one you have" : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                        </span>
                        <span className="coll-printing-price small">
                          <span className="num">{usd(priceOf(p, finish))}</span>
                          {day && priceOf(p, finish) != null && <span className="dim">{day}</span>}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {printings.data && <p className="small dim">Prices per copy in the finish it would be saved in: TCGplayer market via Scryfall on the date shown, not a store quote.</p>}
            </>
          )}
        </section>

        <section className="coll-marks stack" aria-labelledby={`marks-${item.id}`}>
          <h3 id={`marks-${item.id}`}>About this copy</h3>
          {item.qty > 1 && (
            <Segmented label="Which copies to mark" value={markScope} onChange={setMarkScope} options={[["one", "Just one"], ["all", `All ${item.qty} copies`]]} />
          )}
          <Field label="Language">
            <select value={item.lang} disabled={busy} onChange={(e) => mark({ lang: e.target.value })}>
              {languageChoices(item.lang).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </Field>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" checked={!!item.signed} disabled={busy} style={{ width: "auto", minHeight: 0 }} onChange={(e) => mark({ signed: e.target.checked })} />
            Signed
          </label>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" checked={!!item.altered} disabled={busy} style={{ width: "auto", minHeight: 0 }} onChange={(e) => mark({ altered: e.target.checked })} />
            Altered art
          </label>
        </section>

        {deleting ? (
          <div className="coll-delete stack" role="alert">
            <p>
              Delete {item.qty === 1 ? "this copy" : `all ${item.qty} copies`} of {item.name ?? "this card"} from {where(item)}?
            </p>
            <div className="row">
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => send.mutate([{ op_id: ids.idFor("remove"), kind: "remove", item_id: item.id }], { onSuccess: () => alive.current && onClose(`Deleted ${item.qty === 1 ? name : `${item.qty} copies of ${name}`} from ${where(item)}.`) })}
              >
                Delete
              </Button>
              <Button variant="quiet" onClick={() => setDeleting(false)}>Keep</Button>
            </div>
          </div>
        ) : (
          <Button variant="quiet" danger className="coll-danger-quiet" onClick={() => setDeleting(true)}>
            Delete from collection
          </Button>
        )}
        <ErrorText error={send.error} />
      </div>
      {/* What the last change did. Outside the stack, so it can stay in view at the bottom of the
          sheet wherever the change was made. */}
      {said && !send.isPending && !send.error && <p className="coll-sheet-said" role="status">{said}</p>}
    </Dialog>
  );
}
