// The planner bundle on this device. It is cached in IndexedDB per user (`plan:<user id>`), so the
// plan pages open with no signal, and refreshed with the cached copy's `rev`: the server answers
// `{unchanged}` when nothing it depends on (plan, cards, prices) has moved.
import type { PlanBundle } from "@yama/core/plan";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { idbDelete, idbGet, idbPut } from "../offline/idb";
import { type BundleReply, fetchBundle } from "./api";
import { outbox } from "./outbox";

const cacheKey = (userId: string) => `plan:${userId}`;

// Goes up with every sign-out (clearPlanData). A bundle requested before a sign-out is never saved.
let signOuts = 0;

export interface BundleIo {
  fetch: (rev: string | undefined, signal?: AbortSignal) => Promise<BundleReply>;
  put: (key: string, value: unknown) => Promise<void>;
  del: (key: string) => Promise<void>;
}

const deviceIo: BundleIo = { fetch: fetchBundle, put: idbPut, del: idbDelete };

/**
 * Ask the server for the bundle and save it on this device. Plans hold prices paid, so if the
 * user signs out (or the query is cancelled) while the bundle is on its way, it isn't saved, and
 * a sign-out that lands during the save takes it back off. Exported for tests.
 */
export async function refreshBundle(userId: string, prev: PlanBundle | undefined, signal?: AbortSignal, io: BundleIo = deviceIo): Promise<PlanBundle> {
  const at = signOuts;
  const reply = await io.fetch(prev?.rev, signal);
  if ("unchanged" in reply && prev) return prev;
  if (signal?.aborted || at !== signOuts) throw new Error("Signed out while the plan was loading.");
  const bundle = reply as PlanBundle;
  await io.put(cacheKey(userId), bundle).catch(() => undefined);
  if (at !== signOuts) await io.del(cacheKey(userId)).catch(() => undefined);
  return bundle;
}

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
    queryFn: ({ signal }): Promise<PlanBundle> => {
      // The newest copy this page has seen: the last fetch, else the one saved on the device.
      const prev = qc.getQueryData<PlanBundle>(["plan", userId]) ?? cached.data ?? undefined;
      return refreshBundle(userId!, prev, signal);
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
 * Remove this user's plan data from the device: the saved bundle and the outbox of taps. Plans
 * hold prices paid (and "bought it" marks what was paid), so sign-out calls this before anything
 * that can fail. It also stops any bundle still on its way from being saved (refreshBundle). It
 * never throws.
 */
export async function clearPlanData(userId: string | null | undefined): Promise<void> {
  signOuts += 1;
  if (!userId) return;
  outbox.clear(userId);
  await idbDelete(cacheKey(userId)).catch(() => undefined);
}
