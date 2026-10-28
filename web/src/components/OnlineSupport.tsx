import { CardHover, CardRef } from "./CardRef";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { api, type OnlineSupport as Support } from "../api";
import "./cards.css";

/** Card names, each a link to its card sheet when `onCard` is given. */
export function NameList({ names, onCard }: { names: string[]; onCard?: (name: string) => void }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={n}>
          {i > 0 && ", "}
          {onCard ? (
            <button type="button" className="name-link" onClick={() => onCard(n)}><CardHover name={n}/></button>
          ) : (
            <CardRef name={n}/>
          )}
        </Fragment>
      ))}
    </>
  );
}

export function useOnlineSupport(deckId: string | undefined, versionId?: string | null) {
  return useQuery({
    queryKey: ["online-support", deckId, versionId ?? null],
    queryFn: () => api<Support>(`/api/decks/${deckId}/online-support`),
    enabled: !!deckId,
    staleTime: 5 * 60_000,
    // The engine loads its card data for a while after the server starts; ask again then.
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 5000 : false),
  });
}

/**
 * "Online play: 97/100 cards supported", with the cards the rules engine leaves out, only
 * partly implements, or had trouble reading. Counts are copies in the commander and main deck;
 * "supported" means none of the engine's checks found a problem.
 */
export function OnlineSupport({ deckId, versionId, onCard }: {
  deckId: string;
  /** The deck version shown, so an edit asks again. */
  versionId?: string | null;
  onCard?: (name: string) => void;
}) {
  const q = useOnlineSupport(deckId, versionId);
  const d = q.data;
  if (!d) return null;
  if (d.state !== "ready" || !d.support) {
    return (
      <div className="online-support">
        <p className="card-note">
          {d.state === "starting" ? "Online play: checking once the rules engine has started." : "Online play is off on this server, so cards aren't checked."}
        </p>
      </div>
    );
  }
  const s = d.support;
  if (s.total === 0) return null;
  const all = s.supported === s.total;
  return (
    <div className="online-support">
      <p className={`label${all ? " all" : ""}`}>
        Online play: {s.supported}/{s.total} cards supported
      </p>
      {s.missing.length > 0 && (
        <p className="names">
          Left out of online games: <NameList names={s.missing} onCard={onCard} />
        </p>
      )}
      {s.partial.length > 0 && (
        <p className="names">
          Some abilities unsupported online: <NameList names={s.partial} onCard={onCard} />
        </p>
      )}
      {s.uncertain.length > 0 && (
        <p className="names">
          May not work fully online: <NameList names={s.uncertain} onCard={onCard} />
        </p>
      )}
    </div>
  );
}
