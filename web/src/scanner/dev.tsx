// Mounts ScannerView on its own for testing (see dev.html). Not part of the app build.
import "@fontsource/big-shoulders-display/600";
import "@fontsource/big-shoulders-display/800";
import "@fontsource/atkinson-hyperlegible-next/400";
import "@fontsource/atkinson-hyperlegible-next/700";
import "../styles.css";
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
      <ScannerView onAccept={(c) => setAdded((a) => [c, ...a])} />
      {added.length > 0 && (
        <p className="small" style={{ position: "fixed", top: 8, left: 8, zIndex: 30, margin: 0 }}>
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
