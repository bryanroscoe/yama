// Section tabs (design/tokens.md, "Density, actions and page structure", rule 4;
// design/system/components/SectionTabs): a sticky strip of a long page's 3-5 sections, so you jump
// between them instead of scrolling through stacked disclosures. These are jump links to sections
// that all stay open; the one in view is marked current.
import { useEffect, useState } from "react";

export interface SectionTab {
  /** The section element's id. */
  id: string;
  label: string;
  /** A count or a short state beside the label. */
  note?: string | number | null;
}

export function SectionTabs({ tabs, label = "Sections" }: { tabs: SectionTab[]; label?: string }) {
  const [current, setCurrent] = useState(tabs[0]?.id ?? "");
  const ids = tabs.map((t) => t.id).join(" ");

  // The current tab follows the section nearest the top of the screen, under the strip.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = els.find((el) => seen.get(el.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: "-64px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);

  if (tabs.length < 2) return null;
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((t) => (
        <a key={t.id} href={`#${t.id}`} aria-current={current === t.id ? "true" : undefined} onClick={() => setCurrent(t.id)}>
          {t.label}
          {t.note != null && t.note !== "" && <span>{t.note}</span>}
        </a>
      ))}
    </nav>
  );
}
