import { identityName } from "@yama/core";
import { buyList, daysBetween, deckCounts, deckWarnings, fmtDate, opTime, overviewCounts, STALE_DAYS, swapCards, usd, type BuyList, type PlanDeck } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Details, ErrorText, Pips } from "../components/ui";
import { deckGroups, fromLine, NoteDeckTile, PlanNotes, trackedBuild, trackedNote } from "../research/PlanTiles";
import { deckHref, planSummaries, planSummariesKey } from "../research/view";
import { api, type DeckSummary } from "../api";
import { AskClaude } from "../advisor/AskClaude";
import { ConnectButton, HowTo } from "../components/HowTo";
import { AssistantOnly } from "./howto";
import { useQuery } from "@tanstack/react-query";
import { ImportSheet } from "./ImportSheet";
import { deviceId, outbox, useOutbox } from "./outbox";
import { headDetails, PlansHead, usePlanOutlet } from "./PlanLayout";
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
  const elsewhere = buy.elsewhere.length;
  const notes = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries });
  // One tile per deck, whichever notes plan it: a tracked one shows its counts and opens the
  // plan it tracks (a note's deck page at the tracked build, or a plan file's deck page).
  const groups = deckGroups(notes.data ?? [], b.decks);
  const tileArtists = groups.map((g) => {
    const d = trackedNote(g) ?? g.tracked[0];
    return d ? (view.art(d) ? view.card(d.commander[0])?.artist : null) : g.notes[0]?.plan.art?.artist;
  });
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const example = decks.data?.find((d) => !d.parent_id)?.name ?? "Commander";

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

      <HowTo
        title="How plans work"
        open={!!notes.data && notes.data.length === 0 && b.decks.length === 0}
        steps={[
          <>
            <b>Get a plan.</b> <AssistantOnly what="Plans are written for your decks." /> Connect Claude or another assistant to Yama once, then ask it something like <q>Plan Bracket 2, 3 and 4 upgrades for my {example} deck and save them in Yama.</q> It reads your deck and collection and saves the plan here. If someone sends you a shared plan instead, open the link and choose Save a copy in Yama; no assistant needed.
          </>,
          <>
            <b>Read it.</b> Each deck in a plan has its builds, how to pilot it, every change with its reason, a shopping list priced at market (the cheap cards to buy, the rest to print) and the full list to copy.
          </>,
          <>
            <b>Answer it.</b> Pick the build you prefer and mark changes Want, Unsure or Don't want, with a note if you like. Your assistant reads your answers next time. Nothing changes your decks until you do it.
          </>,
          <>
            <b>Make it.</b> On a deck's page, Track this build: its cards to buy go on your buy list and store trip, its prints on Prints, and you tick each change as it goes into the deck. Switch builds or stop at any time. Load a build into your deck with Update from a list, print <Link to="/decks/builds">swap cards</Link> for the deck box, or share the plan by link or on your profile.
          </>,
        ]}
        actions={
          <>
            <ConnectButton className="primary" />
            <AskClaude context={{ kind: "general" }} about="planning your decks" />
            <button className="outline" onClick={() => setImporting(true)}>Import a plan file</button>
          </>
        }
      />

      <section className="plan-section" aria-labelledby="your-plans">
        <h2 id="your-plans" className="plan-section-head">Your deck plans</h2>
        {groups.length > 0 && <p className="small dim plan-tracked-about">One for each deck: open it for its builds, every change with its reason, and what to buy or print. A tracked one shows what's left to do.</p>}
        {notes.error ? <ErrorText error={notes.error} /> : null}
        {groups.length === 0 && (notes.data || notes.error) && <p className="dim">No plans yet. The steps above show how to get one.</p>}
        {groups.length === 0 && !notes.data && !notes.error && <p className="dim">Loading your plans…</p>}
        {groups.length > 0 && (
          <div className="plan-deck-grid">
            {groups.map((g) => {
              const d = trackedNote(g) ?? g.tracked[0];
              if (!d) return <NoteDeckTile key={g.id} group={g} />;
              const i = live.indexOf(d);
              return (
                <DeckTile
                  key={g.id}
                  deck={d}
                  view={view}
                  counts={counts[i]!}
                  buy={buy}
                  to={d.note ? deckHref(d.note.id, d.note.deck, d.note.build) : undefined}
                  from={fromLine(g, d) ?? undefined}
                  tracking={d.note ? (trackedBuild(g, d) ?? "a build") : undefined}
                />
              );
            })}
          </div>
        )}
        {swapCards(b).length > 0 && (
          <div className="row plan-swap-cards">
            <Link className="button outline" to="/decks/plan/swap-cards">Print all swap cards</Link>
            <span className="small dim">A card for each deck box: the swaps to change bracket.</span>
          </div>
        )}
        {tileArtists.some(Boolean) && <p className="small dim art-credits">{artCredits(tileArtists)}</p>}
      </section>

      {b.decks.length > 0 && (
        <>
          <h2 id="tracked-decks" className="plan-section-head plan-tracked-head">What you're tracking</h2>
          <p className="small dim plan-tracked-about">Across the plans you track: the swaps to review, the cards to buy and print, and what's in the deck box yet.</p>
          {b.head && (
            <div className="area-note plan-head-note" role="note">
              <p>
                Imported {fmtDate(b.head.imported_at)}. Lists managed in {b.head.app ?? "your planner"}.
                {b.inputs.pending_pull > 0 ? (
                  <>
                    {" "}<b>{b.inputs.pending_pull === 1 ? "1 answer waiting to be picked up." : `${b.inputs.pending_pull} answers waiting to be picked up.`}</b>
                  </>
                ) : null}
                {pending > 0 ? <b> {pending === 1 ? "1 answer is" : `${pending} answers are`} saved on this phone, waiting to sync.</b> : null}
                {priceAge != null && priceAge > STALE_DAYS ? ` Yama's prices haven't updated for ${priceAge} days.` : ""}
              </p>
              <Details label="Plan source and sync details">
                <p>Lists are read-only here. Your answers go to your planner's inbox.{b.inputs.pulled_at ? ` Last picked up ${fmtDate(b.inputs.pulled_at)}.` : ""}</p>
                <p>{headDetails(b.head)}</p>
                <p>
                  Lists, swaps and prices come from that export.
                  {b.prices_as_of ? ` Market prices are TCGplayer market via Scryfall, as of ${fmtDate(b.prices_as_of)}.` : " No market prices yet."}
                </p>
              </Details>
            </div>
          )}

          <div className="plan-figures">
            <Link className="plan-figure" to="/decks/plan/review">
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
              <p className="small dim">Missing from the latest import. Review with your planner or clear the mark.</p>
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

          {archived.length > 0 && (
            <section className="plan-section">
              <h2 className="plan-section-head">No longer tracked</h2>
              <p className="dim small">Not in the latest import. Previous answers kept.</p>
              <div className="plan-deck-grid">
                {archived.map((d) => (
                  <DeckTile key={d.key} deck={d} view={view} counts={deckCounts(d, view.swapsOf(d.key), view.answers, view.ctx.orders)} buy={buy} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {notes.data && notes.data.length > 0 && (
        <section className="plan-section" aria-labelledby="plan-notes">
          <h2 id="plan-notes" className="plan-section-head">Where they came from</h2>
          <p className="small dim plan-tracked-about">What your assistant saved, and plans you copied from someone's link. Open one for a shopping list across its decks, or to share it.</p>
          <PlanNotes plans={notes.data} />
        </section>
      )}
    </>
  );
}

/** "Mount Doom: where did it come from?": a question cut down to fit a chip. */
function shortQuestion(text: string): string {
  const first = text.split(/(?<=[?.])\s/)[0] ?? text;
  return first.length > 64 ? `${first.slice(0, 61).trimEnd()}…` : first;
}

/** A tracked deck's tile. One tracking a plan's build opens that plan at the build (`to`), says
 *  which (`tracking`) and where it came from (`from`); one from a plan file opens its plan page. */
function DeckTile({ deck, view, counts, buy, to, from, tracking }: { deck: PlanDeck; view: PlanView; counts: ReturnType<typeof deckCounts>; buy: BuyList; to?: string; from?: string; tracking?: string }) {
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
    <Link to={to ?? `/decks/plan/d/${deck.key}`} className="plan-tile">
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
        {from && <span className="plan-tile-counts dim-on-art">{from}</span>}
        <span className="plan-tile-chips">
          {tracking && deck.status !== "archived" && <span className="art-chip plain">Tracking {tracking}</span>}
          {deck.status === "proposals_only" && <span className="art-chip">Proposals only</span>}
          {questions.length > 0 && <span className="art-chip warn">{questions.length === 1 ? shortQuestion(questions[0]!.text) : `${questions.length} open questions`}</span>}
          {warnings.length > 0 && <span className="art-chip warn">{warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}</span>}
        </span>
      </ArtPanel>
    </Link>
  );
}
