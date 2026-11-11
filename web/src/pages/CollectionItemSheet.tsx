import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError, type CollectionItem, type Container, type Printing } from "../api";
import { CardRef } from "../components/CardRef";
import { Button, CardImage, Dialog, ErrorText, Field, Loading, Segmented } from "../components/ui";
import type { ScanCandidate } from "../scanner";
import { finishChoices, finishFor, finishWord, languageChoices, markDone, markOps, markWords, opIds, printingLabel, reprintOps, type Mark, type Op, type Scope } from "./collectionEdit";
// The scan choices and their notes, shown here outside the scanner too.
import "../scanner/scanner.css";
import { shortDate, usd } from "@yama/core";

// The scanner pulls in OCR; load it only when someone rescans.
const ScannerView = lazy(() => import("../scanner").then((m) => ({ default: m.ScannerView })));



const priceOf = (p: Printing, finish: string) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);

/**
 * One collection row: its copies, where they live, its printing, and deleting it. `onClose` gets
 * a line to show on the page when a change needs saying (a new printing, a deleted row).
 */
export function CollectionItemSheet({ item, containers, onClose }: { item: CollectionItem; containers: Container[]; onClose: (done?: string) => void }) {
  const qc = useQueryClient();
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
  const save = (ops: Op[], done?: string) => send.mutate(ops, { onSuccess: () => alive.current && onClose(done) });
  const one = (body: Record<string, unknown>) => save([{ op_id: ids.idFor(`update:${JSON.stringify(body)}`), kind: "update", item_id: item.id, ...body } as Op]);
  const adjust = (delta: number) => save([{ op_id: ids.idFor(`adjust:${delta}`), kind: "adjust", item_id: item.id, delta }]);
  const reprintId = (p: Printing) => () => ids.idFor(`reprint:${p.scryfall_id}:${scope}`);
  const name = item.name ?? "The card";
  const nowIs = (p: Printing) => `${scope === "one" && item.qty > 1 ? `One ${name}` : name} is now ${printingLabel(p)}.`;
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
    if (ops.length > 0) save(ops, markDone(item, m, markScope));
  };
  const reprint = (p: Printing) => {
    const ops = reprintOps(item, p, scope, reprintId(p));
    if (ops.length === 0) onClose();
    else save(ops, nowIs(p));
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
        if (alive.current) onClose(`${c.name} is now ${printingLabel(p)}.`);
        return true;
      }
      if (r.error) throw new Error(`Couldn't load the printings of ${item.name ?? "this card"} to check the scan. Nothing was changed; try again.`);
      list = r.data ?? [];
    }
    const p = list.find((x) => x.scryfall_id === c.scryfall_id);
    if (!p) throw new Error(`That's ${c.name}, not ${item.name ?? "this card"}. Nothing was changed.`);
    if (p.scryfall_id === item.scryfall_id) {
      setRescanning(false);
      setScanNote(`It's the printing you have: ${printingLabel(p)}.`);
      return true;
    }
    await send.mutateAsync(reprintOps(item, p, scope, reprintId(p)));
    if (alive.current) onClose(nowIs(p));
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
      <div className="stack">
        <div style={{ maxWidth: 260 }}>
          <CardImage src={item.image_normal} name={item.name ?? ""} />
        </div>
        <p className="dim">
          {[`${item.set_name} #${item.collector_number}`, finishWord(item.finish), item.condition, ...markWords(item)].join(", ")}
          {item.purchase_price != null ? `. Paid ${usd(item.purchase_price)}` : ""}
        </p>
        <div className="row">
          <Button disabled={busy} onClick={() => adjust(-1)}>Remove one</Button>
          <Button disabled={busy} onClick={() => adjust(1)}>Add one more</Button>
        </div>

        <section className="coll-printing stack" aria-label="Printing">
          <h3>Wrong printing?</h3>
          {item.qty > 1 && (
            <Segmented label="Which copies" value={scope} onChange={setScope} options={[["all", `All ${item.qty} copies`], ["one", "Just one"]]} />
          )}
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
                          <span>{printingLabel(p)}</span>
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

        <Field label="Kept in">
          <select value={item.container_id ?? ""} disabled={busy} onChange={(e) => one({ container_id: e.target.value || null })}>
            <option value="">Not filed anywhere</option>
            {containers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
          </select>
        </Field>
        <Field label="Condition">
          <select value={item.condition} disabled={busy} onChange={(e) => one({ condition: e.target.value })}>
            {["NM", "LP", "MP", "HP", "DMG"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Finish">
          <select value={item.finish} disabled={busy} onChange={(e) => one({ finish: e.target.value })}>
            {finishes.map((f) => <option key={f} value={f}>{finishWord(f).replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
        </Field>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
          <input type="checkbox" checked={item.proxy} disabled={busy} style={{ width: "auto", minHeight: 0 }} onChange={(e) => one({ proxy: e.target.checked })} />
          This is a proxy
        </label>
        <p className="small faint">Moving all copies in this row. To move just one, remove one here and add it from the Cards tab into the new place.</p>

        <section className="coll-marks stack" aria-labelledby={`marks-${item.id}`}>
          <h3 id={`marks-${item.id}`}>About this copy</h3>
          {item.qty > 1 && (
            <Segmented label="Which copies to mark" value={markScope} onChange={setMarkScope} options={[["one", "Just one"], ["all", `All ${item.qty} copies`]]} />
          )}
          <label>
            Language
            <select value={item.lang} disabled={busy} onChange={(e) => mark({ lang: e.target.value })}>
              {languageChoices(item.lang).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
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
              Delete {item.qty === 1 ? "this copy" : `all ${item.qty} copies`} of {item.name ?? "this card"} from {item.container_name ?? "your collection"}?
            </p>
            <div className="row">
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => save([{ op_id: ids.idFor("remove"), kind: "remove", item_id: item.id }], `Deleted ${item.qty === 1 ? name : `${item.qty} copies of ${name}`} from ${item.container_name ?? "your collection"}.`)}
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
    </Dialog>
  );
}
