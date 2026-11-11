import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";

/**
 * Copies `text` and says so: the button reads "Copied" for two seconds, and a screen reader hears
 * it. Where the clipboard isn't available (a phone on plain http, a browser that refuses), it
 * shows the text in a dialog to select and copy by hand instead of failing quietly.
 */
export function CopyButton({ text, label, className, disabled = false }: { text: string; label: string; className?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Different text (another export format) hasn't been copied: the button says so again.
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    clearTimeout(timer.current);
    setState("idle");
  }, [text]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      // The text changed while the browser was copying: what was copied isn't what is shown.
      if (latest.current !== text) return;
      setState("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("manual");
    }
  };
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => void copy()}>
        {state === "copied" ? "Copied" : label}
      </button>
      <span className="visually-hidden" role="status">
        {state === "copied" ? "Copied" : ""}
      </span>
      {state === "manual" && (
        <Dialog title={label} onClose={() => setState("idle")}>
          <div className="stack">
            <p className="dim small">This browser won't copy for Yama here. Select the text and copy it.</p>
            <textarea readOnly value={text} style={{ minHeight: "18rem" }} onFocus={(e) => e.currentTarget.select()} />
          </div>
        </Dialog>
      )}
    </>
  );
}
