// The declared bracket, set in place on the bracket panel (deck page SPEC, "Declared bracket"):
// a segmented control, none or 1 to 5, saved as you tap. It replaced the Edit deck sheet's select.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BRACKETS } from "./Bracket";
import { ErrorText } from "./ui";
import "./declare-bracket.css";

export function DeclareBracket({ deckId, declared }: { deckId: string; declared: number | null }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (bracket: number | null) => api(`/api/decks/${encodeURIComponent(deckId)}`, { method: "PATCH", json: { bracket } }),
    onSuccess: () => {
      // The deck list's chips and every list of the deck show it.
      void qc.invalidateQueries({ queryKey: ["deck"] });
      void qc.invalidateQueries({ queryKey: ["decks"] });
    },
  });
  const shown = set.isPending ? set.variables : declared;
  const choices: { value: number | null; label: string; title: string }[] = [
    { value: null, label: "None", title: "Not declared" },
    ...BRACKETS.map((b) => ({ value: b.value, label: String(b.value), title: `${b.value}, ${b.name}` })),
  ];
  return (
    <div className="declare-bracket">
      <span className="declare-bracket-label" id={`declare-${deckId}`}>Your bracket</span>
      <div className="segmented declare-bracket-choices" role="group" aria-labelledby={`declare-${deckId}`}>
        {choices.map((c) => (
          <button key={c.label} type="button" title={c.title} aria-label={c.title} aria-pressed={shown === c.value} disabled={set.isPending} onClick={() => shown !== c.value && set.mutate(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
      <ErrorText error={set.error} />
    </div>
  );
}
