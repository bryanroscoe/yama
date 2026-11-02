import { CardHover } from "../components/CardRef";
import { UpgradeabilitySection } from "./Upgradeability";
import { DeckPrices } from "../components/DeckPrices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityName } from "@yama/core";
import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { usePower } from "../auth";
import { api, usd, priceSource } from "../api";
import { CardImage, Details, ErrorText, ManaCost, Pips } from "../components/ui";
import { CardSheet } from "../pages/Cards";
import type { Matchup, PreconDetail, PreconItem, RatingV2, RunLabel } from "./api";
import { ConfidenceNote } from "./confidence";
import { cantJudge, caveat, fmtDate, grouped, linScale, logScale, pct, pctRange, strengthDomain, strengthText } from "./logic";
import { ArtPanel, IntervalBar } from "./parts";
import { RunLine, usePrecons } from "./Precons";
import { AskClaude } from "../advisor/AskClaude";
import { EvidenceSection, RatingV2Section } from "./Evidence";
import { LabHead } from "./LabLayout";

interface EngineSupport {
  fully_supported_share?: number;
  nonbasic?: number;
  partly_unimplemented?: string[];
  other_face_partly_unimplemented?: string[];
}

export function PreconDetailPage() {
  const { id } = useParams();
  // Keyed on the precon, so moving to another one (a matchup link) starts afresh: a new op id for
  // "Make this a Yama deck", no deck made for the last one, the card sheet and search cleared.
  return <PreconDetailBody key={id} id={id} />;
}

function PreconDetailBody({ id }: { id: string | undefined }) {
  const detail = useQuery({ queryKey: ["lab", "precon", id], queryFn: ({ signal }) => api<PreconDetail>(`/api/precons/${id}`, { signal }) });
  const list = usePrecons();
  const v2 = useQuery({ queryKey: ["lab", "rating-v2"], queryFn: ({ signal }) => api<RatingV2>("/api/precons/rating-v2", { signal }), staleTime: 5 * 60_000 });
  const [open, setOpen] = useState<string | null>(null);

  if (detail.error) {
    return (
      <>
        <LabHead slim back={{ to: "/lab", label: "Back to the precons" }} />
        <ErrorText error={detail.error} />
      </>
    );
  }
  const d = detail.data;
  if (!d) return <p className="dim">Loading…</p>;
  const p = d.precon;
  const support = (d.engine_support ?? null) as EngineSupport | null;
  const partly = new Set([...(support?.partly_unimplemented ?? []), ...(support?.other_face_partly_unimplemented ?? [])]);

  return (
    <>
      <LabHead slim back={{ to: "/lab", label: "Back to the precons" }} />
      <ArtPanel art={p.art}>
        <h1>{p.name}</h1>
        <span>
          {p.commanders.length > 1 ? "Commanders" : "Commander"}: {p.commanders.join(" and ")}
        </span>
        <span className="dim small">
          <Pips identity={p.color_identity} /> {identityName(p.color_identity)}, {p.set_name ?? p.set_code} ({p.set_code}){p.released ? `, ${fmtDate(p.released)}` : ""}
        </span>
      </ArtPanel>
      <Actions precon={p} />
      <UpgradeabilitySection value={p.upgradeability} />
      <DeckPrices singles={p.singles_value} sealed={p.sealed_price} precon />

      <section>
        <h2>Simulated rating</h2>
        <Rating detail={d} all={list.data?.precons ?? []} />
      </section>

      {p.playgroup?.rank != null && (
        <section className="lab-real">
          <h3>Real games (playgroup.gg)</h3>
          <p style={{ margin: 0 }}>
            Rank {p.playgroup.rank} of {p.playgroup.of}
            {p.playgroup.tier ? `, tier ${p.playgroup.tier}` : ""}
            {p.playgroup.win_rate_4p != null ? `, ${p.playgroup.win_rate_4p.toFixed(1)}% wins in 4-player pods` : ""}
            {p.playgroup.games != null ? ` over ${p.playgroup.games} logged games` : ""}.
          </p>
          <p className="lab-note">Fetched {fmtDate(p.playgroup.fetched)}</p>
          <Details label="About real-game results"><p>
            {p.playgroup.method}
            {p.playgroup.url && (
              <>
                {" "}from <a href={p.playgroup.url} target="_blank" rel="noreferrer">playgroup.gg</a>
              </>
            )}
            .
          </p></Details>
        </section>
      )}

      <EvidenceSection evidence={p.evidence} />
      <RatingV2Section v2={v2.data} id={p.id} />

      <section>
        <h2>EDHREC reviews and upgrades</h2>
        <a className="button" href={`https://edhrec.com/precons/${encodeURIComponent(p.id)}`} target="_blank" rel="noreferrer">
          Open {p.name} on EDHREC
        </a>
      </section>

      {d.matchups && d.matchups.rows.length > 0 && d.run && <Matchups rows={d.matchups.rows} run={d.run} unjudged={cantJudge(p.rating?.confidence)} />}

      <section>
        <h2>Decklist</h2>
        {support?.fully_supported_share != null && (
          <p className="lab-note">
            The rules engine fully supports {pct(support.fully_supported_share)} of the {support.nonbasic} non-basic cards.
            {partly.size > 0 ? ` Partly implemented, so the AI may play them oddly: ${[...partly].join(", ")}.` : ""}
          </p>
        )}
        {d.notes.length > 0 && <ul className="lab-note">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <div className="lab-decklist">
          {grouped(d.cards).map(([group, cards]) => (
            <section key={group}>
              <h3>
                {group} <span className="dim num">{cards.reduce((n, c) => n + c.qty, 0)}</span>
              </h3>
              {cards.map((c) => (
                <button key={`${c.name}-${c.board}`} className="lab-line" onClick={() => c.oracle_id && setOpen(c.oracle_id)} disabled={!c.oracle_id} style={{ opacity: 1 }}>
                  <CardImage src={c.image_small} name={c.name} className="thumb" />
                  <span className="name">
                    {c.qty > 1 ? `${c.qty} ` : ""}
                    <CardHover name={c.name} oracleId={c.oracle_id} image={c.image_normal}/> {partly.has(c.name) && <span className="tag warn">partly in the engine</span>}
                    {!c.oracle_id && <span className="tag">unknown to Yama</span>}
                    <span className="dim small" style={{ display: "block" }} title={priceSource(c.price_date)}>{usd(c.unit_price_usd)}{c.qty > 1 && c.unit_price_usd != null ? ` each, ${usd(c.unit_price_usd * c.qty)} total` : ""}{c.price_date ? ` (${c.price_date})` : ""}</span>
                  </span>
                  <ManaCost cost={c.mana_cost} />
                </button>
              ))}
            </section>
          ))}
        </div>
        <p className="lab-note">
          {sourceName(d.source) ? `List from ${sourceName(d.source)}, imported` : "List imported"} {fmtDate(d.imported_at)}.
        </p>
        {d.source && (
          <Details>
            <p>Source: {d.source}.</p>
          </Details>
        )}
      </section>
      {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Actions({ precon }: { precon: PreconItem }) {
  const power = usePower();
  const qc = useQueryClient();
  // One op id per visit: a retried tap makes one deck.
  const opId = useRef(crypto.randomUUID());
  const make = useMutation({
    mutationFn: () =>
      api<{ id: string; name: string; unknown: string[]; validation: { ok: boolean; errors: string[] } }>(`/api/precons/${precon.id}/deck`, {
        method: "POST",
        json: { op_id: opId.current },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["decks"] }),
  });
  return (
    <div className="stack" style={{ gap: "0.5rem", marginBottom: "1.5rem" }}>
      <div className="row">
        {make.data ? (
          <Link className="button primary" to={`/decks/${make.data.id}`}>Open {make.data.name}</Link>
        ) : (
          <button className="primary" onClick={() => make.mutate()} disabled={make.isPending}>
            {make.isPending ? "Making the deck…" : "Make this a Yama deck"}
          </button>
        )}
        {power && <Link className="button" to={`/lab/try?precon=${encodeURIComponent(precon.id)}`}>Try a change</Link>}
        <AskClaude context={{ kind: "precon", ref: precon.id }} about={precon.name} />
      </div>
      {make.data && (
        <p className="small dim" role="status" style={{ margin: 0 }}>
          Added to your decks, in the Precons folder.
          {make.data.unknown.length > 0 ? ` Yama didn't know ${make.data.unknown.join(", ")}, so they're left out.` : ""}
          {!make.data.validation.ok ? ` Deck check: ${make.data.validation.errors.join("; ")}.` : ""}
        </p>
      )}
      <ErrorText error={make.error} />
    </div>
  );
}

function Rating({ detail, all }: { detail: PreconDetail; all: PreconItem[] }) {
  const r = detail.precon.rating;
  const run = detail.run;
  const strengthScale = useMemo(() => {
    const [lo, hi] = strengthDomain(all.length ? all.map((p) => p.rating ?? { strength: null, lo: null, hi: null }) : [r ?? { strength: null, lo: null, hi: null }]);
    return logScale(lo, hi);
  }, [all, r]);
  if (!run) return <p className="dim">No rating run is imported on this server yet.</p>;
  if (!r) return (
    <>
      <p className="dim">Not rated in run {run.name}.</p>
      <RunLine run={run} />
    </>
  );
  // A rank is among every deck the run ranked, which can be more than the catalogue's precons.
  const of = run.ranked >= (r.rank ?? 0) && run.ranked > 0 ? run.ranked : null;
  const wins = r.win_rate != null ? Math.round(r.win_rate * r.games) : null;
  const conf = r.confidence;
  const pg = detail.precon.playgroup;
  return (
    <>
      {conf && conf.level !== "ok" && (
        <ConfidenceNote level={conf.level} reasons={conf.reasons} fold>
          {cantJudge(conf) && pg?.rank != null && (
            <p>
              Real games are the better guide: rank {pg.rank} of {pg.of} on playgroup.gg{pg.win_rate_4p != null ? `, ${pg.win_rate_4p.toFixed(1)}% wins` : ""}, below.
            </p>
          )}
        </ConfidenceNote>
      )}
      <div className={`lab-figures${cantJudge(conf) ? " unjudged" : ""}`}>
        <div className="lab-figure">
          <b>{r.rank != null ? `${r.rank}${of ? ` of ${of}` : ""}` : "no rank"}</b>
          <span>Simulated rank</span>
        </div>
        <div className="lab-figure">
          <b>{strengthText(r.strength)}</b>
          <span>Relative strength</span>
          <IntervalBar value={r.strength} lo={r.lo} hi={r.hi} scale={strengthScale} reference={1} label={`Strength ${strengthText(r.strength)}; the line is average`} />
        </div>
        {r.p4_field != null && (
          <div className="lab-figure">
            <b>{pct(r.p4_field)}</b>
            <span>Model win rate (4-player)</span>
            <IntervalBar value={r.p4_field} lo={r.p4_lo} hi={r.p4_hi} scale={linScale(0, 1)} reference={0.25} label={`Wins ${pct(r.p4_field)} of 4-player pods; the line is a quarter`} />
          </div>
        )}
        <div className="lab-figure">
          <b>{r.games}</b>
          <span>{r.games === 1 ? "Game" : "Games"}{wins != null ? ` / ${wins} wins` : ""}</span>
        </div>
      </div>
      {r.flags.length > 0 && (
        <p className="row" style={{ gap: "0.35rem" }}>
          {r.flags.map((f) => <span key={f} className="tag warn">{f}</span>)}
        </p>
      )}
      <RunLine run={run} />
      <Details label="How to read these results">
        <p>Rank among {of ?? "the"} decks in {run.name}.{r.rank_lo != null && r.rank_hi != null ? ` Rank range: ${r.rank_lo}–${r.rank_hi}.` : ""}</p>
        <p>Strength 1 is an average precon.{r.lo != null && r.hi != null ? ` Strength interval: ${strengthText(r.lo)}–${strengthText(r.hi)}.` : ""}</p>
        <p>The model estimates wins against random precons in four-player pods; 25% is the equal-deck baseline.{r.p4_lo != null && r.p4_hi != null ? ` Model interval: ${pctRange(r.p4_lo, r.p4_hi)}.` : ""}</p>
        <p>Observed wins: {pct(r.win_rate)}.{r.wr_lo != null && r.wr_hi != null ? ` Interval: ${pctRange(r.wr_lo, r.wr_hi)}.` : ""}{r.avg_place != null ? ` Average place: ${r.avg_place.toFixed(2)}.` : ""}</p>
        <p>{caveat(run.engine)}</p>
      </Details>
    </>
  );
}

function Matchups({ rows, run, unjudged }: { rows: Matchup[]; run: RunLabel; unjudged: boolean }) {
  const [q, setQ] = useState("");
  const scale = linScale(0, 1);
  const best = rows.slice(0, 5);
  const worst = rows.slice(-5).reverse();
  const shown = rows.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()));
  const row = (m: Matchup) => (
    <div key={m.id} className="lab-match">
      <Link to={`/lab/p/${m.id}`}>{m.name}</Link>
      <IntervalBar value={m.p} scale={scale} reference={0.5} label={`${pct(m.p)} to beat ${m.name} one on one; the line is even odds`} />
      <span className="num">{pct(m.p)}</span>
    </div>
  );
  return (
    <section>
      <h2>Modelled one-on-one odds</h2>
      {unjudged && <p className="lab-note">Engine caution: these matchups share the simulation’s limitations.</p>}
      <Details label="How matchups are estimated"><p>
        The chance of beating each precon in a game of two, implied by the model from the 4-player games of run {run.name}. They aren't head-to-head
        games, and with few games per precon they lean towards even.
        {unjudged ? " They come from the same simulation, which can't judge this deck yet, so they say little about real games too." : ""}
      </p></Details>
      <div className="lab-two">
        <div>
          <h3>Best matchups</h3>
          {best.map(row)}
        </div>
        <div>
          <h3>Worst matchups</h3>
          {worst.map(row)}
        </div>
      </div>
      <details style={{ marginTop: "1rem" }}>
        <summary>All {rows.length} matchups</summary>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a precon" aria-label="Find a matchup" style={{ margin: "0.5rem 0" }} />
        {shown.map(row)}
        {shown.length === 0 && <p className="dim small">No precon matches.</p>}
      </details>
    </section>
  );
}

/** "MTGJSON" from "MTGJSON https://…, via …": the source's plain name, without links or file paths. */
function sourceName(source: string | null | undefined): string | null {
  const first = source?.trim().split(/[\s,(]/)[0] ?? "";
  return first && !/[/.:]/.test(first) ? first : null;
}
