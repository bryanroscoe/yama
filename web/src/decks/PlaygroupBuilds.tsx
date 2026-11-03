import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { usePlan } from "../plan/store";
import { buildNotes, buildNotesKey } from "../research/api";
import { buildFamilies, resolveBuildFamily } from "./buildCatalog";

/** These remain sourced alternatives: choosing a guide never installs its proposed cards. */
export function PlaygroupBuilds({ deckId }: { deckId: string }) {
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const plan = usePlan(userId);
  const families = useMemo(() => buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []), [notes.data, plan.bundle, decks.data]);
  const family = resolveBuildFamily(families, null, deckId);
  const variants = family?.choices.filter((c) => c.id.startsWith("research:") && c.kind === "bracket" && /lower.friction|asshole|optimized/i.test(c.label));
  if (!variants?.length) return null;
  return <details className="deck-playgroup-builds"><summary>Playgroup variants</summary>
    <p className="small dim">Researched alternatives; check the guide for any buys or prints.</p>
    <ul>{variants.map((c) => <li key={c.id}><Link to={c.href}>{c.label}</Link></li>)}</ul>
  </details>;
}
