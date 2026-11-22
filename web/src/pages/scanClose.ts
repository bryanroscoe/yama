// Closing the collection scanner with cards that haven't reached the collection (project review,
// 11 Nov 2026: a scan whose save failed was kept in the Added list "to try again", and then the
// scanner closed and dropped it without a word).

/** The part of a scanned entry that says whether its save is still out or failed (scanner/session.ts). */
interface Entry {
  copies: number;
  pending?: { error?: string; fix: unknown };
  /** A fix is looking its row up, before its write is planned. */
  checking?: string;
  /** Card first, printing after: a provisional row, saved only once its printing settles. */
  later?: { open: boolean };
}

export interface Unsaved {
  /** Entries whose last save failed: they are only on this screen. */
  failed: number;
  /** Entries whose save is still on its way. */
  sending: number;
  /** Provisional rows whose printing isn't settled (card first, printing after): nothing of them is saved. */
  waiting?: number;
}

/** What closing the scanner now would lose. */
export function unsavedScans(added: Entry[]): Unsaved {
  let failed = 0;
  let sending = 0;
  let waiting = 0;
  for (const a of added) {
    if (a.later?.open) waiting += a.copies;
    else if (a.pending?.error) failed++;
    // A fix still finding its row hasn't a write yet, but is about to: it could fail after the close too.
    else if (a.pending || a.checking) sending++;
  }
  return { failed, sending, waiting };
}

/** The question when closing with unsaved scans, or null when closing loses nothing. */
export function closeQuestion({ failed, sending, waiting = 0 }: Unsaved): string | null {
  if (failed > 0) {
    const what = failed === 1 ? "1 change from this scan isn't" : `${failed} changes from this scan aren't`;
    return `${what} saved to your collection. Closing the scanner drops ${failed === 1 ? "it" : "them"}.`;
  }
  if (waiting > 0) {
    const what = waiting === 1 ? "1 card is" : `${waiting} cards are`;
    return `${what} still waiting for a printing, so not in your collection yet: tap ${waiting === 1 ? "it" : "them"} in the strip to pick one. Closing the scanner drops ${waiting === 1 ? "it" : "them"}.`;
  }
  if (sending > 0) return sending === 1 ? "Still saving the last card. The scanner closes once it's saved." : `Still saving ${sending} cards. The scanner closes once they're saved.`;
  return null;
}
