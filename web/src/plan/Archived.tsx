import { fmtDate, sourceText } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ErrorText } from "../components/ui";
import { planSummaries, planSummariesKey } from "../research/view";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { planHref } from "./Plans";
import "./plans.css";

/** A research note's page among the archived plans. */
export const archivedNoteHref = (id: string, deck?: string) =>
  `/decks/plans/archived/${encodeURIComponent(id)}${deck ? `/${encodeURIComponent(deck)}` : ""}`;

/**
 * `/decks/plans/archived` (design board "Archived"): research notes, earlier versions of plans and
 * plans set aside. Kept for reference; none of them is a current plan or on a shopping list.
 */
export function Archived() {
  const { view, userId } = usePlanOutlet();
  const notes = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries });
  const versions = (view.b.versions ?? []).filter((v) => v.superseded_at || v.status === "kept");
  const decks = view.b.decks.filter((d) => view.planOf(d).state === "archived");
  return (
    <>
      <PlansHead title="Archived plans" />
      <nav className="plan-crumbs plans-crumbs" aria-label="Breadcrumb">
        <Link to="/decks">Decks</Link>
        <span aria-hidden="true">/</span>
        <Link to="/decks/plans">Plans</Link>
      </nav>
      <p className="dim plans-lede">Kept for reference. They're never a current plan, and nothing in them is on your shopping list.</p>

      <section className="plans-section" aria-labelledby="arch-notes">
        <h2 id="arch-notes">Research notes{notes.data ? ` (${notes.data.length})` : ""}</h2>
        <ErrorText error={notes.error} />
        {notes.isPending && <p className="dim">Loading your notes…</p>}
        {notes.data?.length === 0 && <p className="dim">No research notes.</p>}
        {notes.data && notes.data.length > 0 && (
          <div className="plans-list">
            {notes.data.map((n) => (
              <Link key={n.id} to={archivedNoteHref(n.id)} className="plans-list-row">
                <span className="plans-list-main">
                  <b>{n.title}</b>
                  <span className="small dim">
                    {n.copied_by ? `Copied from ${n.copied_by}'s shared plan, ` : ""}saved {fmtDate(n.updated_at)}, {n.decks === 1 ? "1 deck" : `${n.decks} decks`}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
        <p className="small dim">Open a note to read it as it was. Use a deck from it makes that deck's build a new version of its plan, waiting for your OK.</p>
      </section>

      <section className="plans-section" aria-labelledby="arch-versions">
        <h2 id="arch-versions">Earlier versions</h2>
        {versions.length === 0 && <p className="dim">None yet. When you approve a new version of a plan, the one before it is listed here.</p>}
        {versions.length > 0 && (
          <div className="plans-list">
            {versions.map((v) => (
              <details key={`${v.deck}/${v.n}`} className="plans-list-row plans-version">
                <summary>
                  <span className="plans-list-main">
                    <b>
                      {v.deck_name}, version {v.n}
                    </b>
                    <span className="small dim">
                      {v.status === "kept"
                        ? `Not approved: you kept the version before, ${fmtDate(v.decided_at)}`
                        : `Approved ${fmtDate(v.decided_at)}, replaced ${fmtDate(v.superseded_at)}`}
                      . {cap(sourceText(v.source, v.proposed_at, view.b.head))}.
                    </span>
                  </span>
                </summary>
                <ul className="plans-plain small">
                  {v.changes.map((c) => (
                    <li key={c.key}>
                      {c.in ?? c.key}
                      {c.out ? <span className="dim"> for {c.out}</span> : null}
                    </li>
                  ))}
                  {v.skipped.map((c) => (
                    <li key={c.key} className="dim">
                      Skipped: {c.in ?? c.key}
                    </li>
                  ))}
                  {v.answers.map((a) => (
                    <li key={a.question}>
                      {a.question} <b>{a.answer}</b>
                    </li>
                  ))}
                </ul>
                {v.deck && (
                  <Link className="small" to={planHref(v.deck)}>
                    Open {v.deck_name}'s plan
                  </Link>
                )}
              </details>
            ))}
          </div>
        )}
      </section>

      {decks.length > 0 && (
        <section className="plans-section" aria-labelledby="arch-decks">
          <h2 id="arch-decks">Plans set aside</h2>
          <div className="plans-list">
            {decks.map((d) => {
              const p = view.planOf(d);
              return (
                <Link key={d.key} to={planHref(d.key)} className="plans-list-row">
                  <span className="plans-list-main">
                    <b>{d.name}</b>
                    <span className="small dim">
                      {p.archived_note ?? (d.status === "archived" ? "Not in the latest plan file" : "Archived")}
                      {p.archived_at ? `, ${fmtDate(p.archived_at)}` : ""}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
