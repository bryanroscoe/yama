// The Lab's pages, loaded together when one of them first opens (App.tsx).
import { PowerOnly } from "../components/PowerOnly";
import { ComparePage } from "./Compare";
import { LabHead } from "./LabLayout";
import { TryPage } from "./Try";

export { LabLayout } from "./LabLayout";
export { PreconDetailPage } from "./PreconDetail";
export { PreconsPage } from "./Precons";
export { RunPage } from "./Run";
export { RunDeckPage, RunTablePage } from "./RunTables";
export { BatchPage, RunsPage } from "./Runs";

/** Starting simulations is for admins and power users. */
export function TryRoute() {
  return (
    <PowerOnly head={<LabHead title="Try a change" />}>
      <TryPage />
    </PowerOnly>
  );
}

export function CompareRoute() {
  return (
    <PowerOnly head={<LabHead title="Compare decks" />}>
      <ComparePage />
    </PowerOnly>
  );
}
