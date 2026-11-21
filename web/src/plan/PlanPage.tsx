import { identityName, fmtDate } from "@yama/core";
import { PLAN_STATE_LABEL, STEP_LABEL, exportText, inForce, leftOut, opTime, versionLine, type DeckPlanState, type PlanDeck, type PlanDecisionOp } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { AskClaude } from "../advisor/AskClaude";
import { ArtPanel, artCredit } from "../components/ArtPanel";
import { useScrollToHash } from "../components/useScrollToHash";
import { BackLink, Button, ButtonLink, CopyButton, EmptyState, Pips, ShowMore, StatusPill } from "../components/ui";
import { Ideas, LinkDeck } from "./deckParts";
import { InstalledTick } from "./marks";
import { deviceId, outbox, useOutbox } from "./outbox";
import { SwapPair } from "./parts";
import { SectionTabs, type SectionTab } from "../components/SectionTabs";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { planHref, progressSteps } from "./Plans";
import type { PlanView } from "./view";
import "./plans.css";

/** Archive a plan or bring it back; the outbox keeps it until the server has it. */
function decide(userId: string, deck: PlanDeck, action: PlanDecisionOp["action"]) {
  outbox.enqueue(userId, { kind: "plan", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), deck_key: deck.key, action, version: null, keys: [], skip: [], answers: [], hash: null });
}

/**
 * `/decks/plans/:key`: one deck's plan, as one page whatever its state (design board InProgress).
 * Nobody approves a plan (20 Nov 2026): what an assistant or a plan file sends goes straight in, and
 * the page shows the plan in force and what was left out.
 */
export function PlanPage() {
  const { key = "" } = useParams();
  const { view, banner, userId } = usePlanOutlet();
  const deck = view.deck(key);
  useScrollToHash(!!deck);
  if (!deck) {
    return (
      <div className="page">
        <PlansHead title="Plans" />
        <EmptyState>There's no plan called "{key}" in your plans.</EmptyState>
        <Link to="/decks/plans">All your plans</Link>
      </div>
    );
  }
  const plan = view.planOf(deck);
  return (
    <>
      <PlanHero deck={deck} plan={plan} view={view} />
      <div className="page plans-deck-body">
        {banner}
        <Rejected deck={deck} userId={userId} />
        {plan.state === "archived" && <ArchivedBanner deck={deck} plan={plan} view={view} userId={userId} />}
        {plan.state === "waiting" && <p className="dim">This plan's changes are going in now. Reload in a moment to see them.</p>}
        {(inForce(plan) || plan.state === "archived") && <InProgress deck={deck} plan={plan} view={view} userId={userId} />}
        {plan.state === "empty" && <p className="dim">This deck's plan has no changes yet. Ask your assistant for one; it goes straight in.</p>}
        <Ideas deck={deck} view={view} />
        <LinkDeck deck={deck} />
      </div>
    </>
  );
}

function PlanHero({ deck, plan, view }: { deck: PlanDeck; plan: DeckPlanState; view: PlanView }) {
  const commander = view.card(deck.commander[0]);
  const art = view.art(deck);
  const tone = plan.state === "waiting" ? "warn" : plan.state === "in_progress" || plan.state === "done" ? "good" : "neutral";
  const line = versionLine(plan, view.b.head);
  return (
    <ArtPanel as="header" className="plan-hero" art={art} artist={commander?.artist} wash="bottom" toGround credit={false}>
      <BackLink to="/decks/plans" label="Back to plans" onArt />
      {art && <span className="plan-hero-credit">{artCredit(commander?.artist)}</span>}
      <div className="plan-hero-inner">
        <nav className="plan-crumbs" aria-label="Breadcrumb">
          <Link to="/decks/plans">Plans</Link>
        </nav>
        <span className="plan-hero-cmdr">
          <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
          <span className="visually-hidden">, {identityName(deck.color_identity ?? "")}</span>
        </span>
        <h1 className="plan-hero-title">{deck.name}</h1>
        <span className="plans-hero-meta">
          <StatusPill tone={tone}>{PLAN_STATE_LABEL[plan.state]}</StatusPill>
          {line && <span className="plans-hero-line">{line}</span>}
        </span>
      </div>
    </ArtPanel>
  );
}

/** Plan decisions the server refused, for this deck: the reason, and a way to clear it. */
function Rejected({ deck, userId }: { deck: PlanDeck; userId: string }) {
  const box = useOutbox(userId);
  const mine = box.rejected.filter((r) => r.op.kind === "plan" && r.op.deck_key === deck.key);
  if (!mine.length) return null;
  return (
    <div className="plans-rejected" role="alert">
      {mine.map((r) => (
        <p key={r.op.op_id}>
          Yama couldn't save that: {r.error}{" "}
          <Button variant="quiet" size="small" onClick={() => outbox.dismiss(userId, r.op.op_id)}>
            Dismiss
          </Button>
        </p>
      ))}
    </div>
  );
}

// ── a plan in progress ─────────────────────────────────────────────────────

function InProgress({ deck, plan, view, userId }: { deck: PlanDeck; plan: DeckPlanState; view: PlanView; userId: string }) {
  const steps = progressSteps(view, deck, plan);
  const inDeck = steps.filter((s) => s.step === "in");
  const left = steps.filter((s) => s.step !== "in");
  const total = steps.length;
  const pct = total ? Math.round((inDeck.length / total) * 100) : 0;
  const yd = deck.yama_deck;
  const box = deck.bracket?.box ?? deck.bracket?.target ?? 4;
  const bags = deck.bracket?.bags ?? {};
  const notIn = useMemo(() => leftOut(deck, view.swapsOf(deck.key), view.answers), [deck, view]);
  const swapSheet = `/decks/plans/get/swap-sheet?deck=${encodeURIComponent(deck.key)}`;
  const lists: { label: string; about: string; state: "stock" | "now" | "after" }[] = [
    { label: "The precon", about: "as it came", state: "stock" },
    { label: "The deck now", about: `${inDeck.length} changes in`, state: "now" },
    { label: "The finished deck", about: `all ${total}`, state: "after" },
  ];
  const hasBags = !!(bags["3"]?.length || bags["2"]?.length);
  // Sections, not folds (design/tokens.md, rule 4): a sticky strip of the page's sections.
  const tabs: SectionTab[] = [
    ...(left.length ? [{ id: "left-to-do", label: "Left to do", note: left.length }] : []),
    ...(inDeck.length ? [{ id: "in-the-deck", label: "In the deck", note: inDeck.length }] : []),
    ...(notIn.length ? [{ id: "left-out", label: "Left out", note: notIn.length }] : []),
    ...(hasBags ? [{ id: "brackets", label: "Brackets" }] : []),
    { id: "lists", label: "Lists" },
  ];
  const [allIn, setAllIn] = useState(false);
  const shownIn = allIn ? inDeck : inDeck.slice(0, 8);
  return (
    <>
      {plan.state !== "archived" && (
        <section className="plans-progress" aria-label="Progress">
          <div className="plans-progress-count">
            <span className="num plans-total-n">
              {inDeck.length} of {total}
            </span>
            <span>{left.length ? `changes are in the deck. ${left.length} left.` : "changes are in the deck."}</span>
          </div>
          <span className="plans-bar big" role="img" aria-label={`${inDeck.length} of ${total} in the deck`}>
            <span style={{ width: `${pct}%` }} />
          </span>
          <div className="row plans-links">
            {yd && (
              <ButtonLink variant="outline" to={`/decks/${yd.id}/scan`}>
                Scan the deck
              </ButtonLink>
            )}
            <ButtonLink variant="outline" to={`${swapSheet}&sheet=takeout`}>
              Takeout sheet
            </ButtonLink>
            <ButtonLink variant="outline" to={`/decks/plans/get/swap-cards?deck=${encodeURIComponent(deck.key)}`}>
              Print swap card
            </ButtonLink>
          </div>
        </section>
      )}

      <SectionTabs tabs={tabs} label="Plan sections" />

      <div className="plans-cols">
        <div className="plans-main">
          {plan.questions.length > 0 && plan.state !== "archived" && (
            <section className="plans-questions" aria-labelledby="plans-open">
              <h2 id="plans-open">To settle</h2>
              {plan.questions.map((q) => (
                <p key={q}>
                  <b>{q}</b>
                </p>
              ))}
              <p className="small dim">Ask your assistant: its answer goes straight into the plan.</p>
            </section>
          )}
          {left.length > 0 && (
            <section id="left-to-do" className="plans-section" aria-labelledby="plans-left">
              <h2 id="plans-left">Left to do ({left.length})</h2>
              <ul className="plans-rows">
                {left.map(({ swap: s, step, out }) => (
                  <li key={s.key} className="plans-row">
                    <SwapPair cardIn={s.in} cardOut={out} view={view} />
                    <span className="plans-row-main">
                      <span>
                        <b>{s.in}</b> {out && <span className="dim">replaces {out}</span>}
                      </span>
                      <span className="small dim">{STEP_LABEL[step]}</span>
                    </span>
                    {plan.state !== "archived" &&
                      (step === "in_hand" ? (
                        <InstalledTick swap={s} view={view} userId={userId} compact short />
                      ) : (
                        <Link className="small" to={`/decks/plans/get?deck=${encodeURIComponent(deck.key)}`}>
                          Get the cards
                        </Link>
                      ))}
                  </li>
                ))}
              </ul>
              {plan.state !== "archived" && (
                <Link to={`/decks/plans/get?deck=${encodeURIComponent(deck.key)}`}>See everything to buy and print for {deck.name}</Link>
              )}
            </section>
          )}
          {inDeck.length > 0 && (
            <section id="in-the-deck" className="plans-section" aria-labelledby="plans-in">
              <h2 id="plans-in">In the deck ({inDeck.length})</h2>
              <ul className="plans-plain plans-in-list">
                {shownIn.map(({ swap: s, out }) => (
                  <li key={s.key}>
                    <b>{s.in}</b> {out && <span className="dim">for {out}</span>}
                  </li>
                ))}
              </ul>
              {inDeck.length > shownIn.length && (
                <ShowMore className="plans-show-all" total={inDeck.length} onToggle={() => setAllIn(true)} />
              )}
            </section>
          )}
          {notIn.length > 0 && (
            <section id="left-out" className="plans-section" aria-labelledby="plans-out">
              <h2 id="plans-out">Left out ({notIn.length})</h2>
              <p className="small dim">Proposed for this deck but not in the plan. To put one in, ask your assistant.</p>
              <ul className="plans-rows">
                {notIn.map(({ swap: s, decision, note }) => {
                  const cut = view.answers.get(s.key)?.cut || s.out;
                  return (
                    <li key={s.key} className="plans-row skipped">
                      <SwapPair cardIn={s.in} cardOut={cut} view={view} dim />
                      <span className="plans-row-main">
                        <span>
                          <b>{s.in}</b> <span className="dim">{cut ? `would replace ${cut}` : "no cut named"}</span>
                        </span>
                        <span className="small dim">{note || (decision === "no" ? "You said no to it." : "You weren't sure about it.")}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {hasBags ? (
            <section id="brackets" className="plans-section" aria-labelledby="plans-box">
              <h2 id="plans-box">In the box: Bracket {box}</h2>
              <p className="small dim">The swap bags take it down.</p>
              <div className="plans-bag">
                {(["3", "2"] as const).map((k) =>
                  bags[k]?.length ? (
                    <div key={k}>
                      <h3>
                        To Bracket {k} ({bags[k]!.length === 1 ? "1 swap" : `${bags[k]!.length} swaps`})
                      </h3>
                      <ul>
                        {bags[k]!.map((x) => (
                          <li key={`${x.out}>${x.in}`}>
                            {x.out} <span className="dim">out,</span> {x.in} <span className="dim">in</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null,
                )}
              </div>
            </section>
          ) : null}
        </div>

        <aside id="lists" className="plans-side plans-section" aria-label="Lists and tools">
          <h2>Copy a list</h2>
          {lists.map((l) => {
            const cards = deck.states[l.state]?.cards;
            return cards?.length ? <CopyButton key={l.state} variant="outline" className="plans-wide-button" text={exportText(cards)} label={`${l.label}, ${l.about}`} /> : null;
          })}
          <h2>Test it</h2>
          <p className="small dim">Play the precon against the finished deck in the Lab.</p>
          <ButtonLink variant="outline" className="plans-wide-button" to={deck.deck_id ? `/lab/try?deck=${encodeURIComponent(deck.deck_id)}` : "/lab/try"}>
            Open in the Lab
          </ButtonLink>
          {plan.state !== "archived" && (
            <>
              <p className="small dim">To change this plan, ask your assistant. Its changes go straight in.</p>
              <AskClaude context={{ kind: "plan_deck", ref: deck.key }} about={`the ${deck.name} plan`} ideasFor={deck.key} />
              <Button variant="outline" className="plans-wide-button" onClick={() => decide(userId, deck, "archive")}>
                Archive this plan
              </Button>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function ArchivedBanner({ deck, plan, view, userId }: { deck: PlanDeck; plan: DeckPlanState; view: PlanView; userId: string }) {
  const byFile = deck.status === "archived" && !plan.archived_at;
  const earlier = (view.b.versions ?? []).filter((v) => v.deck === deck.key);
  const current = view.b.decks.find((d) => d.key !== deck.key && d.name.trim().toLowerCase() === deck.name.trim().toLowerCase() && view.planOf(d).state !== "archived");
  return (
    <section className="plans-archived-banner" aria-label="Archived">
      <StatusPill>Archived</StatusPill>
      <p>
        {byFile ? "The latest plan file doesn't have this deck." : plan.archived_note === "Archived by you" || !plan.archived_note ? "You archived this plan." : `${plan.archived_note}.`}
        {plan.archived_at ? ` Archived ${fmtDate(plan.archived_at)}.` : ""} Nothing in it is on your shopping list.
      </p>
      <div className="row">
        {current ? (
          <ButtonLink to={planHref(current.key)}>
            Go to its current plan
          </ButtonLink>
        ) : (
          <ButtonLink to="/decks/plans">
            Go to Plans
          </ButtonLink>
        )}
        {!byFile && !current && (
          <Button variant="outline" onClick={() => decide(userId, deck, "restore")}>
            Bring it back
          </Button>
        )}
      </div>
      {earlier.length > 0 && (
        <p className="small dim">
          Versions: {earlier.map((v) => `${v.n} (${v.status === "approved" ? "" : "not taken, "}${fmtDate(v.decided_at)})`).join(", ")}
        </p>
      )}
    </section>
  );
}
