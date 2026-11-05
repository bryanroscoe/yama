import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { VISIBILITY_CHOICES, useCopy } from "../decks/ShareDeck";
import { noteShareUrl, resetNoteLink, setNoteSharing, type NoteSharing, type ResearchBundle } from "./api";
import { planSummariesKey } from "./view";

/** Who can see this plan, and its link: the same three choices as a deck. */
export function ShareNote({ bundle }: { bundle: ResearchBundle }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const id = bundle.document.id;
  const sharing = useQuery({ queryKey: ["sharing", userId], queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }), enabled: !!userId });
  const [copied, copy] = useCopy();
  // The server's answer is the note's sharing now: put it in the cached note at once, so a reset
  // link never leaves the old one on screen, then refetch.
  const refresh = (r: NoteSharing) => {
    qc.setQueryData<ResearchBundle>(["research", userId, id], (b) => b && { ...b, visibility: r.visibility, share_token: r.share_token });
    void qc.invalidateQueries({ queryKey: ["research", userId, id] });
    void qc.invalidateQueries({ queryKey: ["research", userId, "list"] });
    // The Plans page's tiles say how each plan is shared.
    void qc.invalidateQueries({ queryKey: planSummariesKey(userId) });
  };
  const set = useMutation({ mutationFn: (v: Visibility) => setNoteSharing(id, v), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => resetNoteLink(id), onSuccess: refresh });
  const visibility = (set.isPending ? set.variables : bundle.visibility) ?? "private";
  const token = bundle.share_token;
  const link = token ? noteShareUrl(token) : null;
  const handle = sharing.data?.handle;
  return <details className="research-share" open={visibility !== "private"}>
    <summary>Share this plan{visibility === "private" ? "" : visibility === "link" ? " (anyone with the link)" : " (public on your profile)"}</summary>
    <fieldset className="share-choices">
      <legend className="small dim">Who can see it</legend>
      {VISIBILITY_CHOICES.map((c) => <label key={c.value}>
        <input type="radio" name="note-visibility" checked={visibility === c.value} disabled={set.isPending} onChange={() => set.mutate(c.value)} />
        {c.label}
        <span className="hint">{c.hint}</span>
      </label>)}
    </fieldset>
    <p className="small dim">A shared plan shows its title and summaries, decks, builds, changes with their reasons, sources, full lists and how to pilot them, as written, plus a shopping list worked out from market prices. Read them before sharing. Your answers and notes, ownership and acquisition fields, method notes, combos and your agent's store checks stay private.</p>
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
      : <p className="small">Your profile needs a handle before it lists anything. <Link to="/sharing#sharing">Pick a handle in Sharing</Link>.</p>)}
    <ErrorText error={set.error ?? reset.error} />
  </details>;
}
