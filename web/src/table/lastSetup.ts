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
 * per account (under the bare key) is taken over by the account in its first seat (the one holding
 * the phone, where a new setup puts the account itself), and by nobody else; it then moves to that
 * account's own key.
 */
export function readLastSetup(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, userId: string | null | undefined): LastSetup | null {
  try {
    const own = parse(storage.getItem(lastSetupKey(userId)));
    if (own || !userId) return own;
    const raw = storage.getItem(BASE);
    const old = parse(raw);
    if (old?.seats?.[0]?.userId !== userId) return null;
    storage.setItem(lastSetupKey(userId), raw!);
    storage.removeItem(BASE);
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
