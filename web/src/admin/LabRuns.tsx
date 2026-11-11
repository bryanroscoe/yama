import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ErrorText } from "../components/ui";
import { adminApi, type LabRun } from "./api";
import { ago, count } from "@yama/core";
import { ask } from "../components/confirm";

/** Imported lab runs everyone sees (precon ratings): rename or delete. Adding one stays on the
 *  command line (`yama-server import-lab`). */
export function LabRunsPage() {
  const runs = useQuery({ queryKey: ["admin-lab-runs"], queryFn: adminApi.labRuns });
  return (
    <section className="admin-section" aria-labelledby="adm-runs">
      <div className="admin-section-head">
        <h2 id="adm-runs">Lab runs everyone sees</h2>
        <span className="dim">Add runs on the server with yama-server import-lab.</span>
      </div>
      <ErrorText error={runs.error} />
      {runs.data?.length === 0 && <p className="dim">No runs have been imported.</p>}
      <ul className="admin-list">
        {runs.data?.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </ul>
    </section>
  );
}

function RunRow({ run }: { run: LabRun }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(run.name);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-lab-runs"] });
    void qc.invalidateQueries({ queryKey: ["lab"] });
  };
  const rename = useMutation({
    mutationFn: () => adminApi.renameRun(run.id, name),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const del = useMutation({ mutationFn: () => adminApi.deleteRun(run.id), onSuccess: refresh });
  const what = run.kind === "paired" ? "paired comparison" : "precon ratings";
  return (
    <li>
      <div className="admin-text">
        {editing ? (
          <form
            className="admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <label>
              <span className="visually-hidden">New name for {run.name}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </label>
            <Button type="submit" disabled={rename.isPending || !name.trim()}>Save</Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <b>{run.name}</b>
        )}
        <span>
          {count(run.games)} games, {run.decks} decks rated, {what}.
        </span>
        <span>
          {run.engine ?? "Engine not recorded"}
          {run.difficulty ? `, ${run.difficulty} AI` : ""}. Imported {ago(run.imported_at)}.
        </span>
        <ErrorText error={rename.error ?? del.error} />
      </div>
      {!editing && (
        <div className="admin-actions">
          <Button variant="outline" onClick={() => setEditing(true)}>
            Rename
          </Button>
          <Button
            variant="outline" danger
            disabled={del.isPending}
            onClick={async () => (await ask({ title: `Delete ${run.name}?`, body: "Its ratings go too, for everyone.", confirm: "Delete run", danger: true })) && del.mutate()}
          >
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}
