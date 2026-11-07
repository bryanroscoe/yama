/** Addresses under Plans that a plan key can't take: a plan called one of these opens under `d/`. */
export const RESERVED_KEYS = new Set(["get", "settings", "archived", "d"]);

/** A deck plan's page (`/decks/plans/<key>`, or `/decks/plans/d/<key>` for a reserved key). */
export const planHref = (key: string) => (RESERVED_KEYS.has(key) ? `/decks/plans/d/${encodeURIComponent(key)}` : `/decks/plans/${encodeURIComponent(key)}`);
