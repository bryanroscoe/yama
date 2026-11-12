import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { ago, count } from "@yama/core";
import { RegionPreview } from "../bugs/BugReport";
import { ask } from "../components/confirm";
import { Button, ErrorText, Loading, Segmented } from "../components/ui";
import { adminApi, type BugReport } from "./api";

/** Bug reports people sent from the bug buttons (bugs/BugReport.tsx), newest first. */
export function BugReportsPage() {
  const [show, setShow] = useState<"open" | "resolved">("open");
  const list = useQuery({ queryKey: ["admin-bugs", show], queryFn: () => adminApi.bugReports(show) });
  return (
    <section className="admin-section" aria-labelledby="adm-bugs">
      <div className="admin-section-head">
        <h2 id="adm-bugs">Bug reports</h2>
        <Segmented
          label="Which reports"
          value={show}
          onChange={setShow}
          options={[
            ["open", `Open${list.data ? ` (${count(list.data.open)})` : ""}`],
            ["resolved", `Resolved${list.data ? ` (${count(list.data.resolved)})` : ""}`],
          ]}
        />
      </div>
      <ErrorText error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <Loading />}
      {list.data?.reports.length === 0 && <p className="dim">{show === "open" ? "No open reports." : "No resolved reports."}</p>}
      <ul className="admin-list bug-list">
        {list.data?.reports.map((r) => (
          <ReportRow key={r.id} report={r} />
        ))}
      </ul>
    </section>
  );
}

function ReportRow({ report: r }: { report: BugReport }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-bugs"] });
  const resolve = useMutation({ mutationFn: () => adminApi.resolveBug(r.id, !r.resolved_at), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => adminApi.deleteBug(r.id), onSuccess: refresh });
  const c = r.context ?? {};
  const sel = c.selection;
  return (
    <li className="bug-row">
      <div className="admin-text">
        <b className="bug-message">{r.message}</b>
        <span>
          {r.reporter_name || r.reporter_email} ({r.reporter_email}), {ago(r.created_at)}
          {r.resolved_at ? `, resolved ${ago(r.resolved_at)}` : ""}
        </span>
        <span>
          On <Link to={r.page || "/"}>{r.page || "/"}</Link>
          {c.heading ? `, page ${c.heading}` : ""}
          {c.dialog ? `, in the ${c.dialog} dialog` : ""}
        </span>
      </div>
      <div className="admin-actions">
        <Button size="small" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
          {r.resolved_at ? "Reopen" : "Resolve"}
        </Button>
        <Button
          size="small"
          variant="quiet"
          danger
          disabled={remove.isPending}
          onClick={async () => {
            if (await ask({ title: "Delete this report?", body: "It goes for good.", confirm: "Delete report", danger: true })) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
      {sel && (
        <div className="bug-detail">
          <RegionPreview region={sel} viewport={c.viewport} />
          <dl>
            {sel.images?.length ? (
              <>
                <dt>Pictures</dt>
                <dd>{sel.images.join(", ")}</dd>
              </>
            ) : null}
            {sel.text ? (
              <>
                <dt>Words in the box</dt>
                <dd>{sel.text}</dd>
              </>
            ) : null}
            {sel.controls?.length ? (
              <>
                <dt>Controls</dt>
                <dd>{sel.controls.join("; ")}</dd>
              </>
            ) : null}
            {sel.path ? (
              <>
                <dt>Element</dt>
                <dd className="bug-code">{sel.path}</dd>
              </>
            ) : null}
            <dt>Box</dt>
            <dd>
              {Math.round(sel.x)}, {Math.round(sel.y)}, {Math.round(sel.w)} by {Math.round(sel.h)} px
            </dd>
          </dl>
        </div>
      )}
      <p className="bug-device dim">
        {c.viewport ? `${c.viewport.w} by ${c.viewport.h} window${c.viewport.dpr && c.viewport.dpr !== 1 ? ` at ${c.viewport.dpr}x` : ""}. ` : ""}
        {c.build ? `Build ${c.build}. ` : ""}
        {c.agent}
      </p>
      <ErrorText error={resolve.error ?? remove.error} small />
    </li>
  );
}
