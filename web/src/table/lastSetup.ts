// The last table setup on this device (seat names, the accounts and decks in them, the playgroup),
// kept per account so the next person to sign in here doesn't open the Table on someone else's
// seats (project review, 11 Nov 2026: it was one key for every account). A guest's is apart, so no
// account's names carry into a guest game.

const BASE = "yama.table.lastSetup";

export interface LastSetup {
  seats?: { userId?: string }[];
  groupId?: string;
  life?: number;
  format?: string;
  phones?: string;
  at?: string;
}

/** Where `userId`'s last setup is kept; a guest's when nobody is signed in. */
export function lastSetupKey(userId: string | null | undefined): string {
  return userId ? `${BASE}.${userId}` : `${BASE}.guest`;
}

function parse(raw: string | null): LastSetup | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LastSetup | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The last setup of whoever is using the Table, or null. A setup saved before setups were kept
 * per account (under the bare key) is taken over by the first account to open the Table if it
 * holds the first seat (the one holding the phone, where a new setup puts the account itself),
 * and moves to that account's own key; any other account's read deletes it instead.
 */
export function readLastSetup(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, userId: string | null | undefined): LastSetup | null {
  try {
    const own = parse(storage.getItem(lastSetupKey(userId)));
    if (own || !userId) return own;
    const raw = storage.getItem(BASE);
    const old = parse(raw);
    if (raw === null) return null;
    // Whoever reads it first settles it: theirs if they hold its first seat, otherwise nobody's.
    // Either way the shared key is gone, so it never waits there for some later account.
    storage.removeItem(BASE);
    if (old?.seats?.[0]?.userId !== userId) return null;
    storage.setItem(lastSetupKey(userId), raw);
    return old;
  } catch {
    return null;
  }
}

export function writeLastSetup(storage: Pick<Storage, "setItem">, userId: string | null | undefined, setup: LastSetup & Record<string, unknown>) {
  try {
    storage.setItem(lastSetupKey(userId), JSON.stringify(setup));
  } catch {
    // Storage full or blocked: the next game starts from empty seats.
  }
}
