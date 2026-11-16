// Mounts ScannerView on its own for testing (see dev.html). Not part of the app build.
// `?demo=1` fills the strip with a few sample cards (pictures from Scryfall), each opening large
// with its fixes, so the layout can be seen without a server or a card in hand.
import "@fontsource/big-shoulders-display/600";
import "@fontsource/big-shoulders-display/800";
import "@fontsource/atkinson-hyperlegible-next/400";
import "@fontsource/atkinson-hyperlegible-next/700";
import "../styles.css";
import "../controls.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { refreshOfflineCardsIfStale } from "../offline/cards";
import { Dialog } from "../components/ui";
import { ScannedCard } from "./AddedList";
import { rememberPlayability } from "./playable";
import { ScannerView } from "./ScannerView";
import type { Added } from "./session";
import type { ScanCandidate } from "./types";

const params = new URLSearchParams(location.search);
const img = (path: string) => `https://cards.scryfall.io/small/front/${path}`;
const price = (usd: number | null, foil: number | null = null) => ({ usd, usd_foil: foil, usd_etched: null, date: "2026-11-15" });
/** Sample cards for `?demo=1`, newest first, with their EDHREC ranks as of 16 Nov 2026. */
const DEMO: (Added & { rank: number; gc: boolean })[] = [
  { key: "1", name: "Rhystic Study", oracle_id: "o-rhystic", scryfall_id: "s1", set: "j22", number: "114", image: img("9/f/9f37c5b6-a59c-45cd-9a99-e9357fe9ea1b.jpg"), finish: "nonfoil", finishes: ["nonfoil"], container: null, copies: 1, auto: true, prices: price(68.3), rank: 46, gc: true },
  { key: "2", name: "Grizzly Bears", oracle_id: "o-bears", scryfall_id: "s2", set: "10e", number: "268", image: img("4/0/409f9b88-f03e-40b6-9883-68c14c37c0de.jpg"), finish: "foil", finishes: ["nonfoil", "foil"], container: null, copies: 1, auto: true, prices: price(0.22, 3.29), rank: 8150, gc: false },
  { key: "3", name: "Sol Ring", oracle_id: "o-sol", scryfall_id: "s3", set: "trc", number: "499", image: img("f/c/fc817e07-c1f3-469f-9cf7-0945dea7400f.jpg"), finish: "nonfoil", finishes: ["nonfoil", "foil"], container: null, copies: 2, auto: false, prices: price(1.01), rank: 1, gc: false },
  { key: "4", name: "Mesa Unicorn", oracle_id: "o-unicorn", scryfall_id: "s4", set: "j25", number: "224", image: img("a/e/ae56c64b-47f7-4a73-94a0-95ad328ce1b7.jpg"), finish: "nonfoil", finishes: ["nonfoil"], container: null, copies: 1, auto: true, prices: price(0.28), rank: 14637, gc: false },
  { key: "5", name: "Llanowar Elves", oracle_id: "o-elves", scryfall_id: "s5", set: "fdn", number: "227", image: img("6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg"), finish: "nonfoil", finishes: ["nonfoil", "foil"], container: null, copies: 1, auto: true, prices: price(0.32, 0.68), rank: 54, gc: false, pending: { ops: [], fix: null, error: "Network error" } },
  { key: "6", name: "Arcane Signet", oracle_id: "o-signet", scryfall_id: "s6", set: "trc", number: "485", image: img("7/9/795df2ee-fbfc-4961-852c-e3ec50cc52da.jpg"), finish: "nonfoil", finishes: ["nonfoil", "foil"], container: null, copies: 1, auto: true, prices: price(null), rank: 3, gc: false },
];
if (params.get("demo") === "1") for (const d of DEMO) rememberPlayability(d.oracle_id!, { rank: d.rank, gameChanger: d.gc });

function Dev() {
  const [ready, setReady] = useState(false);
  const [added, setAdded] = useState<ScanCandidate[]>([]);
  const [demo, setDemo] = useState<Added[]>(() => (params.get("demo") === "1" ? DEMO : []));
  const [opened, setOpened] = useState<string | null>(params.get("open"));
  useEffect(() => {
    void refreshOfflineCardsIfStale().finally(() => setReady(true));
  }, []);
  if (!ready) return <p className="page">Loading card names</p>;
  const finish: "foil" | "nonfoil" = params.get("finish") === "foil" ? "foil" : "nonfoil";
  const openedEntry = demo.find((a) => a.key === opened);
  return (
    <>
      <ScannerView
        onAccept={(c) => setAdded((a) => [c, ...a])}
        onUndo={async (c) => setAdded((a) => a.filter((x) => x !== c))}
        onCorrect={async (from, to) => {
          setAdded((a) => a.map((x) => (x === from ? to : x)));
          return from.scryfall_id === to.scryfall_id ? "kept" : "changed";
        }}
        closeups={params.get("closeups") !== "0"}
        finish={finish}
        recentCards={[
          ...added.map((c, i) => ({ key: `a${added.length - i}`, name: c.name, set: c.set, number: c.number, finish, copies: 1, prices: c.prices, image: c.thumb ?? c.image, oracleId: c.oracle_id })),
          ...demo.map((a) => ({ key: a.key, name: a.name, set: a.set, number: a.number, finish: a.finish, copies: a.copies, prices: a.prices, image: a.image, oracleId: a.oracle_id, state: a.pending ? (a.pending.error ? ("failed" as const) : ("saving" as const)) : undefined })),
        ]}
        onOpenCard={(k) => setOpened(k)}
        onShowAdded={() => undefined}
        addedCount={added.length + demo.reduce((n, a) => n + a.copies, 0)}
        paused={opened != null}
        controls={<p className="scan-note">The dev page: nothing is saved.</p>}
        settings={
          <label className="scan-keep">
            <input type="checkbox" />
            <span>
              <strong>A setting.</strong> Settings open from the gear, as on the Collection page.
            </span>
          </label>
        }
        settingsSummary="Regular, into Binder 2, keep adding"
      />
      {openedEntry && (
        <Dialog onClose={() => setOpened(null)} label={openedEntry.name} className="scan-big-sheet">
          <ScannedCard
            a={openedEntry}
            onFix={async (a, f) => setDemo((d) => (f.copies === 0 ? d.filter((x) => x.key !== a.key) : d.map((x) => (x.key === a.key ? { ...x, ...f } : x))))}
            onRetry={async (a) => setDemo((d) => d.map((x) => (x.key === a.key ? { ...x, pending: undefined } : x)))}
            onClose={() => setOpened(null)}
          />
        </Dialog>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
