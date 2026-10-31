import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { VISIBILITY_CHOICES, useCopy } from "../decks/ShareDeck";
import { noteShareUrl, resetNoteLink, setNoteSharing, type ResearchBundle } from "./api";

/** Who can see this note, and its link: the same three choices as a deck. */
export function ShareNote({ bundle }: { bundle: ResearchBundle }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const id = bundle.document.id;
  const sharing = useQuery({ queryKey: ["sharing"], queryFn: () => api<Sharing>("/api/me/sharing") });
  const [copied, copy] = useCopy();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["research", userId, id] });
    void qc.invalidateQueries({ queryKey: ["research", userId, "list"] });
  };
  const set = useMutation({ mutationFn: (v: Visibility) => setNoteSharing(id, v), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => resetNoteLink(id), onSuccess: refresh });
  const visibility = (set.isPending ? set.variables : bundle.visibility) ?? "private";
  const token = set.data?.share_token ?? bundle.share_token;
  const link = token ? noteShareUrl(token) : null;
  const handle = sharing.data?.handle;
  return <details className="research-share" open={visibility !== "private"}>
    <summary>Share this note{visibility === "private" ? "" : visibility === "link" ? " (anyone with the link)" : " (public on your profile)"}</summary>
    <fieldset className="share-choices">
      <legend className="small dim">Who can see it</legend>
      {VISIBILITY_CHOICES.map((c) => <label key={c.value}>
        <input type="radio" name="note-visibility" checked={visibility === c.value} disabled={set.isPending} onChange={() => set.mutate(c.value)} />
        {c.label}
        <span className="hint">{c.hint}</span>
      </label>)}
    </fieldset>
    <p className="small dim">A shared note shows its decks, builds, changes, full lists and how to pilot them. Your answers and notes on it, what you own, store prices and shopping lists stay private.</p>
    {visibility !== "private" && link && <div className="stack share-link">
      <label>Link<input readOnly value={link} onFocus={(e) => e.currentTarget.select()} /></label>
      <div className="row">
        <button type="button" className="primary" onClick={() => void copy(link)}>Copy link</button>
        <a className="button" href={link} target="_blank" rel="noreferrer">Open</a>
        <button type="button" className="quiet" disabled={reset.isPending} onClick={() => confirm("Make a new link? The old one stops working.") && reset.mutate()}>Reset link</button>
      </div>
      {copied && <p className="small" role="status">{copied}</p>}
    </div>}
    {visibility === "public" && sharing.data && (handle
      ? <p className="small dim">Listed on <a href={`/u/${handle}`}>your profile, @{handle}</a>.</p>
      : <p className="small">Your profile needs a handle before it lists anything. <Link to="/group#sharing">Pick one under Group, You</Link>.</p>)}
    <ErrorText error={set.error ?? reset.error} />
  </details>;
}
