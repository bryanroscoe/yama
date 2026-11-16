// Which scanned card is open large (ScannedCard), kept apart from the scanner's code so the
// Collection page can hold it without loading the scanner.

import { useEffect, useState } from "react";
import type { Added } from "./session";

/**
 * The entry opened large, by key: the entry while it's in the session, else nothing, and the key
 * is let go once it's gone (Remove), so a host pausing the scanner on it resumes (review of #152).
 */
export function useOpenedEntry(added: readonly Added[]): { entry: Added | undefined; open: (key: string) => void; close: () => void } {
  const [key, setKey] = useState<string | null>(null);
  const entry = key ? added.find((a) => a.key === key) : undefined;
  useEffect(() => {
    if (key && !entry) setKey(null);
  }, [key, entry]);
  return { entry, open: setKey, close: () => setKey(null) };
}
