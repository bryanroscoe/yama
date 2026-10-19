import { laterOutText, spares, type Spare, type SpareUse } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { usePlanOutlet } from "./PlanLayout";
import { Thumb } from "./parts";
import type { PlanView } from "./view";

const USE_WHEN: Record<SpareUse["when"], string> = {
  now: "Now in",
  after: "Goes to",
  waiting: "Waiting to move to",
  proposed: "Proposed for",
};

const DECISION: Record<string, string> = { want: "you want it", unsure: "you're unsure" };

/** `/decks/plan/spares`: every card the plans take out, before buying or printing anything. */
export function Spares() {
  const { view } = usePlanOutlet();
  const sp = useMemo(() => spares(view.b, view.answers), [view]);
  const [params, setParams] = useSearchParams();
  const freeOnly = params.get("free") === "1";
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const show = (list: Spare[]) =>
    list.filter((s) => (!freeOnly || s.free) && words.every((w) => `${s.card}\n${s.from.name}\n${s.why}`.toLowerCase().includes(w)));
  const sections: { id: string; title: string; about: string; list: Spare[] }[] = [
    { id: "now", title: "Out of a deck now", about: "Their replacement is in hand: bought, moved in, a stand-in, or a basic holding a print's slot.", list: sp.now },
    { id: "after", title: "Free when your prints arrive", about: "Stand-ins leaving, and cards whose replacement waits for a print or for another deck to free it.", list: sp.after },
    { id: "extras", title: "Bought with no slot", about: "Bought for a deck that the plan has no slot for.", list: sp.extras },
  ];
  return (
    <>
      <div className="page-head">
        <h1>Spares</h1>
      </div>
      <p className="small">
        Check here before buying or printing a card: a spare can fill another deck's slot for free. Read from your now and after-prints lists, so a card
        counts as out only when its list says so.
      </p>
      <div className="row plan-spares-tools">
        <input
          type="search"
          className="plan-search"
          value={query}
          placeholder="Search cards, decks and reasons"
          aria-label="Search spares"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="plan-check">
          <input
            type="checkbox"
            checked={freeOnly}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.checked) next.set("free", "1");
              else next.delete("free");
              setParams(next, { replace: true });
            }}
          />
          Only spares no other deck's plan takes
        </label>
      </div>
      {sections.map((sec) => {
        const list = show(sec.list);
        if (!sec.list.length) return null;
        return (
          <section key={sec.id} className="stack plan-store">
            <h3>
              {sec.title} <span className="dim num">{list.length === sec.list.length ? sec.list.length : `${list.length} of ${sec.list.length}`}</span>
            </h3>
            <p className="dim small">{sec.about}</p>
            {list.length === 0 ? <p className="empty">Nothing here matches.</p> : <div className="list">{list.map((s) => <SpareRow key={`${s.card}|${s.from.key}|${s.when}`} s={s} view={view} />)}</div>}
          </section>
        );
      })}
      {sp.before.length > 0 && (
        <details className="plan-fold">
          <summary>
            Taken out before the plans <span className="dim num">{sp.before.length}</span>
          </summary>
          <p className="dim small">Your own changes to the precon. Yama doesn't know whether you still have these.</p>
          <div className="list">
            {sp.before.map((s) => (
              <SpareRow key={`${s.card}|${s.from.key}`} s={s} view={view} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function spareUseText(u: SpareUse): string {
  const deck = u.deck?.name ?? u.swap.deck;
  const decided = u.when === "proposed" ? ` (${u.decision ? DECISION[u.decision] ?? "not decided" : "not decided"})` : "";
  return `${USE_WHEN[u.when]} ${deck}${decided}`;
}

function SpareRow({ s, view }: { s: Spare; view: PlanView }) {
  const later = laterOutText(s);
  return (
    <div className="list-row plan-spare">
      <Thumb name={s.card} card={view.card(s.card)} oracleId={view.oracleId(s.card)} />
      <span>
        <span className="title">
          {s.qty > 1 ? `${s.qty} ` : ""}
          {s.card}
        </span>{" "}
        <span className="small dim">
          from <Link to={`/decks/plan/d/${s.from.key}`}>{s.from.name}</Link>
        </span>
        <br />
        <span className="small">{s.why}</span>
        {later && (
          <>
            <br />
            <span className="small dim">{later}</span>
          </>
        )}
        {s.when === "after" && s.proposedFor.length > 0 && (
          <>
            <br />
            <span className="small dim">A proposal counts on it, but it's only free once your prints arrive.</span>
          </>
        )}
      </span>
      <span className="row plan-slot-tags">
        {s.usedIn.map((u) => (
          <span key={u.swap.key} className="tag">{spareUseText(u)}</span>
        ))}
        {s.proposedFor.map((u) => (
          <span key={u.swap.key} className="tag warn">{spareUseText(u)}</span>
        ))}
        {s.free && !s.proposedFor.length && <span className="tag good">Free</span>}
      </span>
    </div>
  );
}
