import { count, shortDate } from "@yama/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Container } from "../api";
import { CopyButton } from "../components/CopyButton";
import { Details, Dialog, ErrorText, Loading } from "../components/ui";
import "../decks/collect.css";
import {
  chosenPlace,
  IMPORT_MAX_BYTES,
  lineText,
  LIST_EXAMPLE,
  NEW_BOX,
  previewImport,
  previewLines,
  resultLines,
  runImport,
  unmatchedList,
  unmatchedText,
  type ImportReport,
} from "./collectionImport";

/** Lines of a long list drawn at first: an export can run to thousands. */
const SHOWN = 300;

/**
 * Import cards from a pasted list or a file exported by another app. The preview is a dry run
 * (the server matches everything and writes nothing); what matches nothing stays listed, before
 * and after. `onMythic` opens the Mythic Tools import, which also brings that app's boxes and decks.
 */
export function ImportCollectionSheet({ containers, onClose, onMythic }: { containers: Container[]; onClose: () => void; onMythic: () => void }) {
  const qc = useQueryClient();
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [place, setPlace] = useState("");
  const [newName, setNewName] = useState("");
  const [topUp, setTopUp] = useState(false);
  const [tooBig, setTooBig] = useState<Error | null>(null);
  // What is being previewed. Each check gets a number, so the same text checked again asks again.
  const [check, setCheck] = useState<{ n: number; text: string; fileName: string | null } | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);

  const start = (text: string, fileName: string | null) => {
    setResult(null);
    if (text.length > IMPORT_MAX_BYTES) {
      setCheck(null);
      setTooBig(new Error(`That's ${count(Math.round(text.length / 1024))} KB. Yama imports up to ${count(IMPORT_MAX_BYTES / 1024)} KB at a time: split it in two.`));
      return;
    }
    setTooBig(null);
    setCheck({ n: (check?.n ?? 0) + 1, text, fileName });
  };
  const preview = useQuery({
    queryKey: ["collection-import-preview", check?.n, topUp],
    queryFn: () => previewImport(api, check!, topUp),
    enabled: !!check && !result,
    retry: false,
    staleTime: Infinity,
  });
  const apply = useMutation({
    mutationFn: () => runImport(api, check!, { place, newName, topUp }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") || q.queryKey[0] === "containers" });
    },
  });
  const choose = async (f: File) => {
    const text = await f.text();
    setFile({ name: f.name, text });
    start(text, f.name);
  };
  const needsName = place === NEW_BOX && !newName.trim();
  // The preview doesn't depend on where the copies go, so the place is worded here.
  const r = result ?? (preview.data ? { ...preview.data, place: chosenPlace(place, newName, containers) } : undefined);
  return (
    <Dialog title="Import cards" onClose={onClose}>
      <div className="stack">
        <p className="dim">
          Paste a list, or choose a file exported from ManaBox, Moxfield, Archidekt, Deckbox, Dragon Shield or TCGplayer. You see what matches before anything is added.
        </p>
        {!result && (
          <>
            {file ? (
              <p>
                {file.name}{" "}
                <button
                  className="quiet small"
                  onClick={() => {
                    setFile(null);
                    setCheck(null);
                    setTooBig(null);
                  }}
                >
                  Paste a list instead
                </button>
              </p>
            ) : (
              <label>
                List of cards
                <textarea
                  rows={6}
                  placeholder={LIST_EXAMPLE}
                  value={pasted}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setCheck(null);
                  }}
                />
              </label>
            )}
            <label>
              {file ? "Another file" : "Or a file"}
              <input type="file" accept=".csv,.tsv,.txt,.dek,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} />
            </label>
            <label>
              Put them in
              <select value={place} onChange={(e) => setPlace(e.target.value)}>
                <option value="">Not filed anywhere</option>
                {containers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind === "deck" ? "deck box" : c.kind})
                  </option>
                ))}
                <option value={NEW_BOX}>A new box</option>
              </select>
            </label>
            {place === NEW_BOX && (
              <label>
                Name of the new box
                <input value={newName} maxLength={80} placeholder="Bulk" onChange={(e) => setNewName(e.target.value)} />
              </label>
            )}
            <label className="collect-remove">
              <input type="checkbox" checked={topUp} onChange={(e) => setTopUp(e.target.checked)} />
              <span>
                <strong>Only add copies I don't have yet.</strong> For a newer export of a collection that's partly here already: of each printing and finish, Yama adds only the copies beyond what you have.
              </span>
            </label>
            {!file && !check && (
              <div className="row">
                <button className="primary" disabled={!pasted.trim()} onClick={() => start(pasted, null)}>
                  Check the list
                </button>
                <button className="quiet" onClick={onClose}>Cancel</button>
              </div>
            )}
          </>
        )}
        {preview.isFetching && <Loading>Matching the cards…</Loading>}
        <ErrorText error={tooBig ?? preview.error ?? apply.error} retry={!tooBig && preview.error ? () => void preview.refetch() : undefined} />
        {r && <ImportReportView report={r} done={!!result} />}
        {r && !result && r.source === "a Mythic Tools export" && (
          <p>
            This is a Mythic Tools export. Its own import also keeps its boxes and decks.{" "}
            <button className="quiet small" onClick={onMythic}>Import from Mythic Tools</button>
          </p>
        )}
        {r && !result && (
          <div className="row">
            <button className="primary" disabled={apply.isPending || preview.isFetching || r.added === 0 || needsName} onClick={() => apply.mutate()}>
              {apply.isPending ? "Importing…" : r.added ? `Add ${count(r.added)} ${r.added === 1 ? "card" : "cards"}` : "Nothing to add"}
            </button>
            <button className="quiet" onClick={onClose}>Cancel</button>
            {needsName && <span className="dim small">Name the new box first.</span>}
          </div>
        )}
        {result && (
          <div className="row">
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        )}
        {!r && (
          <p className="dim small">
            Coming from Mythic Tools? <button className="quiet small" onClick={onMythic}>Import from Mythic Tools</button> also brings its boxes and decks.
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** What an import would do (a preview) or did: the counts, what matched nothing, and the cards. */
export function ImportReportView({ report: r, done }: { report: ImportReport; done: boolean }) {
  const more = r.added_cards.length - SHOWN;
  return (
    <>
      {done ? (
        <ul className="collect-facts collect-result" role="status">
          {resultLines(r).map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : (
        <ul className="collect-facts">
          {previewLines(r, (d) => shortDate(d) ?? d).map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      {r.unmatched.length > 0 && (
        <section className="stack" aria-label="Lines that matched no card">
          <h3>Not matched</h3>
          <ul className="collect-cards small">{r.unmatched.map((u, i) => <li key={i}>{unmatchedText(u)}</li>)}</ul>
          <div className="row">
            <CopyButton className="outline small" text={unmatchedList(r)} label={r.unmatched.length === 1 ? "Copy this line" : "Copy these lines"} />
          </div>
        </section>
      )}
      {r.added_cards.length > 0 && (
        <Details label={done ? "Cards added" : "Cards to add"}>
          <ul className="collect-cards small">
            {r.added_cards.slice(0, SHOWN).map((c, i) => <li key={i}>{lineText(c)}</li>)}
            {more > 0 && <li className="dim">and {count(more)} more lines</li>}
          </ul>
        </Details>
      )}
      {r.skipped.length > 0 && (
        <Details label="Lines Yama couldn't read">
          <ul className="collect-cards small">{r.skipped.slice(0, SHOWN).map((s, i) => <li key={i}>{s}</li>)}</ul>
        </Details>
      )}
    </>
  );
}
