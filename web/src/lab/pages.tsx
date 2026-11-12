// The Lab's pages, loaded together when one of them first opens (App.tsx).
import { ComparePage } from "./Compare";
import { TryPage } from "./Try";

// Datasets are Lab evidence since 2026-11-04: they load with the Lab, inside its boundary.
export { DatasetsPage } from "../datasets/Datasets";
export { LabLayout } from "./LabLayout";
export { PreconDetailPage } from "./PreconDetail";
export { PreconsPage } from "./Precons";
export { RunPage } from "./Run";
export { RunDeckPage, RunTablePage } from "./RunTables";
export { BatchPage, RunsPage } from "./Runs";

/** Every account may start a simulation within its allowance; the pages say what that is. */
export function TryRoute() {
  return <TryPage />;
}

export function CompareRoute() {
  return <ComparePage />;
}
