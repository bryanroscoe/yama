import { changeStep, inForce, inForceSwaps, nextStep, type DeckPlanState, type PlanDeck } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { ConnectButton } from "../components/HowTo";
import { Button, CardThumb, EmptyState } from "../components/ui";
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

/** Where each change of a plan in progress stands, from its marks and orders. */
export function progressSteps(view: PlanView, deck: PlanDeck, plan: DeckPlanState) {
  return inForceSwaps(deck, plan, view.b.swaps, view.answers).map((s) => ({
    swap: s,
    step: changeStep(s, view.markBy.get(s.key), view.ctx.orders),
    /** The card it takes out: your chosen cut, else the plan's. */
    out: view.answers.get(s.key)?.cut || s.out,
  }));
}

/**
 * `/decks/plans`: every deck once, by its plan's state (design board "Main"). Nobody approves a plan
 * (20 Nov 2026), so there's no waiting list: a plan is in progress, done, empty or archived.
 */
export function Plans() {
  const { view } = usePlanOutlet();
  const [importing, setImporting] = useState(false);
  const rows: Row[] = useMemo(
    () => [...view.b.decks].sort((a, b) => a.sort - b.sort).map((deck) => ({ deck, plan: view.planOf(deck) })),
    [view],
  );
  const have = (r: Row) => !!r.deck.yama_deck || !!r.deck.deck_id;
  // A plan the server is still taking in (only for a moment) shows with the plans in progress.
  const progress = rows.filter((r) => r.plan.state === "in_progress" || r.plan.state === "waiting");
  const done = rows.filter((r) => r.plan.state === "done");
  // Decks with no changes yet: yours wait for a plan; one you don't have yet is listed with them.
  const empty = rows.filter((r) => r.plan.state === "empty" && !have(r));
  const noPlan = rows.filter((r) => r.plan.state === "empty" && have(r));
  const archived = rows.filter((r) => r.plan.state === "archived").length + new Set((view.b.versions ?? []).filter((v) => v.superseded_at || v.status === "kept").map((v) => `${v.deck}/${v.n}`)).size;
  const get = useMemo(() => {
    const steps = rows.filter((r) => inForce(r.plan)).flatMap((r) => progressSteps(view, r.deck, r.plan));
    const n = (k: string) => steps.filter((s) => s.step === k).length;
    return { buy: n("to_buy"), print: n("to_print"), move: n("to_move"), putIn: n("in_hand") };
  }, [rows, view]);
  // Get the cards shows for any plan in force, and for cards added to the shopping list by hand.
  const anyInForce = rows.some((r) => inForce(r.plan)) || (view.b.shopping_wants?.length ?? 0) > 0;
  // The small art beside done plans, credited once under the page.
  const thumbArtists = [...new Set(done.filter((r) => view.art(r.deck)).map((r) => view.card(r.deck.commander[0])?.artist))];

  return (
    <>
      <PlansHead title="Plans" index />
      {importing && <ImportSheet view={view} onClose={() => setImporting(false)} />}
      <p className="dim plans-lede">One plan per deck: a Bracket 4 build and the swaps back to Bracket 3 and 2.</p>

      {anyInForce && (
        <section className="plans-start" aria-label="Get the cards">
          <Link to="/decks/plans/get" className="plans-get-card">
            <span className="plans-card-title">Get the cards</span>
            <span>{getSummary(get)}</span>
            <span className="small dim">For every plan</span>
          </Link>
        </section>
      )}

      {rows.length === 0 && (
        <EmptyState
          variant="panel"
          action={
            <>
              <ConnectButton variant="primary" />
              <Button variant="outline" onClick={() => setImporting(true)}>Import a plan file</Button>
            </>
          }
        >
          No plans yet. Ask your assistant for a plan for one of your decks, or import a plan file. Its changes go straight in.
        </EmptyState>
      )}

      {progress.length > 0 && (
        <section className="plans-section" aria-labelledby="plans-progress">
          <div className="plans-section-head">
            <h2 id="plans-progress">In progress</h2>
            <span className="dim">Buying, printing and putting cards in.</span>
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

      {empty.length > 0 && (
        <section className="plans-section" aria-labelledby="plans-later">
          <div className="plans-section-head">
            <h2 id="plans-later">Decks you don't have yet</h2>
            <span className="dim">No plan yet, and the deck isn't in Yama.</span>
          </div>
          <div className="plans-list">
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
            <span className="dim">Ask your assistant for a plan; it goes straight in.</span>
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
        <Button className="link-button" onClick={() => setImporting(true)}>
          Import a plan file
        </Button>
      </div>
    </>
  );
}

function getSummary(g: { buy: number; print: number; move: number; putIn: number }): string {
  const parts = [g.buy && `${g.buy} to buy`, g.print && `${g.print} to print`, g.move && `${g.move} to move between decks`, g.putIn && `${g.putIn} to put in`].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everything is in hand";
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

function ProgressTile({ row, view }: { row: Row; view: PlanView }) {
  const { deck, plan } = row;
  const steps = progressSteps(view, deck, plan);
  const inDeck = steps.filter((s) => s.step === "in").length;
  const total = steps.length;
  const pct = total ? Math.round((inDeck / total) * 100) : 0;
  const box = deck.bracket?.box ?? deck.bracket?.target ?? null;
  const next = nextStep(steps.map((s) => s.step));
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
      </span>
    </Link>
  );
}

function Thumb({ deck, view, round = false }: { deck: PlanDeck; view: PlanView; round?: boolean }) {
  const art = view.art(deck);
  const artist = view.card(deck.commander[0])?.artist;
  return <CardThumb className={`plans-thumb${round ? " round" : ""}`} src={art} title={artCredit(artist)} eager fallback={<span className={`plans-thumb${round ? " round" : ""}`} aria-hidden="true" />} />;
}

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

