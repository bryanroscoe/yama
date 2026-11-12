import { useContext, type ReactNode } from "react";
import { BugButton, ReportBug } from "../bugs/BugButton";

/**
 * A page's title row: the `h1`, an optional line under it, and the page's actions at the end
 * of the row (they wrap under the title on a narrow screen). One per page, first in `<main>`.
 * The Decks, Plans and Lab areas draw theirs with `AreaHead`, `PlansHead` and `LabHead`.
 */
export function PageHeader({ title, sub, actions, className }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={["page-head", className].filter(Boolean).join(" ")}>
      {sub ? (
        <div>
          <h1>{title}</h1>
          {sub}
        </div>
      ) : (
        <h1>{title}</h1>
      )}
      {/* Report a bug, for someone signed in, after the page's own actions. */}
      {useContext(ReportBug) ? (
        <div className="page-head-end">
          {actions}
          <BugButton />
        </div>
      ) : (
        actions
      )}
    </div>
  );
}
