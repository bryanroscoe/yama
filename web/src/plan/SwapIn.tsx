// "Swap in the prints" for one plan deck: preview what changes in Yama (the deck's list, its box,
// where the cut cards go, the installed ticks), then apply (server/src/plan/swap_in.rs).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button, Details, Dialog, ErrorText, Loading } from "../components/ui";
import { isViewing } from "../viewingFlag";
import "../decks/collect.css";
import "./swapsheet.css";
import { plural } from "@yama/core";

interface PutIn {
  name: string;
  kind: "print" | "moved" | "other";
  from_deck: string | null;
  action: "add_proxy" | "move" | "in_box" | "not_found";
  detail: string | null;
}

interface TakeOut {
  name: string;
  to: "deck" | "swap_bag" | "spares";
  to_name: string;
  replaces: string | null;
  action: "move" | "not_in_box";
}

export interface SwapInPreview {
  plan_key: string;
  plan_name: string;
  box_name: string | null;
  puts_in: PutIn[];
  takes_out: TakeOut[];
  deck: { deck_id: string | null; deck_name: string | null; already: boolean; add: string[]; remove: string[]; differed: string[] };
  ticks: string[];
  ticked_already: number;
  proxies_added: number;
  moved: number;
  warnings: string[];
  done: boolean;
  applied: boolean;
}



function facts(p: SwapInPreview, done: boolean): string[] {
  const box = p.box_name ?? "the deck's box";
  const out: string[] = [];
  const prints = p.puts_in.filter((x) => x.action === "add_proxy").length;
  if (prints) out.push(`${plural(prints, "print")} ${done ? "went" : "go"} into ${box} as proxies.`);
  const movedIn = p.puts_in.filter((x) => x.action === "move");
  for (const m of movedIn) out.push(`${m.name} ${done ? "moved" : "moves"} in from ${m.from_deck ?? m.detail ?? "your collection"}.`);
  const by = new Map<string, number>();
  for (const t of p.takes_out.filter((t) => t.action === "move" && t.to !== "deck")) by.set(t.to_name, (by.get(t.to_name) ?? 0) + 1);
  for (const [to, n] of by) out.push(`${plural(n, "card")} ${done ? "went" : n === 1 ? "goes" : "go"} to ${to}.`);
  for (const t of p.takes_out.filter((t) => t.action === "move" && t.to === "deck")) {
    out.push(`${t.name} ${done ? "went" : "goes"} to ${t.to_name}${t.replaces ? `, in for ${t.replaces}` : ""}.`);
  }
  if (p.deck.deck_name) {
    out.push(
      p.deck.already
        ? `Your deck ${p.deck.deck_name} already has the after-prints list.`
        : `Your deck ${p.deck.deck_name} ${done ? "got" : "gets"} a new version with the after-prints list (${p.deck.add.length} in, ${p.deck.remove.length} out).`,
    );
  }
  if (p.ticks.length) out.push(`${plural(p.ticks.length, "swap")} ${done ? "were" : "are"} ticked installed${p.ticked_already ? ` (${p.ticked_already} already were)` : ""}.`);
  return out;
}

export function SwapInSheet({ deckKey, deckName, onClose }: { deckKey: string; deckName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<SwapInPreview | null>(null);
  const preview = useQuery({
    queryKey: ["plan-swap-in", deckKey],
    queryFn: ({ signal }) => api<SwapInPreview>(`/api/plan/decks/${encodeURIComponent(deckKey)}/swap-in`, { signal }),
    enabled: !result,
  });
  const apply = useMutation({
    mutationFn: () => api<SwapInPreview>(`/api/plan/decks/${encodeURIComponent(deckKey)}/swap-in`, { method: "POST" }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({
        predicate: (q) => ["plan", "deck", "decks", "containers", "plan-swap-in"].includes(String(q.queryKey[0])) || String(q.queryKey[0]).startsWith("collection"),
      });
    },
  });
  const viewing = isViewing();
  const p = result ?? preview.data;
  return (
    <Dialog title={`Swap the prints into ${deckName}`} onClose={onClose}>
      <div className="stack">
        <ErrorText error={preview.error} />
        {!p && !preview.error && <Loading>Checking the deck and your collection…</Loading>}
        {p && p.done && !result && <p>{deckName} already has its prints swapped in, here in Yama. Nothing to do.</p>}
        {p && !(p.done && !result) && (
          <>
            <p className="dim">
              {result
                ? "Deck and collection updated."
                : "Sleeve the prints first. This updates the deck list and moves collection copies as shown below."}
            </p>
            <ul className="collect-facts">
              {facts(p, !!result).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {p.warnings.length > 0 && (
              <ul className="swapin-notes small">
                {p.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <Details label="Which cards">
              <h3 className="small">In</h3>
              <ul className="swapin-list small">
                {p.puts_in.map((x, i) => (
                  <li key={`${x.name}-${i}`}>
                    <b>{x.name}</b>{" "}
                    <span className="dim">
                      {x.action === "add_proxy"
                        ? `proxy${x.detail ? `, ${x.detail} art` : ""}`
                        : x.action === "move"
                          ? `from ${x.from_deck ?? x.detail ?? "your collection"}`
                          : x.action === "in_box"
                            ? "already in the box"
                            : "no copy found"}
                    </span>
                  </li>
                ))}
              </ul>
              <h3 className="small">Out</h3>
              <ul className="swapin-list small">
                {p.takes_out.map((t, i) => (
                  <li key={`${t.name}-${i}`}>
                    <b>{t.name}</b>{" "}
                    <span className="dim">
                      {t.action === "move" ? `to ${t.to_name}${t.replaces ? `, in for ${t.replaces}` : ""}` : "not in the box"}
                    </span>
                  </li>
                ))}
              </ul>
            </Details>
            <ErrorText error={apply.error} />
            {!result && (
              <div className="row">
                <Button variant="primary" disabled={viewing || apply.isPending} onClick={() => apply.mutate()}>
                  {apply.isPending ? "Swapping…" : "Swap them in"}
                </Button>
                <Button variant="quiet" onClick={onClose}>
                  Cancel
                </Button>
                {viewing && <span className="small dim">Read only while viewing as someone.</span>}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
