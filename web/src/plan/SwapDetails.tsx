import { CardRef, CardText } from "../components/CardRef";
import { sheetCardMatches, type SheetStep, type SwapSheet } from "@yama/core/plan";
import type { PlanView } from "./view";

export function destination(s: SheetStep): string {
  if (s.to === "deck") return `to ${s.toDeck?.name ?? "another deck"}${s.toReplaces ? `, in for ${s.toReplaces}` : ""}`;
  if (s.to === "bag") return `swap bag, back in at ${s.bagBracket}`;
  return s.to === "basics" ? "back to your basics" : "spares box";
}

export function SwapReasons({ step: s, side = "both" }: { step: SheetStep; side?: "in" | "out" | "both" }) {
  const swap = s.swap;
  const add = side !== "out";
  const cut = side !== "in";
  return (
    <div className="ss-reasons">
      {cut && s.outKind !== "cut" && <p>{s.out&&<CardRef name={s.out}/>} is {s.outKind === "standin" ? "the stand-in" : "a basic holding the slot"}{swap?.out?<> for <CardRef name={swap.out}/></>:""}.</p>}
      {add && swap?.why && <p><b>Why add <CardRef name={s.in}/>:</b> {swap.why}</p>}
      {cut && swap?.why_out && <p><b>Why cut {(swap.out??s.out)&&<CardRef name={(swap.out??s.out)!}/>}:</b> {swap.why_out}</p>}
      {side === "both" && !swap?.why && !swap?.why_out && <p className="dim">No reason recorded for this swap.</p>}
      {side === "in" && !swap?.why && <p className="dim">No add reason recorded.</p>}
      {side === "out" && !swap?.why_out && s.outKind === "cut" && <p className="dim">No cut reason recorded.</p>}
      {add && swap?.when && <p>{swap.when}</p>}
      {add && swap?.advice && <p>{swap.advice}</p>}
      {add && swap?.note && <p className="dim">{swap.note}</p>}
    </div>
  );
}

/** The same answer for a camera result and a typed card name; a scan never marks a swap done. */
export function SwapCardResult({ name, sheet, view, deckKey }: { name: string; sheet: SwapSheet; view: PlanView; deckKey?: string }) {
  const matches = sheetCardMatches(sheet, view.b, name, deckKey);
  return (
    <div className="ss-card-result" role="status">
      {!matches.length && <p><b>No swap for {name}{deckKey ? ` in ${view.deckName(deckKey)}` : " in this sheet"}.</b> This checks the now-to-after-prints changes only.</p>}
      {matches.map(({ deck, step, side }, i) => (
        <section className="ss-match" key={`${deck.key}-${side}-${i}`}>
          <h3>{deck.name}: {step.installed ? "already marked installed" : side === "out" ? "take this card out" : "put this card in"}</h3>
          <p><b>Put in:</b> {step.in?<CardRef name={step.in} oracleId={view.oracleId(step.in)}/>:"No card named"}<br /><b>Take out:</b> {step.out?<CardRef name={step.out} oracleId={view.oracleId(step.out)}/>:"No card named"}</p>
          {step.out && <p><b>Then:</b> <CardText text={destination(step)} names={step.toReplaces?[step.toReplaces]:[]}/>.</p>}
          <SwapReasons step={step} />
        </section>
      ))}
    </div>
  );
}
