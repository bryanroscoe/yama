import { SymbolText } from "../components/ManaSymbols";

/** Keep action words intact while drawing embedded mana ("Pay {2}{R}") as symbols. */
export function CostText({ text }: { text: string }) {
  return <SymbolText text={text} />;
}
