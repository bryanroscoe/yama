import { identityName } from "@yama/core";
import { buyList, daysBetween, deckCounts, deckWarnings, fmtDate, opTime, overviewCounts, STALE_DAYS, usd, type BuyList, type PlanDeck } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Pips } from "../components/ui";
import { ImportSheet } from "./ImportSheet";
import { deviceId, outbox, useOutbox } from "./outbox";
import { headSentence, PlansHead, usePlanOutlet } from "./PlanLayout";
import type { PlanView } from "./view";

/** `/decks/plan`: where the plans came from, the totals, and one art tile per deck (design: PlanOverview). */
export function Overview() {
  const { view, userId } = usePlanOutlet();
  const pending = useOutbox(userId).pending.length;
  const { b } = view;
  const [importing, setImporting] = useState(false);
  const live = b.decks.filter((d) => d.status !== "archived");
  const archived = b.decks.filter((d) => d.status === "archived");
  const counts = live.map((d) => deckCounts(d, view.swapsOf(d.key), view.answers, view.ctx.orders));
  const sum = (f: (c: (typeof counts)[number]) => number) => counts.reduce((n, c) => n + f(c), 0);
  const totals = useMemo(() => overviewCounts(b, { answers: view.answers, marks: view.markBy, today: view.today }), [b, view]);
  const buy = useMemo(() => buyList(b, { answers: view.answers, marks: view.markBy }), [b, view]);
  const priceAge = daysBetween(b.prices_as_of, view.today);
  const installedGone = view.markOrphans.filter(([, m]) => m.installed?.value);
  const questions = b.notes.filter((n) => n.kind === "open_question");
  const otherNotes = b.notes.filter((n) => n.kind !== "open_question");
  const artists = live.map((d) => (view.art(d) ? view.card(d.commander[0])?.artist : null));
  const elsewhere = buy.elsewhere.length;

  return (
    <>
      <PlansHead
        title="Plans"
        index
        action={
          <button className={b.decks.length ? "" : "primary"} onClick={() => setImporting(true)}>
            <span className="wide-only">Import a plan file</span>
            <span className="phone-only">Import</span>
          </button>
        }
      />
      {importing && <ImportSheet view={view} onClose={() => setImporting(false)} />}

      {b.decks.length === 0 ? (
        <div className="empty stack">
          <p>No plans yet.</p>
          <p className="small">
            A plan file brings in your decks with their stock, now and after-prints lists, every swap with its reason and where each card comes from, and
            your proposals. Your plans are yours: nobody else sees them.
          </p>
        </div>
      ) : (
        <>
          {b.head && (
            <div className="area-note plan-head-note" role="note">
              <p>
                Planned in {b.head.app ?? "an outside planner"}. {headSentence(b.head)} What you do here goes to its inbox
                {b.inputs.pending_pull > 0 ? (
                  <>
                    : <b>{b.inputs.pending_pull === 1 ? "1 item waiting." : `${b.inputs.pending_pull} items waiting.`}</b>
                  </>
                ) : b.inputs.pulled_at ? (
                  `; it last picked up ${fmtDate(b.inputs.pulled_at)}.`
                ) : (
                  "."
                )}
                {pending > 0 ? <b> {pending === 1 ? "1 answer is" : `${pending} answers are`} saved on this phone, waiting to sync.</b> : null}
              </p>
              <p>
                Lists, swaps and prices come from that export and are read-only here.
                {b.prices_as_of ? ` Market prices are TCGplayer market via Scryfall, as of ${fmtDate(b.prices_as_of)}.` : " No market prices yet."}
                {priceAge != null && priceAge > STALE_DAYS ? ` Yama's prices haven't updated for ${priceAge} days.` : ""}
              </p>
            </div>
          )}

          <div className="plan-figures">
            <Link className="plan-figure" to="/decks/plan/review?show=proposed">
              <b className={`num${totals.toReview ? " warn" : ""}`}>{totals.toReview}</b>
              <span>to review</span>
            </Link>
            <Link className="plan-figure" to="/decks/plan/buy">
              <b className="num">{buy.total != null ? usd(buy.total) : buy.count}</b>
              <span>
                {buy.total != null ? `${buy.priced} to buy` : "to buy"}
                {elsewhere ? `, ${elsewhere} not stocked` : ""}
                {buy.noPrice.length ? `, ${buy.noPrice.length} with no listed price` : ""}
                {buy.total != null && buy.checkedOn.length ? `. Store prices, ${fmtDate(buy.checkedOn[buy.checkedOn.length - 1])}` : ""}
              </span>
            </Link>
            <Link className="plan-figure" to="/decks/plan/prints">
              <b className="num">{totals.printsOnOrder}</b>
              <span>
                prints on order{totals.printsNext ? `, ${totals.printsNext} for the next order` : ""}
                {totals.printsArrived ? `, ${totals.printsArrived} arrived` : ""}
              </span>
            </Link>
            <Link className="plan-figure" to="/decks/plan/spares">
              <b className="num">{totals.sparesNow}</b>
              <span>spares out now{totals.sparesLater ? `, ${totals.sparesLater} more when prints arrive` : ""}</span>
            </Link>
            <div className="plan-figure">
              <b className="num">{totals.waitingToInstall}</b>
              <span>in hand, not in the deck yet</span>
            </div>
            <div className="plan-figure">
              <b className="num">
                {sum((c) => c.ready)}/{sum((c) => c.planned)}
              </b>
              <span>planned swaps in hand now</span>
            </div>
          </div>

          {installedGone.length > 0 && (
            <section className="plan-notes">
              <h3>Installed, but no longer in the plan</h3>
              <p className="small dim">You ticked these as in the deck, and the latest import doesn't have the swap. Settle them with your planner, or clear the tick.</p>
              <ul className="small">
                {installedGone.map(([key]) => {
                  const [, deck, inn, out] = key.split("|");
                  return (
                    <li key={key}>
                      {inn ? `${inn}${out ? ` for ${out}` : ""}` : key}
                      {deck ? <span className="dim"> ({deck})</span> : null}{" "}
                      <button
                        className="quiet small"
                        onClick={() =>
                          outbox.enqueue(userId, { kind: "installed", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: key, deck_key: null, value: false })
                        }
                      >
                        Clear the tick
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="plan-section" aria-labelledby="your-plans">
            <h2 id="your-plans" className="plan-section-head">Your plans</h2>
            <div className="plan-deck-grid">
              {live.map((d, i) => (
                <DeckTile key={d.key} deck={d} view={view} counts={counts[i]!} buy={buy} />
              ))}
            </div>
            {artists.some(Boolean) && <p className="small dim art-credits">{artCredits(artists)}</p>}
          </section>

          {questions.length > 0 && (
            <details className="plan-notes plan-notes-fold">
              <summary>
                <span className="tag warn">{questions.length === 1 ? "1 open question" : `${questions.length} open questions`}</span>{" "}
                <span className="dim small">for you and your planner about the whole plan</span>
              </summary>
              <ul>
                {questions.map((n) => (
                  <li key={n.text}>
                    {n.text}
                    {n.source && <span className="faint small"> From {n.source}.</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {otherNotes.length > 0 && (
            <ul className="small dim">
              {otherNotes.map((n) => (
                <li key={n.text}>{n.text}</li>
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-section-head">No longer in the plan</h2>
              <p className="dim small">The latest import didn't include these decks. Yama keeps them so their answers aren't lost.</p>
              <div className="plan-deck-grid">
                {archived.map((d) => (
                  <DeckTile key={d.key} deck={d} view={view} counts={deckCounts(d, view.swapsOf(d.key), view.answers, view.ctx.orders)} buy={buy} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

/** "Mount Doom: where did it come from?": a question cut down to fit a chip. */
function shortQuestion(text: string): string {
  const first = text.split(/(?<=[?.])\s/)[0] ?? text;
  return first.length > 64 ? `${first.slice(0, 61).trimEnd()}…` : first;
}

function DeckTile({ deck, view, counts, buy }: { deck: PlanDeck; view: PlanView; counts: ReturnType<typeof deckCounts>; buy: BuyList }) {
  const warnings = deckWarnings(deck, view.b.head?.warnings ?? [], view.b.head?.export_warnings ?? []);
  const questions = deck.notes.filter((n) => n.kind === "open_question");
  const toBuy = [...buy.stores.flatMap((g) => g.rows), ...buy.noPrice, ...buy.elsewhere].filter((r) => r.swap.deck === deck.key).length;
  const prints = counts.printsOnOrder + counts.printsNext;
  const parts: string[] = [];
  if (counts.undecided) parts.push(`${counts.undecided} to review`);
  if (toBuy) parts.push(`${toBuy} to buy`);
  if (prints) parts.push(`${prints} wait on prints`);
  if (counts.waitingMoves) parts.push(`${counts.waitingMoves} waiting for another deck`);
  const target = deck.bracket?.target;
  if (target != null && parts.length < 3) parts.push(`bracket ${target}`);
  const commander = view.card(deck.commander[0]);
  return (
    <Link to={`/decks/plan/d/${deck.key}`} className="plan-tile">
      <ArtPanel art={view.art(deck)} artist={commander?.artist} wash="left" credit={false} className="plan-tile-art">
        <span className="plan-tile-name">{deck.name}</span>
        <span className="plan-tile-cmdr">
          <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
          <span className="visually-hidden">, {identityName(deck.color_identity ?? "")}</span>
        </span>
        <span className="plan-tile-counts">{parts.length ? `${parts.join(", ")}.` : "Nothing waiting."}</span>
        {counts.planned > 0 && (
          <span className="plan-tile-counts dim-on-art">
            {counts.ready} of {counts.planned} swaps in hand now
          </span>
        )}
        <span className="plan-tile-chips">
          {deck.status === "proposals_only" && <span className="art-chip">Proposals only</span>}
          {questions.length > 0 && <span className="art-chip warn">{questions.length === 1 ? shortQuestion(questions[0]!.text) : `${questions.length} open questions`}</span>}
          {warnings.length > 0 && <span className="art-chip warn">{warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}</span>}
        </span>
      </ArtPanel>
    </Link>
  );
}
