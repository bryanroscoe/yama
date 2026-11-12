import { CardRef } from "../components/CardRef";
// "Add to my collection" for a deck: preview what goes into the deck's box, choose what to do
// with copies of the same printing elsewhere, then add (server/src/collection/deck_box.rs).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button, Details, Dialog, ErrorText, Loading } from "../components/ui";
import { isViewing } from "../viewingFlag";
import { boxText, buttonText, groups, outcomeText, printingText, resultText, SAME_CHOICES, summary, type CollectPreview, type SamePrinting } from "./collect";
import "./collect.css";

/** `offer`: opened at the end of a deck import, so it asks rather than tells. */
export function CollectSheet({ deckId, offer = false, onClose }: { deckId: string; offer?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [same, setSame] = useState<SamePrinting>("move");
  // null preserves imported proxy flags until the owner makes a choice.
  const [proxies, setProxies] = useState<string[] | null>(null);
  const [result, setResult] = useState<CollectPreview | null>(null);
  const preview = useQuery({
    queryKey: ["deck-collect", deckId, same, proxies],
    queryFn: ({ signal }) => api<CollectPreview>(`/api/decks/${deckId}/collect?same=${same}${proxies === null ? "" : `&proxies=${encodeURIComponent(proxies.join(","))}`}`, { signal }),
    enabled: !result,
    placeholderData: keepPreviousData,
  });
  const add = useMutation({
    mutationFn: () => api<CollectPreview>(`/api/decks/${deckId}/collect`, { method: "POST", json: { same, ...(proxies === null ? {} : { proxies }) } }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ predicate: (q) => ["deck", "decks", "containers", "deck-collect"].includes(String(q.queryKey[0])) || String(q.queryKey[0]).startsWith("collection") });
    },
  });
  const viewing = isViewing();
  const p = result ?? preview.data;
  const title = offer && p && !result ? `Add these ${p.cards} cards to your collection?` : "Add to my collection";
  const g = p ? groups(p) : null;

  return (
    <Dialog title={title} onClose={onClose}>
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
            {!result && p.lines.length > 0 && (
              <fieldset className="collect-choices" disabled={viewing || add.isPending}>
                <legend>Which cards are printed proxies?</legend>
                <p className="small dim">Saving a deck list doesn’t add collection copies. Mark your printed cards here; unmarked cards are added as real copies. Copies already in the box stay as they are.</p>
                {p.lines.map((line) => (
                  <label key={line.oracle_id}>
                    <input type="checkbox" checked={proxies === null ? line.proxy : proxies.includes(line.oracle_id)} onChange={(event) => {
                      const selected = new Set(proxies ?? p.lines.filter((l) => l.proxy).map((l) => l.oracle_id));
                      if (event.target.checked) selected.add(line.oracle_id);
                      else selected.delete(line.oracle_id);
                      setProxies([...selected].sort());
                    }} />
                    {line.missing > 1 ? `${line.missing} ` : ""}{line.name}
                    <span className="hint">{(proxies === null ? line.proxy : proxies.includes(line.oracle_id)) ? "Proxy" : "Real copy"}</span>
                  </label>
                ))}
              </fieldset>
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
            <ErrorText error={add.error} />
            {!result && (
              <div className="row">
                <Button variant="primary" disabled={viewing || add.isPending || preview.isFetching || !!preview.error || p.added + p.moved === 0} onClick={() => add.mutate()}>
                  {add.isPending ? "Adding…" : preview.isFetching ? "Checking…" : buttonText(p)}
                </Button>
                <Button variant="quiet" onClick={onClose}>
                  {offer ? "Not now" : "Cancel"}
                </Button>
                {viewing && <span className="small dim">Read only while viewing as someone.</span>}
              </div>
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
