import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type ConfigurationRef, type DeckView } from "../api";
import { ErrorText } from "../components/ui";
import { configurationLabel } from "./buildCatalog";

/** A configuration's name as the deck page shows it: its label, else Main for the main deck. */
export function listLabel(c: ConfigurationRef, main: boolean): string {
  return configurationLabel(c.configuration, c.name, main);
}

/**
 * Which list is in the real deck, and the other lists that can go in (Bryan, 2026-10-28: "There
 * should be the one that's currently implemented, and then there should be an easy way to swap
 * back to other versions of the deck"). The main deck's current list is the one in the box, and
 * plans read their installed swaps from it. Null for a deck with no configurations.
 */
export function deckLists(deck: Pick<DeckView, "id" | "parent_id" | "configurations">): { main: ConfigurationRef; here: "main" | "other"; others: ConfigurationRef[] } | null {
  if (deck.configurations.length < 2) return null;
  const main = deck.configurations.find((c) => c.id === (deck.parent_id ?? deck.id)) ?? deck.configurations[0]!;
  return { main, here: deck.id === main.id ? "main" : "other", others: deck.configurations.filter((c) => c.id !== main.id) };
}

/** The panel on a deck page whose deck has configurations. */
export function DeckLists({ deck }: { deck: DeckView }) {
  const lists = deckLists(deck);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<ConfigurationRef | null>(null);
  // One op id per list asked for: a retry of that list reuses it, another list gets its own.
  const ops = useRef(new Map<string, string>());
  const opFor = (target: string) => ops.current.get(target) ?? ops.current.set(target, crypto.randomUUID()).get(target)!;
  const use = useMutation({
    mutationFn: (from: ConfigurationRef) =>
      api<{ version_id: string | null; changed: boolean }>(`/api/decks/${lists!.main.id}/use`, { method: "POST", json: { from: from.id, op_id: opFor(from.id) } }),
    onSuccess: (_, from) => {
      ops.current.delete(from.id);
      setAsking(null);
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck-versions"] });
      // Installed swaps are read from the main deck's list.
      void qc.invalidateQueries({ queryKey: ["plan"] });
      if (deck.id !== lists!.main.id) navigate(`/decks/${lists!.main.id}`);
    },
  });
  if (!lists) return null;
  const { main, here } = lists;
  const mainName = main.name;
  const ask = (c: ConfigurationRef) => {
    setAsking(c);
    use.reset();
  };
  const confirm = asking && (
    <div className="deck-lists-confirm" role="group" aria-label="Confirm">
      <p className="small">
        Put the {listLabel(asking, false)} list in {mainName}? Its current list stays in History, so you can switch back.
      </p>
      <div className="row">
        <button className="primary" disabled={use.isPending} onClick={() => use.mutate(asking)}>
          {use.isPending ? "Putting it in…" : "Put it in"}
        </button>
        <button className="quiet" onClick={() => setAsking(null)}>Cancel</button>
      </div>
      <ErrorText error={use.error} />
    </div>
  );
  return (
    <section className="deck-lists" aria-label="Lists for this deck">
      {here === "main" ? (
        <Link to={`/decks/builds?savedDeck=${main.id}`}>Print swap cards between this deck and a build</Link>
      ) : (
        <>
          <p>
            <b>Saved configuration.</b>{" "}
            <span className="dim">
              Current deck: <Link to={`/decks/${main.id}`}>{mainName}</Link>.
            </span>
          </p>
          <button className="outline" onClick={() => ask(deck.configurations.find((c) => c.id === deck.id)!)}>
            Use this as the current list
          </button>
        </>
      )}
      {confirm}
    </section>
  );
}
