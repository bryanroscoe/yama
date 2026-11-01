import { CardRef } from "../components/CardRef";
import {
  boughtInfo,
  fmtDate,
  planTrip,
  PREFERENCE_TEXT,
  storePreference,
  usd,
  type PrintRow,
  type Store,
  type StorePreference,
  type TripRow,
} from "@yama/core/plan";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { ErrorText } from "../components/ui";
import { setStorePreference } from "./api";
import { marketSentence } from "./marks";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import type { PlanView } from "./view";

const CHOICES: StorePreference[] = ["default", "ok", "maybe", "never"];

/** Why a needed card isn't on the trip, in words. */
function printReason(p: PrintRow): string {
  const at = p.offer ? `${usd(p.offer.price)} at ${p.offer.store.name}` : "";
  switch (p.reason) {
    case "never-store":
      return `Only at ${p.stores.join(", ")}, where you won't go (${at}).`;
    case "not-local":
      return `Only at ${p.stores.join(", ")}, which isn't local, and your rule is to buy locally (${at}).`;
    case "over-max":
      return `Over your limit (${at}). Print it; it stays on your real-card wishlist.`;
    case "over-market":
      return `Above your rule for its market (${at}).`;
    case "no-market":
      return `No market price to judge it by (${at}).`;
    case "no-price":
      return "In stock with no listed price. Ask the store.";
    case "unknown-stock":
      return "Listed, but the check didn't say whether it's in stock. Ask the store.";
    case "not-stocked":
      return "Not in stock at the last check.";
    default:
      return "No store check recorded.";
  }
}

/** `/decks/plan/trip`: which of your stores to visit, and what to print instead (docs/shopping-design.md). */
export function Trip() {
  const { view, userId } = usePlanOutlet();
  const trip = useMemo(
    () => planTrip(view.b, { today: view.today, answers: view.answers, bought: (k) => !!boughtInfo(view.markBy.get(k)?.bought) }),
    [view],
  );
  const stores = view.b.stores.filter((s) => !s.retired && s.kind !== "printer");
  const nameOf = (key: string) => view.b.stores.find((s) => s.key === key)?.name ?? key;
  // Every art crop on the page, credited at the bottom.
  const shownArtists = [...trip.stops.flatMap((st) => [...st.rows, ...st.along].map((r) => r.want.card)), ...trip.print.map((p) => p.want.card)].map(
    (c) => view.card(c)?.artist,
  );

  return (
    <>
      <PlansHead title="Store trip" />
      <div className="area-note warn" role="note">
        <p>
          {trip.checkedOn.length
            ? `Store listings checked ${fmtDate(trip.checkedOn[0])}${trip.checkedOn.length > 1 ? ` to ${fmtDate(trip.checkedOn[trip.checkedOn.length - 1])}` : ""}. Recheck before going in.`
            : "No store stock checks in the plan."}{" "}
          {trip.rule.text}
        </p>
        <p className="small">
          A listing is a dated quote, not a purchase. Cards in the plan and proposals you want decide the stores; undecided proposals and your wishlist only come
          along from stores you're visiting anyway.
        </p>
      </div>

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

      {trip.stops.length === 0 && <p className="empty">No store has a card you need under your rule. See below for what to print.</p>}

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
                <a className="button primary buy-cart" href={st.cartUrl} target="_blank" rel="noreferrer" title="Replaces what's in that cart now">
                  Fill the cart
                </a>
              )}
            </header>
            {st.noCartLine > 0 && <p className="buy-store-note">{st.noCartLine === 1 ? "1 card has" : `${st.noCartLine} cards have`} no cart line: ask at the counter.</p>}
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
          <p className="dim small">Undecided proposals and wishlist cards. Not worth a trip on their own.</p>
          <ul className="small">
            {trip.elsewhere.map((e) => (
              <li key={e.store.key}>
                {e.store.name}: {e.rows.map((r) => `${r.want.card} ${usd(r.offer.price)}`).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <StorePrefs stores={stores} view={view} userId={userId} skipped={trip.skipped} />

      {trip.wishlist.length > 0 && (
        <section className="plan-section" aria-labelledby="trip-wishlist">
          <h2 id="trip-wishlist" className="plan-section-head">Real-card wishlist</h2>
          <p className="dim small">Cards you print for now and want real copies of someday, by cheapest non-foil market. A watchlist, not a purchase.</p>
          {trip.wishlist.map((t) => (
            <details key={t.label} className="plan-fold">
              <summary>
                {t.label} <span className="dim num">{t.items.length}{t.market != null ? `, ${usd(t.market)} at market` : ""}</span>
              </summary>
              <ul className="small">
                {t.items.map((x) => (
                  <li key={x.want.id}>
                    <CardRef name={x.want.card} oracleId={view.oracleId(x.want.card)} image={view.card(x.want.card)?.image_normal} />{" "}
                    <span className="dim">{x.market ? `${usd(x.market.usd)}, ${fmtDate(x.market.date)}` : "no market price"}</span>
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
  const what = want.source === "wishlist" ? "Your real-card wishlist" : `${want.deckName ?? ""}${want.source === "proposal" && !want.needed ? ", proposed, not decided" : ""}`;
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

/** Your stores and how you feel about going to each. Yours alone: an import never changes them. */
function StorePrefs({ stores, view, userId, skipped }: { stores: Store[]; view: PlanView; userId: string; skipped: { store: Store; cards: number }[] }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: ({ key, preference }: { key: string; preference: StorePreference }) => setStorePreference(key, preference === "ok" ? null : preference),
    onSettled: () => qc.invalidateQueries({ queryKey: ["plan", userId] }),
  });
  if (!stores.length) return null;
  return (
    <section className="plan-section trip-prefs" aria-labelledby="trip-prefs">
      <h2 id="trip-prefs" className="plan-section-head">Your stores</h2>
      <p className="dim small">The trip never sends you to a store you won't go to, and visits a "maybe" store only for cards no other store has.</p>
      {stores.map((s) => {
        const missed = skipped.find((x) => x.store.key === s.key)?.cards;
        return (
          <label key={s.key} className="trip-pref">
            <span>
              <b>{s.name}</b>
              {s.location ? <span className="dim">, {s.location}</span> : null}
              {missed ? <span className="dim small"> Has {missed === 1 ? "1 card" : `${missed} cards`} you need.</span> : null}
            </span>
            <select
              value={storePreference(view.b, s.key)}
              disabled={set.isPending}
              onChange={(e) => set.mutate({ key: s.key, preference: e.target.value as StorePreference })}
            >
              {CHOICES.map((c) => (
                <option key={c} value={c}>
                  {PREFERENCE_TEXT[c]}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {set.error && <ErrorText error={set.error} />}
    </section>
  );
}
