import { CardRef } from "../components/CardRef";
// "Add to my collection" for a deck: preview what goes into the deck's box, choose what to do
// with copies of the same printing elsewhere, then add (server/src/collection/deck_box.rs).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { api } from "../api";
import { Button, Details, Dialog, ErrorText, Loading } from "../components/ui";
import { isViewing } from "../viewingFlag";
import { boxText, buttonText, collectAfter, declineOffer, forgetDeclined, groups, offerDeclined, offerLine, offerTitle, outcomeText, printingText, resultText, SAME_CHOICES, summary, type CollectPreview, type SamePrinting } from "./collect";
import "./collect.css";

const previewPath = (deckId: string, same: SamePrinting, proxies: string[] | null) =>
  `/api/decks/${deckId}/collect?same=${same}${proxies === null ? "" : `&proxies=${encodeURIComponent(proxies.join(","))}`}`;

/**
 * `offer`: opened by `?collect=1`, so it asks rather than tells. When the page got there by
 * itself (the navigation's state says why, collect.ts `collectAfter`) the offer is kept small:
 * after adding a deck it is the sheet, once; after saving an edit it is one line, and only for
 * a deck whose box already holds cards. "Not now" is remembered for the deck on this device.
 */
export function CollectSheet({ deckId, offer = false, onClose }: { deckId: string; offer?: boolean; onClose: () => void }) {
  const location = useLocation();
  const after = offer ? collectAfter(location.state) : null;
  // Decided once, as the sheet opens: answering "Not now" mustn't unmount what is on screen.
  const [declined] = useState(() => after !== null && offerDeclined(deckId));
  const [line, setLine] = useState(after === "edit");
  useEffect(() => {
    if (declined) onClose();
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (declined) return null;
  const notNow = () => {
    declineOffer(deckId);
    onClose();
  };
  if (line) return <OfferLine deckId={deckId} onOpen={() => setLine(false)} onNotNow={notNow} onNothing={onClose} />;
  return <Sheet deckId={deckId} offer={offer} onClose={onClose} onNotNow={after ? notNow : onClose} />;
}

/** After a saved edit: one line, where the deck's box is short of cards the list now has. */
function OfferLine({ deckId, onOpen, onNotNow, onNothing }: { deckId: string; onOpen: () => void; onNotNow: () => void; onNothing: () => void }) {
  const viewing = isViewing();
  // The sheet's own first question, so opening it from here has its answer already.
  const preview = useQuery({
    queryKey: ["deck-collect", deckId, "move", null],
    queryFn: ({ signal }) => api<CollectPreview>(previewPath(deckId, "move", null), { signal }),
    enabled: !viewing,
  });
  const text = preview.data ? offerLine(preview.data) : null;
  const nothing = viewing || preview.isError || (!!preview.data && !text);
  useEffect(() => {
    if (nothing) onNothing();
    // onNothing is the page's close: it is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nothing]);
  if (!text) return null;
  return (
    <p className="collect-offer" role="status">
      <span>{text.text}</span>
      <Button variant="quiet" size="small" onClick={onOpen}>{text.action}</Button>
      <Button variant="quiet" size="small" onClick={onNotNow}>Not now</Button>
    </p>
  );
}

function Sheet({ deckId, offer, onClose, onNotNow }: { deckId: string; offer: boolean; onClose: () => void; onNotNow: () => void }) {
  const qc = useQueryClient();
  const [same, setSame] = useState<SamePrinting>("move");
  // null preserves imported proxy flags until the owner makes a choice.
  const [proxies, setProxies] = useState<string[] | null>(null);
  const [result, setResult] = useState<CollectPreview | null>(null);
  const preview = useQuery({
    queryKey: ["deck-collect", deckId, same, proxies],
    queryFn: ({ signal }) => api<CollectPreview>(previewPath(deckId, same, proxies), { signal }),
    enabled: !result,
    placeholderData: keepPreviousData,
  });
  const add = useMutation({
    mutationFn: () => api<CollectPreview>(`/api/decks/${deckId}/collect`, { method: "POST", json: { same, ...(proxies === null ? {} : { proxies }) } }),
    onSuccess: (r) => {
      setResult(r);
      // The deck is in the collection now: an earlier "Not now" no longer speaks for it.
      forgetDeclined(deckId);
      void qc.invalidateQueries({ predicate: (q) => ["deck", "decks", "containers", "deck-collect"].includes(String(q.queryKey[0])) || String(q.queryKey[0]).startsWith("collection") });
    },
  });
  const viewing = isViewing();
  const p = result ?? preview.data;
  const title = offer && p && !result ? offerTitle(p) : "Add to my collection";
  const g = p ? groups(p) : null;
  // Closing an offer without adding is "Not now" too; after adding there is nothing to decline.
  const close = result ? onClose : onNotNow;
  const isProxy = (line: { oracle_id: string; proxy: boolean }) => (proxies === null ? line.proxy : proxies.includes(line.oracle_id));

  return (
    <Dialog title={title} onClose={close}>
      <div className="stack">
        <ErrorText error={preview.error} />
        {!p && !preview.error && <Loading>Checking your collection…</Loading>}
        {p && (
          <>
            <p className="dim">{boxText(p)}</p>
            {result ? (
              <p className="collect-result" role="status">
                {resultText(result)}
              </p>
            ) : (
              <ul className="collect-facts">
                {summary(p).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
            {!result && p.same_elsewhere > 0 && (
              <fieldset className="collect-choices" disabled={viewing || add.isPending}>
                <legend>The copies you own in the same printing</legend>
                {SAME_CHOICES.map((c) => (
                  <label key={c.value}>
                    <input type="radio" name="collect-same" checked={same === c.value} onChange={() => setSame(c.value)} />
                    {c.label}
                    <span className="hint">
                      {outcomeText(p.options[c.value])}
                      {c.value === "move" && " Never from another deck's box."}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <ErrorText error={add.error} />
            {/* The answer comes straight after the summary; what's below it is optional detail. It
                stays in reach while the proxy list is open and scrolled. */}
            {!result && (
              <div className="row collect-answer">
                <Button variant="primary" disabled={viewing || add.isPending || preview.isFetching || !!preview.error || p.added + p.moved === 0} onClick={() => add.mutate()}>
                  {add.isPending ? "Adding…" : preview.isFetching ? "Checking…" : buttonText(p)}
                </Button>
                <Button variant="quiet" onClick={close}>
                  {offer ? "Not now" : "Cancel"}
                </Button>
                {viewing && <span className="small dim">Read only while viewing as someone.</span>}
              </div>
            )}
            {!result && p.lines.length > 0 && (
              <Details className="collect-proxies" label={p.lines.length === 1 ? "It's a proxy (a printed stand-in)" : "Some of these are proxies (printed stand-ins)"}>
                <fieldset className="collect-choices" disabled={viewing || add.isPending}>
                  <legend className="visually-hidden">Which cards are proxies</legend>
                  <p className="small dim">Tick each card you printed yourself or use a stand-in for. Yama adds those as proxies and the rest as real cards. Copies already in the box stay as they are.</p>
                  {p.lines.map((line) => (
                    <label key={line.oracle_id}>
                      <input type="checkbox" checked={isProxy(line)} onChange={(event) => {
                        const selected = new Set(proxies ?? p.lines.filter((l) => l.proxy).map((l) => l.oracle_id));
                        if (event.target.checked) selected.add(line.oracle_id);
                        else selected.delete(line.oracle_id);
                        setProxies([...selected].sort());
                      }} />
                      {line.missing > 1 ? `${line.missing} ` : ""}{line.name}
                      <span className="hint">{isProxy(line) ? "Proxy" : "Real card"}</span>
                    </label>
                  ))}
                </fieldset>
              </Details>
            )}
            {g && (g.add.length > 0 || g.move.length > 0 || g.leave.length > 0) && (
              <Details label={result ? "The cards" : "Which cards"}>
                {g.add.length > 0 && (
                  <CardList title={result ? "Added" : "To add"} lines={g.add.map((l) => ({ key: l.oracle_id, qty: l.added, name: l.name, note: printingText(l) }))} />
                )}
                {g.move.length > 0 && (
                  <CardList
                    title={result ? "Moved in" : "To move in"}
                    lines={g.move.map((l) => ({ key: l.oracle_id, qty: l.moved, name: l.name, note: `${printingText(l)}. From ${l.elsewhere.map((e) => e.place).join(", ")}` }))}
                  />
                )}
                {g.leave.length > 0 && (
                  <CardList
                    title="Left out"
                    lines={g.leave.map((l) => ({ key: l.oracle_id, qty: l.left_out, name: l.name, note: l.elsewhere.length ? `You have it in ${l.elsewhere.map((e) => e.place).join(", ")}` : printingText(l) }))}
                  />
                )}
              </Details>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function CardList({ title, lines }: { title: string; lines: { key: string; qty: number; name: string; note: string }[] }) {
  return (
    <section>
      <h3 className="small">{title}</h3>
      <ul className="collect-cards">
        {lines.map((l) => (
          <li key={l.key}>
            <span>
              {l.qty > 1 ? `${l.qty} ` : ""}
              <CardRef name={l.name}/>
            </span>
            <span className="small dim">{l.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
