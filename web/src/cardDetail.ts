// One card's details (rules text, printings, rulings), shared by the card sheet and the online
// board's inspector so both read the same cached answer.

import { api, type CardDetail, type Printing } from "./api";
import { offlineCard } from "./offline/cards";

/** Network trouble (not a bad request, nor a request cancelled because nobody wants it any more):
 *  fall back to the copy on this device. */
export const isNetworkError = (e: unknown) => !(e instanceof DOMException && e.name === "AbortError") && (e instanceof TypeError || !navigator.onLine);

export function cardDetailQuery(oracleId: string) {
  return {
    queryKey: ["card", oracleId] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<CardDetail> => {
      try {
        return await api<CardDetail>(`/api/cards/${oracleId}`, { signal });
      } catch (e) {
        const card = isNetworkError(e) ? await offlineCard(oracleId) : null;
        if (card) return { card, printings: [] as Printing[] };
        throw e;
      }
    },
  };
}
