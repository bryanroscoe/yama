import { type ImportReport, type RowCounts } from "@yama/core/plan";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { importReport } from "../research/api";
import { Details, ErrorText, Sheet } from "../components/ui";
import { uploadPlan } from "./api";
import { shortHash } from "./PlanLayout";
import type { PlanView } from "./view";
import { fmtDate } from "@yama/core";

/**
 * Pick a plan file, read what importing it would do (a dry run that saves nothing), then import.
 * The file goes to the server exactly as picked.
 */
export function ImportSheet({ view, onClose }: { view: PlanView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  // A plan note (yama-research/1, what agents save) or a planner's export: the file says which.
  const [note, setNote] = useState<{ title: string; decks: number; doc: unknown } | null>(null);
  const check = useMutation({ mutationFn: (f: File) => uploadPlan(f, true) });
  const apply = useMutation({
    mutationFn: (f: File) => uploadPlan(f, false),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan"] }),
  });
  const saveNote = useMutation({
    mutationFn: (doc: unknown) => importReport(doc),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["research"] });
      onClose();
      navigate(`/decks/research/${encodeURIComponent(r.id)}`);
    },
  });
  const read = useMutation({
    mutationFn: async (f: File) => {
      // A note is named in its schema; anything else (a planner export, or not JSON at all) goes
      // to the plan import, which checks it and says what's wrong.
      type Doc = { schema?: unknown; title?: unknown; decks?: unknown } | null;
      let doc: Doc;
      try {
        doc = JSON.parse(await f.text()) as Doc;
      } catch {
        return null;
      }
      if (doc?.schema !== "yama-research/1") return null;
      if (f.size > 4 << 20) throw new Error("Plan notes must be under 4 MiB.");
      return { title: String(doc.title ?? "Untitled plan"), decks: Array.isArray(doc.decks) ? doc.decks.length : 0, doc };
    },
    onSuccess: (n, f) => {
      setNote(n);
      if (!n) check.mutate(f);
    },
  });
  const report = apply.data ?? check.data;

  return (
    <Sheet label="Import a plan file" onClose={onClose}>
      <div className="stack">
        <div className="sheet-head">
          <h2>Import a plan file</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        {!apply.data && (
          <>
            <p className="dim small">
              A plan file an agent saved (yama-research/1), or your planner's JSON export. A planner export shows what importing it would change first.
            </p>
            <label>
              Plan file
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setNote(null);
                  check.reset();
                  saveNote.reset();
                  if (f) read.mutate(f);
                }}
              />
            </label>
          </>
        )}
        {(check.isPending || read.isPending) && <p className="dim">Checking the file…</p>}
        <ErrorText error={read.error ?? check.error ?? apply.error ?? saveNote.error} />
        {note && (
          <>
            <p>
              <b>{note.title}</b>: a plan for {note.decks} {note.decks === 1 ? "deck" : "decks"}. Importing saves it to your plans, replacing a plan with the same ID.
            </p>
            <div className="row">
              <button className="primary" disabled={saveNote.isPending} onClick={() => saveNote.mutate(note.doc)}>
                {saveNote.isPending ? "Importing…" : "Import"}
              </button>
              <button className="quiet" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
        {report && <Report report={report} view={view} applied={!!apply.data} />}
        {check.data && !check.data.unchanged && !apply.data && file && (
          <div className="row">
            <button className="primary" disabled={apply.isPending} onClick={() => apply.mutate(file)}>
              {apply.isPending ? "Importing…" : "Import"}
            </button>
            <button className="quiet" onClick={onClose}>Cancel</button>
          </div>
        )}
        {(apply.data || check.data?.unchanged) && (
          <div className="row">
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function rows(label: string, c: RowCounts): string | null {
  const parts = [
    c.added && `${c.added} new`,
    c.changed && `${c.changed} changed`,
    c.restored && `${c.restored} back again`,
    c.retired && `${c.retired} ${label === "decks" ? "archived" : "retired"}`,
    c.unchanged && `${c.unchanged} unchanged`,
  ].filter(Boolean);
  return parts.length ? `${label[0]!.toUpperCase()}${label.slice(1)}: ${parts.join(", ")}.` : null;
}

function Report({ report: r, view, applied }: { report: ImportReport; view: PlanView; applied: boolean }) {
  const before = r.head_before;
  const older = r.guide_version != null && before?.guide_version != null && r.guide_version < before.guide_version;
  const deckName = (k: string | null) => (k ? view.deckName(k) : null);
  // The older-file warning is shown on its own above, so it isn't repeated in the list.
  const warnings = older ? r.warnings.filter((w) => !w.startsWith("This file is guide v")) : r.warnings;
  if (r.unchanged) {
    return (
      <>
        <p>This file is the plan Yama already has. Nothing to import.</p>
        <Details>
          <p>Plan {shortHash(r.content_hash)}.</p>
        </Details>
      </>
    );
  }
  return (
    <div className="stack plan-report">
      {applied ? (
        <p role="status">
          <span className="tag good">Imported</span> Your plans now show this file.
        </p>
      ) : (
        <p className="dim small">What importing this file would do:</p>
      )}
      <dl className="plan-kv small">
        <dt>This file</dt>
        <dd>
          {r.app ?? "Unknown planner"}
          {r.guide_version != null ? `, guide v${r.guide_version}` : ""}
          {r.guide_date ? ` of ${fmtDate(r.guide_date)}` : ""}
        </dd>
        <dt>In Yama {applied ? "before" : "now"}</dt>
        <dd>
          {before?.content_hash
            ? [before.guide_version != null ? `Guide v${before.guide_version}` : "A plan", before.imported_at ? `imported ${fmtDate(before.imported_at)}` : null]
                .filter(Boolean)
                .join(", ")
            : "No plan yet"}
        </dd>
      </dl>
      <Details>
        <p>
          This file: plan {shortHash(r.content_hash)}
          {r.git_sha ? `, commit ${r.git_sha.slice(0, 7)}` : ""}
          {r.dirty ? " with uncommitted changes" : ""}.
        </p>
        {before?.content_hash && (
          <p>
            In Yama {applied ? "before" : "now"}: plan {shortHash(before.content_hash)}
            {before.git_sha ? `, commit ${before.git_sha.slice(0, 7)}` : ""}.
          </p>
        )}
      </Details>
      {older && (
        <p>
          <span className="tag warn">Older file</span> This file is guide v{r.guide_version}, older than the guide v{before?.guide_version} plan Yama has.
          Importing it goes back to the older plan.
        </p>
      )}
      <ul className="small">
        {[rows("decks", r.counts.decks), rows("swaps", r.counts.swaps), rows("orders", r.counts.orders), rows("stores", r.counts.stores)]
          .filter(Boolean)
          .map((l) => (
            <li key={l}>{l}</li>
          ))}
        <li>
          {r.counts.states_new} new {r.counts.states_new === 1 ? "list" : "lists"}
          {r.counts.states_refreshed ? `, ${r.counts.states_refreshed} with new printings or sources` : ""}; {r.counts.quotes} price and stock records;{" "}
          {r.counts.settings} shopping rule {r.counts.settings === 1 ? "set" : "sets"}.
        </li>
        {r.reviews.from_document_applied + r.reviews.yama_newer_kept > 0 && (
          <li>
            Answers: {r.reviews.from_document_applied} taken from the file, {r.reviews.yama_newer_kept} newer ones made in Yama kept.
          </li>
        )}
      </ul>
      {r.unknown_cards.length > 0 && (
        <details>
          <summary>{r.unknown_cards.length} cards Yama doesn't know yet (kept; they show up once Yama's card data has them)</summary>
          <ul className="small">
            {r.unknown_cards.map((c) => (
              <li key={c.name}>
                {c.name} <span className="dim">({c.where.join("; ")})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.unknown_printings.length > 0 && (
        <details>
          <summary>{r.unknown_printings.length} printings Yama doesn't know (kept)</summary>
          <ul className="small">
            {r.unknown_printings.map((p, i) => (
              <li key={i}>
                {p.card} {p.set ? `(${p.set.toUpperCase()}${p.num ? ` #${p.num}` : ""})` : ""} <span className="dim">{p.where.join("; ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.orphan_answers.length > 0 && (
        <details>
          <summary>{r.orphan_answers.length} of your answers match no swap in this file (kept)</summary>
          <ul className="small">
            {r.orphan_answers.map((o) => (
              <li key={o.swap_key}>
                {o.card ?? o.swap_key}
                {o.deck ? ` in ${o.deck}` : ""}
                {o.decision ? `: ${o.decision}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {warnings.length > 0 && (
        <details open>
          <summary>{warnings.length === 1 ? "1 warning from Yama" : `${warnings.length} warnings from Yama`}</summary>
          <ul className="small">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {r.export_warnings.length > 0 && (
        <details>
          <summary>{r.export_warnings.length === 1 ? "1 warning from the planner" : `${r.export_warnings.length} warnings from the planner`}</summary>
          <ul className="small">
            {r.export_warnings.map((w, i) => (
              <li key={i}>
                {deckName(w.deck) ? <b>{deckName(w.deck)}: </b> : null}
                {w.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.existing_decks.length > 0 && (
        <p className="small dim">
          Your Yama decks in the folder "commander-decks" ({r.existing_decks.map((d) => d.name).join(", ")}) aren't changed by an import.
        </p>
      )}
    </div>
  );
}
