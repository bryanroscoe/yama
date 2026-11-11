import { CardRef } from "../components/CardRef";
import {
  inForceBundle,
  boughtInfo,
  hassleOrder,
  planTrip,
  PREFERENCE_TEXT,
  sealedFor,
  storePreference,
  storePremium,
  type PrintRow,
  type RuleSet,
  type SkipReason,
  type Store,
  type StorePreference,
  type StorePref,
  type ShoppingWant,
  type StoreSnapshot,
  type TripRow,
} from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { ErrorText, Loading, EmptyState, CopyButton } from "../components/ui";
import {
  addSealedQuote,
  addWant,
  checkStores,
  deckGaps,
  removeSealedQuote,
  removeWant,
  sealedView,
  setStoreOrder,
  setStorePreference,
  storeSnapshots,
  type SealedItem,
  type StorePrefBody,
} from "./api";
import { api, type DeckSummary } from "../api";
import { marketSentence } from "./marks";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { TripHowTo } from "./howto";
import type { PlanView } from "./view";
import { fmtDate, usd, NO_PRICE, fmtDateTime } from "@yama/core";

const CHOICES: StorePreference[] = ["favorite", "ok", "maybe", "never"];

const SKIP_TEXT: Record<SkipReason, string> = { never: "you won't go", "not-local": "not local, and your rule says buy local", "left-out": "left off this trip" };

/** Why a needed card isn't on the trip, in words. */
function printReason(p: PrintRow): string {
  const at = p.offer ? `${usd(p.offer.price)} at ${p.offer.store.name}` : "";
  switch (p.reason) {
    case "too-few":
      return `Not enough copies: ${p.stores.join(", ")} ${p.stores.length === 1 ? "lists" : "list"} fewer than you want (${at}).`;
    case "never-store":
      return `Only at ${p.stores.join(", ")}, where you won't go (${at}).`;
    case "not-local":
      return `Only at ${p.stores.join(", ")}, which isn't local, and your rule is to buy locally (${at}).`;
    case "left-out":
      return `Only at ${p.stores.join(", ")}, which you left off this trip (${at}).`;
    case "over-max":
      return `Over your limit (${at}). Print it; it stays on your real-card wishlist.`;
    case "over-market":
      return `Above your rule for its market (${at}).`;
    case "no-market":
      return `No market price to judge it by (${at}).`;
    case "no-price":
      return `In stock with no listed price at ${p.stores.join(", ")}. Ask the store.`;
    case "unknown-stock":
      return `Listed at ${p.stores.join(", ")}, but the check didn't say whether it's in stock. Ask the store.`;
    case "not-stocked":
      return "Not in stock at the last check.";
    default:
      return "No store check recorded.";
  }
}

/** `/decks/plans/get/trip`: which of your stores to visit, and what to print instead (docs/shopping-design.md). */
export function Trip() {
  const { view, userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const stores = view.b.stores.filter((s) => !s.retired && s.kind !== "printer");
  // The stores you're going to this time (?going=1&store=a&store=b; none listed is none, since a
  // key may hold any character); no "going": every store you'll go to.
  const going = params.has("going") ? params.getAll("store").filter((k) => stores.some((s) => s.key === k)) : null;
  const goingKey = going ? JSON.stringify(going) : null;
  // From Get the cards filtered to one deck (?deck=): only that plan's buys.
  const deckFilter = params.get("deck") && view.deck(params.get("deck")!) ? params.get("deck") : null;
  const trip = useMemo(
    () =>
      // Only approved plans: one waiting for your OK puts nothing on a trip.
      // One deck's trip has only its plan's buys: no hand-added wants or wishlist.
      planTrip({ ...inForceBundle(view.b, view.planOf, view.answers, deckFilter), ...(deckFilter ? { shopping_wants: [], wishlist: [] } : {}) }, {
        today: view.today,
        answers: view.answers,
        bought: (k) => !!boughtInfo(view.markBy.get(k)?.bought),
        stores: goingKey == null ? null : (JSON.parse(goingKey) as string[]),
      }),
    [view, goingKey, deckFilter],
  );
  const willGo = stores.filter((s) => storePreference(view.b, s.key) !== "never");
  const toggle = (key: string) => {
    const now = new Set(going ?? willGo.map((s) => s.key));
    if (now.has(key)) now.delete(key);
    else now.add(key);
    const next = willGo.map((s) => s.key).filter((k) => now.has(k));
    setParams(
      (p) => {
        p.delete("going");
        p.delete("store");
        if (next.length < willGo.length) {
          p.set("going", "1");
          for (const k of next) p.append("store", k);
        }
        return p;
      },
      { replace: true },
    );
  };
  const nameOf = (key: string) => view.b.stores.find((s) => s.key === key)?.name ?? key;
  // Every art crop on the page, credited at the bottom.
  const shownArtists = [...trip.stops.flatMap((st) => [...st.rows, ...st.along].map((r) => r.want.card)), ...trip.print.map((p) => p.want.card)].map(
    (c) => view.card(c)?.artist,
  );

  return (
    <>
      <PlansHead title="Store trip" />
      <TripHowTo open={trip.needed === 0 && !(view.b.shopping_wants ?? []).length} />
      <div className="area-note warn" role="note">
        <p>
          {trip.checkedOn.length
            ? `Store listings checked ${fmtDate(trip.checkedOn[0])}${trip.checkedOn.length > 1 ? ` to ${fmtDate(trip.checkedOn[trip.checkedOn.length - 1])}` : ""}. Recheck before going in.`
            : "No store stock checks in the plan."}{" "}
          {trip.rule.text}
        </p>
        <p className="small">
          Planned buys and proposals you want decide the stops. Wishlist cards come along if stocked there.
        </p>
      </div>

      {willGo.length > 0 && (
        <fieldset className="trip-going">
          <legend className="small">Going this time</legend>
          {willGo.map((s) => (
            <label key={s.key} className="trip-going-store">
              <input type="checkbox" checked={!going || going.includes(s.key)} onChange={() => toggle(s.key)} /> {s.short ?? s.name}
            </label>
          ))}
        </fieldset>
      )}

      <StockCheck stores={stores} going={going} view={view} userId={userId} />

      <div className="plan-figures">
        <div className="plan-figure">
          <b className="num">{trip.covered}</b>
          <span>
            of {trip.needed} cards to buy, from {trip.stops.length === 1 ? "1 store" : `${trip.stops.length} stores`}
          </span>
        </div>
        {trip.total != null && (
          <div className="plan-figure">
            <b className="num">{usd(trip.total)}</b>
            <span>listed, before tax</span>
          </div>
        )}
        {trip.print.length > 0 && (
          <div className="plan-figure">
            <b className="num">{trip.print.length}</b>
            <span>to print or check by hand</span>
          </div>
        )}
      </div>

      {trip.stops.length > 1 && (
        <p className="trip-copy">
          <CopyButton text={trip.stops.map((st) => `${st.store.name}\n${st.paste}`).join("\n\n")} label="Copy every store's list" className="button outline" />
        </p>
      )}

      {trip.stops.length === 0 && <EmptyState>No store has a card you need under your rule. See below for what to print.</EmptyState>}

      <div className="buy-stores">
        {trip.stops.map((st, i) => (
          <section key={st.store.key} className="buy-store" aria-label={st.store.name}>
            <header className="buy-store-head">
              <span className="buy-store-name">
                <b>
                  {i + 1}. {st.store.name}
                </b>
                <span>
                  {PREFERENCE_TEXT[st.preference]}. {st.rows.length === 1 ? "1 card" : `${st.rows.length} cards`}, {usd(st.total)} before tax
                  {st.store.location ? `. ${st.store.location}` : ""}
                </span>
              </span>
              {st.cartUrl && (
                <a className="button primary buy-cart" href={st.cartUrl} target="_blank" rel="noreferrer">
                  Replace cart
                </a>
              )}
            </header>
            {st.noCartLine > 0 && !st.search.length && (
              <p className="buy-store-note">{st.noCartLine === 1 ? "1 card has" : `${st.noCartLine} cards have`} no cart line: ask at the counter.</p>
            )}
            {st.search.length > 0 && (
              <p className="buy-store-note">
                This store's site has no cart link. Find each card there:{" "}
                {st.search.map((x, n) => (
                  <span key={x.card}>
                    {n ? ", " : ""}
                    <a href={x.url} target="_blank" rel="noreferrer">
                      {x.card}
                    </a>
                  </span>
                ))}
                .
              </p>
            )}
            <p className="trip-copy">
              <CopyButton text={st.paste} label="Copy the list" className="button outline" />
            </p>
            {st.rows.map((r) => (
              <TripItem key={r.want.id} r={r} view={view} />
            ))}
            {st.along.length > 0 && (
              <details className="plan-fold">
                <summary>
                  Also here, if you want them <span className="dim num">{st.along.length}, {usd(st.alongTotal)}</span>
                </summary>
                {st.along.map((r) => (
                  <TripItem key={r.want.id} r={r} view={view} />
                ))}
              </details>
            )}
          </section>
        ))}
      </div>

      {trip.alternatives.length > 1 && (
        <section className="plan-section" aria-labelledby="trip-fewer">
          <h2 id="trip-fewer" className="plan-section-head">With fewer stores</h2>
          <ul className="small">
            {trip.alternatives.slice(0, -1).map((a) => (
              <li key={a.stores.join("|")}>
                {a.stores.map(nameOf).join(" and ")}: {a.covered} of {trip.needed} cards, {usd(a.total)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {trip.print.length > 0 && (
        <section className="plan-section" aria-labelledby="trip-print">
          <h2 id="trip-print" className="plan-section-head">
            Print, or check by hand <span className="num dim">{trip.print.length}</span>
          </h2>
          <p className="trip-copy">
            <CopyButton text={trip.printPaste} label="Copy the list" className="button outline" />
            {trip.printMassEntry && (
              <a className="button outline" href={trip.printMassEntry} target="_blank" rel="noreferrer" title="TCGplayer Mass Entry, prices online">
                Compare on TCGplayer
              </a>
            )}
          </p>
          {trip.print.map((p) => (
            <div key={p.want.id} className="buy-row">
              <Crop src={view.card(p.want.card)?.image_art_crop} />
              <span className="buy-row-text">
                <span className="buy-row-top">
                  <b>
                    <CardRef name={p.want.card} oracleId={view.oracleId(p.want.card)} image={view.card(p.want.card)?.image_normal} />
                  </b>
                </span>
                <span className="buy-row-meta">{p.want.deckName}</span>
                <span className="buy-row-meta">{printReason(p)}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      {trip.elsewhere.length > 0 && (
        <section className="plan-section" aria-labelledby="trip-elsewhere">
          <h2 id="trip-elsewhere" className="plan-section-head">Only at stores not on this trip</h2>
          <ul className="small">
            {trip.elsewhere.map((e) => (
              <li key={e.store.key}>
                {e.store.name}: {e.rows.map((r) => `${r.want.card} ${usd(r.offer.price)}`).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <MyList view={view} userId={userId} />

      <Sealed stores={stores} view={view} userId={userId} going={going} trip={trip.stops.map((st) => st.store.key)} />

      <StorePrefs stores={stores} view={view} userId={userId} skipped={trip.skipped} />

      {trip.wishlist.length > 0 && (
        <section className="plan-section" aria-labelledby="trip-wishlist">
          <h2 id="trip-wishlist" className="plan-section-head">Real-card wishlist</h2>
          <p className="dim small">Real copies to watch for, by cheapest nonfoil market price.</p>
          {trip.wishlist.map((t) => (
            <details key={t.label} className="plan-fold">
              <summary>
                {t.label} <span className="dim num">{t.items.length}{t.market != null ? `, ${usd(t.market)} at market` : ""}</span>
              </summary>
              <ul className="small">
                {t.items.map((x) => (
                  <li key={x.want.id}>
                    <CardRef name={x.want.card} oracleId={view.oracleId(x.want.card)} image={view.card(x.want.card)?.image_normal} />{" "}
                    <span className="dim">{x.market ? `${usd(x.market.usd)}, ${fmtDate(x.market.date)}` : NO_PRICE}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      )}
      {shownArtists.some(Boolean) && <p className="small dim art-credits">{artCredits(shownArtists)}</p>}
    </>
  );
}

function TripItem({ r, view }: { r: TripRow; view: PlanView }) {
  const { want, offer } = r;
  const q = offer.quote;
  const what =
    want.source === "wishlist"
      ? "Your real-card wishlist"
      : want.source === "want"
        ? `On your list${want.deckName ? `, for ${want.deckName}` : ""}`
        : `${want.deckName ?? ""}${want.source === "proposal" && !want.needed ? ", proposed, not decided" : ""}`;
  return (
    <div className="buy-row">
      <Crop src={view.card(want.card)?.image_art_crop} />
      <span className="buy-row-text">
        <span className="buy-row-top">
          <b>
            <CardRef name={want.card} oracleId={view.oracleId(want.card)} image={view.card(want.card)?.image_normal} />
          </b>
          <b className="num">{usd(offer.price)}</b>
        </span>
        <span className="buy-row-meta">
          {what}
          {want.replaces ? `, replaces ${want.replaces}` : ""}
        </span>
        <span className="buy-row-meta">
          {q.result ?? "Listed"}, checked {fmtDate(q.checked)}.
        </span>
        <span className="buy-row-meta">{marketSentence(offer.market, true)}</span>
      </span>
    </div>
  );
}

const SOURCE_TEXT: Record<StoreSnapshot["source"], string> = {
  shopify: "its website",
  tcgplayer_pro: "its TCGplayer Pro catalog",
  yestcg: "YesTCG",
  import: "an imported file",
};

/** One snapshot in words: when, from where, and how it went. */
function snapshotText(s: StoreSnapshot): string {
  const when = s.fetched_at ?? s.requested_at;
  const what = s.cards == null ? "whole catalog" : s.cards === 1 ? "1 card" : `${s.cards} cards`;
  const how =
    s.status === "running"
      ? "reading now"
      : s.status === "error"
        ? `failed${s.error ? `: ${s.error}` : ""}`
        : `${s.listings === 1 ? "1 listing" : `${s.listings} listings`}${s.failed ? `, ${s.failed} ${s.failed === 1 ? "card" : "cards"} unknown (a request failed)` : ""}`;
  return `${fmtDateTime(when, { utc: true })} UTC, ${what} from ${SOURCE_TEXT[s.source]}: ${how}.`;
}

/**
 * "Check stores": Yama reads the stores' stock now (only when you ask), one dated snapshot per
 * store, and the trip uses the newest answer for each card beside the plan's own checks.
 */
function StockCheck({ stores, going, view, userId }: { stores: Store[]; going: string[] | null; view: PlanView; userId: string }) {
  const qc = useQueryClient();
  const [yestcg, setYestcg] = useState(false);
  const [skipped, setSkipped] = useState<{ store: string; name: string; why: string }[]>([]);
  const start = useMutation({
    mutationFn: () => checkStores({ stores: going, yestcg }),
    onSuccess: (r) => {
      setSkipped(r.skipped);
      void qc.invalidateQueries({ queryKey: ["plan-stock", userId] });
    },
  });
  // Follow a running check every few seconds; the bundle is fetched again when it ends.
  const live = useQuery({
    queryKey: ["plan-stock", userId],
    queryFn: storeSnapshots,
    enabled: start.isSuccess || (view.b.snapshots ?? []).some((s) => s.status === "running"),
    refetchInterval: (q) => (q.state.data?.snapshots.some((s) => s.status === "running") ? 4000 : false),
  });
  const snaps = live.data?.snapshots ?? view.b.snapshots ?? [];
  const running = snaps.some((s) => s.status === "running");
  useEffect(() => {
    if (live.data && !running) void qc.invalidateQueries({ queryKey: ["plan", userId] });
  }, [live.data, running, qc, userId]);
  // The newest snapshot of each store and source.
  const newest = new Map<string, StoreSnapshot>();
  for (const s of snaps) if (!newest.has(`${s.store}|${s.source}`)) newest.set(`${s.store}|${s.source}`, s);
  const name = (key: string) => stores.find((s) => s.key === key)?.name ?? key;
  return (
    <section className="plan-section" aria-labelledby="trip-stock">
      <h2 id="trip-stock" className="plan-section-head">Store stock</h2>
      <p className="dim small">
        Checks online stock when you ask. Stores without an online list need a check by hand.
      </p>
      <p className="trip-copy">
        <button type="button" className="button outline" disabled={start.isPending || running} onClick={() => start.mutate()}>
          {running ? "Checking stores…" : going ? "Check the stores I'm going to" : "Check stores"}
        </button>
        <label className="check small">
          <input type="checkbox" checked={yestcg} onChange={(e) => setYestcg(e.target.checked)} /> Also ask YesTCG (Austin), which gives condition and quantity
        </label>
      </p>
      <ErrorText error={start.error} />
      {skipped.length > 0 && (
        <p className="small dim">
          Not checked: {skipped.map((x) => `${x.name} (${x.why})`).join("; ")}.
        </p>
      )}
      {newest.size > 0 && (
        <ul className="small">
          {[...newest.values()].map((s) => (
            <li key={s.id}>
              {name(s.store)}: {snapshotText(s)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Cards and sealed products you added to your list by hand: needed ones decide the stores like
 * planned buys; "along the way" ones only come from a store already on the trip. A deck that isn't
 * in a plan says which of its cards your collection lacks, so you can add the ones to buy here.
 */
function MyList({ view, userId }: { view: PlanView; userId: string }) {
  const qc = useQueryClient();
  const wants = view.b.shopping_wants ?? [];
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [kind, setKind] = useState<ShoppingWant["kind"]>("card");
  const [priority, setPriority] = useState<ShoppingWant["priority"]>("need");
  const [deckId, setDeckId] = useState("");
  const [why, setWhy] = useState("");
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const gaps = useQuery({ queryKey: ["deck-gaps", userId, deckId], queryFn: () => deckGaps(deckId), enabled: !!deckId });
  const done = () => void qc.invalidateQueries({ queryKey: ["plan", userId] });
  const add = useMutation({ mutationFn: addWant, onSuccess: () => setName(""), onSettled: done });
  const remove = useMutation({ mutationFn: removeWant, onSettled: done });
  const deckName = decks.data?.find((d) => d.id === deckId)?.name ?? null;
  const submit = (card: string, n: number, as: ShoppingWant["kind"] = kind) =>
    add.mutate({ kind: as, name: card.trim(), qty: n, priority, deck_id: deckId || null, deck_name: null, why: why.trim() || null });
  return (
    <section className="plan-section" aria-labelledby="trip-list">
      <h2 id="trip-list" className="plan-section-head">
        Your list <span className="num dim">{wants.length}</span>
      </h2>
      {wants.length > 0 && (
        <ul className="small">
          {wants.map((w) => (
            <li key={w.id}>
              {w.kind === "card" ? <CardRef name={w.name} oracleId={view.oracleId(w.name)} image={view.card(w.name)?.image_normal} /> : w.name}
              {w.qty > 1 ? ` ×${w.qty}` : ""}
              <span className="dim">
                {w.kind === "sealed" ? ", sealed" : ""}
                {w.priority === "along" ? ", only along the way" : ""}
                {w.deck_name ? `, for ${w.deck_name}` : ""}
                {w.why ? `. ${w.why}` : ""}
                {w.source === "assistant" ? " (added by a change from Claude)" : ""}
              </span>{" "}
              <button type="button" className="button outline small" disabled={remove.isPending} onClick={() => remove.mutate(w.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="trip-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) submit(name, qty);
        }}
      >
        <label>
          {kind === "card" ? "Card" : "Product"} <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </label>
        <label>
          How many <input type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
        </label>
        <label>
          <select value={kind} onChange={(e) => setKind(e.target.value as ShoppingWant["kind"])}>
            <option value="card">A card</option>
            <option value="sealed">A sealed product</option>
          </select>
        </label>
        <label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as ShoppingWant["priority"])}>
            <option value="need">{kind === "sealed" ? "Worth a trip for it" : "To buy: worth a trip"}</option>
            <option value="along">Only along the way</option>
          </select>
        </label>
        <label>
          For{" "}
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">No deck</option>
            {(decks.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Why <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} />
        </label>
        <button type="submit" className="button primary" disabled={add.isPending}>
          Add to the list
        </button>
      </form>
      <ErrorText error={add.error ?? remove.error} />
      {deckId && (
        <details className="plan-fold" open>
          <summary>
            {deckName ?? "This deck"}: cards your collection doesn't hold <span className="num dim">{gaps.data?.cards.length ?? ""}</span>
          </summary>
          <p className="dim small">Real copies counted across your whole collection, so a card another deck uses counts here too. Basic lands are left out.</p>
          {gaps.isLoading && <Loading small>Reading the deck…</Loading>}
          <ErrorText error={gaps.error} />
          <ul className="small">
            {(gaps.data?.cards ?? []).map((c) => (
              <li key={c.name}>
                <CardRef name={c.name} oracleId={view.oracleId(c.name)} image={view.card(c.name)?.image_normal} />{" "}
                <span className="dim">
                  {c.real ? `${c.real} of ${c.need} real` : c.need > 1 ? `${c.need} needed` : "none real"}
                  {c.proxy ? `, ${c.proxy} ${c.proxy === 1 ? "proxy" : "proxies"}` : ""}
                </span>{" "}
                <button type="button" className="button outline small" disabled={add.isPending} onClick={() => submit(c.name, Math.max(1, c.need - c.real), "card")}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * Sealed precons on your list: each store's newest price against your sealed cap, the sealed market
 * and the singles inside at market. A store price is a dated quote you typed, not a purchase; the
 * singles value is an estimate of the cards, not what they'd sell for.
 */
function Sealed({ stores, view, userId, going, trip }: { stores: Store[]; view: PlanView; userId: string; going: string[] | null; trip: string[] }) {
  const any = (view.b.shopping_wants ?? []).some((w) => w.kind === "sealed");
  const q = useQuery({
    queryKey: ["plan-sealed", userId, view.b.rev, view.today, going, trip],
    queryFn: () => sealedView(view.today, going, trip),
    enabled: any,
  });
  if (!any) return null;
  // Offline (or the request failed): the copy saved with your plan, which picks no store for
  // products along the way.
  // Judged again for your day and this trip, as the server would.
  const saved = !q.data && view.b.sealed ? sealedFor(view.b.sealed, view.b.settings as unknown as RuleSet[], view.today, going, trip) : null;
  const data = q.data ?? saved;
  const cap = data?.cap_usd ?? null;
  return (
    <section className="plan-section" aria-labelledby="trip-sealed">
      <h2 id="trip-sealed" className="plan-section-head">
        Sealed precons <span className="num dim">{q.data?.items.length ?? ""}</span>
      </h2>
      {saved && <p className="small">Showing the prices saved with your plan; reconnect for the latest.</p>}
      <p className="dim small">
        {!data ? "" : cap != null ? `Your cap: ${usd(cap)} a deck before tax. ` : "No sealed cap set (Plan settings). "}
        Store quotes are entered by hand. Singles show replacement market value. Sealed picks may add a stop.
      </p>
      {!data && <ErrorText error={q.error} />}
      {(data?.items ?? []).map((it) => (
        <SealedRow key={it.want} it={it} stores={stores} userId={userId} today={view.today} capped={cap != null} trip={trip} />
      ))}
    </section>
  );
}

function SealedRow({ it, stores, userId, today, capped, trip }: { it: SealedItem; stores: Store[]; userId: string; today: string; capped: boolean; trip: string[] }) {
  const qc = useQueryClient();
  const [picked, setStore] = useState(stores[0]?.key ?? "");
  // Always a store that's still listed (an import may add the first one or retire the one picked).
  const store = stores.some((s) => s.key === picked) ? picked : (stores[0]?.key ?? "");
  const [price, setPrice] = useState("");
  const [inStock, setInStock] = useState(true);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  // One id per price entered, so a retried save records it once; a changed form is a new price.
  const [entry, setEntry] = useState(() => crypto.randomUUID());
  useEffect(() => setEntry(crypto.randomUUID()), [store, price, inStock, date, note]);
  // The live view, and the plan bundle that keeps the offline copy.
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["plan-sealed", userId] });
    void qc.invalidateQueries({ queryKey: ["plan", userId] });
  };
  const add = useMutation({
    mutationFn: () => addSealedQuote(it.want, { store, price: price.trim() === "" ? null : Number(price), in_stock: inStock, checked_on: date, note: note.trim() || null, id: entry }),
    onSuccess: () => {
      setPrice("");
      setNote("");
      setEntry(crypto.randomUUID());
    },
    onSettled: done,
  });
  const remove = useMutation({ mutationFn: removeSealedQuote, onSettled: done });
  const pct = (p: number | null, what: string) => (p == null ? "" : p >= 0 ? `, ${p}% above ${what}` : `, ${-p}% below ${what}`);
  return (
    <div className="buy-store">
      <p>
        <b>{it.name}</b>
        {it.qty > 1 ? ` ×${it.qty}` : ""}
        {it.precon ? <span className="dim">{it.precon.set_name ? `, ${it.precon.set_name}` : ""}</span> : <span className="dim">, not matched to a precon Yama knows</span>}
      </p>
      {it.precon && (
        <p className="small">
          Sealed market {it.market ? `${it.market.usd != null ? usd(it.market.usd) : "unknown"}, ${fmtDate(it.market.price_date)} (${it.market.source})` : "unknown"}. Singles inside{" "}
          {it.singles?.usd != null ? usd(it.singles.usd) : "unknown"}
          {it.singles
            ? ` (${it.singles.priced_copies} priced${it.singles.unpriced_copies ? `, ${it.singles.unpriced_copies} without a price` : ""}; ${it.singles.source}${
                it.singles.oldest_date
                  ? `, ${fmtDate(it.singles.oldest_date)}${it.singles.newest_date && it.singles.newest_date !== it.singles.oldest_date ? ` to ${fmtDate(it.singles.newest_date)}` : ""}`
                  : ""
              })`
            : ""}
          .
        </p>
      )}
      <ul className="small">
        {it.quotes.length === 0 && <li className="dim">No store price recorded.</li>}
        {it.quotes.map((x) => (
          <li key={x.id}>
            {x.store_name}: {usd(x.price)}, {fmtDate(x.checked_on)}
            {x.in_stock ? "" : ", not in stock"}
            {x.over_cap ? ", over your cap" : ""}
            {x.store_live ? "" : ", a store no longer on your list"}
            {pct(x.vs_market_pct, "market")}
            {it.best === x.id ? (capped ? ". Best choice" : ". Cheapest in stock") : ""}
            {it.best === x.id && !trip.includes(x.store) ? ", an extra stop" : ""}
            {x.note ? <span className="dim">. {x.note}</span> : null}{" "}
            <button type="button" className="button outline small" disabled={remove.isPending} onClick={() => remove.mutate(x.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="trip-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (store) add.mutate();
        }}
      >
        <label>
          Store{" "}
          <select value={store} disabled={add.isPending} onChange={(e) => setStore(e.target.value)}>
            {stores.map((s) => (
              <option key={s.key} value={s.key}>
                {s.short ?? s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Price $<input type="number" min={0} step={0.01} value={price} disabled={add.isPending} onChange={(e) => setPrice(e.target.value)} placeholder="unknown" />
        </label>
        <label>
          <input type="checkbox" checked={inStock} disabled={add.isPending} onChange={(e) => setInStock(e.target.checked)} /> In stock
        </label>
        <label>
          On <input type="date" value={date} disabled={add.isPending} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Note <input value={note} disabled={add.isPending} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="what the store said" />
        </label>
        <button type="submit" className="button outline" disabled={add.isPending}>
          Record the price
        </button>
      </form>
      <ErrorText error={add.error ?? remove.error} />
    </div>
  );
}

/** The whole setting for one store, as the route takes it. */
function prefBody(p: StorePref | undefined, change: Partial<StorePrefBody>): StorePrefBody {
  const preference = p?.preference === "default" ? "favorite" : (p?.preference ?? "ok");
  return { preference, note: p?.note ?? null, hassle: p?.hassle ?? null, premium_usd: p?.premium_usd ?? null, ...change };
}

/** Your stores and how you feel about going to each. Yours alone: an import never changes them. */
function StorePrefs({ stores, view, userId, skipped }: { stores: Store[]; view: PlanView; userId: string; skipped: { store: Store; cards: number; why: SkipReason }[] }) {
  const qc = useQueryClient();
  const prefs = view.b.store_prefs ?? {};
  const set = useMutation({
    mutationFn: async (changes: { key: string; body: StorePrefBody }[]) => {
      for (const c of changes) await setStorePreference(c.key, c.body);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["plan", userId] }),
  });
  const reorder = useMutation({ mutationFn: setStoreOrder, onSettled: () => qc.invalidateQueries({ queryKey: ["plan", userId] }) });
  const busy = set.isPending || reorder.isPending;
  if (!stores.length) return null;
  const order = hassleOrder({ stores, store_prefs: prefs });
  const sorted = [...stores].sort((x, y) => order.get(x.key)! - order.get(y.key)!);
  // Moving a store swaps it with its neighbour; every store gets its place, so the order is all yours.
  const move = (i: number, by: -1 | 1) => {
    const next = [...sorted];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    reorder.mutate(next.map((s) => s.key));
  };
  return (
    <section className="plan-section trip-prefs" aria-labelledby="trip-prefs">
      <h2 id="trip-prefs" className="plan-section-head">Your stores</h2>
      <p className="dim small">
        Order stores by convenience. Favorites get qualifying cards within your premium; maybe stores fill gaps only.
      </p>
      {sorted.map((s, i) => {
        const missed = skipped.find((x) => x.store.key === s.key);
        const pref = storePreference(view.b, s.key);
        return (
          <div key={s.key} className="trip-pref">
            <span className="trip-pref-name">
              <b>
                {i + 1}. {s.name}
              </b>
              {s.location ? <span className="dim">, {s.location}</span> : null}
              {missed ? (
                <span className="dim small">
                  {" "}
                  Has {missed.cards === 1 ? "1 card" : `${missed.cards} cards`} you need ({SKIP_TEXT[missed.why]}).
                </span>
              ) : null}
            </span>
            <span className="trip-pref-controls">
              <select
                aria-label={`How you feel about ${s.name}`}
                value={pref}
                disabled={busy}
                onChange={(e) => set.mutate([{ key: s.key, body: prefBody(prefs[s.key], { preference: e.target.value as StorePreference }) }])}
              >
                {CHOICES.map((c) => (
                  <option key={c} value={c}>
                    {PREFERENCE_TEXT[c]}
                  </option>
                ))}
              </select>
              {pref === "favorite" && (
                <Premium
                  store={s}
                  value={storePremium(view.b, s.key)}
                  disabled={busy}
                  onSave={(v) => set.mutate([{ key: s.key, body: prefBody(prefs[s.key], { premium_usd: v }) }])}
                />
              )}
              <button type="button" className="trip-move" aria-label={`${s.name} is easier to get to`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="trip-move"
                aria-label={`${s.name} is harder to get to`}
                disabled={busy || i === sorted.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </span>
          </div>
        );
      })}
      {(set.error || reorder.error) && <ErrorText error={set.error ?? reorder.error} />}
    </section>
  );
}

/** "Up to $0.25 more a card here": how much a favourite may cost above the cheapest and still get the card. */
function Premium({ store, value, disabled, onSave }: { store: Store; value: number; disabled: boolean; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value ? value.toFixed(2) : "");
  const save = () => {
    const v = text.trim() === "" ? null : Number(text);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 10)) return setText(value ? value.toFixed(2) : "");
    if ((v ?? 0) !== value) onSave(v || null);
  };
  return (
    <label className="trip-premium small">
      up to $
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={10}
        step={0.05}
        placeholder="0.00"
        aria-label={`How much more a card may cost at ${store.name}`}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />{" "}
      more
    </label>
  );
}
