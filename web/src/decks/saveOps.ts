// Op ids for creating decks from the import page (`POST /api/decks` with `op_id`).

/**
 * One op id per deck as it would be saved. Asking again for the same deck (its place in the
 * import, name, cards and printings) gives the same id, so a request sent twice makes one deck;
 * a deck that was changed since gets a new id, because it is another deck.
 */
export function createOpIds(newId: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  return (index: number, name: string, body: { cards: unknown; prints: unknown }): string => {
    const key = JSON.stringify([index, name, body.cards, body.prints]);
    let id = ids.get(key);
    if (!id) {
      id = newId();
      ids.set(key, id);
    }
    return id;
  };
}
