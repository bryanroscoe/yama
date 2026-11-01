import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, usd, type CollectionItem, type Container, type Printing } from "../api";
import { CardRef } from "../components/CardRef";
import { CardImage, ErrorText, Sheet } from "../components/ui";
import type { ScanCandidate } from "../scanner";
import { printingLabel, reprintOps, type Op, type Scope } from "./collectionEdit";

// The scanner pulls in OCR; load it only when someone rescans.
const ScannerView = lazy(() => import("../scanner").then((m) => ({ default: m.ScannerView })));

type Item = CollectionItem & { altered?: boolean; signed?: boolean; misprint?: boolean };

const priceOf = (p: Printing, finish: string) => (finish === "foil" ? p.usd_foil : finish === "etched" ? p.usd_etched : p.usd);

/**
 * One collection row: its copies, where they live, its printing, and deleting it. `onClose` gets
 * a line to show on the page when a change needs saying (a new printing, a deleted row).
 */
export function CollectionItemSheet({ item, containers, onClose }: { item: Item; containers: Container[]; onClose: (done?: string) => void }) {
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
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const copies = item.qty === 1 ? "this copy" : scope === "all" ? `all ${item.qty} copies` : "one copy";

  const send = useMutation({
    mutationFn: (ops: Op[]) => api("/api/collection/ops", { method: "POST", json: ops }),
    onSuccess: () => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" }),
  });
  const busy = send.isPending;
  const save = (ops: Op[], done?: string) => send.mutate(ops, { onSuccess: () => alive.current && onClose(done) });
  const one = (body: Record<string, unknown>) => save([{ op_id: crypto.randomUUID(), kind: "update", item_id: item.id, ...body } as Op]);
  const adjust = (delta: number) => save([{ op_id: crypto.randomUUID(), kind: "adjust", item_id: item.id, delta }]);
  const name = item.name ?? "The card";
  const nowIs = (p: Printing) => `${scope === "one" && item.qty > 1 ? `One ${name}` : name} is now ${printingLabel(p)}.`;
  // Every printing of this card, newest first: the picker's list, and the check on a rescan.
  const printings = useQuery({
    queryKey: ["printings-of", item.scryfall_id],
    queryFn: () => api<{ printings: Printing[] }>(`/api/scan/printings?id=${encodeURIComponent(item.scryfall_id)}`).then((r) => r.printings),
    enabled: picking || rescanning,
    staleTime: 60 * 60 * 1000,
  });
  const reprint = (p: Printing) => {
    const ops = reprintOps(item, p, scope, () => crypto.randomUUID());
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
    await send.mutateAsync(reprintOps(item, p, scope, () => crypto.randomUUID()));
    if (alive.current) onClose(nowIs(p));
    return true;
  };

  if (rescanning) {
    return (
      <div className="scan-overlay">
        <Suspense fallback={<p className="dim" style={{ padding: "1rem" }}>Starting the scanner…</p>}>
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
    <Sheet label={item.name ?? "Card"} onClose={() => onClose()}>
      <div className="stack">
        <div className="sheet-head">
          <h2>{item.name && <CardRef name={item.name} oracleId={item.oracle_id} image={item.image_small} />}</h2>
          <button className="quiet" onClick={() => onClose()}>Close</button>
        </div>
        <div style={{ maxWidth: 260 }}>
          <CardImage src={item.image_normal} name={item.name ?? ""} />
        </div>
        <p className="dim">
          {item.set_name} #{item.collector_number}, {item.finish}, {item.condition}, {item.lang}
          {item.purchase_price != null ? `. Paid ${usd(item.purchase_price)}` : ""}
        </p>
        <div className="row">
          <button disabled={busy} onClick={() => adjust(-1)}>Remove one</button>
          <button disabled={busy} onClick={() => adjust(1)}>Add one more</button>
        </div>

        <section className="coll-printing stack" aria-label="Printing">
          <h3>Wrong printing?</h3>
          {item.qty > 1 && (
            <div className="segmented" role="group" aria-label="Which copies">
              <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All {item.qty} copies</button>
              <button aria-pressed={scope === "one"} onClick={() => setScope("one")}>Just one</button>
            </div>
          )}
          <div className="row">
            <button aria-expanded={picking} onClick={() => setPicking(!picking)}>Change printing</button>
            <button
              disabled={busy}
              onClick={() => {
                setScanError(null);
                setScanNote(null);
                setRescanning(true);
              }}
            >
              Rescan this card
            </button>
          </div>
          {scanNote && <p className="small" role="status">{scanNote}</p>}
          {picking && (
            <>
              {printings.isPending && <p className="dim small">Finding the printings…</p>}
              <ErrorText error={printings.error} />
              <ul className="coll-printings">
                {printings.data?.map((p) => {
                  const current = p.scryfall_id === item.scryfall_id;
                  return (
                    <li key={p.scryfall_id}>
                      <button className="coll-printing-choice" aria-current={current} disabled={busy} onClick={() => reprint(p)}>
                        <CardImage src={p.image_small} name={p.name} className="coll-printing-img" />
                        <span className="coll-printing-text">
                          <span>{printingLabel(p)}</span>
                          <span className="small dim">
                            {[p.released_at?.slice(0, 4), p.artist ? `art by ${p.artist}` : null, current ? "the one you have" : null].filter(Boolean).join(", ")}
                          </span>
                        </span>
                        <span className="num small">{usd(priceOf(p, item.finish))}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {printings.data && <p className="small dim">Prices for the {item.finish} finish, TCGplayer market via Scryfall, where known.</p>}
            </>
          )}
        </section>

        <label>
          Kept in
          <select value={item.container_id ?? ""} disabled={busy} onChange={(e) => one({ container_id: e.target.value || null })}>
            <option value="">Not filed anywhere</option>
            {containers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
          </select>
        </label>
        <label>
          Condition
          <select value={item.condition} disabled={busy} onChange={(e) => one({ condition: e.target.value })}>
            {["NM", "LP", "MP", "HP", "DMG"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 400 }}>
          <input type="checkbox" checked={item.proxy} disabled={busy} style={{ width: "auto", minHeight: 0 }} onChange={(e) => one({ proxy: e.target.checked })} />
          This is a proxy
        </label>
        <p className="small faint">Moving all copies in this row. To move just one, remove one here and add it from the Cards tab into the new place.</p>

        {deleting ? (
          <div className="coll-delete stack" role="alertdialog" aria-label="Delete">
            <p>
              Delete {item.qty === 1 ? "this copy" : `all ${item.qty} copies`} of {item.name ?? "this card"} from {item.container_name ?? "your collection"}?
            </p>
            <div className="row">
              <button
                className="coll-danger"
                disabled={busy}
                onClick={() => save([{ op_id: crypto.randomUUID(), kind: "remove", item_id: item.id }], `Deleted ${item.qty === 1 ? name : `${item.qty} copies of ${name}`} from ${item.container_name ?? "your collection"}.`)}
              >
                Delete
              </button>
              <button className="quiet" onClick={() => setDeleting(false)}>Keep</button>
            </div>
          </div>
        ) : (
          <button className="quiet coll-danger-quiet" onClick={() => setDeleting(true)}>
            Delete from collection
          </button>
        )}
        <ErrorText error={send.error} />
      </div>
    </Sheet>
  );
}
