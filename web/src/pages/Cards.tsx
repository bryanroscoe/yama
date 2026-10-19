import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, priceSource, usd, type Card, type Printing, type SearchResult } from "../api";
import { ArtPanel } from "../components/ArtPanel";
import { CardImage, ErrorText, ManaCost, Pips, Sheet } from "../components/ui";
import { offlineCard, offlineSearch } from "../offline/cards";
import { PriceHistory } from "../components/PriceHistory";

/** Network trouble (not a bad query): fall back to the copy on this device. */
const isNetworkError = (e: unknown) => e instanceof TypeError || !navigator.onLine;

const EXAMPLES = [
  { q: "id<=ug is:commander", label: "Simic commanders" },
  { q: 't:land o:"enters tapped" -o:"unless" id<=wr', label: "Boros taplands" },
  { q: 'o:"draw a card" mv<=2 id<=ub', label: "Cheap Dimir draw" },
  { q: "kw:flying t:creature pow>=4", label: "Big flyers" },
];

export function CardsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const order = params.get("order") ?? "name";
  const page = Number(params.get("page") ?? 1);
  const [draft, setDraft] = useState(q);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setDraft(q), [q]);

  const results = useQuery({
    queryKey: ["search", q, order, page],
    queryFn: async (): Promise<SearchResult & { offline?: boolean }> => {
      try {
        return await api<SearchResult>(`/api/cards/search?q=${encodeURIComponent(q)}&order=${order}&page=${page}`);
      } catch (e) {
        if (isNetworkError(e)) return offlineSearch(q, order, page);
        throw e;
      }
    },
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    setParams(next);
  };
  const pages = results.data ? Math.ceil(results.data.total / results.data.page_size) : 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Cards</h1>
      </div>
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: draft, page: "1" });
        }}
      >
        <input
          style={{ flex: "1 1 18rem" }}
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Name, or syntax like t:elf id<=gw"
          aria-label="Search cards"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <select value={order} onChange={(e) => set({ order: e.target.value, page: "1" })} aria-label="Sort by" style={{ width: "auto" }}>
          <option value="name">Name</option>
          <option value="edhrec">Most played</option>
          <option value="mv">Mana value</option>
          <option value="color">Color</option>
        </select>
        <button className="primary">Search</button>
      </form>

      {!q && (
        <div style={{ marginTop: "1.5rem" }}>
          <p className="dim">Search works like Scryfall: <code>o:</code> rules text, <code>t:</code> type, <code>id&lt;=</code> fits a commander, <code>mv</code>, <code>pow</code>, <code>f:commander</code>, <code>-</code> to exclude, <code>or</code> and parentheses.</p>
          <div className="row">
            {EXAMPLES.map((e) => (
              <button key={e.q} onClick={() => set({ q: e.q, page: "1" })}>{e.label}</button>
            ))}
          </div>
        </div>
      )}

      <ErrorText error={results.error} />
      {results.data && (
        <>
          <p className="dim small" style={{ margin: "1rem 0" }}>
            {results.data.total.toLocaleString()} {results.data.total === 1 ? "card" : "cards"}
            {results.data.offline && ", searched on this device while offline"}
          </p>
          <div className="card-grid">
            {results.data.cards.map((c) => (
              <button key={c.oracle_id} onClick={() => setOpen(c.oracle_id)} aria-label={c.name}>
                <CardImage src={c.image_normal} name={c.name} />
              </button>
            ))}
          </div>
          {pages > 1 && (
            <div className="row" style={{ marginTop: "1rem" }}>
              <button disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
              <span className="dim num">Page {page} of {pages}</span>
              <button disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </>
      )}
      {open && <CardSheet oracleId={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

export function CardSheet({ oracleId, onClose }: { oracleId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["card", oracleId],
    queryFn: async () => {
      try {
        return await api<{ card: Card; printings: Printing[] }>(`/api/cards/${oracleId}`);
      } catch (e) {
        const card = isNetworkError(e) ? await offlineCard(oracleId) : null;
        if (card) return { card, printings: [] as Printing[] };
        throw e;
      }
    },
  });
  const [flipped, setFlipped] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [allPrintings, setAllPrintings] = useState(false);
  const [chart, setChart] = useState<{ id: string; finish: "nonfoil" | "foil" | "etched"; set: string } | null>(null);
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (v: { p: Printing; finish: string }) =>
      api("/api/collection/ops", {
        method: "POST",
        json: [{ op_id: crypto.randomUUID(), kind: "add", scryfall_id: v.p.scryfall_id, qty: 1, finish: v.finish }],
      }),
    onSuccess: (_, v) => {
      setAdded(`Added ${v.finish === "nonfoil" ? "a" : `a ${v.finish}`} ${v.p.set_name} copy to your collection.`);
      void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("collection") });
    },
  });
  const card = detail.data?.card;
  return (
    <Sheet label={card?.name ?? "Card"} onClose={onClose}>
      <ErrorText error={detail.error} />
      {card && (
        <div className="stack card-sheet">
          {/* The card's art behind the top of the sheet, washed into the sheet's color, with the
              whole card standing on it. The full card shows here, so it carries the credit. */}
          <ArtPanel className="card-hero" art={card.image_art_crop} artist={card.artist} wash="bottom" toGround credit={false}>
            <button className="hero-close" onClick={onClose}>Close</button>
          </ArtPanel>
          <figure className="card-figure">
            <CardImage src={flipped && card.back_image_normal ? card.back_image_normal : card.image_normal} name={card.name} />
            <figcaption className="small dim">
              {card.artist ? `Art by ${card.artist}. ` : ""}™ &amp; © Wizards of the Coast. Image from Scryfall.
            </figcaption>
            {card.back_image_normal && (
              <button className="quiet small" onClick={() => setFlipped((f) => !f)}>Show the other face</button>
            )}
          </figure>
          <div>
            <h2 style={{ marginBottom: "0.3rem" }}>{card.name}</h2>
            <div className="row" style={{ marginBottom: "0.5rem" }}>
              <ManaCost cost={card.mana_cost} />
              <Pips identity={card.color_identity} />
            </div>
            <p className="dim" style={{ marginBottom: "0.3rem" }}>{card.type_line}</p>
            <p className="oracle">{card.oracle_text}</p>
            {(card.power || card.loyalty) && (
              <p className="num"><b>{card.power ? `${card.power}/${card.toughness}` : `Loyalty ${card.loyalty}`}</b></p>
            )}
          </div>
          <p>
            Commander: <Legality status={card.legalities.commander} />
          </p>
          {detail.data!.printings.length > 0 && (
            <div>
              <h3>Printings and market prices</h3>
              {chart && <PriceHistory key={chart.id} scryfallId={chart.id} finish={chart.finish} setName={chart.set} />}
              <table className="plain small">
                <thead>
                  <tr>
                    <th>Set</th>
                    <th>#</th>
                    <th className="r">Normal</th>
                    <th className="r">Foil</th>
                    <th className="r">Add</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data!.printings.slice(0, allPrintings ? undefined : 12).map((p) => (
                    <tr key={p.scryfall_id}>
                      <td>
                        <button
                          className="quiet small"
                          style={{ padding: "0 4px", marginInline: -4, fontWeight: 400, textAlign: "left" }}
                          onClick={() => setChart({ id: p.scryfall_id, finish: p.finishes.includes("nonfoil") ? "nonfoil" : (p.finishes[0] as "foil" | "etched"), set: p.set_name })}
                        >
                          {p.set_name}
                        </button>
                      </td>
                      <td className="num">{p.collector_number}</td>
                      <td className="r num">{p.finishes.includes("nonfoil") ? usd(p.usd) : ""}</td>
                      <td className="r num">{p.finishes.includes("foil") ? usd(p.usd_foil) : p.finishes.includes("etched") ? usd(p.usd_etched) : ""}</td>
                      <td className="r">
                        <span className="row" style={{ justifyContent: "end", gap: 4, flexWrap: "nowrap" }}>
                          {p.finishes.map((f) => (
                            <button
                              key={f}
                              className="small"
                              style={{ padding: "0 0.6rem", minWidth: 44 }}
                              onClick={() => add.mutate({ p, finish: f })}
                              aria-label={`Add a ${f} ${p.set_name} copy to your collection`}
                            >
                              {f === "nonfoil" ? "+1" : f === "foil" ? "+F" : "+E"}
                            </button>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.data!.printings.length > 12 && !allPrintings && (
                <button className="quiet small" onClick={() => setAllPrintings(true)}>Show all {detail.data!.printings.length} printings</button>
              )}
              {added && <p className="small" role="status">{added}</p>}
              <ErrorText error={add.error} />
              <p className="small faint">
                Tap a set to see its price history. +1 adds a regular copy, +F a foil, +E an etched foil. {priceSource(detail.data!.printings.find((p) => p.price_date)?.price_date)}. A market price isn't a quote from any store.
              </p>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Legality({ status }: { status: string | undefined }) {
  if (status === "legal") return <span className="tag good">Legal</span>;
  if (status === "banned") return <span className="tag bad">Banned</span>;
  const text = status ? status.replace("_", " ") : "unknown";
  return <span className="tag">{text[0]!.toUpperCase() + text.slice(1)}</span>;
}
