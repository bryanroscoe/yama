// The strip of a tab's pages, under the frame and above the page (nav.tsx has the table). It
// shows on the tab's own pages and the pages under them (a run, a saved game), and not on a deck's
// or a plan deck's own page, which has its own way back.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link, useLocation } from "react-router";
import { publicOrigin } from "../api";
import { useMe } from "../auth";
import { datasets } from "../datasets/api";
import { holdsPath, sectionOf, sectionsFor, tabOf, type Who } from "../nav";
import { AlphaTag } from "./AlphaTag";

/**
 * The count of plans waiting for an answer. It reads the plan store, so its code loads when the
 * Workshop's strip first shows, and by hand rather than with React.lazy: the strip is part of the
 * frame, outside every page's error boundary, so code that didn't arrive (no connection) must
 * show nothing instead of taking the app down. Opening the Workshop again asks again.
 */
function PlansCount() {
  const [Badge, setBadge] = useState<ComponentType | null>(null);
  useEffect(() => {
    let here = true;
    import("./PlansBadge").then(
      (m) => here && setBadge(() => m.default),
      () => undefined,
    );
    return () => {
      here = false;
    };
  }, []);
  return Badge ? <Badge /> : null;
}

/** Who is looking, for the sections to list. `evidence` asks for the account's datasets, so only
 *  the Workshop's strip asks (the Datasets page shares the query). */
export function useWho(evidence = false): Who {
  const me = useMe().data;
  // An admin may upload a dataset, so always has the page; not while viewing as someone.
  const admin = !!me?.is_admin && !me.viewing;
  const list = useQuery({ queryKey: ["datasets", me?.id], queryFn: datasets, enabled: evidence && !!me && !admin, staleTime: 5 * 60_000 });
  return { signedIn: !!me, power: me?.power === true, evidence: admin || !!list.data?.length };
}

/** On a phone the strip can run past the screen's edge: bring the current page's entry into view
 *  and mark which ends have more (`data-more`), so the row fades there instead of cutting a word off. */
function useScrollHint<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>("a.active");
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

export function TabSections() {
  const { pathname } = useLocation();
  const t = tabOf(pathname);
  const asked = useWho(t?.id === "workshop");
  // The Datasets page lists itself while open, even for an account the strip would leave it out
  // for, and before the account's datasets have answered: the strip doesn't come and go there.
  const who = { ...asked, evidence: asked.evidence || holdsPath(pathname, "/lab/datasets") };
  const sections = t ? sectionsFor(t, who) : [];
  const current = t ? sectionOf(t, pathname, who) : null;
  const shown = sections.length > 1 && !!current;
  const track = useScrollHint<HTMLElement>(shown ? sections.length : 0);
  if (!t || !shown) return null;
  return (
    <nav ref={track} className="tab-sections" aria-label={`${t.label} pages`}>
      {sections.map((s) =>
        s.page ? (
          <a key={s.to} href={`${publicOrigin()}${s.to}`}>{s.label}</a>
        ) : (
          // Only the entry's own address is "the page"; on a page under it (a run) it is the place.
          <Link key={s.to} to={s.to} className={s === current ? "active" : undefined} aria-current={s === current ? (pathname.replace(/\/+$/, "") === s.to ? "page" : "true") : undefined}>
            {s.label}
            {s.alpha && <AlphaTag />}
            {s.to === "/decks/plans" && who.signedIn && <PlansCount />}
          </Link>
        ),
      )}
    </nav>
  );
}
