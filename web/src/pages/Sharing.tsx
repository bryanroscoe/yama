import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { api, publicOrigin, shareUrl, type DeckSummary, type Sharing, type Visibility } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { SharingSettings } from "../decks/SharingSettings";
import { useCopy } from "../decks/ShareDeck";
import { noteShareUrl, reports } from "../research/api";
import "./group.css";
import "./sharing.css";

function SharedLink({ name, manage, url, visibility }: { name: string; manage: string; url: string | null; visibility: Visibility }) {
  const [copied, copy] = useCopy();
  return <li className="sharing-item">
    <div><Link to={manage}>{name}</Link><p className="small dim">{visibility === "public" ? "Public" : "Anyone with the link"}</p></div>
    <div className="row">
      {url && <><a className="button outline" href={url} target="_blank" rel="noreferrer">Open shared page<span className="visually-hidden">: {name}</span></a><button className="outline" onClick={() => void copy(url)}>Copy link<span className="visually-hidden">: {name}</span></button></>}
      <Link className="button quiet" to={manage}>Manage<span className="visually-hidden">: {name}</span></Link>
      {copied && <span className="small" role="status">{copied}</span>}
      {url && copied?.startsWith("Couldn't") && <input aria-label={`Shared link: ${name}`} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />}
    </div>
  </li>;
}

/** A way back to everything this account has already shared, without publishing anything. */
export function SharingPage() {
  const me = useMe().data;
  const enabled = !!me && !me.viewing;
  const { hash } = useLocation();
  useEffect(() => {
    if (enabled && hash === "#sharing") document.getElementById("sharing-settings-title")?.scrollIntoView();
  }, [enabled, hash]);
  const sharing = useQuery({ queryKey: ["sharing", me?.id], queryFn: () => api<Sharing>("/api/me/sharing"), enabled });
  const decks = useQuery({ queryKey: ["decks", me?.id], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled });
  const notes = useQuery({ queryKey: ["research", me?.id, "list"], queryFn: reports, enabled });
  const [copied, copy] = useCopy();
  // A disabled query may still have cached data. Never render it outside the current account.
  if (!enabled) return <main className="page"><h1>Sharing</h1><p>Open Sharing from your own account to manage public pages and links.</p></main>;
  const sharedDecks = decks.data?.filter((d) => d.visibility === "public" || d.visibility === "link");
  const sharedNotes = notes.data?.filter((n) => n.visibility === "public" || n.visibility === "link");
  const profile = sharing.data?.handle ? `${publicOrigin()}/u/${sharing.data.handle}` : null;
  return <main className="page sharing-page">
    <div className="page-head"><h1>Sharing</h1></div>
    <p className="dim">Open your public pages, copy their links or manage what you share.</p>
    <nav className="sharing-jumps" aria-label="On this page"><a href="#sharing-notes">Plans</a><a href="#sharing-decks">Decks</a><a href="#sharing">Settings</a></nav>
    <section className="grp-section" aria-labelledby="sharing-profile">
      <h2 id="sharing-profile">Your public profile</h2>
      {sharing.isPending && <p>Loading profile…</p>}
      <ErrorText error={sharing.error} />
      {profile ? <><p>Public decks, public plans{sharing.data?.collection_public ? " and your collection" : ""} appear here.</p><div className="row"><a className="button outline" href={profile} target="_blank" rel="noreferrer">Open my public profile</a><button className="outline" onClick={() => void copy(profile)}>Copy profile link</button>{copied && <span className="small" role="status">{copied}</span>}{copied?.startsWith("Couldn't") && <input className="share-fallback" aria-label="Public profile link" readOnly value={profile} onFocus={(e) => e.currentTarget.select()} />}</div></> : sharing.data && <p>Choose a handle in <a href="#sharing">Sharing settings</a> to give your public pages a profile.</p>}
    </section>
    <section className="grp-section" aria-labelledby="sharing-decks">
      <h2 id="sharing-decks">Shared decks</h2>
      <ErrorText error={decks.error} />
      {decks.isPending && <p>Loading decks…</p>}
      {sharedDecks?.length === 0 && <p>No decks shared yet. Open a deck and choose Share.</p>}
      <ul className="sharing-list">{sharedDecks?.map((d) => <SharedLink key={d.id} name={d.configuration ? `${d.name} — ${d.configuration}` : d.name} manage={`/decks/${d.id}`} url={d.share_token ? shareUrl(d.share_token) : null} visibility={d.visibility} />)}</ul>
      <Link className="sharing-browse" to="/decks">All my decks</Link>
    </section>
    <section className="grp-section" aria-labelledby="sharing-notes">
      <h2 id="sharing-notes">Shared plans</h2>
      <p className="dim">Plans for one or more decks, with their builds and changes, shared by link or on your profile.</p>
      <ErrorText error={notes.error} />
      {notes.isPending && <p>Loading plans…</p>}
      {sharedNotes?.length === 0 && <p>No plans shared yet. Open a plan and choose Share this plan.</p>}
      <ul className="sharing-list">{sharedNotes?.map((n) => <SharedLink key={n.id} name={n.title} manage={`/decks/research/${encodeURIComponent(n.id)}`} url={n.share_token ? noteShareUrl(n.share_token) : null} visibility={n.visibility!} />)}</ul>
      <Link className="sharing-browse" to="/decks/plan">All my plans</Link>
    </section>
    <section className="grp-section" aria-labelledby="sharing-settings-title">
      <h2 id="sharing-settings-title">Sharing settings</h2>
      <SharingSettings key={me.id} />
    </section>
  </main>;
}
