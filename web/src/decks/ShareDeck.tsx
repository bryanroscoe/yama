import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, shareUrl, type DeckView, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ActionBar, Button, ButtonLink, Dialog, ErrorText, Segmented } from "../components/ui";
import { configurationLabel } from "./buildCatalog";
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

/** Making a new link, confirmed in place: the confirm button really rotates the link (the canvas's
 *  version called cancel), Keep this one closes the question. */
export function ResetConfirm({ pending, onConfirm, onKeep }: { pending: boolean; onConfirm: () => void; onKeep: () => void }) {
  return (
    <div className="share-reset" role="alert">
      <span>The old link will stop working.</span>
      <ActionBar as="span">
        <Button disabled={pending} onClick={onConfirm}>{pending ? "Making it…" : "Make a new link"}</Button>
        <Button variant="quiet" onClick={onKeep}>Keep this one</Button>
      </ActionBar>
    </div>
  );
}

/** Who can see this deck, and its link (deck page SPEC section 5; board DeckShare). */
export function ShareDeck({ deck, onClose }: { deck: DeckView; onClose: () => void }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: !!userId });
  const [copied, copy] = useCopy();
  const [help, setHelp] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const refresh = () => {
    // Every list of the deck lists the others' sharing.
    void qc.invalidateQueries({ queryKey: ["deck"] });
    void qc.invalidateQueries({ queryKey: ["decks"] });
    void qc.invalidateQueries({ queryKey: ["sharing"] });
  };
  const set = useMutation({
    mutationFn: ({ id, visibility }: { id: string; visibility: Visibility }) => api(`/api/decks/${encodeURIComponent(id)}`, { method: "PATCH", json: { visibility } }),
    onSuccess: (_, { id }) => {
      if (id !== deck.id) setChanging(null);
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => api<{ share_token: string }>(`/api/decks/${encodeURIComponent(deck.id)}/share-link`, { method: "POST" }),
    onSuccess: () => {
      setAskReset(false);
      refresh();
    },
  });
  const pending = set.isPending ? set.variables : null;
  const visibility = pending?.id === deck.id ? pending.visibility : deck.visibility;
  const link = deck.share_token ? shareUrl(deck.share_token) : null;
  const handle = sharing.data?.handle;
  const others = deck.configurations.map((c, i) => ({ ...c, label: configurationLabel(c.configuration, c.name, i === 0) })).filter((c) => c.id !== deck.id);
  const labelOf = (v: Visibility) => VISIBILITY_CHOICES.find((c) => c.value === v)?.label ?? v;

  return (
    <Dialog title={<>Share {deck.name}</>} onClose={onClose}>
      <div className="share-sheet">
        <fieldset className="share-choices">
          <legend className="share-legend">
            Who can see it
            <Button className="share-help" aria-label="What sharing shows" aria-expanded={help} onClick={() => setHelp((h) => !h)}>?</Button>
          </legend>
          {help && (
            <div className="share-help-note" role="note">
              <span><b>Shown:</b> the cards, the printings its exports name, its commander art and the bracket you declare.</span>
              <span><b>Never shown:</b> your collection, proxies, prices you paid, notes, boxes, plans, games and account details.</span>
            </div>
          )}
          {VISIBILITY_CHOICES.map((c) => (
            <label key={c.value} className="share-card">
              <input type="radio" name="visibility" checked={visibility === c.value} disabled={set.isPending} onChange={() => { setAskReset(false); set.mutate({ id: deck.id, visibility: c.value }); }} />
              <b>{c.label}</b>
            </label>
          ))}
        </fieldset>

        {visibility !== "private" && link && (
          <div className="share-link">
            <label>
              Link
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <ActionBar>
              <Button variant="primary" onClick={() => void copy(link)}>Copy link</Button>
              <ButtonLink href={link} target="_blank" rel="noreferrer">Open it</ButtonLink>
              <Button variant="quiet" aria-expanded={askReset} onClick={() => setAskReset(true)}>Make a new link</Button>
              {copied && <span className="small" role="status">{copied}</span>}
            </ActionBar>
            {askReset && <ResetConfirm pending={reset.isPending} onConfirm={() => reset.mutate()} onKeep={() => setAskReset(false)} />}
          </div>
        )}
        {visibility === "public" && !handle && sharing.data && (
          <p className="small share-line">
            Your profile needs a handle before it lists anything. <Link to="/sharing#sharing">Pick a handle in Sharing</Link>.
          </p>
        )}
        {visibility === "public" && handle && (
          <p className="small share-line">
            Listed on <a href={`/u/${handle}`}>your profile, @{handle}</a>.
          </p>
        )}

        {others.length > 0 && (
          <div className="share-rows">
            <h3>Its other lists</h3>
            {others.map((c) => (
              <div key={c.id} className="share-row">
                <div className="share-row-head">
                  <span>{c.label}</span>
                  <span className="share-row-value">
                    <span className="dim">{labelOf(pending?.id === c.id ? pending.visibility : c.visibility)}</span>
                    <Button variant="quiet" aria-expanded={changing === c.id} onClick={() => setChanging(changing === c.id ? null : c.id)}>Change</Button>
                  </span>
                </div>
                {changing === c.id && (
                  <Segmented
                    className="share-row-choice"
                    label={`Who can see ${c.label}`}
                    value={c.visibility}
                    disabled={set.isPending}
                    onChange={(visibility) => set.mutate({ id: c.id, visibility })}
                    options={VISIBILITY_CHOICES.map((v) => [v.value, v.value === "link" ? "With the link" : v.value === "public" ? "Public" : v.label] as const)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {sharing.data && (
          <div className="share-row share-row-head share-lab">
            <span>Simulated win rates <span className="dim">{sharing.data.share_lab_results ? "shown" : "hidden"}</span></span>
            <Link to="/sharing#sharing" onClick={onClose}>Change in Sharing</Link>
          </div>
        )}
        <ErrorText error={set.error ?? reset.error} />
      </div>
    </Dialog>
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
    <Dialog title="New configuration" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
        <p className="small dim" style={{ margin: 0 }}>
          Another build of {main}, starting from this list. It shows under {main} in your decks, with its own versions, games and sharing.
        </p>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="stock, high power, budget" maxLength={60} required autoFocus />
        </label>
        <ErrorText error={make.error} />
        <div className="row">
          <Button type="submit" variant="primary" disabled={make.isPending || !label.trim()}>Make it</Button>
        </div>
      </form>
    </Dialog>
  );
}
