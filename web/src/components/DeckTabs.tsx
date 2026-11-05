import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useMe } from "../auth";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView } from "../plan/view";
import "./deck-area.css";

/** The Decks tab's sections, in order. Adding a section is one line here. The Lab has its own
 *  tab since 2026-10-28; Research is labelled as what it is, notes agents keep for themselves. */
/** `also`: pages that belong to a section without sitting under its path (adding a deck and
 *  suggested changes are part of the Decks list), so the section stays lit there. */
export const DECK_SECTIONS: { to: string; label: string; end?: boolean; also?: string[] }[] = [
  { to: "/decks", label: "Decks", end: true, also: ["/decks/import", "/decks/changes"] },
  { to: "/sharing", label: "Sharing" },
  { to: "/decks/builds", label: "Builds" },
  { to: "/decks/plan", label: "Plans" },
  { to: "/decks/research", label: "Agent notes" },
  { to: "/decks/datasets", label: "Datasets" },
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

/** The segmented control at the top of the Decks tab: the Decks list, the plan pages and the
 *  agent notes all show it. Drawn as the shared .segmented pill (styles.css). Plans carries a count of
 *  proposals still waiting for an answer. */
/** On a phone the sections run past the screen's edge: bring the chosen one into view and mark
 *  which ends have more (`data-more`), so the track fades there instead of cutting a word off. */
function useScrollHint<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && el.scrollWidth > el.clientWidth) {
      const a = active.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      el.scrollLeft += a.left - e.left - (e.width - a.width) / 2;
    }
    const update = () => {
      const more = [el.scrollLeft > 1 && "start", el.scrollLeft + el.clientWidth < el.scrollWidth - 1 && "end"].filter(Boolean).join(" ");
      if (more) el.dataset.more = more;
      else delete el.dataset.more;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resize?.disconnect();
    };
  }, [pathname, content]);
  return ref;
}

export function DeckTabs() {
  const toReview = useToReview();
  const { pathname } = useLocation();
  // The Plans count arrives after load and widens the track: measure again when it does.
  const track = useScrollHint<HTMLElement>(toReview);
  return (
    <nav ref={track} className="segmented deck-sections" aria-label="Decks sections">
      {DECK_SECTIONS.map((s) => {
        const label = (
          <>
            {s.label}
            {s.to === "/decks/plan" && toReview > 0 && (
              <span className="deck-tab-badge num">
                <span className="visually-hidden">, </span>
                {toReview}
                <span className="visually-hidden"> to review</span>
              </span>
            )}
          </>
        );
        // NavLink marks only its own path current, so a page that belongs here from elsewhere
        // is marked by hand (as SubNav does).
        return s.also?.includes(pathname) ? (
          <Link key={s.to} to={s.to} className="active" aria-current="page">
            {label}
          </Link>
        ) : (
          <NavLink key={s.to} to={s.to} end={s.end}>
            {label}
          </NavLink>
        );
      })}
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

/** An underlined row of section pages (Overview, Review... or the Lab's Precons, Try a change...). */
export function SubNav({ label, pages, also }: { label: string; pages: { to: string; label: string; end?: boolean; also?: string }[]; also?: string }) {
  return (
    <nav className="area-subnav" aria-label={label}>
      {pages.map((p) =>
        // A page that belongs under another (Swap cards under Overview) marks it current for
        // screen readers too, which NavLink only does for its own path.
        p.also && also?.startsWith(p.also) ? (
          <Link key={p.to} to={p.to} className="active" aria-current="page">
            {p.label}
          </Link>
        ) : (
          <NavLink key={p.to} to={p.to} end={p.end} className={({ isActive }) => (isActive ? "active" : "")}>
            {p.label}
          </NavLink>
        ),
      )}
    </nav>
  );
}

/**
 * The head of a Decks-tab page (design: DeckList, Lab, PlanOverview, Buy...).
 *
 * - Laptop: the page title on the left; Decks | Plans | Agent notes and the page's action on the right;
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
  area = "Decks",
  sections = <DeckTabs />,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
  nav?: ReactNode;
  status?: ReactNode;
  /** The tab this page belongs to, the phone title of its front page. */
  area?: string;
  /** The tab's own sections control (Decks | Plans | Agent notes); null for a tab without one. */
  sections?: ReactNode;
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
                <span className="area-phone">{area}</span>
              </>
            ) : (
              title
            )}
          </h1>
        )}
        {status && <div className="area-status">{status}</div>}
        {sections}
        {action && <div className="area-action">{action}</div>}
      </div>
      {nav}
    </header>
  );
}
