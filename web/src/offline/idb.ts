// A tiny key-value store in IndexedDB ("yama" database, "kv" object store), shared by
// everything the app keeps on the device: the offline card list, and the planner's bundle.
// Used from the page and from the card list's worker (offline/cards.worker.ts).

const DB = "yama";
const STORE = "kv";

/** One open connection per page or worker, reopened if the browser closes it. */
let open: Promise<IDBDatabase> | null = null;

export function idb(): Promise<IDBDatabase> {
  open ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database, or the browser closing it: open afresh next time.
      db.onversionchange = () => {
        db.close();
        open = null;
      };
      db.onclose = () => {
        open = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      open = null;
      reject(req.error);
    };
  });
  return open;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(key: string, value: unknown): Promise<void> {
  return idbPutMany([[key, value]]);
}

/** Several entries in one transaction: all of them are saved, or none. */
export async function idbPutMany(entries: [string, unknown][], remove: string[] = []): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const [key, value] of entries) store.put(value, key);
    for (const key of remove) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Remove one entry. Removing a key that isn't there is fine. */
export async function idbDelete(key: string): Promise<void> {
  return idbPutMany([], [key]);
}
