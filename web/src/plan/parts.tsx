import { CardHover } from "../components/CardRef";
// Small pieces the plan pages share.
import type { PlanCard } from "@yama/core/plan";
import { useState } from "react";
import { CardImage, Sheet } from "../components/ui";
import { CardSheet } from "../pages/Cards";

/** A card thumbnail that opens the card (read-only) when Yama knows it. */
export function Thumb({ name, card, oracleId, dim = false }: { name: string; card: PlanCard | undefined; oracleId: string | undefined; dim?: boolean }) {
  const [open, setOpen] = useState(false);
  const img = <CardHover name={name} oracleId={oracleId} image={card?.image_normal}><CardImage src={card?.image_small} name={name} className={`thumb${dim ? " plan-thumb-out" : ""}`}/></CardHover>;
  if (!oracleId) return <span className="plan-thumb-wrap" title={`${name} isn't in Yama's card data yet`}>{img}</span>;
  return (
    <>
      <button type="button" className="plan-thumb-wrap" onClick={() => setOpen(true)} aria-label={`Show ${name}`}>
        {img}
      </button>
      {open && <CardSheet oracleId={oracleId} readOnly onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Copies text. Where the clipboard isn't available (a phone on plain http), it shows the text in
 * a sheet to select and copy by hand.
 */
export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("manual");
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void copy()}>
        {state === "copied" ? "Copied" : label}
      </button>
      {state === "manual" && (
        <Sheet label={label} onClose={() => setState("idle")}>
          <div className="stack">
            <div className="sheet-head">
              <h2>{label}</h2>
              <button className="quiet" onClick={() => setState("idle")}>Close</button>
            </div>
            <p className="dim small">This browser won't copy for Yama here. Select the text and copy it.</p>
            <textarea readOnly value={text} style={{ minHeight: "18rem" }} onFocus={(e) => e.currentTarget.select()} />
          </div>
        </Sheet>
      )}
    </>
  );
}
