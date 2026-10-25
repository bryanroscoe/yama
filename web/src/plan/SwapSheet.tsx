import { swapSheet, type SheetDeck, type SheetStep } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { SwapInSheet } from "./SwapIn";
import type { PlanView } from "./view";
import "./swapsheet.css";

/**
 * `/decks/plan/prints/swap`: the swap sheet for when prints arrive, on screen and on paper. Sort the
 * prints into decks, then swap each deck from its now list to its after-prints list, with where each
 * card coming out goes. The same sheet commander-decks prints (mtg-print-swaps.pdf).
 */
export function SwapSheetPage() {
  const { view } = usePlanOutlet();
  const sheet = useMemo(() => swapSheet({ ...view.b, marks: view.marks }), [view]);
  const [swapping, setSwapping] = useState<SheetDeck | null>(null);
  const decks = sheet.decks.length;
  return (
    <div className="swap-sheet">
      <div className="no-print">
        <PlansHead
          title="Swap sheet"
          action={
            <button className="primary" onClick={() => window.print()}>
              Print
            </button>
          }
        />
      </div>
      <h1 className="print-only">Prints are here: swap them in</h1>
      {sheet.prints === 0 ? (
        <p className="empty">No prints waiting to go into a deck. Every deck already has its after-prints list.</p>
      ) : (
        <>
          <p className="ss-lead">
            {sheet.prints} printed cards ({sheet.sort.length} different) for {decks} {decks === 1 ? "deck" : "decks"}. Each deck goes from what's in it now to its
            after-prints list.
          </p>
          <ol className="ss-how">
            <li>
              <b>Check and sort</b> with the first table: tick a box as each copy goes on its deck's pile. Every box ticked means the order came complete.
            </li>
            {sheet.moves.length > 0 && (
              <li>
                <b>Do the decks in this order.</b> {sheet.moves.length === 1 ? "One card changes" : `${sheet.moves.length} cards change`} decks:{" "}
                {sheet.moves.map((m) => `${m.card} from ${m.from.name} to ${m.to.name}`).join("; ")}. When one comes out, put it straight on the other deck's pile.
              </li>
            )}
            <li>
              <b>Cards coming out:</b> swap bag means keep it in that deck's box, for playing at a lower bracket. Everything else goes in your spares box,
              stand-ins you bought too.
            </li>
            <li>
              <b>GC</b> marks a Game Changer. Mark those sleeves so you can count them for brackets.
            </li>
            <li className="no-print">When a deck is sleeved, use "Swap in the prints" on its section so Yama matches it: the deck's list, its box and the installed ticks.</li>
          </ol>

          <section className="ss-sort" aria-labelledby="ss-sort-h">
            <h2 id="ss-sort-h">Check and sort the prints, A to Z</h2>
            <table>
              <thead>
                <tr>
                  <th>Card</th>
                  <th className="num">Copies</th>
                  <th>Pile</th>
                </tr>
              </thead>
              <tbody>
                {sheet.sort.map((l) => (
                  <tr key={l.card}>
                    <td>
                      <b>{l.card}</b>
                      {l.gameChanger && <span className="ss-gc">GC</span>}
                      {l.back && <span className="ss-note">double-faced, back is {l.back}</span>}
                    </td>
                    <td className="num">{l.decks.length}</td>
                    <td>
                      {l.decks.map((d, i) => (
                        <span className="ss-chip" key={`${d.key}-${i}`}>
                          <span className="ss-box" aria-hidden="true" />
                          {d.name}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {sheet.decks.map((d) => (
            <DeckSection key={d.deck.key} d={d} view={view} onSwap={() => setSwapping(d)} />
          ))}
        </>
      )}
      {swapping && <SwapInSheet deckKey={swapping.deck.key} deckName={swapping.deck.name} onClose={() => setSwapping(null)} />}
    </div>
  );
}

function DeckSection({ d, view, onSwap }: { d: SheetDeck; view: PlanView; onSwap: () => void }) {
  const all = d.installed === d.steps.length;
  return (
    <section className="ss-deck" aria-labelledby={`ss-${d.deck.key}`}>
      <div className="ss-deck-head">
        <h2 id={`ss-${d.deck.key}`}>
          {d.deck.name} <span className="dim">{d.deck.commander.join(" and ")}</span>
        </h2>
        <button className={all ? "outline no-print" : "primary no-print"} onClick={onSwap}>
          {all ? "Check it in Yama" : "Swap in the prints"}
        </button>
      </div>
      <p className="ss-lead">
        {d.prints} {d.prints === 1 ? "print" : "prints"}
        {d.moves ? ` and ${d.moves} ${d.moves === 1 ? "card" : "cards"} from another deck` : ""}. Put the left card in, take the right card out.
        {d.installed > 0 ? ` ${d.installed} of ${d.steps.length} ticked installed.` : ""}
      </p>
      <table className="ss-steps">
        <thead>
          <tr>
            <th aria-label="Done" />
            <th>Put in</th>
            <th>Take out</th>
            <th>Then</th>
          </tr>
        </thead>
        <tbody>
          {d.steps.map((s, i) => (
            <Step key={`${s.in}-${s.out}-${i}`} s={s} view={view} />
          ))}
        </tbody>
      </table>
      {d.bagAlreadyOut.length > 0 && <p className="ss-note-line">Also for the swap bag, already out of the deck (in your spares box): {d.bagAlreadyOut.join(", ")}.</p>}
    </section>
  );
}

function Thumb({ name, view }: { name: string; view: PlanView }) {
  const src = view.card(name)?.image_small;
  return src ? <img className="ss-thumb" src={src} alt="" loading="lazy" /> : <span className="ss-thumb" aria-hidden="true" />;
}

function Step({ s, view }: { s: SheetStep; view: PlanView }) {
  const then =
    s.to === "deck" ? (
      <>
        <b>to {s.toDeck?.name}</b>
        {s.toReplaces ? `, in for ${s.toReplaces}` : ""}
      </>
    ) : s.to === "bag" ? (
      <>
        <b>swap bag</b>, back in at {s.bagBracket}
      </>
    ) : s.to === "basics" ? (
      "back to your basics"
    ) : (
      "spares box"
    );
  return (
    <tr className={s.installed ? "ss-done" : undefined}>
      <td className="ss-tick">{s.installed ? <span className="ss-box ss-box-on" aria-label="Installed" /> : <span className="ss-box" aria-label="Not installed yet" />}</td>
      <td>
        {s.in && (
          <span className="ss-card">
            <Thumb name={s.in} view={view} />
            <span>
              <span>
                <b>{s.in}</b>
                {s.gameChanger && <span className="ss-gc">GC</span>}
              </span>
              <span className="ss-sub">{s.kind === "print" ? "print" : s.kind === "moved" ? `from ${s.fromDeck?.name ?? "another deck"}` : "in hand"}</span>
            </span>
          </span>
        )}
      </td>
      <td>
        {s.out && (
          <span className="ss-card">
            <Thumb name={s.out} view={view} />
            <span>
              <b>{s.out}</b>
              {s.outKind !== "cut" && <span className="ss-sub">{s.outKind === "standin" ? "stand-in" : "basic holding the slot"}</span>}
            </span>
          </span>
        )}
      </td>
      <td className="ss-then">{then}</td>
    </tr>
  );
}
