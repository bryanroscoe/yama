// Mounts ScannerView on its own for testing (see dev.html). Not part of the app build.
import "@fontsource/big-shoulders-display/600";
import "@fontsource/big-shoulders-display/800";
import "@fontsource/atkinson-hyperlegible-next/400";
import "@fontsource/atkinson-hyperlegible-next/700";
import "../styles.css";
import "../controls.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { refreshOfflineCardsIfStale } from "../offline/cards";
import { ScannerView } from "./ScannerView";
import type { ScanCandidate } from "./types";

function Dev() {
  const [ready, setReady] = useState(false);
  const [added, setAdded] = useState<ScanCandidate[]>([]);
  useEffect(() => {
    void refreshOfflineCardsIfStale().finally(() => setReady(true));
  }, []);
  if (!ready) return <p className="page">Loading card names</p>;
  return (
    <>
      <ScannerView
        onAccept={(c) => setAdded((a) => [c, ...a])}
        onUndo={async (c) => setAdded((a) => a.filter((x) => x !== c))}
        onCorrect={async (from, to) => {
          setAdded((a) => a.map((x) => (x === from ? to : x)));
          return from.scryfall_id === to.scryfall_id ? "kept" : "changed";
        }}
        closeups={new URLSearchParams(location.search).get("closeups") !== "0"}
        finish={new URLSearchParams(location.search).get("finish") === "foil" ? "foil" : "nonfoil"}
        recentCards={added.map((c, i) => ({ key: String(added.length - i), name: c.name, set: c.set, number: c.number, finish: new URLSearchParams(location.search).get("finish") === "foil" ? "foil" : "nonfoil", copies: 1, prices: c.prices }))}
        controls={<p className="scan-note">The dev page: nothing is saved.</p>}
        settings={
          <label className="scan-keep">
            <input type="checkbox" />
            <span>
              <strong>A setting.</strong> Settings fold into one row, as on the Collection page.
            </span>
          </label>
        }
        settingsSummary="Regular, not filed"
      />
      {added.length > 0 && (
        <p className="small" style={{ position: "fixed", top: 8, left: 8, zIndex: "var(--z-popover)", margin: 0 }}>
          Added {added.length}: {added.map((c) => c.name).join(", ")}
        </p>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
