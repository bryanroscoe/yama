import { useEffect, useState } from "react";
import { api } from "../api";

/** Type a card's name instead of scanning it. */
export function NameEntry({ onPick, placeholder = "Or type the name" }: { onPick: (name: string) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [names, setNames] = useState<string[]>([]);
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
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Card name" autoComplete="off" />
      {names.length > 0 && (
        <ul className="scan-name-list">
          {names.map((n) => (
            <li key={n}>
              <button
                onClick={() => {
                  setQ("");
                  setNames([]);
                  onPick(n);
                }}
              >
                {n}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
