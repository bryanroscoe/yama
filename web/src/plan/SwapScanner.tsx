import { useEffect, useState } from "react";
import type { SwapSheet } from "@yama/core/plan";
import { ScannerView, createServerCatalog, type ScanCatalog } from "../scanner";
import { SwapCardResult } from "./SwapDetails";
import type { PlanView } from "./view";

export default function SwapScanner({ sheet, view, deckKey, onClose }: { sheet: SwapSheet; view: PlanView; deckKey?: string; onClose: () => void }) {
  const [catalog, setCatalog] = useState<ScanCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => {
    let cancelled = false;
    // Use the whole saved card catalog so a card outside the plan can be recognized too.
    // Plan aliases and faces fill any gaps; no printing or price request is needed.
    void createServerCatalog({ identityOnly: true, extraNames: [
      ...Object.keys(view.b.names), ...Object.values(view.b.cards).map((c) => c.name),
      ...view.b.decks.flatMap((d) => Object.values(d.states).flatMap((s) => s?.cards.map((c) => c.name) ?? [])),
    ] })
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [view.b.names, view.b.cards, view.b.decks]);
  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-label="Scan a card for a swap">
      {catalog ? (
        <ScannerView
          catalog={catalog}
          identityOnly
          onClose={onClose}
          controls={<p className="scan-note">Checking {deckKey ? view.deckName(deckKey) : `${sheet.decks.length} selected decks`}. Scanning doesn't apply swaps.</p>}
          renderResult={(card) => <SwapCardResult name={card.name} sheet={sheet} view={view} deckKey={deckKey} />}
        />
      ) : (
        <div className="sheet stack">
          <p>{error ?? "Starting the scanner…"}</p>
          <button onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
