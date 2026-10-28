import { CardRef } from "../components/CardRef";
import { laterOutText, spares, type Spare, type SpareUse } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { Details } from "../components/ui";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import type { PlanView } from "./view";

const USE_WHEN: Record<SpareUse["when"], string> = {
  now: "Now in",
  after: "Goes to",
  waiting: "Waiting to move to",
  proposed: "Proposed for",
};

const DECISION: Record<string, string> = { want: "you want it", unsure: "you're unsure" };

/** `/decks/plan/spares`: every card the plans take out, before buying or printing anything (design: Spares). */
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
    { id: "now", title: "Out now", about: "Their replacement is in hand: bought, moved in, a stand-in, or a basic holding a print's slot.", list: sp.now },
    {
      id: "after",
      title: "Out when prints arrive",
      about: "Cards whose replacement waits for a print or for another deck to free it.",
      list: sp.after.filter((s) => !s.standin),
    },
    { id: "standins", title: "Stand-ins leaving", about: "Each holds a slot until its print arrives, then comes out.", list: sp.after.filter((s) => s.standin) },
    { id: "extras", title: "Bought with no slot", about: "Bought for a deck that the plan has no slot for.", list: sp.extras },
  ];
  const artists = sections.flatMap((s) => show(s.list)).map((s) => view.card(s.card)?.artist);
  return (
    <>
      <PlansHead title="Spares" />
      <p className="spares-intro">Cards leaving one deck, and where they go next.</p>
      <Details label="How spares are counted">
        <p>
        Check here before buying or printing a card: a spare can fill another deck's slot for free. Read from your now and after-prints lists, so a card
        counts as out only when its list says so.
        </p>
      </Details>
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
      <div className="spares-cols">
        {sections.map((sec) => {
          const list = show(sec.list);
          if (!sec.list.length) return null;
          return (
            <section key={sec.id} className="plan-section spares-group" aria-label={sec.title}>
              <h2 className="plan-section-head spares-head">
                {sec.title} <span className="num">{list.length === sec.list.length ? sec.list.length : `${list.length} of ${sec.list.length}`}</span>
              </h2>
              <p className="dim small">{sec.about}</p>
              {list.length === 0 ? <p className="empty">Nothing here matches.</p> : list.map((s) => <SpareRow key={`${s.card}|${s.from.key}|${s.when}`} s={s} view={view} />)}
            </section>
          );
        })}
      </div>
      {artists.some(Boolean) && <p className="small dim art-credits">{artCredits(artists)}</p>}
      {sp.before.length > 0 && (
        <details className="plan-fold">
          <summary>
            Taken out before the plans <span className="dim num">{sp.before.length}</span>
          </summary>
          <p className="dim small">Your own changes to the precon. Yama doesn't know whether you still have these.</p>
          {sp.before.map((s) => (
            <SpareRow key={`${s.card}|${s.from.key}`} s={s} view={view} />
          ))}
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
  const uses = [...s.usedIn.map((u) => ({ u, warn: false })), ...s.proposedFor.map((u) => ({ u, warn: s.when === "after" }))];
  return (
    <div className="spare-card">
      <Crop src={view.card(s.card)?.image_art_crop} size="md" />
      <span className="spare-text">
        <b>
          {s.qty > 1 ? `${s.qty} ` : ""}
          <CardRef name={s.card} oracleId={view.oracleId(s.card)} image={view.card(s.card)?.image_normal}/>
        </b>
        <span className="dim">
          From <Link to={`/decks/plan/d/${s.from.key}`}>{s.from.name}</Link>. {s.why}
        </span>
        {uses.map(({ u, warn }) => (
          <span key={u.swap.key} className={`spare-next${warn ? " warn" : ""}`}>
            {spareUseText(u)}
          </span>
        ))}
        {s.free && !s.proposedFor.length && !s.usedIn.length && <span className="spare-next quiet">No deck wants it yet</span>}
        {s.free && s.usedIn.length === 0 && s.proposedFor.length > 0 && <span className="spare-next good">Free: no plan takes it yet</span>}
        {later && <span className="small dim">{later}</span>}
        {s.when === "after" && s.proposedFor.length > 0 && <span className="small dim">A proposal counts on it, but it's only free once your prints arrive.</span>}
      </span>
    </div>
  );
}
