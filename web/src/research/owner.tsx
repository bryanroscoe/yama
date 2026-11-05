import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { useMe } from "../auth";
import { CardRef, CardText } from "../components/CardRef";
import { ErrorText } from "../components/ui";
import { changedAnswer, money, safeUrl, saveReview, type Combo, type Item, type ResearchBundle, type ReviewOp, type Scenario, type Source } from "./api";

/**
 * What only a note's owner sees: their answers for the agent, and the agent's own evidence
 * (owned copies, store quotes, local searches, combos, sources). A shared note shows none of it
 * (`deck_research::public_view`), and a copy of one has none.
 */

export const LocalChecks = createContext<NonNullable<ResearchBundle["document"]["local_checks"]>>({});

export function Sources({ sources = [] }: { sources?: Source[] }) {
  return (
    <ul className="research-sources">
      {sources.map((s, i) => (
        <li key={`${s.url}-${i}`}>
          {safeUrl(s.url) ? (
            <a href={safeUrl(s.url)} target="_blank" rel="noreferrer">
              {s.title}
            </a>
          ) : (
            s.title
          )}
          {s.accessed && <span className="dim small"> — checked {s.accessed}</span>}
        </li>
      ))}
    </ul>
  );
}

const KINDS: Record<string, string> = {
  keep: "Keep in this deck",
  sealed_purchase: "Precon purchase required",
  owned: "Available owned card",
  transfer: "Move from another deck",
  arrived_print: "Print already here",
  future_stock: "Stock after purchase/arrival",
  buy: "Local buy",
  print: "New print",
  basic: "Basic land",
  unknown: "Check source",
};

/** One card the agent allocated: where it comes from, with any store quote and search evidence. */
export function AcquisitionItem({ item, showCard = true }: { item: Item; showCard?: boolean }) {
  const quote = item.quote ?? item;
  const check = useContext(LocalChecks)[item.local_check ?? item.card ?? ""];
  return (
    <div className="research-item">
      {showCard && (
        <p>
          <b>
            {item.qty && item.qty > 1 ? `${item.qty} × ` : ""}
            {item.card && (item.kind === "sealed_purchase" ? item.card : <CardRef name={item.card} />)}
          </b>
          {item.deck && <span className="dim"> — {item.deck}</span>}
        </p>
      )}
      {item.kind && <span className={`research-tag kind-${item.kind}`}>{KINDS[item.kind] ?? item.kind}</span>}
      {item.kind === "transfer" && item.source_deck && <p className="small">Move from {item.source_deck} once its replacement is ready.</p>}
      {item.detail && (
        <details className="small research-provenance">
          <summary>Source details</summary>
          <p>{item.detail}</p>
        </details>
      )}
      {item.reason && <p className="small dim">{item.reason}</p>}
      {(quote.store || item.kind === "buy") && (
        <p className="small">
          <b>
            {quote.store || "Store unverified"}: {money(quote.price)}
          </b>{" "}
          before tax{quote.printing && `, ${quote.printing}`}
          {quote.condition && `, ${quote.condition}`}
          <br />
          {item.kind === "sealed_purchase" ? "Sealed market reference" : "Matched market"}: {money(quote.market)}
          {quote.checked && `; checked ${quote.checked}`}
          {safeUrl(quote.url) && (
            <>
              .{" "}
              <a href={safeUrl(quote.url)} target="_blank" rel="noreferrer">
                Store listing
              </a>
            </>
          )}
        </p>
      )}
      {check && (
        <details className="small">
          <summary>Local search evidence</summary>
          <p>{check.reason}</p>
          <p className="dim">{check.coverage}</p>
          <ul>
            {check.local_checks?.map((s, i) => (
              <li key={i}>
                {s.store}, checked {s.checked ?? check.checked ?? "date unknown"}
                {s.search_may_be_truncated ? "; search may be incomplete" : ""}
                {!!s.errors?.length && `; unresolved: ${s.errors.join("; ")}`}
              </li>
            ))}
          </ul>
          {check.market_reference && (
            <p>
              Cheapest priced market reference: {money(check.market_reference.market)}
              {check.market_reference.set && `, ${check.market_reference.set.toUpperCase()} #${check.market_reference.num}`}
              {safeUrl(check.market_reference.url) && (
                <>
                  .{" "}
                  <a href={safeUrl(check.market_reference.url)} target="_blank" rel="noreferrer">
                    Market source
                  </a>
                </>
              )}
              . This is a market reference, not a store offer.
            </p>
          )}
          {check.rejected_offers?.map((r, i) => (
            <p key={i}>
              {r.store}: {money(r.price)}, {r.printing}. {r.reason}
              {safeUrl(r.url) && (
                <>
                  {" "}
                  <a href={safeUrl(r.url)} target="_blank" rel="noreferrer">
                    Listing
                  </a>
                </>
              )}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

/** The owner's answer on a build or a swap, for the next agent. Answers never apply a change. */
export function ReviewEditor({ bundle, target, buildId, compact = false }: { bundle: ResearchBundle; target: string; buildId?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const answer = bundle.reviews.find((r) => r.target === target);
  const [note, setNote] = useState(answer?.note ?? "");
  const save = useMutation({
    mutationFn: (op: ReviewOp) => saveReview(bundle.document.id, op),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["research", userId, bundle.document.id] });
    },
  });
  const decide = (decision: string | null) => {
    const hash = bundle.target_hashes[target];
    if (hash) save.mutate({ op_id: crypto.randomUUID(), target, decision, note: note.trim() || null, expected_version: answer?.version ?? 0, target_hash: hash });
  };
  const stale = answer && changedAnswer(bundle, answer);
  const status = save.isPending ? "Saving…" : save.isError ? "Latest edit not saved" : save.isSuccess || answer ? "Saved in Yama" : "No answer yet";
  return (
    <div className={`research-review${compact ? " is-compact" : ""}`}>
      {stale && <p className="small warn">The note changed since your answer. Your previous answer is kept; answer again.</p>}
      <div className="research-review-actions">
        {buildId ? (
          <button
            type="button"
            className={answer?.decision === buildId && !stale ? "primary" : "outline"}
            aria-pressed={answer?.decision === buildId && !stale}
            disabled={save.isPending}
            onClick={() => decide(answer?.decision === buildId && !stale ? null : buildId)}
          >
            {answer?.decision === buildId && !stale ? "Preferred build ✓" : "Prefer this build"}
          </button>
        ) : (
          ([
            ["want", "Want"],
            ["unsure", "Unsure"],
            ["no", "Don’t want"],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={`small ${answer?.decision === value && !stale ? "primary" : "outline"}`}
              aria-pressed={answer?.decision === value && !stale}
              disabled={save.isPending}
              onClick={() => decide(answer?.decision === value && !stale ? null : value)}
            >
              {label}
            </button>
          ))
        )}
        <span className="small dim" role="status">
          {status}
        </span>
      </div>
      <details className="research-note-fold" open={!compact || !!answer?.note}>
        <summary className="small">Your note for the agent</summary>
        <label className="research-note">
          <span className="visually-hidden">Your note</span>
          <textarea rows={2} maxLength={6000} value={note} disabled={save.isPending} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="button" className="outline small" disabled={save.isPending || note === (answer?.note ?? "")} onClick={() => decide(answer?.decision ?? null)}>
          Save note
        </button>
      </details>
      <ErrorText error={save.error} />
      {save.isError && save.variables && (
        <button type="button" className="outline small" onClick={() => save.mutate(save.variables!)}>
          Retry same save
        </button>
      )}
    </div>
  );
}

export function ComboCard({ combo }: { combo: Combo }) {
  const names = combo.cards ?? [];
  return (
    <details className={`research-combo ${combo.present === false ? "is-missing" : ""}`}>
      <summary>
        <b>{combo.name}</b>{" "}
        <span className="dim small">
          {combo.kind}
          {combo.is_caution ? " — rules caution" : combo.present === false ? " — missing pieces" : " — pieces in this list"}
        </span>
      </summary>
      <p className="small">
        {names.map((name, i) => (
          <span key={name}>
            {i > 0 && " + "}
            <CardRef name={name} />
          </span>
        ))}
      </p>
      {!!combo.missing_cards?.length && (
        <p className="warn small">
          Missing:{" "}
          {combo.missing_cards.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <CardRef name={name} />
            </span>
          ))}
        </p>
      )}
      {!!combo.setup?.length && (
        <>
          <h4>Setup</h4>
          <ul>{combo.setup.map((x, i) => <li key={i}><CardText text={x} names={names} /></li>)}</ul>
        </>
      )}
      {!!combo.steps?.length && (
        <>
          <h4>Sequence</h4>
          <ol>{combo.steps.map((x, i) => <li key={i}><CardText text={x} names={names} /></li>)}</ol>
        </>
      )}
      {combo.outcome && (
        <p>
          <b>Outcome:</b> <CardText text={combo.outcome} names={names} />
        </p>
      )}
      {!!combo.stop_points?.length && (
        <>
          <h4>Where it stops</h4>
          <ul>{combo.stop_points.map((x, i) => <li key={i}><CardText text={x} names={names} /></li>)}</ul>
        </>
      )}
      {combo.bracket_fit && <p className="small">{combo.bracket_fit}</p>}
      <Sources sources={combo.sources} />
    </details>
  );
}

/** A standing list of cards to watch for real copies, kept apart from orders. */
export function PrintedWishlist({ scenarios = [] }: { scenarios?: Scenario[] }) {
  return (
    <>
      {scenarios
        .filter((s) => s.purpose === "permanent_real_wishlist")
        .map((wishlist) => (
          <section key={wishlist.id} className="note-section" id="printed-real-wishlist">
            <h2>{wishlist.label}</h2>
            <p>{wishlist.note}</p>
            <details>
              <summary>{wishlist.buys?.length ?? 0} card names to keep watching for real copies</summary>
              {wishlist.buys?.map((item, i) => (
                <div className="research-item" key={`${item.card}-${i}`}>
                  <p>
                    <b>{item.card && <CardRef name={item.card} />}</b>
                  </p>
                  {item.reason && <p className="small">{item.reason}</p>}
                  {item.detail && <p className="small dim">{item.detail}</p>}
                  <p className="small dim">Local price and stock: Unknown. Quantity to buy: undecided.</p>
                  {safeUrl(item.url) && (
                    <a className="small" href={safeUrl(item.url)} target="_blank" rel="noreferrer">
                      Card reference
                    </a>
                  )}
                </div>
              ))}
            </details>
          </section>
        ))}
    </>
  );
}

/** The agent's own store-checked buy and print lists across the decks, when the note has them:
 *  alternatives, so their totals don't add up. */
export function AgentShopping({ scenarios: allScenarios = [], defaultId }: { scenarios?: Scenario[]; defaultId?: string }) {
  const scenarios = allScenarios.filter((s) => s.purpose !== "permanent_real_wishlist");
  const [selected, setSelected] = useState(defaultId ?? scenarios.find((s) => s.id === "default")?.id ?? scenarios[0]?.id);
  const scenario = scenarios.find((s) => s.id === selected) ?? scenarios[0];
  if (!scenario) return null;
  const singles = scenario.buys?.reduce((n, r) => n + (r.qty ?? 1), 0) ?? 0;
  return (
    <section className="note-section research-shopping">
      <h2>Your agent's store checks</h2>
      <p className="small dim">
        Quotes your agent found at stores, by option. Options are alternatives; don't add their totals. Quotes and availability are dated, and a missing offer isn't proof
        a store has none.
      </p>
      {scenarios.length > 1 && (
        <label className="research-select">
          Option
          <select value={scenario.id} onChange={(e) => setSelected(e.target.value)}>
            {scenarios.map((s) => (
              <option value={s.id} key={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>{scenario.note}</p>
      {!!scenario.sealed_purchases?.length && (
        <div className="research-sealed">
          <h3>Buy these precons first</h3>
          <p className="small dim">
            These decks are planned purchases. Their cards are projected stock, not cards you own now. Sealed deck prices are separate from the singles total.
          </p>
          {scenario.sealed_purchases.map((r, i) => (
            <AcquisitionItem key={i} item={r} />
          ))}
        </div>
      )}
      <p className="research-shopping-total">
        <b>
          {singles} local singles; {money(scenario.buy_total)} before tax; {scenario.print_count ?? scenario.prints?.length ?? 0} proposed prints
        </b>
      </p>
      <div className="research-acquisition-grid">
        <details open>
          <summary>Local singles order list</summary>
          {scenario.buys?.map((r, i) => (
            <AcquisitionItem key={i} item={r} />
          ))}
        </details>
        <details>
          <summary>Proposed print order</summary>
          {scenario.prints?.map((r, i) => (
            <AcquisitionItem key={i} item={r} />
          ))}
        </details>
      </div>
    </section>
  );
}
