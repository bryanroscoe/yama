import { identityName } from "@yama/core";
import {
  changeStep,
  countChanges,
  getLine,
  inForce,
  inForceSwaps,
  nextStep,
  planChange,
  sourceText,
  startSkipped,
  waitingSwaps,
  type DeckPlanState,
  type PlanDeck,
} from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { ConnectButton } from "../components/HowTo";
import { Pips } from "../components/ui";
import { ImportSheet } from "./ImportSheet";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import type { PlanView } from "./view";
import "./plans.css";

import { planHref } from "./href";
export { planHref } from "./href";

interface Row {
  deck: PlanDeck;
  plan: DeckPlanState;
}

/** The changes of a plan's waiting version that aren't skipped yet, counted by where they come from. */
export function waitingCounts(view: PlanView, deck: PlanDeck, plan: DeckPlanState) {
  // The same changes the plan's page starts skipped.
  const skipped = plan.next ? startSkipped(plan.next) : new Set<string>();
  const swaps = waitingSwaps(plan, view.swapsOf(deck.key)).filter((s) => !skipped.has(s.key));
  return countChanges(swaps.map((s) => planChange(s, view.b, view.deckName)));
}

/** Where each change of a plan in progress stands, from its marks and orders. */
export function progressSteps(view: PlanView, deck: PlanDeck, plan: DeckPlanState) {
  return inForceSwaps(deck, plan, view.b.swaps, view.answers).map((s) => ({
    swap: s,
    step: changeStep(s, view.markBy.get(s.key), view.ctx.orders),
    /** The card it takes out: your chosen cut, else the plan's. */
    out: view.answers.get(s.key)?.cut || s.out,
  }));
}

const cardsWord = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** `/decks/plans`: every deck once, by its plan's state (design board "Main"). */
export function Plans() {
  const { view } = usePlanOutlet();
  const [importing, setImporting] = useState(false);
  const rows: Row[] = useMemo(
    () => [...view.b.decks].sort((a, b) => a.sort - b.sort).map((deck) => ({ deck, plan: view.planOf(deck) })),
    [view],
  );
  const have = (r: Row) => !!r.deck.yama_deck || !!r.deck.deck_id;
  const waiting = rows.filter((r) => r.plan.state === "waiting");
  const waitingMine = waiting.filter(have);
  const notYet = waiting.filter((r) => !have(r));
  const versions = rows.filter((r) => inForce(r.plan) && r.plan.next);
  const progress = rows.filter((r) => r.plan.state === "in_progress");
  const done = rows.filter((r) => r.plan.state === "done");
  // Decks with no changes yet: yours wait for a plan; one you don't have yet is listed with them.
  const empty = rows.filter((r) => r.plan.state === "empty" && !have(r));
  const noPlan = rows.filter((r) => r.plan.state === "empty" && have(r));
  const archived = rows.filter((r) => r.plan.state === "archived").length + new Set((view.b.versions ?? []).filter((v) => v.superseded_at || v.status === "kept").map((v) => `${v.deck}/${v.n}`)).size;
  // Start with the plan that has waited longest.
  const start = [...waitingMine].sort((a, b) => (a.plan.next?.proposed_at ?? "").localeCompare(b.plan.next?.proposed_at ?? ""))[0];
  const get = useMemo(() => {
    const steps = rows.filter((r) => inForce(r.plan)).flatMap((r) => progressSteps(view, r.deck, r.plan));
    const n = (k: string) => steps.filter((s) => s.step === k).length;
    return { buy: n("to_buy"), print: n("to_print"), move: n("to_move"), putIn: n("in_hand") };
  }, [rows, view]);
  // Get the cards shows for any approved plan, and for cards added to the shopping list by hand.
  const anyApproved = rows.some((r) => inForce(r.plan)) || (view.b.shopping_wants?.length ?? 0) > 0;
  // The small art beside new versions and done plans, credited once under the page.
  const thumbArtists = [...new Set([...versions, ...done].filter((r) => view.art(r.deck)).map((r) => view.card(r.deck.commander[0])?.artist))];

  return (
    <>
      <PlansHead title="Plans" index />
      {importing && <ImportSheet view={view} onClose={() => setImporting(false)} />}
      <p className="dim plans-lede">One plan per deck: a Bracket 4 build and the swaps back to Bracket 3 and 2.</p>

      {(start || anyApproved) && (
        <section className="plans-start" aria-labelledby="plans-start">
          {start && <StartCard row={start} view={view} />}
          {anyApproved && (
            <Link to="/decks/plans/get" className="plans-get-card">
              <span className="plans-card-title">Get the cards</span>
              <span>{getSummary(get)}</span>
              <span className="small dim">For every plan you've approved</span>
            </Link>
          )}
        </section>
      )}

      {rows.length === 0 && (
        <section className="plans-empty">
          <p>No plans yet. Ask your assistant for a plan for one of your decks, or import a plan file. Each plan waits here for your OK.</p>
          <div className="row">
            <ConnectButton className="primary" />
            <button className="outline" onClick={() => setImporting(true)}>Import a plan file</button>
          </div>
        </section>
      )}

      {(waitingMine.length > 0 || versions.length > 0) && (
        <section className="plans-section" aria-labelledby="plans-waiting">
          <div className="plans-section-head">
            <h2 id="plans-waiting">Waiting for your OK</h2>
            <span className="dim">
              {[waitingMine.length && (waitingMine.length === 1 ? "1 new plan" : `${waitingMine.length} new plans`), versions.length && (versions.length === 1 ? "1 new version" : `${versions.length} new versions`)]
                .filter(Boolean)
                .join(", ")}
              . Nothing is bought or printed until you approve.
            </span>
          </div>
          {waitingMine.length > 0 && (
            <div className="plans-grid">
              {waitingMine.map((r) => (
                <WaitingTile key={r.deck.key} row={r} view={view} />
              ))}
            </div>
          )}
          {versions.length > 0 && (
            <div className="plans-list">
              {versions.map((r) => (
                <Link key={r.deck.key} to={`${planHref(r.deck.key)}#new-version`} className="plans-list-row">
                  <Thumb deck={r.deck} view={view} />
                  <span className="plans-list-main">
                    <b>{r.deck.name}: a new version</b>
                    <span className="small dim">
                      Adds {cardsWord(r.plan.next!.keys.length)}, {sourceText(r.plan.next!.source, r.plan.next!.proposed_at, view.b.head)}
                    </span>
                  </span>
                  <span className="small dim">In progress meanwhile</span>
                  <Chevron />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {progress.length > 0 && (
        <section className="plans-section" aria-labelledby="plans-progress">
          <div className="plans-section-head">
            <h2 id="plans-progress">In progress</h2>
            <span className="dim">Approved. Buying, printing and putting cards in.</span>
          </div>
          <div className="plans-grid">
            {progress.map((r) => (
              <ProgressTile key={r.deck.key} row={r} view={view} />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section className="plans-section" aria-labelledby="plans-done">
          <h2 id="plans-done">Done</h2>
          <div className="plans-chips">
            {done.map((r) => (
              <Link key={r.deck.key} to={planHref(r.deck.key)} className="plans-done-chip">
                <Thumb deck={r.deck} view={view} round />
                <b>{r.deck.name}</b>
                <span className="small good">All {r.plan.changes} in</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {(notYet.length > 0 || empty.length > 0) && (
        <section className="plans-section" aria-labelledby="plans-later">
          <div className="plans-section-head">
            <h2 id="plans-later">Decks you don't have yet</h2>
            <span className="dim">Their plans wait here until the deck is in Yama. Approve one once it arrives.</span>
          </div>
          <div className="plans-list">
            {notYet.map((r) => (
              <Link key={r.deck.key} to={planHref(r.deck.key)} className="plans-list-row">
                <b className="plans-list-main">{r.deck.name}</b>
                <span className="small dim">{cardsWord(waitingCounts(view, r.deck, r.plan).total)} waiting</span>
                <Chevron />
              </Link>
            ))}
            {empty.map((r) => (
              <div key={r.deck.key} className="plans-list-row">
                <b className="plans-list-main">{r.deck.name}</b>
                <span className="small dim">No plan yet</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {noPlan.length > 0 && (
        <section className="plans-section" aria-labelledby="plans-none">
          <div className="plans-section-head">
            <h2 id="plans-none">No plan yet</h2>
            <span className="dim">Ask your assistant for a plan; it waits here for your OK.</span>
          </div>
          <div className="plans-list">
            {noPlan.map((r) => (
              <Link key={r.deck.key} to={planHref(r.deck.key)} className="plans-list-row">
                <b className="plans-list-main">{r.deck.name}</b>
                <span className="small dim">No changes yet</span>
                <Chevron />
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="plans-archived-link" aria-label="Archived plans">
        <Link to="/decks/plans/archived">
          <b>Archived plans{archived ? ` (${archived})` : ""}</b>
          <span className="dim">Research notes, earlier versions and plans you set aside, kept for reference. None of them is a current plan.</span>
        </Link>
      </section>

      {thumbArtists.some(Boolean) && <p className="small dim art-credits">Small pictures: {artCredits(thumbArtists)}</p>}
      <div className="small dim plans-footer-links">
        <Link to="/decks/plans/settings">Shopping rules and stores</Link>
        <ConnectButton className="link-button" />
        <button type="button" className="link-button" onClick={() => setImporting(true)}>
          Import a plan file
        </button>
      </div>
    </>
  );
}

function getSummary(g: { buy: number; print: number; move: number; putIn: number }): string {
  const parts = [g.buy && `${g.buy} to buy`, g.print && `${g.print} to print`, g.move && `${g.move} to move between decks`, g.putIn && `${g.putIn} to put in`].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everything you approved is in hand";
}

function StartCard({ row, view }: { row: Row; view: PlanView }) {
  const c = waitingCounts(view, row.deck, row.plan);
  const commander = view.card(row.deck.commander[0]);
  const crop = view.art(row.deck);
  const bits = [cardsWord(c.total), c.buy ? `${c.buyUsd != null ? `$${c.buyUsd.toFixed(2)}` : `${c.buy} cards`} to buy` : null, c.print ? `${c.print} to print` : null].filter(Boolean);
  return (
    <div className="plans-start-card">
      {crop && (
        <figure className="plans-start-art">
          <img src={crop} alt="" />
          <figcaption className="small dim">{artCredit(commander?.artist)}</figcaption>
        </figure>
      )}
      <div className="plans-start-text">
        <h2 id="plans-start" className="plans-card-title">Start with {row.deck.name}</h2>
        <span>Its plan is waiting for your OK: {bits.join(", ")}.</span>
      </div>
      <Link className="button primary plans-big-button" to={planHref(row.deck.key)}>
        Review the plan
      </Link>
    </div>
  );
}

function TileArt({ deck, view, children, tall = false }: { deck: PlanDeck; view: PlanView; children: React.ReactNode; tall?: boolean }) {
  const commander = view.card(deck.commander[0]);
  const art = view.art(deck);
  return (
    <ArtPanel art={art} artist={commander?.artist} wash="bottom" className={`plans-tile-art${tall ? " tall" : ""}`}>
      {children}
    </ArtPanel>
  );
}

function WaitingTile({ row, view }: { row: Row; view: PlanView }) {
  const { deck, plan } = row;
  const c = waitingCounts(view, deck, plan);
  return (
    <Link to={planHref(deck.key)} className="plans-tile">
      <TileArt deck={deck} view={view} tall>
        <span className="plans-tile-name">{deck.name}</span>
        <span className="plans-tile-cmdr">
          <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
          <span className="visually-hidden">, {identityName(deck.color_identity ?? "")}</span>
        </span>
      </TileArt>
      <span className="plans-tile-body">
        <b>{cardsWord(c.total)}</b>
        <span className="small">{getLine(c)}</span>
        {plan.questions.length > 0 && <span className="small warn">{plan.questions.length === 1 ? "1 question to answer" : `${plan.questions.length} questions to answer`}</span>}
        <span className="small dim">{plan.next ? cap(sourceText(plan.next.source, plan.next.proposed_at, view.b.head)) : ""}</span>
      </span>
    </Link>
  );
}

function ProgressTile({ row, view }: { row: Row; view: PlanView }) {
  const { deck, plan } = row;
  const steps = progressSteps(view, deck, plan);
  const inDeck = steps.filter((s) => s.step === "in").length;
  const total = steps.length;
  const pct = total ? Math.round((inDeck / total) * 100) : 0;
  const box = deck.bracket?.box ?? deck.bracket?.target ?? null;
  const next = plan.next ? "OK the new version" : nextStep(steps.map((s) => s.step));
  return (
    <Link to={planHref(deck.key)} className="plans-tile">
      <TileArt deck={deck} view={view}>
        <span className="plans-tile-name">{deck.name}</span>
      </TileArt>
      <span className="plans-tile-body">
        <span className="plans-tile-line">
          <b>
            {inDeck} of {total} in
          </b>
          {box != null && <span className="small dim">Bracket {box} in the box</span>}
        </span>
        <span className="plans-bar" role="img" aria-label={`${inDeck} of ${total} in the deck`}>
          <span style={{ width: `${pct}%` }} />
        </span>
        {next && <span className="small">Next: {next}</span>}
        {plan.next && <span className="tag warn small">New version waiting for your OK</span>}
      </span>
    </Link>
  );
}

function Thumb({ deck, view, round = false }: { deck: PlanDeck; view: PlanView; round?: boolean }) {
  const art = view.art(deck);
  const artist = view.card(deck.commander[0])?.artist;
  return art ? <img className={`plans-thumb${round ? " round" : ""}`} src={art} alt="" title={artCredit(artist)} /> : <span className={`plans-thumb${round ? " round" : ""}`} aria-hidden="true" />;
}

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
