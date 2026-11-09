import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { usePlan } from "../plan/store";
import { buildNotes, buildNotesKey } from "../research/api";
import { buildFamilies, resolveBuildFamily } from "./buildCatalog";

/**
 * A deck's researched playgroup variants (lower friction, optimized...), for the List picker.
 * These remain sourced alternatives: choosing a guide never installs its proposed cards.
 */
export function usePlaygroupVariants(deckId: string): { id: string; label: string; href: string }[] {
  const userId = useMe().data?.id;
  const notes = useQuery({ queryKey: buildNotesKey(userId), queryFn: buildNotes, enabled: !!userId });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const plan = usePlan(userId);
  return useMemo(() => {
    const families = buildFamilies(notes.data ?? [], plan.bundle, decks.data ?? []);
    const family = resolveBuildFamily(families, null, deckId);
    return (family?.choices ?? [])
      .filter((c) => c.id.startsWith("research:") && c.kind === "bracket" && /lower.friction|asshole|optimized/i.test(c.label))
      .map((c) => ({ id: c.id, label: c.label, href: c.href }));
  }, [notes.data, plan.bundle, decks.data, deckId]);
}
