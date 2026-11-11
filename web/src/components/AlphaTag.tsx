import { Tag } from "./StatusPill";

// Online play is in alpha (Bryan, 2026-11-02: "it's not even alpha stage. We need to make sure we
// market it as that"). Shown wherever Play is reached: the nav, Play's pages, the lobby and the board.

export const ALPHA_NOTE = "Online play is in alpha: expect bugs and slow turns.";

export function AlphaTag({ className = "" }: { className?: string }) {
  return (
    <Tag className={`alpha-tag ${className}`.trim()} title={ALPHA_NOTE}>
      <span className="visually-hidden">, </span>Alpha
    </Tag>
  );
}
