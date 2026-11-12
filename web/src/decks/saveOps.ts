// Op ids for creating decks from the import page (`POST /api/decks` with `op_id`).

/**
 * One op id per deck as it would be saved. Asking again for the same deck (its place in the
 * import, name, cards, printings and Considering list) gives the same id, so a request sent twice makes one deck;
 * a deck that was changed since gets a new id, because it is another deck.
 */
export function createOpIds(newId: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  return (index: number, name: string, body: { cards: unknown; prints: unknown; maybe?: unknown[] }): string => {
    // The server's fingerprint of the request counts the Considering list, so the id must too:
    // the same id for a changed list would be refused as used for something else.
    const key = JSON.stringify([index, name, body.cards, body.prints, ...(body.maybe?.length ? [body.maybe] : [])]);
    let id = ids.get(key);
    if (!id) {
      id = newId();
      ids.set(key, id);
    }
    return id;
  };
}

/**
 * The body of `POST /api/decks` for one deck of the import. The save step's choice of who can see
 * it goes along once the account's default has loaded; without it the server uses that default.
 * The choice is not part of the op id: a save sent again after the choice changed names the deck
 * already made rather than making a second one.
 */
export function newDeckRequest<B extends { cards: unknown; prints: unknown; maybe: unknown[] }>(name: string, body: B, opId: string, visibility: string | undefined) {
  return { name, cards: body.cards, prints: body.prints, maybe: body.maybe, op_id: opId, ...(visibility ? { visibility } : {}) };
}
