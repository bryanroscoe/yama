import { ManaCost } from "../components/ui";

/** Keep action words intact while rendering embedded mana in the shared text-symbol style. */
export function CostText({ text }: { text: string }) {
  return <>{text.split(/(\{(?:\d+|[WUBRGCXYZS]|[WUBRGC2]\/[WUBRGPC])\})/).map((part, i) => i % 2 === 1 ? <ManaCost key={i} cost={part} /> : part)}</>;
}
