import { useMemo, type ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { useMe } from "../auth";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView } from "../plan/view";
import "./deck-area.css";

/** The Decks tab's sections, in order. Adding a section is one line here. */
export const DECK_SECTIONS: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks", label: "Decks", end: true },
  { to: "/decks/plan", label: "Plans" },
  { to: "/decks/research", label: "Research" },
  { to: "/decks/lab", label: "Lab" },
];

/** Proposals with no answer yet, over the plans that aren't archived (the Plans badge). */
function useToReview(): number {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  const box = useOutbox(userId);
  return useMemo(() => {
    if (!plan.bundle || !userId) return 0;
    const view = planView(plan.bundle, outbox.localOps(userId));
    const active = new Set(view.b.decks.filter((d) => d.status !== "archived").map((d) => d.key));
    return view.b.swaps.filter((s) => !s.retired && s.stage === "proposed" && active.has(s.deck) && !view.answers.get(s.key)?.decision).length;
    // `box` changes when a tap lands in the outbox, so the count follows answers made here.
  }, [plan.bundle, box, userId]);
}

/** The segmented control at the top of the Decks tab: the Decks list, the plan pages and the lab
 *  pages all show it. Drawn as the shared .segmented pill (styles.css). Plans carries a count of
 *  proposals still waiting for an answer. */
export function DeckTabs() {
  const toReview = useToReview();
  return (
    <nav className="segmented deck-sections" aria-label="Decks sections">
      {DECK_SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end}>
          {s.label}
          {s.to === "/decks/plan" && toReview > 0 && (
            <span className="deck-tab-badge num">
              <span className="visually-hidden">, </span>
              {toReview}
              <span className="visually-hidden"> to review</span>
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Chevron() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

/** A round back button (44 px), for phone sub-pages and the art heroes. With `text`, laptops
 *  show the words beside the chevron. */
export function BackButton({ to, label, text, className = "" }: { to: string; label: string; text?: string; className?: string }) {
  return (
    <Link to={to} className={`area-back${text ? " has-text" : ""} ${className}`.trim()} aria-label={label}>
      <Chevron />
      {text && <span className="area-back-text">{text}</span>}
    </Link>
  );
}

/** An underlined row of section pages (Overview, Review... or Precons, Try a change...). */
export function SubNav({ label, pages, also }: { label: string; pages: { to: string; label: string; end?: boolean; also?: string }[]; also?: string }) {
  return (
    <nav className="area-subnav" aria-label={label}>
      {pages.map((p) => (
        <NavLink
          key={p.to}
          to={p.to}
          end={p.end}
          className={({ isActive }) => (isActive || (p.also && also?.startsWith(p.also)) ? "active" : "")}
        >
          {p.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The head of a Decks-tab page (design: DeckList, Lab, PlanOverview, Buy...).
 *
 * - Laptop: the page title on the left; Decks | Plans | Lab and the page's action on the right;
 *   the section's sub-nav underneath.
 * - Phone, a section's front page (`index`): "Decks" and the action, the control full width, the
 *   sub-nav. Phone, any other page: a back button and the page title (and `status`), nothing else.
 * - `slim`: no title of its own (the page has an art hero or its own heading); laptops keep the
 *   control and sub-nav, phones keep the back button.
 */
export function AreaHead({
  title,
  index = false,
  slim = false,
  back,
  action,
  nav,
  status,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
  nav?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <header className={`area-head ${index ? "is-index" : "is-sub"}${slim ? " is-slim" : ""}`}>
      <div className="area-top">
        {back && !index && <BackButton to={back.to} label={back.label} />}
        {!slim && (
          <h1 className="area-title">
            {index ? (
              <>
                <span className="area-wide">{title}</span>
                <span className="area-phone">Decks</span>
              </>
            ) : (
              title
            )}
          </h1>
        )}
        {status && <div className="area-status">{status}</div>}
        <DeckTabs />
        {action && <div className="area-action">{action}</div>}
      </div>
      {nav}
    </header>
  );
}
