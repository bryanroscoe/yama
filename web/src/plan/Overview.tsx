import { identityName } from "@yama/core";
import { daysBetween, deckCounts, deckWarnings, fmtDate, opTime, overviewCounts, STALE_DAYS, usd, type PlanDeck } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Pips } from "../components/ui";
import { ImportSheet } from "./ImportSheet";
import { deviceId, outbox, useOutbox } from "./outbox";
import { headSentence, usePlanOutlet } from "./PlanLayout";
import { ArtPanel } from "./parts";
import type { PlanView } from "./view";

/** `/decks/plan`: where the plans came from, the totals, and one card per deck. */
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
  const priceAge = daysBetween(b.prices_as_of, view.today);
  const installedGone = view.markOrphans.filter(([, m]) => m.installed?.value);
  const questions = b.notes.filter((n) => n.kind === "open_question");
  const otherNotes = b.notes.filter((n) => n.kind !== "open_question");

  return (
    <>
      <div className="page-head">
        <h1>Plans</h1>
        <button className={b.decks.length ? "" : "primary"} onClick={() => setImporting(true)}>Import a plan file</button>
      </div>
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
            <div className="plan-banner">
              <p>
                Planned in {b.head.app ?? "an outside planner"}. {headSentence(b.head)}
              </p>
              <p className="small dim">
                Lists, swaps and prices come from that export and are read-only here.
                {b.prices_as_of ? ` Market prices are TCGplayer market via Scryfall, as of ${fmtDate(b.prices_as_of)}.` : " No market prices yet."}
                {priceAge != null && priceAge > STALE_DAYS ? ` Yama's prices haven't updated for ${priceAge} days.` : ""}
                {` What you do here goes to its inbox`}
                {b.inputs.pending_pull > 0
                  ? `: ${b.inputs.pending_pull === 1 ? "1 item is" : `${b.inputs.pending_pull} items are`} waiting to be picked up.`
                  : b.inputs.pulled_at
                    ? `; it last picked up ${fmtDate(b.inputs.pulled_at)}.`
                    : "."}
                {pending > 0 ? ` ${pending === 1 ? "1 answer is" : `${pending} answers are`} saved on this phone, waiting to sync.` : ""}
              </p>
            </div>
          )}

          <div className="figures">
            <Link className="figure" to="/decks/plan/review?show=proposed">
              <b className="num">{totals.toReview}</b>
              <span>proposals to review</span>
            </Link>
            <Link className="figure" to="/decks/plan/buy">
              <b className="num">{totals.toBuy}</b>
              <span>
                to buy, {usd(totals.buyTotal)} listed{totals.buyUnpriced ? `, ${totals.buyUnpriced} without a listed price` : ""}
              </span>
            </Link>
            <Link className="figure" to="/decks/plan/prints">
              <b className="num">{totals.printsOnOrder}</b>
              <span>
                prints on order{totals.printsNext ? `, ${totals.printsNext} for the next order` : ""}
                {totals.printsArrived ? `, ${totals.printsArrived} arrived` : ""}
              </span>
            </Link>
            <div className="figure">
              <b className="num">{totals.waitingToInstall}</b>
              <span>in hand, not ticked as installed</span>
            </div>
            <Link className="figure" to="/decks/plan/spares">
              <b className="num">{totals.sparesNow}</b>
              <span>spares free now{totals.sparesLater ? `, ${totals.sparesLater} more when prints arrive` : ""}</span>
            </Link>
            <div className="figure">
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

          <div className="plan-deck-grid">
            {live.map((d, i) => (
              <DeckCard key={d.key} deck={d} view={view} counts={counts[i]!} />
            ))}
          </div>

          {archived.length > 0 && (
            <section>
              <h3>No longer in the plan</h3>
              <p className="dim small">The latest import didn't include these decks. Yama keeps them so their answers aren't lost.</p>
              <div className="plan-deck-grid">
                {archived.map((d) => (
                  <DeckCard key={d.key} deck={d} view={view} counts={deckCounts(d, view.swapsOf(d.key), view.answers, view.ctx.orders)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function DeckCard({ deck, view, counts }: { deck: PlanDeck; view: PlanView; counts: ReturnType<typeof deckCounts> }) {
  const warnings = deckWarnings(deck, view.b.head?.warnings ?? [], view.b.head?.export_warnings ?? []);
  const questions = deck.notes.filter((n) => n.kind === "open_question").length;
  const lines: string[] = [];
  if (counts.planned) lines.push(`${counts.ready} of ${counts.planned} swaps in hand now`);
  if (counts.printsOnOrder) lines.push(`${counts.printsOnOrder} prints on order`);
  if (counts.waitingMoves) lines.push(`${counts.waitingMoves} waiting for another deck`);
  if (counts.proposals) lines.push(`${counts.proposals} proposals, ${counts.undecided} not decided`);
  return (
    <Link to={`/decks/plan/d/${deck.key}`} className="plan-deck-link">
      <ArtPanel art={view.art(deck)} className="plan-deck-card">
        <div className="plan-deck-title">
          <h2>{deck.name}</h2>
          <span className="plan-deck-commander">
            {deck.commander.join(" and ")} <Pips identity={deck.color_identity ?? ""} />
          </span>
          <span className="small dim">{identityName(deck.color_identity ?? "")}</span>
        </div>
        <ul className="plan-deck-counts small">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="row plan-deck-tags">
          {deck.status === "proposals_only" && <span className="tag">Proposals only</span>}
          {questions > 0 && <span className="tag warn">{questions === 1 ? "1 open question" : `${questions} open questions`}</span>}
          {warnings.length > 0 && <span className="tag warn">{warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}</span>}
        </div>
      </ArtPanel>
    </Link>
  );
}
