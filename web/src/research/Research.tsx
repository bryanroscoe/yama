import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { useMe } from "../auth";
import { ArtPanel, artCredit, artCredits } from "../components/ArtPanel";
import { CardRef, CardText } from "../components/CardRef";
import { AreaHead, BackButton } from "../components/DeckTabs";
import { ErrorText, Pips } from "../components/ui";
import { saveFile } from "../download";
import { copySharedNote, report, targetForSwap, type Build, type GameplayProfile, type Power, type ResearchBundle, type ResearchDeck } from "./api";
import { DeckChanged, useDeckNamed } from "./about";
import { buildTitle } from "../decks/buildCatalog";
import { isOwnedBuild, ownedBuildProblems } from "./availability";
import { AccountingSummary, buildAccounting, listEntries, resolvedCombos } from "./details";
import { AcquisitionItem, AgentShopping, ComboCard, LocalChecks, PrintedWishlist, ReviewEditor, Sources } from "./owner";
import { CardViews, ChangesTable, Choices, CopyBox, GetChoices, SectionHead, ShoppingTable, ShoppingText, ShoppingTotals } from "./parts";
import { ShareNote } from "./ShareNote";
import { TrackPanel, trackedSwaps, useBuyRule, usePlansSettled, useTracked } from "./Tracking";
import { useScrollToHash } from "../components/useScrollToHash";
import { bracketLabel, cardsWord, deckHref, deckView, moved, noteHref, noteView, pickBuild, uptoOf, type GetId, type NoteView, type Totals } from "./view";
import "../plan/plan.css";
import "./research.css";
import { fmtDate, usd } from "@yama/core";

/**
 * A plan: a note an agent saved, or a copy of one someone shared (`/r/<token>`). Its pages show
 * what the shared page shows, in the same order (server/src/sharing/research.rs), plus what only
 * its owner sees: sharing, their answers for the agent and the agent's own evidence.
 */

/** The note with every build named one way ("Bracket 2: Buildable now"), as its shared page. */
function titled(b: ResearchBundle): ResearchBundle {
  return { ...b, document: { ...b.document, decks: b.document.decks.map((d) => ({ ...d, builds: d.builds.map((x) => ({ ...x, label: buildTitle(x.label) })) })) } };
}

const getOf = (v: string | null): GetId => (v === "buy" || v === "print" ? v : "split");
/** Agent-written fragments as sentences: each ends with one full stop, whether or not it came with one. */
function sentences(...parts: (string | undefined)[]): string {
  return parts
    .filter((p) => p?.trim())
    .map((p) => `${p!.trim().replace(/\.+$/, "")}.`)
    .join(" ");
}

/** Sets or clears search parameters, keeping the others and the scroll position. */
function useParamSetter() {
  const [params, setParams] = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true, preventScrollReset: true });
  };
}

/** Who made this plan: "Copied from @saget's shared plan", or the agent that saved it. */
function Origin({ doc }: { doc: ResearchBundle["document"] }) {
  const from = doc.copied_from;
  if (!from) return <p className="note-eyebrow">Saved by your agent</p>;
  return (
    <p className="note-eyebrow">
      Copied from{" "}
      {from.link ? (
        <a href={from.link} target="_blank" rel="noreferrer">
          {from.by ? `@${from.by}'s shared plan` : "a shared plan"}
        </a>
      ) : from.by ? (
        `@${from.by}'s shared plan`
      ) : (
        "a shared plan"
      )}
    </p>
  );
}

// ── A plan's page ────────────────────────────────────────────────────────────

const RECOMMENDED = "*recommended";
const ALL = "*all";

function NotePage({ bundle }: { bundle: ResearchBundle }) {
  const doc = bundle.document;
  const userId = useMe().data?.id;
  const [params] = useSearchParams();
  const set = useParamSetter();
  const all = params.get("builds") === "all";
  const build = all ? null : params.get("build");
  const get = getOf(params.get("get"));
  const rule = useBuyRule();
  const settled = usePlansSettled();
  const upto = uptoOf(params.get("upto")) ?? rule?.upto ?? null;
  const view = useQuery({
    queryKey: ["research", userId, doc.id, "view", bundle.revision, { build, all, get, upto }],
    queryFn: ({ signal }) => noteView(doc.id, { build, all, get, upto }, signal),
    // Once the account's buy limit is known, so the list doesn't load twice.
    enabled: settled,
    placeholderData: keepPreviousData,
  });
  const choices: { id: string; label: string }[] = [];
  for (const b of doc.decks.flatMap((d) => d.builds)) if (!choices.some((c) => c.id === `b:${b.id}`)) choices.push({ id: `b:${b.id}`, label: b.label });
  const chosen = all ? ALL : build ? `b:${build}` : RECOMMENDED;
  const v = view.data;
  const tiles = new Map(v?.decks.map((d) => [d.key, d]));
  const artists = doc.decks.map((d) => tiles.get(d.key)?.art?.artist);
  const retired = bundle.reviews.filter((r) => !bundle.target_hashes[r.target]);
  const guideNames = [...new Set(doc.decks.flatMap((d) => d.builds.flatMap((b) => listEntries(b.list).map((r) => r.name))))];
  return (
    <main className="page plan note-page">
      <AreaHead slim back={{ to: "/decks/plans/archived", label: "Back to archived plans" }} />
      <section className="note-head">
        <nav className="plan-crumbs" aria-label="Breadcrumb">
          <Link to="/decks">Decks</Link>
          <span aria-hidden="true">/</span>
          <Link to="/decks/plans">Plans</Link>
          <span aria-hidden="true">/</span>
          <Link to="/decks/plans/archived">Archived</Link>
        </nav>
        <Origin doc={doc} />
        <h1>{doc.title}</h1>
        <p className="note-archived">
          <span className="tag plain">Archived</span> A research note, kept for reference. It's never a current plan, and nothing in it is on your shopping list. Open a deck and choose Use a deck from it to make that build a new version of the deck's plan, waiting for your OK.
        </p>
        {doc.summary && <p className="note-summary">{doc.summary}</p>}
        {Array.isArray(doc.local_sources) && doc.local_sources.length > 0 && (
          <p><Link className="button outline" to={`/decks/plans/get/sourcing?report=${encodeURIComponent(doc.id)}`}>Source cards across all these decks</Link></p>
        )}
        <p className="dim">
          {doc.decks.length} {doc.decks.length === 1 ? "deck" : "decks"}. Saved {fmtDate(bundle.updated_at)}
          {bundle.revision > 1 ? `, revision ${bundle.revision}` : ""}.
        </p>
      </section>
      <ShareNote bundle={bundle} />
      <p className="small dim note-hint">Open a deck for its builds, how to pilot it and every change with its reason. The shopping list and deck lists below cover the recommended builds; pick another build, or All builds, to compare.</p>

      <div className="plan-deck-grid note-decks">
        {doc.decks.map((d) => {
          const tile = tiles.get(d.key);
          const recommended = d.builds.find((b) => b.id === d.recommended_build);
          const preferred = bundle.reviews.find((r) => r.target === `deck:${d.key}`)?.decision;
          const pick = preferred ? d.builds.find((b) => b.id === preferred) : null;
          return (
            <article key={d.key} className="note-tile">
              <Link to={deckHref(doc.id, d.key)} className="plan-tile">
                <ArtPanel art={tile?.art?.image} artist={tile?.art?.artist} wash="left" credit={false} className="plan-tile-art">
                  <span className="plan-tile-name">{d.name}</span>
                  <span className="plan-tile-cmdr">
                    {tile?.identity != null && <Pips identity={tile.identity} />} {d.commander}
                  </span>
                  <span className="plan-tile-counts">{recommended ? `Recommended: ${recommended.label}` : `${d.builds.length} builds`}</span>
                  {pick && (
                    <span className="plan-tile-chips">
                      <span className="art-chip plain">Your pick: {pick.label}</span>
                    </span>
                  )}
                </ArtPanel>
              </Link>
              {d.builds.length > 1 && (
                <nav className="note-tile-builds" aria-label={`Builds of ${d.name}`}>
                  {d.builds.map((b) => (
                    <Link key={b.id} to={deckHref(doc.id, d.key, b.id)}>
                      {b.label}
                    </Link>
                  ))}
                </nav>
              )}
              <DeckChanged name={d.name} savedAt={bundle.updated_at} />
            </article>
          );
        })}
      </div>
      {artists.some(Boolean) && <p className="small dim art-credits">{artCredits(artists)}</p>}

      <section className="note-section" aria-labelledby="shop-head">
        <SectionHead id="shop-head" eyebrow={v ? `${cardsWord(v.shopping.total.cards)} to get across ${doc.decks.length} ${doc.decks.length === 1 ? "deck" : "decks"}` : undefined}>
          Shopping list
        </SectionHead>
        {choices.length > 1 && (
          <Choices
            label="Builds to price"
            title="Builds"
            options={[{ id: RECOMMENDED, label: "Recommended" }, ...choices, { id: ALL, label: "All builds" }]}
            value={chosen}
            onChange={(id) => set({ build: id.startsWith("b:") ? id.slice(2) : null, builds: id === ALL ? "all" : null })}
          />
        )}
        <ErrorText error={view.error} />
        {!v && view.isPending && <p className="dim">Pricing the cards…</p>}
        {v && v.shopping.items.length === 0 && <p className="dim">These builds add no cards to the starting lists.</p>}
        {v && v.shopping.items.length > 0 && (
          <div className={view.isPlaceholderData ? "note-stale" : undefined}>
            {all && <p className="small dim note-how">Every build as its own deck, starting from one copy of each precon: the cards the builds share are counted once per build.</p>}
            <GetChoices s={v.shopping} onChange={(g) => set({ get: g === "split" ? null : g })} onUpTo={(d) => set({ upto: d })} rule={rule} />
            <ShoppingTotals s={v.shopping} />
            <div className="note-table-wrap">
              <table className="note-table">
                <thead>
                  <tr>
                    <th scope="col">Deck</th>
                    <th scope="col">Build</th>
                    <th scope="col" className="num">Cards</th>
                    <th scope="col" className="num">Buy locally</th>
                    <th scope="col" className="num">Print</th>
                    <th scope="col" className="num">Worth</th>
                    <th scope="col" className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.decks.map((d) => {
                    const row = tiles.get(d.key);
                    if (!row) return null;
                    return (
                      <tr key={d.key}>
                        <td>
                          <Link to={deckHref(doc.id, d.key, build && row.label ? build : undefined)}>{d.name}</Link>
                        </td>
                        <td>
                          {row.label ?? <span className="dim">No such build</span>}
                          {all && (
                            <small className="note-row-note">
                              {row.builds.map((b, i) => (
                                <span key={b.id}>
                                  {i > 0 && ", "}
                                  <Link to={deckHref(doc.id, d.key, b.id)}>{b.label}</Link>
                                </span>
                              ))}
                            </small>
                          )}
                        </td>
                        <TotalCells t={row.totals} />
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      Total
                    </th>
                    <TotalCells t={v.shopping.total} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <details className="note-fold">
              <summary>Every card to get ({cardsWord(v.shopping.total.cards)})</summary>
              <ShoppingTable s={v.shopping} decks />
            </details>
            <ShoppingText s={v.shopping} />
          </div>
        )}
      </section>

      {v && <NoteLists doc={doc} lists={v.lists} onAll={() => set({ build: null, builds: "all" })} />}

      <PrintedWishlist scenarios={doc.scenarios} />
      <AgentShopping scenarios={doc.scenarios} defaultId={doc.default_scenario_id} />
      {!!doc.method?.length && (
        <details className="note-fold">
          <summary>How your agent worked these out</summary>
          <ul>
            {doc.method.map((m, i) => (
              <li key={i}>
                <CardText text={m} names={guideNames} />
              </li>
            ))}
          </ul>
          <p className="small dim">Estimates are advice, not game results. Bracket and power are separate. Official brackets run 1–5; cEDH is Bracket 5.</p>
        </details>
      )}
      {retired.length > 0 && (
        <details className="note-fold">
          <summary>Your answers on parts no longer in this plan ({retired.length})</summary>
          {retired.map((r) => (
            <p key={r.target}>
              <b>{r.target}</b>: {r.decision ?? "No choice"}. {r.note}
            </p>
          ))}
        </details>
      )}
    </main>
  );
}

function TotalCells({ t }: { t: Totals }) {
  const buy = t.buy_uncosted === 0 ? usd(t.buy_cost) : t.buy_uncosted === t.buy ? "cost unknown" : `${usd(t.buy_cost)} + ${t.buy_uncosted} without a price`;
  return (
    <>
      <td className="num">{t.cards}</td>
      <td className="num">
        {t.buy}, {buy}
      </td>
      <td className="num">
        {t.print}, {usd(t.print_cost)}
      </td>
      <td className="num">{usd(t.worth)}</td>
      <td className="num">{usd(t.cost)}</td>
    </>
  );
}

/** Every list the shopping list's build choice covers, each to copy, and all of them as one text. */
function NoteLists({ doc, lists: given, onAll }: { doc: ResearchBundle["document"]; lists: NoteView["lists"]; onAll: () => void }) {
  const lists = given.flatMap((l) => {
    const d = doc.decks.find((x) => x.key === l.deck);
    const b = d?.builds.find((x) => x.id === l.build);
    return d && b ? [{ d, b, title: `${d.name}: ${b.label}`, text: l.text }] : [];
  });
  if (!lists.length) return null;
  const every = lists.map((l) => `// ${l.title}\n${l.text}`).join("\n");
  return (
    <section className="note-section" aria-labelledby="lists-head">
      <SectionHead id="lists-head" eyebrow={`${lists.length} ${lists.length === 1 ? "list" : "lists"}`}>
        Deck lists
      </SectionHead>
      <p className="small dim note-how">
        Standard text lists (Commander, then Deck), for Moxfield, Archidekt or Yama's own import. The builds follow the shopping list's choice;{" "}
        <button type="button" className="link-button" onClick={onAll}>
          every build
        </button>{" "}
        lists them all.
      </p>
      {lists.length > 1 && <CopyBox title={`Every list (${lists.length})`} text={every} />}
      <div className="note-copy-grid">
        {lists.map((l) => (
          <CopyBox key={`${l.d.key}:${l.b.id}`} title={l.title} text={l.text} />
        ))}
      </div>
    </section>
  );
}

// ── A deck's page ────────────────────────────────────────────────────────────

/** How a build plays, as the shared page's "How it plays" panel. Old notes keep their prose. */
function HowItPlays({ profile, legacy, names }: { profile?: GameplayProfile; legacy?: Power; names: string[] }) {
  const p: GameplayProfile = profile ?? { plan: legacy?.rationale, pace: legacy?.speed, confidence: legacy?.confidence, weaknesses: legacy?.vulnerabilities };
  const lines = (
    [
      ["plan", "Plan"],
      ["pressure", "Pressure"],
      ["interaction", "Interaction"],
      ["consistency", "Consistency"],
      ["recovery", "Recovery"],
      ["pace", "Pace"],
      ["ceiling", "Ceiling"],
    ] as const
  ).filter(([k]) => p[k]);
  const lists = (
    [
      ["setup", "Setup"],
      ["finishers", "How it wins"],
      ["weaknesses", "Weaknesses"],
    ] as const
  ).filter(([k]) => p[k]?.length);
  if (!lines.length && !lists.length) return null;
  return (
    <section className="note-panel" aria-labelledby="play-head">
      <h2 id="play-head">How it plays</h2>
      <dl className="note-profile">
        {lines.map(([k, label]) => (
          <div key={k}>
            <dt>{label}</dt>
            <dd>
              <CardText text={p[k] as string} names={names} />
            </dd>
          </div>
        ))}
      </dl>
      {lists.map(([k, label]) => (
        <div key={k}>
          <h3>{label}</h3>
          <ul>
            {(p[k] as string[]).map((x, i) => (
              <li key={i}>
                <CardText text={x} names={names} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {p.confidence && <p className="small dim">{p.confidence.replace(/\.+$/, "")}. An estimate, not simulated games.</p>}
    </section>
  );
}

function Panel({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="note-panel" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** What the agent allocated for a build: kept, moved, bought and printed copies, when the note
 *  has that evidence (a copy of a shared plan has none). */
function AgentAcquisition({ deck, build }: { deck: ResearchDeck; build: Build }) {
  const acq = build.acquisition;
  if (!acq || !(acq.owned?.length || acq.buys?.length || acq.prints?.length || acq.basics?.length)) return null;
  const baseline = deck.builds.find((b) => ["current", "stock"].includes(b.id));
  const starting = new Set(baseline ? listEntries(baseline.list).map((r) => r.name) : []);
  const kept = acq.owned?.filter((r) => r.kind === "keep" || (starting.has(r.card ?? "") && !["future_stock", "transfer"].includes(r.kind ?? ""))) ?? [];
  const available = acq.owned?.filter((r) => !kept.includes(r)) ?? [];
  const count = (rows: { qty?: number }[] = []) => rows.reduce((n, r) => n + (r.qty ?? 1), 0);
  return (
    <section className="note-section" aria-labelledby="acq-head">
      <SectionHead id="acq-head" eyebrow="From your agent's checks">
        What to keep, move, buy or print
      </SectionHead>
      <p className="small dim">{acq.note || "Keep the cards listed below."} Transfers wait for the donor deck to release its copy.</p>
      <AccountingSummary build={build} />
      <div className="research-acquisition-grid">
        <details>
          <summary>Keep in this deck ({count(kept)})</summary>
          {kept.map((r, i) => (
            <p className="small" key={i}>
              {r.qty && r.qty > 1 && `${r.qty} × `}
              {r.card && <CardRef name={r.card} />}
            </p>
          ))}
        </details>
        <details open={available.length > 0}>
          <summary>Other owned cards and projected stock ({count(available)})</summary>
          {available.map((r, i) => (
            <AcquisitionItem key={i} item={r} />
          ))}
        </details>
        <details open={!!acq.buys?.length}>
          <summary>Local singles to buy ({count(acq.buys)})</summary>
          {acq.buys?.length ? acq.buys.map((r, i) => <AcquisitionItem key={i} item={r} />) : <p className="small dim">No local single allocated.</p>}
        </details>
        <details open>
          <summary>Prints ({count(acq.prints)})</summary>
          {acq.prints?.length ? acq.prints.map((r, i) => <AcquisitionItem key={i} item={r} />) : <p className="small dim">No print allocated.</p>}
        </details>
        {!!acq.basics?.length && (
          <details>
            <summary>Ordinary basic lands ({count(acq.basics)})</summary>
            <p className="small dim">Included in the 100-card total; left out of print orders.</p>
            {acq.basics.map((r, i) => (
              <p key={i}>
                {r.qty ?? 1} × {r.card && <CardRef name={r.card} />}
              </p>
            ))}
          </details>
        )}
      </div>
    </section>
  );
}

function DeckPage({ bundle, deck }: { bundle: ResearchBundle; deck: ResearchDeck }) {
  const doc = bundle.document;
  const userId = useMe().data?.id;
  const [params] = useSearchParams();
  const set = useParamSetter();
  const build = pickBuild(bundle, deck, params.get("build"));
  const vsId = params.get("vs");
  const vs = deck.builds.find((b) => b.id === vsId && b.id !== build?.id) ?? null;
  const get = getOf(params.get("get"));
  const rule = useBuyRule();
  const settled = usePlansSettled();
  const upto = uptoOf(params.get("upto")) ?? rule?.upto ?? null;
  const view = useQuery({
    queryKey: ["research", userId, doc.id, "view", bundle.revision, deck.key, { build: build?.id, vs: vs?.id, get, upto }],
    queryFn: ({ signal }) => deckView(doc.id, deck.key, { build: build!.id, vs: vs?.id, get, upto }, signal),
    // Once the account's buy limit is known: a second load would unmount the answers being typed.
    enabled: !!build && settled,
    // Keep the page while another build or comparison loads, but never another deck's.
    placeholderData: (prev, q) => (q && q.queryKey[5] === deck.key ? prev : undefined),
  });
  const yours = useDeckNamed(deck.name);
  const tracking = useTracked(doc.id, deck.key);
  // Review links straight to the changes, drawn once the deck's view loads.
  useScrollToHash(!!view.data);
  if (!build) return <NoteMissing id={doc.id} what="That deck has no builds." />;
  const v = view.data;
  const names = [...new Set([...deck.builds.flatMap((b) => listEntries(b.list).map((r) => r.name)), ...resolvedCombos(deck, build).flatMap((c) => c.cards ?? [])])];
  const { added, removed } = moved(build);
  const preferred = bundle.reviews.find((r) => r.target === `deck:${deck.key}`);
  const combos = resolvedCombos(deck, build);
  const present = combos.filter((c) => c.present !== false);
  const missing = combos.filter((c) => c.present === false);
  const problems = ownedBuildProblems(build);
  const others = deck.builds.filter((b) => b.id !== build.id);
  const copies = (side: "add" | "cut") => v?.changes.filter((c) => c[side]).reduce((n, c) => n + c.n, 0) ?? 0;
  // The server's standard text when it's here (it reads every list format the shared page does);
  // the list as saved until then.
  const listText = v && v.build === build.id ? v.text : build.list;
  const download = () => void saveFile(new Blob([listText], { type: "text/plain" }), `${deck.key}-${build.id}.txt`);
  const size = buildAccounting(build).total;

  return (
    <main className="plan plan-deck-page note-page">
      <ArtPanel as="header" className="plan-hero" art={v?.art?.image} artist={v?.art?.artist} wash="bottom" toGround credit={false}>
        <BackButton to={noteHref(doc.id)} label="Back to the note" className="on-art" />
        {v?.art && (
          <span className="plan-hero-credit">
            {deck.commander}. {artCredit(v.art.artist)}
          </span>
        )}
        <div className="plan-hero-inner">
          <nav className="plan-crumbs" aria-label="Breadcrumb">
            <Link to="/decks">Decks</Link>
            <span aria-hidden="true">/</span>
            <Link to="/decks/plans">Plans</Link>
            <span aria-hidden="true">/</span>
            <Link to="/decks/plans/archived">Archived</Link>
            <span aria-hidden="true">/</span>
            <Link to={noteHref(doc.id)}>{doc.title}</Link>
          </nav>
          <span className="plan-hero-cmdr">
            {v?.identity != null && <Pips identity={v.identity} />} {deck.commander}
          </span>
          <h1 className="plan-hero-title">{deck.name}</h1>
          <span className="plan-hero-chips">
            <span className="art-chip plain">{build.label}</span>
            <span className="art-chip plain dim-on-art">Saved {fmtDate(bundle.updated_at)}</span>
          </span>
        </div>
      </ArtPanel>

      <div className="page plan-deck-body">
        <DeckChanged name={deck.name} savedAt={bundle.updated_at} />
        {deck.builds.length > 1 && (
          <Choices
            label="Builds of this deck"
            title="Builds"
            options={deck.builds.map((b) => ({ id: b.id, label: `${b.label}${b.id === deck.recommended_build ? " (recommended)" : ""}` }))}
            value={build.id}
            onChange={(id) => set({ build: id, vs: vs?.id === id ? null : vs?.id ?? null })}
          />
        )}
        <p className="small dim note-hint">
          Pick a build: its case, the changes, the shopping list and the decklist below follow it.{" "}
          {yours ? <>Load it into <Link to={`/decks/${encodeURIComponent(yours.id)}/edit`}>your {yours.name} deck</Link> (Edit the list, then Another list)</> : "Load it into one of your decks with Edit list on the deck's page"}, or print <Link to={`/decks/builds${yours ? `?savedDeck=${encodeURIComponent(yours.id)}` : ""}`}>swap cards</Link> for the deck box.
        </p>
        <div className="note-pills">
          {bracketLabel(build) && <span className="pill">{bracketLabel(build)}</span>}
          {Array.isArray(build.game_changers) && (
            <span className="pill">
              {build.game_changers.length} Game Changer{build.game_changers.length === 1 ? "" : "s"}
            </span>
          )}
          <a className="tag note-pill-link" href="#changes-head">
            {added} in, {removed} out from the starting list
          </a>
          {isOwnedBuild(build) && <span className="tag good">Buildable now from your cards</span>}
        </div>

        <TrackPanel key={build.id} bundle={bundle} deck={deck} build={build} />

        <section className="note-owner" aria-label="Your answer for the agent">
          <p className="small dim">
            Your answers tell the next agent what you think. They change no deck or order.
            {(deck.ownership || deck.installed_state) && ` ${sentences(deck.ownership, deck.installed_state)}`}
          </p>
          <ReviewEditor key={`deck:${deck.key}:${preferred?.version ?? 0}:${build.id}`} bundle={bundle} target={`deck:${deck.key}`} buildId={build.id} compact />
        </section>

        <div className="note-panels">
          <Panel id="about-head" title={build.label}>
            {problems.length > 0 && <p className="warn small">Ownership not verified: {problems.join(" ")}</p>}
            {build.prospective && <p className="warn small">A future build: its stock cards are yours only once the product is bought and arrives.</p>}
            {build.why && (
              <p>
                <CardText text={build.why} names={names} />
              </p>
            )}
            {build.option_swap && (
              <p className="small">
                Optional change from base Bracket 4: add <CardRef name={build.option_swap.card_in ?? build.option_swap.inn ?? "Unnamed"} />; cut{" "}
                <CardRef name={build.option_swap.card_out ?? build.option_swap.out ?? "Unnamed"} />.
              </p>
            )}
            {deck.summary && deck.summary !== build.why && (
              <>
                <h3>The deck</h3>
                <p>
                  <CardText text={deck.summary} names={names} />
                </p>
              </>
            )}
            {!!build.game_changers?.length && (
              <>
                <h3>Game Changers</h3>
                <p>
                  {build.game_changers.map((n, i) => (
                    <span key={n}>
                      {i > 0 && ", "}
                      <CardRef name={n} />
                    </span>
                  ))}
                </p>
                {build.gc_choices?.map((g) => (
                  <p className="small dim" key={g.card}>
                    <CardRef name={g.card} />: <CardText text={g.reason} names={names} />
                  </p>
                ))}
              </>
            )}
            {!!deck.warnings?.length && (
              <>
                <h3>Good to know</h3>
                <ul>
                  {deck.warnings.map((w, i) => (
                    <li key={i}>
                      <CardText text={w} names={names} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!!deck.mechanics?.length && (
              <>
                <h3>Mechanics</h3>
                <ul>
                  {deck.mechanics.map((m, i) => (
                    <li key={i}>
                      <CardText text={m} names={names} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!!build.risks?.length && (
              <>
                <h3>Limits of this build</h3>
                <ul>
                  {build.risks.map((r, i) => (
                    <li key={i}>
                      <CardText text={r} names={names} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
          {deck.pilot && deck.pilot !== build.why && deck.pilot !== deck.summary && (
            <Panel id="pilot-head" title="How to pilot this deck">
              <p>
                <CardText text={deck.pilot} names={names} />
              </p>
            </Panel>
          )}
          <HowItPlays profile={build.gameplay_profile} legacy={build.power} names={names} />
          {combos.length > 0 && (
            <Panel id="combos-head" title="Combos and engines">
              <p className="small dim">{present.length} with every piece in this list. Check the setup and where each stops; some entries describe lines that don't work.</p>
              {present.map((c) => (
                <ComboCard key={c.id} combo={c} />
              ))}
              {missing.length > 0 && (
                <details>
                  <summary>Other lines and missing-piece cautions ({missing.length})</summary>
                  {missing.map((c) => (
                    <ComboCard key={c.id} combo={c} />
                  ))}
                </details>
              )}
            </Panel>
          )}
          {!!deck.sources?.length && (
            <Panel id="sources-head" title="Sources">
              <Sources sources={deck.sources} />
            </Panel>
          )}
        </div>

        <section className="note-section" aria-labelledby="changes-head">
          <SectionHead
            eyebrow={v ? `${copies("add")} in, ${copies("cut")} out` : undefined}
            id="changes-head"
            after={
              others.length > 0 && (
                <label className="note-vs">
                  <span className="visually-hidden">Compare with</span>
                  <select value={vs?.id ?? ""} onChange={(e) => set({ vs: e.target.value || null })}>
                    <option value="">the starting list</option>
                    {others.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
              )
            }
          >
            Changes from{others.length > 0 ? <span className="visually-hidden"> {vs?.label ?? "the starting list"}</span> : " the starting list"}
          </SectionHead>
          <ErrorText error={view.error} />
          {!v && view.isPending && <p className="dim">Loading the changes…</p>}
          {v && v.changes.length === 0 && <p className="dim">{vs ? "These builds play the same cards." : "This build is the starting list."}</p>}
          {v && v.changes.length > 0 && (
            <ChangesTable
              rows={v.changes}
              extra={
                // Only on this build's own rows (never the previous build's, shown while this one
                // loads), and only from the starting list, where each row is one of its swaps.
                vs || view.isPlaceholderData || v.build !== build.id || v.vs
                  ? undefined
                  : (row) => {
                      const swap = build.swaps?.find((x) => x.id === row.swap);
                      if (!swap) return null;
                      const target = targetForSwap(deck.key, build.id, swap.id);
                      const answer = bundle.reviews.find((r) => r.target === target);
                      // Tracking this build: where each copy's card is now (in the deck, bought, to get).
                      const copies = tracking.deck?.status !== "archived" && tracking.deck?.note?.build === build.id ? trackedSwaps(tracking.swaps, doc.id, deck.key, build.id, swap.id) : [];
                      return (
                        <div className="note-swap-owner">
                          {copies.length > 0 && (
                            <p className="note-swap-state">
                              {copies.map((c) => (
                                <span key={c.key} className={`tag ${tracking.status(c) === "In the deck" ? "good" : "quiet"}`}>{tracking.status(c)}</span>
                              ))}
                            </p>
                          )}
                          {swap.acquisition && <AcquisitionItem item={swap.acquisition} showCard={false} />}
                          <ReviewEditor key={`${target}:${answer?.version ?? 0}`} bundle={bundle} target={target} compact />
                        </div>
                      );
                    }
              }
            />
          )}
        </section>

        {v?.shopping && (
          <section className="note-section" aria-labelledby="shop-head">
            <SectionHead id="shop-head" eyebrow={`${cardsWord(v.shopping.total.cards)} to add to ${v.vs_label}`}>
              Shopping list
            </SectionHead>
            <GetChoices s={v.shopping} onChange={(g) => set({ get: g === "split" ? null : g })} onUpTo={(d) => set({ upto: d })} rule={rule} />
            <ShoppingTotals s={v.shopping} />
            <ShoppingTable s={v.shopping} />
            <ShoppingText s={v.shopping} />
          </section>
        )}

        <AgentAcquisition deck={deck} build={build} />

        <section className="note-section" aria-labelledby="list-head">
          <SectionHead id="list-head" eyebrow={cardsWord(size)}>
            Decklist
          </SectionHead>
          <div className="row">
            <button type="button" className="primary" onClick={download}>
              Download the list
            </button>
          </div>
          <CopyBox title="Standard list (Commander, then Deck)" text={listText} rows={12} />
          {v && <CardViews cards={v.cards} />}
          {v?.cut && <p className="small dim">Only the first 300 lines of this list are shown.</p>}
          {!!v?.unknown.length && <p className="small dim">Not in Yama's card data: {v.unknown.join(", ")}.</p>}
        </section>

        <ResearchDetails deck={deck} names={names} />
      </div>
    </main>
  );
}

/** The agent's working: upgrade guides compared, earlier swaps judged, rules checked, and a
 *  competitive direction. Kept for the next agent; folded away. */
function ResearchDetails({ deck, names }: { deck: ResearchDeck; names: string[] }) {
  const has = deck.guide_comparison || deck.existing_swap_audit?.length || deck.combo_limits?.length || deck.competitive_path;
  if (!has) return null;
  return (
    <details className="note-fold">
      <summary>Your agent's research: upgrade guides, earlier swaps and rules checks</summary>
      {deck.guide_comparison && (
        <p>
          <CardText text={deck.guide_comparison} names={names} />
        </p>
      )}
      {!!deck.existing_swap_audit?.length && (
        <>
          <h3>Earlier upgrade judgments ({deck.existing_swap_audit.length})</h3>
          {deck.existing_swap_audit.map((r, i) => (
            <div className="research-item" key={i}>
              <p>
                <b>{r.inn && <CardRef name={r.inn} />}</b>
                {r.out && (
                  <>
                    {" "}
                    for <CardRef name={r.out} />
                  </>
                )}{" "}
                — {r.verdict}
              </p>
              <p className="small">
                <CardText text={r.reason ?? ""} names={names} />
              </p>
            </div>
          ))}
        </>
      )}
      {deck.combo_limits?.map((m, i) => (
        <p className="small dim" key={i}>
          {m}
        </p>
      ))}
      {deck.competitive_path && (
        <>
          <h3>Competitive path: Bracket 5</h3>
          <p>
            <b>{deck.competitive_path.status}</b>
          </p>
          <p>
            <CardText text={deck.competitive_path.summary ?? ""} names={names} />
          </p>
          {deck.competitive_path.commander_change && <p className="small">Commander or archetype changes: {deck.competitive_path.commander_change}</p>}
          <Sources sources={deck.competitive_path.sources} />
          <p className="small dim">A competitive direction; tournament results not checked.</p>
        </>
      )}
    </details>
  );
}

function NoteMissing({ id, what }: { id?: string; what: string }) {
  return (
    <main className="page plan note-page">
      <AreaHead slim back={{ to: id ? noteHref(id) : "/decks/plans", label: id ? "Back to this plan" : "Back to plans" }} />
      <p>
        {what} {id ? <Link to={noteHref(id)}>Open the plan.</Link> : <Link to="/decks/plans">Open your plans.</Link>}
      </p>
    </main>
  );
}

// ── Saving a copy of a shared plan ───────────────────────────────────────────

/** One id per Save-a-copy action in this tab: a reload or a retry after a lost answer gets the
 * copy already made. It is forgotten once the copy opens, so saving again makes another copy. */
const copyKey = (token: string) => `yama-copy:${token}`;
function copyOp(token: string): string | undefined {
  try {
    const op = sessionStorage.getItem(copyKey(token)) ?? crypto.randomUUID();
    sessionStorage.setItem(copyKey(token), op);
    return op;
  } catch {
    return undefined;
  }
}
function forgetCopyOp(token: string) {
  try {
    sessionStorage.removeItem(copyKey(token));
  } catch {
    /* no storage: nothing kept */
  }
}

/** `?copy=<token>` from a shared plan's page: save the copy once, then open it. */
function CopyShared({ token }: { token: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const copy = useMutation({
    mutationFn: () => copySharedNote(token, copyOp(token)),
    onSuccess: (r) => {
      forgetCopyOp(token);
      void qc.invalidateQueries({ queryKey: ["research"] });
      navigate(noteHref(r.id), { replace: true });
    },
  });
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      copy.mutate();
    }
  }, [copy]);
  return (
    <main className="page plan note-page">
      <AreaHead slim back={{ to: "/decks/plans", label: "Back to plans" }} />
      <section className="research-copy">
        {copy.isError ? (
          <>
            <p>The shared plan wasn't copied.</p>
            <ErrorText error={copy.error} />
            <Link to="/decks/plans">Open your plans</Link>
          </>
        ) : (
          <p>Saving a copy of the shared plan…</p>
        )}
      </section>
    </main>
  );
}

// ── The route ────────────────────────────────────────────────────────────────

/** `/decks/plans/archived/:reportId[/:deckKey]`: a research note, an archived plan. `/decks/research`
 *  keeps `?copy=` for shared plans' "Save a copy"; its other addresses redirect here. */
export function ResearchPage() {
  const { reportId, deckKey } = useParams();
  const [params] = useSearchParams();
  const userId = useMe().data?.id;
  const data = useQuery({ queryKey: ["research", userId, reportId], queryFn: ({ signal }) => report(reportId!, signal), enabled: !!reportId, select: titled });
  if (!reportId) {
    const token = params.get("copy");
    return token ? <CopyShared token={token} /> : <Navigate to="/decks/plans/archived" replace />;
  }
  const b = data.data;
  if (!b) {
    return (
      <main className="page plan note-page">
        <AreaHead slim back={{ to: "/decks/plans", label: "Back to plans" }} />
        <ErrorText error={data.error} />
        {data.isPending && <p className="dim">Loading the plan…</p>}
      </main>
    );
  }
  const deck = deckKey ? b.document.decks.find((d) => d.key === deckKey) : null;
  return (
    <LocalChecks.Provider value={b.document.local_checks ?? {}}>
      {!deckKey ? <NotePage bundle={b} /> : deck ? <DeckPage key={deck.key} bundle={b} deck={deck} /> : <NoteMissing id={reportId} what="That deck isn't in this plan." />}
    </LocalChecks.Provider>
  );
}
