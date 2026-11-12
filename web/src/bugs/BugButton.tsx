import { createContext, useContext } from "react";
import { Button } from "../components/Button";
import { BugIcon } from "../components/icons";

// The bug buttons, kept apart from the report form (BugReport.tsx) so every head can carry one
// without loading the form. BugReportProvider fills the context for someone signed in.

/** Opens the report form; `from` is the control pressed, to note the dialog it sits in. */
export const ReportBug = createContext<((from?: Element | null) => void) | null>(null);

/**
 * The little bug: opens the report form, noting the dialog it sits in. Draws nothing for someone
 * signed out (or outside the app, in a test), so any head can carry it.
 */
export function BugButton({ className }: { className?: string }) {
  const report = useContext(ReportBug);
  if (!report) return null;
  return (
    <Button variant="quiet" className={["bug-button", className].filter(Boolean).join(" ")} aria-label="Report a bug" title="Report a bug" onClick={(e) => report(e.currentTarget)}>
      <BugIcon />
    </Button>
  );
}

/** "Report a bug" in words, for the laptop rail. */
export function BugLink({ className }: { className?: string }) {
  const report = useContext(ReportBug);
  if (!report) return null;
  return (
    <Button className={className} onClick={(e) => report(e.currentTarget)}>
      <BugIcon />
      <span>Report a bug</span>
    </Button>
  );
}
