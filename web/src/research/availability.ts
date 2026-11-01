import type { Build, Item } from "./api";
import { listEntries } from "./details";

const ownedKinds = new Set(["keep", "owned", "transfer", "arrived_print", "basic"]);
const key = (name: string) => name.split(" // ")[0]!.trim().toLowerCase();
/** Check the report's declared supply, not live inventory or physical installation. */
export function ownedBuildProblems(build: Build): string[] {
  if (build.acquisition?.track !== "owned_now") return [];
  const acq = build.acquisition, a = build.accounting, problems: string[] = [];
  if (build.prospective || acq.buys?.length || acq.prints?.length || acq.sealed_purchases?.length) problems.push("Requires future cards, purchases or new prints.");
  if (!acq.scenario?.trim()) problems.push("Missing allocation scenario.");
  if (!a || a.total !== 100 || a.owned + a.basics !== 100 || a.local_buys !== 0 || a.prints !== 0 || (a.projected_stock ?? 0) !== 0) problems.push("Missing or conflicting owned-card accounting.");
  const owned = acq.owned ?? [], basics = acq.basics ?? [], supply = [...owned, ...basics];
  const count = (items: Item[]) => items.reduce((n, row) => n + (row.qty ?? 1), 0);
  if (supply.some((row) => !row.card?.trim() || !ownedKinds.has(row.kind ?? "") || !Number.isSafeInteger(row.qty ?? 1) || (row.qty ?? 1) < 1)) problems.push("Supply includes unavailable, unidentified or invalid copies.");
  if (a && (count(owned) !== a.owned || count(basics) !== a.basics)) problems.push("Supply quantities disagree with accounting.");
  const expected = new Map<string, number>(), actual = new Map<string, number>();
  const entries = listEntries(build.list);
  for (const row of entries) expected.set(key(row.name), (expected.get(key(row.name)) ?? 0) + row.qty);
  for (const row of supply) actual.set(key(row.card ?? ""), (actual.get(key(row.card ?? "")) ?? 0) + (row.qty ?? 1));
  if (entries.reduce((n, row) => n + row.qty, 0) !== 100 || actual.size !== expected.size || [...expected].some(([name, qty]) => actual.get(name) !== qty)) problems.push("Owned supply does not match the complete 100-card list.");
  return problems;
}
export function isOwnedBuild(build: Build): boolean {
  return build.acquisition?.track === "owned_now" && ownedBuildProblems(build).length === 0;
}
