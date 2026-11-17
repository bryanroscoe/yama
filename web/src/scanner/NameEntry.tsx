import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { Button } from "../components/ui";

/** Type a card's name instead of scanning it. */
export function NameEntry({ onPick, placeholder = "Or type the name" }: { onPick: (name: string) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the suggestions go, beside the box (the scanner's panel pins them with these, so the panel
  // keeps scrolling rather than letting them out: Codex review, 16 Nov 2026). Above the box when
  // there's room, else below; as tall as that side allows.
  const [at, setAt] = useState<CSSProperties>({});
  const open = names.length > 0;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const above = r.top - 8;
      const below = window.innerHeight - r.bottom - 8;
      const up = above >= Math.min(240, below);
      setAt({
        "--name-left": `${r.left}px`,
        "--name-width": `${r.width}px`,
        ...(up ? { "--name-bottom": `${window.innerHeight - r.top + 4}px`, "--name-top": "auto" } : { "--name-top": `${r.bottom + 4}px`, "--name-bottom": "auto" }),
        "--name-max": `${Math.max(up ? above : below, 80)}px`,
      } as CSSProperties);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return setNames([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      api<string[]>(`/api/cards/autocomplete?q=${encodeURIComponent(t)}`)
        .then((r) => !cancelled && setNames(r.slice(0, 6)))
        .catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <div className="scan-name">
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Card name" autoComplete="off" />
      {names.length > 0 && (
        <ul className="scan-name-list" style={at}>
          {names.map((n) => (
            <li key={n}>
              <Button
                onClick={() => {
                  setQ("");
                  setNames([]);
                  onPick(n);
                }}
              >
                {n}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
