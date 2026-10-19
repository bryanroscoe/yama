import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, usd, type Printing, type SearchResult } from "../api";
import { cardDetailQuery, isNetworkError } from "../cardDetail";
import { CardImage, ErrorText, ManaCost, Pips, Sheet } from "../components/ui";
import { offlineSearch } from "../offline/cards";
import { PriceHistory } from "../components/PriceHistory";
import { Rulings } from "../components/Rulings";

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
          placeholder="Name, or Scryfall syntax like t:elf id<=gw"
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
          <p className="dim">Search works like Scryfall: <code>o:</code> rules text, <code>t:</code> type, <code>id&lt;=</code> fits a commander, <code>mv</code>, <code>pow</code>, <code>f:commander</code>, <code>is:gamechanger</code>, <code>-</code> to exclude, <code>or</code> and parentheses.</p>
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
  const detail = useQuery(cardDetailQuery(oracleId));
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
        <div className="stack">
          <div className="sheet-head">
            <div>
              <h2 style={{ marginBottom: "0.2rem" }}>{card.name}</h2>
              <div className="row">
                <ManaCost cost={card.mana_cost} />
                <Pips identity={card.color_identity} />
              </div>
            </div>
            <button className="quiet" onClick={onClose}>Close</button>
          </div>
          <div style={{ maxWidth: 320 }}>
            <CardImage src={flipped && card.back_image_normal ? card.back_image_normal : card.image_normal} name={card.name} />
            {card.back_image_normal && (
              <button className="quiet small" onClick={() => setFlipped((f) => !f)}>Show the other face</button>
            )}
            {card.artist && <p className="small faint">Illustrated by {card.artist}. Image from Scryfall.</p>}
          </div>
          <div>
            <p className="dim" style={{ marginBottom: "0.3rem" }}>{card.type_line}</p>
            <p className="oracle">{card.oracle_text}</p>
            {(card.power || card.loyalty) && (
              <p className="num"><b>{card.power ? `${card.power}/${card.toughness}` : `Loyalty ${card.loyalty}`}</b></p>
            )}
          </div>
          <p className="row" style={{ gap: "0.4rem" }}>
            Commander: <Legality status={card.legalities.commander} />
            {card.game_changer && <span className="tag gc" title="On the Commander Game Changers list, per Scryfall">Game Changer</span>}
          </p>
          {detail.data!.rulings && <Rulings rulings={detail.data!.rulings} />}
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
                          style={{ minHeight: 32, padding: 0, fontWeight: 400, textAlign: "left" }}
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
                              style={{ minHeight: 32, padding: "0 0.5rem" }}
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
                Tap a set to see its price history. +1 adds a regular copy, +F a foil, +E an etched foil. TCGplayer market prices via Scryfall, {detail.data!.printings.find((p) => p.price_date)?.price_date ?? "date unknown"}. A market price isn't a quote from any store.
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
  return <span className="tag">{status ? status.replace("_", " ") : "unknown"}</span>;
}
