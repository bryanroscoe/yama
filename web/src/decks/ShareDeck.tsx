import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, shareUrl, type DeckView, type Sharing, type Visibility } from "../api";
import { ErrorText, Sheet } from "../components/ui";
import "./share.css";

export const VISIBILITY_CHOICES: { value: Visibility; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "Only you." },
  { value: "link", label: "Anyone with the link", hint: "Friends you send the link to can see the list and download it. It isn't listed anywhere." },
  { value: "public", label: "Public on your profile", hint: "Anyone with the link, and listed on your profile for anyone who has its address." },
];

/** Copy `text`, saying whether it worked. */
export function useCopy(): [string | null, (text: string) => Promise<void>] {
  const [said, setSaid] = useState<string | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid("Copied.");
    } catch {
      setSaid("Couldn't copy here; select the link and copy it instead.");
    }
  };
  return [said, copy];
}

/** Who can see this deck, and its link. */
export function ShareDeck({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const sharing = useQuery({ queryKey: ["sharing"], queryFn: () => api<Sharing>("/api/me/sharing") });
  const [copied, copy] = useCopy();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["deck", deck.id] });
    void qc.invalidateQueries({ queryKey: ["decks"] });
    void qc.invalidateQueries({ queryKey: ["sharing"] });
  };
  const set = useMutation({
    mutationFn: (visibility: Visibility) => api(`/api/decks/${deck.id}`, { method: "PATCH", json: { visibility } }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: () => api<{ share_token: string }>(`/api/decks/${deck.id}/share-link`, { method: "POST" }),
    onSuccess: refresh,
  });
  const visibility = set.isPending ? set.variables : deck.visibility;
  const link = deck.share_token ? shareUrl(deck.share_token) : null;
  const handle = sharing.data?.handle;

  return (
    <Sheet label="Share deck" onClose={onClose}>
      <div className="stack share-sheet">
        <div className="sheet-head">
          <h2>Share {deck.name}</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        <fieldset className="share-choices">
          <legend className="small dim">Who can see it</legend>
          {VISIBILITY_CHOICES.map((c) => (
            <label key={c.value}>
              <input type="radio" name="visibility" checked={visibility === c.value} disabled={set.isPending} onChange={() => set.mutate(c.value)} />
              {c.label}
              <span className="hint">{c.hint}</span>
            </label>
          ))}
        </fieldset>
        <p className="small dim share-what">
          A shared deck shows its cards, the printings its exports name, its commander art and the bracket you declare. Your
          collection, prices you paid, notes, plans and games stay private.
        </p>
        {visibility !== "private" && link && (
          <div className="stack share-link">
            <label>
              Link
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="row">
              <button className="primary" onClick={() => void copy(link)}>Copy link</button>
              <a className="button" href={link} target="_blank" rel="noreferrer">Open</a>
              <button className="quiet" disabled={reset.isPending} onClick={() => confirm("Make a new link? The old one stops working.") && reset.mutate()}>
                Reset link
              </button>
            </div>
            {copied && <p className="small" role="status">{copied}</p>}
          </div>
        )}
        {visibility === "public" && !handle && sharing.data && (
          <p className="small">
            Your profile needs a handle before it lists anything. <Link to="/group#sharing">Pick one under Group, You</Link>.
          </p>
        )}
        {visibility === "public" && handle && (
          <p className="small dim">
            Listed on <a href={`/u/${handle}`}>your profile, @{handle}</a>.
          </p>
        )}
        <ErrorText error={set.error ?? reset.error} />
      </div>
    </Sheet>
  );
}

/** Another build of this deck ("stock", "high power"), starting from this list. */
export function NewConfiguration({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [opId] = useState(() => crypto.randomUUID());
  const main = deck.configurations[0]?.name ?? deck.name;
  const make = useMutation({
    mutationFn: () => api<{ id: string }>(`/api/decks/${deck.id}/configurations`, { method: "POST", json: { configuration: label, op_id: opId } }),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: ["decks"] });
      void qc.invalidateQueries({ queryKey: ["deck"] });
      onClose();
      navigate(`/decks/${made.id}`);
    },
  });
  return (
    <Sheet label="New configuration" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
        <div className="sheet-head">
          <h2>New configuration</h2>
          <button type="button" className="quiet" onClick={onClose}>Close</button>
        </div>
        <p className="small dim" style={{ margin: 0 }}>
          Another build of {main}, starting from this list. It shows under {main} in your decks, with its own versions, games and sharing.
        </p>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="stock, high power, budget" maxLength={60} required autoFocus />
        </label>
        <ErrorText error={make.error} />
        <div className="row">
          <button className="primary" disabled={make.isPending || !label.trim()}>Make it</button>
        </div>
      </form>
    </Sheet>
  );
}
