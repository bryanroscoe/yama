import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import "./deck-area.css";
import { BackLink } from "./BackLink";

/** An underlined row of an area's pages (the admin area's). A tab's own pages are listed by the
 *  frame instead (TabSections, from nav.tsx). */
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
 * The head of a page in the Decks, Workshop or You tabs. The tab's pages are listed by the frame
 * above it (TabSections), so the head is the title and the page's own action.
 *
 * - Laptop: the page title on the left, the page's action on the right.
 * - Phone, a section's front page (`index`): its name and the action. Phone, any other page: a
 *   back button and the page title (and `status`), nothing else.
 * - `slim`: no title of its own (the page has an art hero or its own heading); phones keep the
 *   back button.
 */
export function AreaHead({
  title,
  index = false,
  slim = false,
  back,
  action,
  status,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <header className={`area-head ${index ? "is-index" : "is-sub"}${slim ? " is-slim" : ""}${!index && !back ? " no-back" : ""}`}>
      <div className="area-top">
        {back && !index && <BackLink to={back.to} label={back.label} />}
        {!slim && <h1 className="area-title">{title}</h1>}
        {status && <div className="area-status">{status}</div>}
        {action && <div className="area-action">{action}</div>}
      </div>
    </header>
  );
}
