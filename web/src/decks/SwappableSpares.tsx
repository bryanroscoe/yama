// A deck's swappable spares, under its cards: copies kept in the deck's box on top of its 100 (the
// bracket bag's cards and ready swaps), from server/src/decks/spares.rs. They count toward nothing
// in the deck: not its legality, stats, prices or exports. Copies go in and out with the
// collection's Move (into the spares' box); here the owner sets the box up and says what each
// spare comes in for.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plural } from "@yama/core";
import { useId, useState } from "react";
import { Link } from "react-router";
import { api, type Container, type DeckSpares, type SpareSwap } from "../api";
import { ActionBar, Button, CardImage, ErrorText } from "../components/ui";
import { isViewing } from "../viewingFlag";

/** "For Thought Vessel at Bracket 4 (your note)". */
export function swapText(w: SpareSwap): string {
  const what = w.out && w.bracket ? `For ${w.out} at Bracket ${w.bracket}` : w.out ? `For ${w.out}` : w.bracket ? `At Bracket ${w.bracket}` : "";
  const note = w.note ? (what ? ` (${w.note})` : w.note) : "";
  return `${what}${note}${w.from === "plan" ? ", from the plan's bracket bag" : ""}`;
}

/** A sentence's start for inside another: "For X" as "for X". */
const inline = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Boxes, binders and lists that could hold the spares: not a deck box, not another deck's spares. */
export function spareBoxChoices(containers: Container[], deckId: string): Container[] {
  return containers.filter((c) => c.kind !== "deck" && (!c.spares_of_deck_id || c.spares_of_deck_id === deckId));
}

export function SwappableSpares({ deckId, onOpen }: { deckId: string; onOpen: (oracleId: string) => void }) {
  const heading = useId();
  const qc = useQueryClient();
  const viewing = isViewing();
  const spares = useQuery({ queryKey: ["deck-spares", deckId], queryFn: ({ signal }) => api<DeckSpares>(`/api/decks/${deckId}/spares`, { signal }) });
  const [linking, setLinking] = useState(false);
  const containers = useQuery({ queryKey: ["containers"], queryFn: ({ signal }) => api<Container[]>("/api/containers", { signal }), enabled: linking });
  const [editing, setEditing] = useState<string | null>(null);
  const done = (r: DeckSpares) => {
    qc.setQueryData(["deck-spares", deckId], r);
    void qc.invalidateQueries({ predicate: (q) => ["containers", "deck"].includes(String(q.queryKey[0])) || String(q.queryKey[0]).startsWith("collection") });
  };
  const set = useMutation({
    mutationFn: (body: { create: true } | { container_id: string | null }) => api<DeckSpares>(`/api/decks/${deckId}/spares`, { method: "PUT", json: body }),
    onSuccess: (r) => (setLinking(false), done(r)),
  });
  const swap = useMutation({
    mutationFn: (body: { oracle_id: string; swaps_out: string | null; bracket: number | null }) => api<DeckSpares>(`/api/decks/${deckId}/spares/swaps`, { method: "PUT", json: body }),
    onSuccess: (r) => (setEditing(null), done(r)),
  });
  const s = spares.data;
  if (!s) return spares.error ? <ErrorText error={spares.error} small /> : null;
  const box = s.container_id;
  return (
    <section className="deck-considering deck-spares" aria-labelledby={heading}>
      <h2 id={heading}>
        Swappable spares {box && <span className="dim num">{s.copies}</span>}
      </h2>
      {box ? (
        <p className="small dim">
          {s.copies ? `${plural(s.copies, "card")} kept in the deck box on top of its 100` : "Cards kept in the deck box on top of its 100"}: bracket-bag cards and ready swaps. They count toward nothing in the deck: not its legality, stats, prices or exports. In your collection they're{" "}
          <Link to={`/collection?container=${encodeURIComponent(box)}`}>{s.container_name}</Link>; move a copy there to add it.
        </p>
      ) : (
        <p className="small dim">Keep cards in this deck's box on top of its 100, such as the cards a lower bracket swaps back in. They won't count toward the deck's legality, stats, prices or exports.</p>
      )}
      <ErrorText error={set.error ?? swap.error} small />
      {box && s.cards.length > 0 && (
        <ul className="deck-considering-cards">
          {s.cards.map((c) => (
            <li key={c.oracle_id}>
              <div className="deck-spare">
                <Button className="deck-considering-card" onClick={() => onOpen(c.oracle_id)}>
                  <CardImage src={c.image_small} name={c.name} className="deck-considering-thumb" />
                  <span className="deck-considering-text">
                    <span>
                      {c.qty > 1 ? `${c.qty} ` : ""}
                      {c.name}
                      {c.proxies > 0 ? (c.proxies === c.qty ? ", proxy" : `, ${c.proxies} proxy`) : ""}
                    </span>
                    {c.swaps.map((w, i) => (
                      <span key={i} className="small dim">
                        {swapText(w)}
                      </span>
                    ))}
                  </span>
                </Button>
                {editing === c.oracle_id ? (
                  <SwapForm
                    initial={c.swaps.find((w) => w.from === "owner") ?? null}
                    busy={swap.isPending || viewing}
                    onCancel={() => setEditing(null)}
                    onSave={(out, bracket) => swap.mutate({ oracle_id: c.oracle_id, swaps_out: out, bracket })}
                  />
                ) : (
                  !viewing && (
                    <Button variant="quiet" size="small" className="deck-spare-edit" onClick={() => setEditing(c.oracle_id)}>
                      {c.swaps.some((w) => w.from === "owner") ? "Change what it swaps for" : "Say what it swaps for"}
                    </Button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {s.planned_missing.length > 0 && (
        <p className="small dim">
          The plan's bracket bags also name {s.planned_missing.map((m) => `${m.name}${m.swaps[0] ? ` (${inline(swapText({ ...m.swaps[0], from: "owner" }))})` : ""}`).join(", ")}, not in {box ? "these spares" : "a spares box"} yet.
        </p>
      )}
      {!viewing && (
        <ActionBar>
          {!box && (
            <Button variant="outline" disabled={set.isPending} onClick={() => set.mutate({ create: true })}>
              Keep swappable spares
            </Button>
          )}
          {linking ? (
            <select
              aria-label="Box for the swappable spares"
              disabled={set.isPending || !containers.data}
              value={box ?? ""}
              onChange={(e) => e.target.value && set.mutate({ container_id: e.target.value })}
            >
              <option value="">{containers.data ? "Pick a box, binder or list" : "Loading…"}</option>
              {spareBoxChoices(containers.data ?? [], s.deck_id).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
          ) : (
            <Button variant="quiet" onClick={() => setLinking(true)}>
              {box ? "Use another box" : "Use a box I have"}
            </Button>
          )}
          {box && (
            <Button variant="quiet" disabled={set.isPending} onClick={() => set.mutate({ container_id: null })}>
              Stop keeping them here
            </Button>
          )}
        </ActionBar>
      )}
    </section>
  );
}

function SwapForm({ initial, busy, onCancel, onSave }: { initial: SpareSwap | null; busy: boolean; onCancel: () => void; onSave: (out: string | null, bracket: number | null) => void }) {
  const [out, setOut] = useState(initial?.out ?? "");
  const [bracket, setBracket] = useState(initial?.bracket ? String(initial.bracket) : "");
  return (
    <form
      className="row deck-spare-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(out.trim() || null, bracket ? Number(bracket) : null);
      }}
    >
      <input aria-label="Card it comes in for" placeholder="Card it comes in for" value={out} maxLength={200} onChange={(e) => setOut(e.target.value)} />
      <select aria-label="Bracket" value={bracket} onChange={(e) => setBracket(e.target.value)}>
        <option value="">Any bracket</option>
        {[1, 2, 3, 4, 5].map((b) => (
          <option key={b} value={b}>
            Bracket {b}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" disabled={busy}>
        Save
      </Button>
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
