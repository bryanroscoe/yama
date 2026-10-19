// The planner bundle on this device. It is cached in IndexedDB per user (`plan:<user id>`), so the
// plan pages open with no signal, and refreshed with the cached copy's `rev`: the server answers
// `{unchanged}` when nothing it depends on (plan, cards, prices) has moved.
import type { PlanBundle } from "@yama/core/plan";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { idbDelete, idbGet, idbPut } from "../offline/idb";
import { fetchBundle } from "./api";

const cacheKey = (userId: string) => `plan:${userId}`;

export interface PlanData {
  bundle: PlanBundle | undefined;
  /** Still loading, with nothing to show yet. */
  pending: boolean;
  error: unknown;
  /** The server couldn't be reached; the copy saved on this device is shown. */
  offline: boolean;
}

/** The signed-in user's plan bundle: the saved copy at once, then the server's when it answers. */
export function usePlan(userId: string | undefined): PlanData {
  const qc = useQueryClient();
  const cached = useQuery({
    queryKey: ["plan-cache", userId],
    queryFn: async () => (await idbGet<PlanBundle>(cacheKey(userId!)).catch(() => undefined)) ?? null,
    enabled: !!userId,
    staleTime: Infinity,
  });
  const live = useQuery({
    queryKey: ["plan", userId],
    enabled: !!userId && cached.isFetched,
    staleTime: 30_000,
    queryFn: async (): Promise<PlanBundle> => {
      // The newest copy this page has seen: the last fetch, else the one saved on the device.
      const prev = qc.getQueryData<PlanBundle>(["plan", userId]) ?? cached.data ?? undefined;
      const reply = await fetchBundle(prev?.rev);
      if ("unchanged" in reply && prev) return prev;
      const bundle = reply as PlanBundle;
      await idbPut(cacheKey(userId!), bundle).catch(() => undefined);
      return bundle;
    },
  });
  const bundle = live.data ?? cached.data ?? undefined;
  return {
    bundle,
    pending: !bundle && (cached.isPending || live.isPending) && !live.error,
    error: bundle ? null : live.error,
    offline: !!live.error && !!cached.data && !live.data,
  };
}

/**
 * Remove this user's plan data from the device. Plans hold prices paid, so sign-out calls this
 * before anything that can fail. It never throws.
 */
export async function clearPlanData(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  await idbDelete(cacheKey(userId)).catch(() => undefined);
}
