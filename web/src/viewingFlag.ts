// Whether this device is viewing Yama as someone else (admin "View as"; viewing.ts). Kept apart
// with no imports, so the sync code can check it without an import cycle.

/** Set while this device views as someone; holds the viewed account's id. */
export const VIEWING_KEY = "yama.viewing";

export function viewingFlag(): string | null {
  try {
    return localStorage.getItem(VIEWING_KEY);
  } catch {
    return null;
  }
}

/** Whether this device is viewing as someone. Sync checks it and sends nothing while it is. */
export function isViewing(): boolean {
  return viewingFlag() !== null;
}
