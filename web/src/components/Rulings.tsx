import { useQuery } from "@tanstack/react-query";
import type { Ruling } from "../api";
import { cardDetailQuery } from "../cardDetail";
import "./cards.css";

const SOURCES: Record<string, string> = { wotc: "Wizards of the Coast", scryfall: "Scryfall" };

/** "2004-10-04" → "Oct 4, 2004" in the reader's locale. The date is a calendar day, so UTC. */
function day(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Collapsible rulings list, oldest first as Scryfall lists them. */
export function Rulings({ rulings }: { rulings: Ruling[] }) {
  if (!rulings.length) return <p className="small faint">No rulings for this card.</p>;
  return (
    <details className="rulings">
      <summary>Rulings ({rulings.length})</summary>
      <ol>
        {rulings.map((r, i) => (
          <li key={i}>
            <p>{r.comment}</p>
            <p className="ruling-meta">
              {day(r.published_at)}, {SOURCES[r.source] ?? r.source}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Rulings for a card by oracle ID, sharing the card sheet's cached detail. */
export function CardRulings({ oracleId }: { oracleId: string }) {
  const detail = useQuery(cardDetailQuery(oracleId));
  const rulings = detail.data?.rulings;
  return rulings ? <Rulings rulings={rulings} /> : null;
}
