// Choosing the sets a scan is locked to (setlock.ts): search by name or code, newest sets first.

import { useEffect, useMemo, useState } from "react";
import { MAX_LOCKED, scanSets, type ScanSet } from "./setlock";
import { Loading } from "../components/ui";

const SHOWN = 30;

export function SetLockPicker({ codes, loading, onChange, onClose }: { codes: string[]; loading: boolean; onChange: (codes: string[]) => void; onClose: () => void }) {
  const [sets, setSets] = useState<ScanSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    scanSets().then(
      (s) => live && setSets(s),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const byCode = useMemo(() => new Map((sets ?? []).map((s) => [s.code, s])), [sets]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = (sets ?? []).filter((s) => !codes.includes(s.code));
    if (!needle) return all.slice(0, SHOWN);
    // An exact code first, then names and codes that start with it, then those that contain it.
    const rank = (s: ScanSet) => (s.code === needle ? 0 : s.code.startsWith(needle) || s.name.toLowerCase().startsWith(needle) ? 1 : s.name.toLowerCase().includes(needle) ? 2 : 3);
    return all
      .map((s) => [s, rank(s)] as const)
      .filter(([, r]) => r < 3)
      .sort((a, b) => a[1] - b[1])
      .slice(0, SHOWN)
      .map(([s]) => s);
  }, [sets, q, codes]);
  const full = codes.length >= MAX_LOCKED;
  const year = (s: ScanSet) => s.released_at?.slice(0, 4);
  return (
    <div className="scan-step scan-lock-picker">
      <p>
        <strong>Scan only these sets.</strong> The scanner matches their cards first and files that set's printing, with no corner to read. A card from anywhere else is shown as such, and you say whether it's from another set.
      </p>
      {codes.length > 0 && (
        <ul className="scan-lock-chosen">
          {codes.map((c) => (
            <li key={c}>
              <span>
                {byCode.get(c)?.name ?? c.toUpperCase()} <span className="dim">{c.toUpperCase()}</span>
              </span>
              <button className="scan-alt" onClick={() => onChange(codes.filter((x) => x !== c))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && <Loading className="scan-note">Getting the set's cards…</Loading>}
      {error && <p className="error">{error}</p>}
      {!full && (
        <label className="scan-lock-search">
          <span className="dim">{codes.length ? "Add another set" : "Set name or code"}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Edge of Eternities, ECC…" autoComplete="off" enterKeyHint="search" />
        </label>
      )}
      {!full && sets === null && !error && <Loading className="scan-note">Loading sets…</Loading>}
      {!full && sets !== null && (
        <div className="scan-lock-list" role="listbox" aria-label="Sets">
          {shown.map((s) => (
            <button
              key={s.code}
              role="option"
              aria-selected={false}
              className="scan-lock-set"
              onClick={() => {
                onChange([...codes, s.code]);
                setQ("");
              }}
            >
              <span>{s.name}</span>
              <span className="dim">
                {s.code.toUpperCase()}
                {year(s) ? `, ${year(s)}` : ""}, {s.cards} cards
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="scan-note">No set matches “{q}”.</p>}
        </div>
      )}
      {full && <p className="scan-note">That's {MAX_LOCKED} sets, the most at once.</p>}
      <div className="scan-other-ways">
        <button className="primary" onClick={onClose}>
          {codes.length ? "Scan these sets" : "Scan any set"}
        </button>
        {codes.length > 0 && <button onClick={() => onChange([])}>Any set</button>}
      </div>
    </div>
  );
}
