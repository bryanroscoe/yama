// Choosing how the panels sit: a miniature of each arrangement for this many players. Shown when
// a game is set up (so the table agrees before anyone sits down) and in the table menu.

import type { CSSProperties } from "react";
import { layoutOptions, setLayout, tableLayout, useLayoutChoice, type LayoutKey } from "./layouts";
import "./layouts.css";
import { Button } from "../components/ui";

/** The panels in miniature, each with its seat's art and number, turned toward its player. */
export function LayoutSketch({ n, layout, art, className = "" }: { n: number; layout: LayoutKey; art?: (seat: number) => string | undefined; className?: string }) {
  const { cols, rows, cells } = tableLayout(n, layout);
  return (
    <span
      className={`layout-sketch ${className}`}
      aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } as CSSProperties}
    >
      {cells.map(({ seat, rot, area }) => {
        const a = art?.(seat);
        return (
          <span key={seat} className={`sketch-cell${a ? " has-art" : ""}`} style={{ gridArea: area }}>
            {a && <img src={a} alt="" />}
            <span className="sketch-n">
              <span style={{ transform: `rotate(${rot}deg)` }}>{seat + 1}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function LayoutPicker({ n, art, className = "" }: { n: number; art?: (seat: number) => string | undefined; className?: string }) {
  const chosen = useLayoutChoice(n);
  const options = layoutOptions(n);
  if (options.length < 2) return null;
  const about = options.find((o) => o.key === chosen)?.about;
  return (
    <div className={`layout-picker ${className}`}>
      <span id={`layout-${n}`} className="field-label">Panels</span>
      <div className="layout-options" role="group" aria-labelledby={`layout-${n}`}>
        {options.map((o) => (
          <Button key={o.key} className="layout-option" aria-pressed={o.key === chosen} onClick={() => setLayout(n, o.key)}>
            <LayoutSketch n={n} layout={o.key} art={art} />
            <span className="layout-label">{o.label}</span>
          </Button>
        ))}
      </div>
      {about && <p className="small dim layout-about">{about} Seat 1 is nearest this device; the rest go clockwise. Each device keeps its own layout.</p>}
    </div>
  );
}
