import { identityName } from "@yama/core";
import {
  KIND_ORDER,
  KIND_TITLE,
  PLAN_STATE_LABEL,
  STEP_LABEL,
  countChanges,
  exportText,
  fmtDate,
  inForce,
  opTime,
  planChange,
  proposalBuild,
  versionLine,
  waitingSwaps,
  type DeckPlanState,
  type PlanChange,
  type PlanDeck,
  type PlanDecisionOp,
} from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { AskClaude } from "../advisor/AskClaude";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { BackButton } from "../components/DeckTabs";
import { useScrollToHash } from "../components/useScrollToHash";
import { Pips } from "../components/ui";
import { Ideas, LinkDeck } from "./deckParts";
import { InstalledTick } from "./marks";
import { deviceId, outbox, useOutbox } from "./outbox";
import { CopyButton, Thumb } from "./parts";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { planHref, progressSteps } from "./Plans";
import type { PlanView } from "./view";
import "./plans.css";

const money = (n: number) => `$${n.toFixed(2)}`;
const changesWord = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** Send a whole-plan decision; the outbox keeps it until the server has it. */
function decide(userId: string, deck: PlanDeck, action: PlanDecisionOp["action"], version: number | null, keys: string[] = [], skip: string[] = [], answers: PlanDecisionOp["answers"] = []) {
  outbox.enqueue(userId, { kind: "plan", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), deck_key: deck.key, action, version, keys, skip, answers });
}

/** `/decks/plans/:key`: one deck's plan, as one page whatever its state (design boards ProposedPlan, InProgress, NewVersion). */
export function PlanPage() {
  const { key = "" } = useParams();
  const { view, banner, userId } = usePlanOutlet();
  const deck = view.deck(key);
  useScrollToHash(!!deck);
  if (!deck) {
    return (
      <div className="page">
        <PlansHead title="Plans" />
        <p className="empty">There's no plan called "{key}" in your plans.</p>
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
        {plan.state === "waiting" && plan.next && <Approve key={`${deck.key}/${plan.next.n}`} deck={deck} plan={plan} view={view} userId={userId} first />}
        {(inForce(plan) || plan.state === "archived") && <InProgress deck={deck} plan={plan} view={view} userId={userId} />}
        {plan.state === "empty" && <p className="dim">This deck's plan has no changes yet. Ask your assistant for one; it waits here for your OK.</p>}
        <Ideas deck={deck} view={view} />
        <LinkDeck deck={deck} />
      </div>
    </>
  );
}

function PlanHero({ deck, plan, view }: { deck: PlanDeck; plan: DeckPlanState; view: PlanView }) {
  const commander = view.card(deck.commander[0]);
  const art = view.art(deck);
  const tone = plan.state === "waiting" ? "warn" : plan.state === "in_progress" || plan.state === "done" ? "good" : "plain";
  const line = versionLine(plan, view.b.head);
  return (
    <ArtPanel as="header" className="plan-hero" art={art} artist={commander?.artist} wash="bottom" toGround credit={false}>
      <BackButton to="/decks/plans" label="Back to plans" className="on-art" />
      {art && <span className="plan-hero-credit">{artCredit(commander?.artist)}</span>}
      <div className="plan-hero-inner">
        <nav className="plan-crumbs" aria-label="Breadcrumb">
          <Link to="/decks">Decks</Link>
          <span aria-hidden="true">/</span>
          <Link to="/decks/plans">Plans</Link>
        </nav>
        <span className="plan-hero-cmdr">
          <Pips identity={deck.color_identity ?? ""} /> {deck.commander.join(" and ")}
          <span className="visually-hidden">, {identityName(deck.color_identity ?? "")}</span>
        </span>
        <h1 className="plan-hero-title">{deck.name}</h1>
        <span className="plans-hero-meta">
          <span className={`tag ${tone}`}>{PLAN_STATE_LABEL[plan.state]}</span>
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
          <button className="quiet small" onClick={() => outbox.dismiss(userId, r.op.op_id)}>
            Dismiss
          </button>
        </p>
      ))}
    </div>
  );
}

// ── approving a version ────────────────────────────────────────────────────

/**
 * A version waiting for your OK: skip any change, answer the open questions, then approve the
 * whole version. `first`: the deck's first version (no plan in progress yet).
 */
function Approve({ deck, plan, view, userId, first = false }: { deck: PlanDeck; plan: DeckPlanState; view: PlanView; userId: string; first?: boolean }) {
  const next = plan.next!;
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set(next.skipped));
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [bracket, setBracket] = useState<4 | 3 | 2>(4);
  const swaps = useMemo(() => waitingSwaps(plan, view.swapsOf(deck.key)), [plan, view, deck.key]);
  const changes = useMemo(() => swaps.map((s) => planChange(s, view.b, view.deckName)), [swaps, view]);
  const live = changes.filter((c) => !skipped.has(c.swap.key));
  const counts = countChanges(live);
  const open = plan.questions.filter((q) => !answers[q]?.trim());
  const toggle = (k: string) =>
    setSkipped((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const approve = () =>
    decide(
      userId,
      deck,
      "approve",
      next.n,
      live.map((c) => c.swap.key),
      changes.filter((c) => skipped.has(c.swap.key)).map((c) => c.swap.key),
      plan.questions.map((q) => ({ question: q, answer: answers[q]!.trim() })),
    );
  const bags = deck.bracket?.bags ?? {};
  const gcs = deck.bracket?.game_changers ?? null;
  const stock = deck.states.after?.cards ?? deck.states.stock?.cards ?? [];
  const keptAnswers = useMemo(() => {
    const m = new Map(view.answers);
    for (const c of changes) m.set(c.swap.key, { decision: skipped.has(c.swap.key) ? "no" : "want", note: null, cut: null, deck: null, card: null, at: "", origin: "yama" });
    return m;
  }, [changes, skipped, view.answers]);
  const b4 = useMemo(() => proposalBuild(stock, swaps, keptAnswers, deck.groups).cards, [stock, swaps, keptAnswers, deck.groups]);
  const priceNote = counts.buy
    ? counts.buyUsd != null
      ? `Prices ${counts.stores.filter((s) => s !== "market").length ? `at ${counts.stores.filter((s) => s !== "market").join(" and ")}` : ""}${counts.stores.includes("market") ? `${counts.stores.length > 1 ? ", or " : ""}TCGplayer market via Scryfall` : ""}${counts.pricedOn ? `, checked ${fmtDate(counts.pricedOn)}` : ""}, before tax.${counts.buyUnpriced ? ` ${counts.buyUnpriced} without a price count toward no total.` : ""}`
      : "None of the cards to buy has a price yet."
    : null;
  const artists = changes.map((c) => view.card(c.swap.in)?.artist);

  return (
    <section id="new-version" className="plans-approve" aria-labelledby="plans-approve-head">
      <div className="plans-cols">
        <div className="plans-main">
          {!first && (
            <div className="plans-version-head">
              <span className="tag warn">Waiting for your OK</span>
              <h2 id="plans-approve-head">
                Version {next.n} adds {changesWord(changes.length)}
              </h2>
              <p className="dim">
                The {changesWord(plan.changes)} already in version {plan.version} stay as they are. Until you approve, you keep working on version {plan.version}.
              </p>
            </div>
          )}
          {first && <h2 id="plans-approve-head" className="visually-hidden">Approve this plan</h2>}

          {plan.questions.length > 0 && (
            <section className="plans-questions" aria-labelledby="plans-q">
              <h3 id="plans-q">{open.length ? (open.length === 1 ? "1 question before you approve" : `${open.length} questions before you approve`) : "Your answers"}</h3>
              {plan.questions.map((q) => (
                <label key={q} className="plans-question">
                  <b>{q}</b>
                  <textarea rows={2} value={answers[q] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q]: e.target.value }))} placeholder="Your answer" maxLength={2000} />
                </label>
              ))}
              <p className="small dim">Your answers are saved with the plan and go to your assistant.</p>
            </section>
          )}

          <section aria-labelledby="plans-changes">
            <div className="plans-changes-head">
              <h3 id="plans-changes">The changes</h3>
              {(bags["3"]?.length || bags["2"]?.length) ? (
                <div className="segmented plans-brackets" role="group" aria-label="Bracket">
                  {([4, 3, 2] as const).map((n) => (
                    <button key={n} type="button" aria-pressed={bracket === n} onClick={() => setBracket(n)}>
                      Bracket {n}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {bracket === 4 && (
              <>
                {gcs?.["4"]?.length ? <p className="small dim">Game Changers: {gcs["4"].join(", ")}.</p> : null}
                {KIND_ORDER.map((k) => {
                  const rows = changes.filter((c) => c.kind === k);
                  if (!rows.length) return null;
                  const kept = rows.filter((c) => !skipped.has(c.swap.key));
                  const total = kept.filter((c) => c.price).reduce((t, c) => t + c.price!.usd, 0);
                  const note =
                    k === "have" ? "In your collection, not in a deck" : k === "move" ? "Moved when you put this deck together" : k === "buy" ? (kept.some((c) => c.price) ? `${money(total)} listed` : "No prices yet") : "Goes on your next print order";
                  return (
                    <div key={k} className="plans-group">
                      <div className="plans-group-head">
                        <h4>
                          {KIND_TITLE[k]} ({rows.length})
                        </h4>
                        <span className="small dim">{note}</span>
                      </div>
                      <ul className="plans-rows">
                        {rows.map((c) => (
                          <ChangeRow key={c.swap.key} change={c} view={view} skipped={skipped.has(c.swap.key)} onToggle={() => toggle(c.swap.key)} />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </>
            )}
            {bracket !== 4 && <BagView deck={deck} bracket={bracket} />}
          </section>

          {(deck.bracket?.keep_note || deck.bracket?.callouts?.length) && (
            <details className="plans-details">
              <summary>How it plays at Bracket 4</summary>
              {deck.bracket?.keep_note && <p>{deck.bracket.keep_note}</p>}
              {deck.bracket?.callouts?.map((c) => <p key={c}>{c}</p>)}
            </details>
          )}
          <div className="row plans-links">
            {stock.length > 0 && <CopyButton className="outline" text={exportText(b4)} label="Copy the Bracket 4 list" />}
            <AskClaude context={{ kind: "plan_deck", ref: deck.key }} about={`the ${deck.name} plan`} ideasFor={deck.key} />
          </div>
          {artists.some(Boolean) && <p className="small dim art-credits">Card images from Scryfall. {artCredits(artists)}</p>}
        </div>

        <aside className="plans-side" aria-label="Approve">
          {first ? (
            <div className="plans-total">
              <span className="num plans-total-n">{live.length}</span>
              <span>{skipped.size ? `changes, ${skipped.size} skipped` : "changes"}</span>
            </div>
          ) : (
            <h3>
              Version {plan.version} against {next.n}
            </h3>
          )}
          <dl className="plans-figures">
            {!first && (
              <div>
                <dt>Changes</dt>
                <dd>
                  {plan.changes} to {plan.changes + live.length}
                </dd>
              </div>
            )}
            <div>
              <dt>You have it</dt>
              <dd>{counts.have}</dd>
            </div>
            <div>
              <dt>From other decks</dt>
              <dd>{counts.move}</dd>
            </div>
            <div>
              <dt>To buy</dt>
              <dd>
                {counts.buy}
                {counts.buyUsd != null ? `, ${money(counts.buyUsd)}` : ""}
              </dd>
            </div>
            <div>
              <dt>To print</dt>
              <dd>{counts.print}</dd>
            </div>
          </dl>
          {priceNote && <p className="small dim">{priceNote}</p>}
          <p className="small">Approving puts the buys on your shopping list and the prints on your next print order. Nothing is bought until you mark it.</p>
          {open.length === 0 && live.length > 0 ? (
            <button className="primary plans-big-button" onClick={approve}>
              {first ? "Approve plan" : `Approve version ${next.n}`}
            </button>
          ) : (
            <button className="primary plans-big-button" disabled>
              {live.length === 0 ? "Every change is skipped" : open.length === 1 ? "Answer the question first" : `Answer ${open.length} questions first`}
            </button>
          )}
          {first ? (
            <button className="outline plans-wide-button" onClick={() => decide(userId, deck, "archive", null)}>
              Not now: archive this plan
            </button>
          ) : (
            <button className="outline plans-wide-button" onClick={() => decide(userId, deck, "keep", next.n)}>
              Keep version {plan.version}
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}

function ChangeRow({ change, view, skipped, onToggle }: { change: PlanChange; view: PlanView; skipped: boolean; onToggle: () => void }) {
  const s = change.swap;
  const meta =
    change.kind === "buy"
      ? change.price
        ? `${money(change.price.usd)}${change.price.store ? ` at ${change.price.store}` : " market"}`
        : "No price yet"
      : change.kind === "move"
        ? `From ${change.from}`
        : change.kind === "print"
          ? "Print"
          : "";
  return (
    <li className={`plans-row${skipped ? " skipped" : ""}`}>
      <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} dim={skipped} />
      <span className="plans-row-main">
        <span>
          <b>{s.in}</b> {s.out ? <span className="dim">for {s.out}</span> : <span className="dim">added</span>}
          {skipped && <span className="tag small plain plans-skip-pill">Skipped</span>}
        </span>
        {s.why && <span className="small plans-why">{s.why}</span>}
      </span>
      <span className="small dim plans-row-meta">{meta}</span>
      <button type="button" className="outline small plans-skip" onClick={onToggle} aria-label={`${skipped ? "Undo skipping" : "Skip"} ${s.in}`}>
        {skipped ? "Undo" : "Skip"}
      </button>
    </li>
  );
}

/** A swap bag: from the bracket above, what comes out and what goes back in. */
function BagView({ deck, bracket }: { deck: PlanDeck; bracket: 3 | 2 }) {
  const bag = deck.bracket?.bags?.[String(bracket)] ?? [];
  const gcs = deck.bracket?.game_changers?.[String(bracket)];
  return (
    <>
      <p className="small dim">
        From Bracket {bracket + 1}, swap {bag.length === 1 ? "this 1" : `these ${bag.length}`} back.
        {gcs ? (gcs.length ? ` Game Changers left: ${gcs.join(", ")}.` : " No Game Changers.") : ""}
      </p>
      <div className="plans-bag">
        <div>
          <h4>Take out</h4>
          <ul>{bag.map((x) => <li key={`o${x.out}`}>{x.out}</li>)}</ul>
        </div>
        <div>
          <h4>Put back in</h4>
          <ul>{bag.map((x) => <li key={`i${x.in}`}>{x.in}</li>)}</ul>
        </div>
      </div>
    </>
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
  const newest = (view.b.versions ?? []).find((v) => v.deck === deck.key);
  const swapSheet = `/decks/plan/prints/swap?deck=${encodeURIComponent(deck.key)}`;
  const lists: { label: string; about: string; state: "stock" | "now" | "after" }[] = [
    { label: "The precon", about: "as it came", state: "stock" },
    { label: "The deck now", about: `${inDeck.length} changes in`, state: "now" },
    { label: "The finished deck", about: `all ${total}`, state: "after" },
  ];
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
              <Link className="button outline" to={`/decks/${yd.id}/scan`}>
                Scan the deck
              </Link>
            )}
            <Link className="button outline" to={`${swapSheet}&sheet=takeout`}>
              Takeout sheet
            </Link>
            <Link className="button outline" to={`/decks/plan/swap-cards?deck=${encodeURIComponent(deck.key)}`}>
              Print swap card
            </Link>
          </div>
          {newest && !plan.next && (
            <p className="small dim">
              {newest.status === "approved" ? `You approved version ${newest.n}` : `You kept version ${newest.n - 1}`} on {fmtDate(newest.decided_at)}.{" "}
              <button className="link-button" onClick={() => decide(userId, deck, "undo", newest.n)}>
                Undo
              </button>
            </p>
          )}
        </section>
      )}

      {plan.next && plan.state !== "archived" && <Approve key={`${deck.key}/${plan.next.n}`} deck={deck} plan={plan} view={view} userId={userId} />}

      <div className="plans-cols">
        <div className="plans-main">
          {plan.questions.length > 0 && !plan.next && (
            <section className="plans-questions" aria-labelledby="plans-open">
              <h2 id="plans-open">To settle</h2>
              {plan.questions.map((q) => (
                <p key={q}>
                  <b>{q}</b>
                </p>
              ))}
              <p className="small dim">Ask your assistant: its answer comes back as a new version, waiting for your OK.</p>
            </section>
          )}
          {left.length > 0 && (
            <section aria-labelledby="plans-left">
              <h2 id="plans-left">Left to do ({left.length})</h2>
              <ul className="plans-rows">
                {left.map(({ swap: s, step }) => (
                  <li key={s.key} className="plans-row">
                    <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} />
                    <span className="plans-row-main">
                      <span>
                        <b>{s.in}</b> {s.out ? <span className="dim">for {s.out}</span> : null}
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
            <details className="plans-details">
              <summary>
                <b>In the deck ({inDeck.length})</b> <span className="small dim">Each beside the card it replaced.</span>
              </summary>
              <ul className="plans-plain">
                {inDeck.map(({ swap: s }) => (
                  <li key={s.key}>
                    <b>{s.in}</b> {s.out && <span className="dim">for {s.out}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {(bags["3"]?.length || bags["2"]?.length) ? (
            <section aria-labelledby="plans-box">
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

        <aside className="plans-side" aria-label="Lists and tools">
          <h2>Copy a list</h2>
          {lists.map((l) => {
            const cards = deck.states[l.state]?.cards;
            return cards?.length ? <CopyButton key={l.state} className="outline plans-wide-button" text={exportText(cards)} label={`${l.label}, ${l.about}`} /> : null;
          })}
          <h2>Test it</h2>
          <p className="small dim">Play the precon against the finished deck in the Lab.</p>
          <Link className="button outline plans-wide-button" to={deck.deck_id ? `/lab/try?deck=${encodeURIComponent(deck.deck_id)}` : "/lab/try"}>
            Open in the Lab
          </Link>
          {plan.state !== "archived" && (
            <>
              <p className="small dim">To change this plan, ask your assistant. Its new version waits for your OK on Plans.</p>
              <AskClaude context={{ kind: "plan_deck", ref: deck.key }} about={`the ${deck.name} plan`} ideasFor={deck.key} />
              <button className="outline plans-wide-button" onClick={() => decide(userId, deck, "archive", null)}>
                Archive this plan
              </button>
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
      <span className="tag plain">Archived</span>
      <p>
        {byFile ? "The latest plan file doesn't have this deck." : plan.archived_note === "Archived by you" || !plan.archived_note ? "You archived this plan." : `${plan.archived_note}.`}
        {plan.archived_at ? ` Archived ${fmtDate(plan.archived_at)}.` : ""} Nothing in it is on your shopping list.
      </p>
      <div className="row">
        {current ? (
          <Link className="button" to={planHref(current.key)}>
            Go to its current plan
          </Link>
        ) : (
          <Link className="button" to="/decks/plans">
            Go to Plans
          </Link>
        )}
        {!byFile && !current && (
          <button className="outline" onClick={() => decide(userId, deck, "restore", null)}>
            Bring it back
          </button>
        )}
      </div>
      {earlier.length > 0 && (
        <p className="small dim">
          Versions: {earlier.map((v) => `${v.n} (${v.status === "approved" ? "approved" : "not approved"} ${fmtDate(v.decided_at)})`).join(", ")}
        </p>
      )}
    </section>
  );
}
