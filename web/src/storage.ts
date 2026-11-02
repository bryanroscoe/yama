// Ask the browser to keep what Yama saves on the device (games not yet uploaded, plan answers,
// the offline card list and the app's code) instead of clearing it when space runs low
// (navigator.storage.persist). Chrome decides quietly; Firefox asks, so this runs only when it
// means something to the person: an installed app opening, a life counter game starting, or the
// card list saved by hand.

import { standalone } from "./install";

let asked = false;

export function keepStorage({ installed = false }: { installed?: boolean } = {}): void {
  if (asked || (installed && !standalone())) return;
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist || !storage.persisted) return;
  asked = true;
  void storage
    .persisted()
    .then((kept) => kept || storage.persist())
    .catch(() => undefined);
}
