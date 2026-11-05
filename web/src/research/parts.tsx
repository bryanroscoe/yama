import { GROUP_ORDER, groupOf } from "@yama/core";
import { fmtDate, usd } from "@yama/core/plan";
import { useEffect, useState, type ReactNode } from "react";
import { CardHover, CardRef } from "../components/CardRef";
import { CardImage } from "../components/ui";
import { CopyButton } from "../plan/parts";
import { cardsWord, type ChangeRow, type GetId, type ListCard, type ShopItem, type ShoppingData, type Totals } from "./view";

/**
 * The pieces a note's pages share with the shared page (`/r/<token>`, server/src/sharing/research.rs):
 * the same sections in the same order, drawn with the app's own components.
 */

/** A row of choices, the chosen one filled: builds, how to get the cards. */
export function Choices<T extends string>({ label, title, options, value, onChange }: { label: string; title?: string; options: { id: T; label: string; disabled?: boolean }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="choice-chips" role="group" aria-label={label}>
      {title && <span className="dim small">{title}</span>}
      {options.map((o) => (
        <button key={o.id} type="button" className="choice-chip" aria-pressed={o.id === value} disabled={o.disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A section's heading with its small count line above it, as the shared page has. */
export function SectionHead({ id, eyebrow, children, after }: { id?: string; eyebrow?: ReactNode; children: ReactNode; after?: ReactNode }) {
  return (
    <div className="note-section-head">
      <div>
        {eyebrow && <p className="note-eyebrow">{eyebrow}</p>}
        <h2 id={id}>{children}</h2>
      </div>
      {after}
    </div>
  );
}

/** Text to copy, with a Copy button; the text can also be selected by hand. */
export function CopyBox({ title, text, rows = 8 }: { title: string; text: string; rows?: number }) {
  return (
    <div className="note-copy-box">
      <div className="note-copy-head">
        <b>{title}</b>
        <CopyButton text={text} label="Copy" className="outline small" />
      </div>
      <textarea readOnly rows={rows} value={text} aria-label={title} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

/** "about $83.45", the buys' known cost, or what's missing from it. */
function buyMoney(t: Totals): string {
  if (t.buy_uncosted === 0) return `about ${usd(t.buy_cost)}`;
  if (t.buy_uncosted === t.buy) return "cost unknown";
  return `about ${usd(t.buy_cost)} + ${t.buy_uncosted} without a price`;
}

const money = (v: number | null) => (v == null ? "Unknown" : usd(v));

/** When the prices are from: one date, or the range. */
function asOf(s: ShoppingData): string {
  if (!s.prices_from || !s.prices_to) return "";
  return s.prices_from === s.prices_to ? `, as of ${fmtDate(s.prices_from)}` : `, from ${fmtDate(s.prices_from)} to ${fmtDate(s.prices_to)}`;
}

/** The totals as pills, and how they're worked out. */
export function ShoppingTotals({ s }: { s: ShoppingData }) {
  const t = s.total;
  return (
    <>
      <div className="note-pills">
        <span className="pill">{cardsWord(t.cards)}</span>
        {(t.buy > 0 || s.get === "split") && <span className="pill">{t.buy} to buy locally: {buyMoney(t)}</span>}
        {(t.print > 0 || s.get === "split") && <span className="pill">{t.print} to print: about {usd(t.print_cost)}</span>}
        <span className="pill">{t.worth == null ? "Worth unknown" : `Worth ${usd(t.worth)}`}</span>
        <span className="pill">{t.cost == null ? "Cost unknown" : `About ${usd(t.cost)} to get`}</span>
      </div>
      <p className="small dim note-how">
        Market price is each card's cheapest paper printing at TCGplayer market, from Scryfall{asOf(s)}. {s.explain} Worth is what the cards sell for. The cost is an
        estimate: buys at market price (a store's own price will differ) plus prints.
        {t.unpriced > 0 && ` ${cardsWord(t.unpriced)} without a market price in Yama ${t.unpriced === 1 ? "is" : "are"} out of the worth.`}
        {t.uncosted > 0 && ` ${cardsWord(t.uncosted)} without a known cost ${t.uncosted === 1 ? "is" : "are"} out of the cost.`}
      </p>
    </>
  );
}

const GET_LABEL: Record<ShopItem["get"], string> = { buy: "Buy locally", print: "Print", unknown: "No price" };

/** A card with its copies on one line: "2× Name", the name previewing the card. */
function CardLine({ name, n, image }: { name: string; n: number; image?: string | null }) {
  return (
    <span className="note-card-line">
      {n > 1 && <span className="note-qty num">{n}×</span>}
      <CardRef name={name} image={image ?? undefined} />
    </span>
  );
}

/** Every card to get: buys first, then prints, then cards without a price. */
export function ShoppingTable({ s, decks = false }: { s: ShoppingData; decks?: boolean }) {
  return (
    <div className="note-table-wrap">
      <table className="note-table">
        <thead>
          <tr>
            <th scope="col">Card</th>
            {decks && <th scope="col">Decks</th>}
            <th scope="col">Get it</th>
            <th scope="col" className="num">Market</th>
            <th scope="col" className="num">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {s.items.map((t) => (
            <tr key={t.name}>
              <td><CardLine name={t.name} n={t.n} image={t.image} /></td>
              {decks && <td className="dim">{t.decks.join(", ")}</td>}
              <td>{GET_LABEL[t.get]}</td>
              <td className="num">{money(t.usd)}</td>
              <td className="num">{money(t.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The shopping list as standard text ("2 Card Name"), one box per way of getting the cards. */
export function ShoppingText({ s }: { s: ShoppingData }) {
  const boxes = (["buy", "print", "unknown"] as const).flatMap((get) => {
    const items = s.items.filter((t) => t.get === get);
    if (!items.length) return [];
    const lines = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((t) => `${t.n} ${t.name}`);
    const title = { buy: "Buy locally", print: "Print", unknown: "No price yet" }[get];
    return [<CopyBox key={get} title={`${title} (${cardsWord(items.reduce((n, t) => n + t.n, 0))})`} text={`${lines.join("\n")}\n`} />];
  });
  return (
    <>
      <h3 className="note-copy-title">Copy the shopping list</h3>
      <div className="note-copy-grid">{boxes}</div>
    </>
  );
}

/** How to get the cards: buy the cheap ones and print the rest, buy all or print all. Under the
 *  split, `onUpTo` sets its limit in dollars ("3.50"), or null for the suggested one. */
export function GetChoices({ s, onChange, onUpTo }: { s: ShoppingData; onChange: (g: GetId) => void; onUpTo?: (dollars: string | null) => void }) {
  return (
    <>
      <Choices label="How to get the cards" title="Get" options={s.gets} value={s.get} onChange={onChange} />
      {s.get === "split" && onUpTo && <UpTo value={s.up_to} max={s.up_to_max} onSet={(d) => onUpTo(Number(d) === s.up_to_suggested ? null : d)} />}
    </>
  );
}

/** The split's limit: a dollar field, applied on Update (or Enter), not on every keystroke. */
function UpTo({ value, max, onSet }: { value: number; max: number; onSet: (dollars: string) => void }) {
  const [draft, setDraft] = useState(value.toFixed(2));
  useEffect(() => setDraft(value.toFixed(2)), [value]);
  return (
    <form
      className="note-upto"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(draft);
        if (draft.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= max) onSet(n.toFixed(2));
      }}
    >
      <label htmlFor="note-upto">
        Buy cards up to<span className="visually-hidden"> (US dollars)</span>
      </label>
      <span className="note-upto-field">
        <span aria-hidden="true">$</span>
        <input id="note-upto" type="number" inputMode="decimal" min={0} max={max} step={0.01} required value={draft} onChange={(e) => setDraft(e.target.value)} />
      </span>
      <button type="submit" className="button outline">
        Update
      </button>
    </form>
  );
}

/** The changes, as a table to work through with the deck box open. `extra` adds a cell per row
 *  (the owner's answers). */
export function ChangesTable({ rows, extra }: { rows: ChangeRow[]; extra?: (row: ChangeRow) => ReactNode }) {
  return (
    <div className="note-table-wrap">
      <table className="note-table note-changes">
        <thead>
          <tr>
            <th scope="col">Add</th>
            <th scope="col">Cut</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.add}|${c.cut}|${i}`}>
              <td>{c.add ? <CardLine name={c.add} n={c.n} image={c.add_image} /> : <span className="dim">Nothing</span>}</td>
              <td>{c.cut ? <CardLine name={c.cut} n={c.n} image={c.cut_image} /> : <span className="dim">Nothing</span>}</td>
              <td>
                {c.why}
                {c.notes.map((n) => (
                  <span key={n} className="dim note-row-note">{n}</span>
                ))}
                {extra?.(c)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How many cards a collapsed stack shows before "Show all", as on a deck's page. */
const STACK_PEEK = 6;

/** A build's list as stacks of card images by type, or as a list, as a deck's page shows one. */
export function CardViews({ cards }: { cards: ListCard[] }) {
  const [layout, setLayout] = useState<"stacks" | "list">("stacks");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = GROUP_ORDER.flatMap((g) => {
    const rows = cards.filter((c) => groupOf(c.board, c.type_line) === g).sort((a, b) => a.cmc - b.cmc || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return rows.length ? [[g, rows] as const] : [];
  });
  return (
    <div className="note-cards">
      <div className="segmented note-layout" role="group" aria-label="View">
        <button type="button" aria-pressed={layout === "stacks"} onClick={() => setLayout("stacks")}>Stacks</button>
        <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
      </div>
      {layout === "stacks" ? (
        <div className="deck-stacks note-stacks">
          {groups.map(([group, rows]) => {
            const count = rows.reduce((n, c) => n + c.qty, 0);
            const all = expanded.has(group) || rows.length <= STACK_PEEK + 1;
            return (
              <section key={group} className="deck-stack" aria-label={group}>
                <h3>
                  {group} <span className="deck-stack-meta num">{count}</span>
                </h3>
                <div className="stack-cards">
                  {(all ? rows : rows.slice(0, STACK_PEEK)).map((c) => (
                    <span key={`${c.board}-${c.name}`} className="stack-card" aria-label={`${c.qty > 1 ? `${c.qty} ` : ""}${c.name}`}>
                      <CardHover name={c.name} image={c.image ?? undefined}>
                        <CardImage src={c.image} name={c.name} />
                      </CardHover>
                      {c.qty > 1 && <span className="qty-badge num">×{c.qty}</span>}
                    </span>
                  ))}
                </div>
                {rows.length > STACK_PEEK + 1 && (
                  <button
                    type="button"
                    className="small stack-more"
                    onClick={() =>
                      setExpanded((cur) => {
                        const next = new Set(cur);
                        if (next.has(group)) next.delete(group);
                        else next.add(group);
                        return next;
                      })
                    }
                  >
                    {expanded.has(group) ? "Show fewer" : `Show all ${rows.length}`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="note-list-groups">
          {groups.map(([group, rows]) => (
            <section key={group} className="note-list-group">
              <h3>
                {group} <span className="deck-stack-meta num">{rows.reduce((n, c) => n + c.qty, 0)}</span>
              </h3>
              <ul>
                {rows.map((c) => (
                  <li key={`${c.board}-${c.name}`}>
                    <span className="num note-qty">{c.qty}</span>
                    <CardRef name={c.name} image={c.image ?? undefined} />
                    {c.type_line && <span className="dim small"> {c.type_line}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
