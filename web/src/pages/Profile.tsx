import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { api, publicOrigin, type Sharing } from "../api";
import { useMe } from "../auth";
import { Button, ButtonLink, ErrorText, Loading } from "../components/ui";
import { useCopy } from "../decks/ShareDeck";
import { AccountSettings } from "./AccountSettings";
import "./profile.css";

/** Your private starting point; public pages always use their own document links. */
export function ProfilePage() {
  const me = useMe().data;
  const enabled = !!me && !me.viewing;
  const sharing = useQuery({
    queryKey: ["sharing", me?.id],
    queryFn: ({ signal }) => api<Sharing>("/api/me/sharing", { signal }),
    enabled,
  });
  const [copied, copy] = useCopy();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === "#grp-you" || hash === "#delete-account") document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, sharing.data, me?.id]);
  if (!me) return null;
  const s = enabled ? sharing.data : undefined;
  const profile = s?.handle ? `${publicOrigin()}/u/${encodeURIComponent(s.handle)}` : null;
  return <main className="page profile-page">
    <header className="profile-heading">
      <h1>Your profile</h1>
      <p className="profile-name">{me.display_name || me.email}</p>
      {s?.handle && <p className="dim">@{s.handle}</p>}
    </header>

    {enabled && <section className="profile-public" aria-labelledby="profile-public-title">
      <h2 id="profile-public-title">Your public profile</h2>
      {sharing.isPending && <Loading>Loading profile…</Loading>}
      <ErrorText error={sharing.error} />
      {profile ? <>
        <div className="row">
          <ButtonLink variant="primary" href={profile} target="_blank" rel="noreferrer">View public profile</ButtonLink>
          <Button variant="outline" onClick={() => void copy(profile)}>Copy profile link</Button>
          <Link to="/sharing#sharing">Edit sharing</Link>
        </div>
        {copied && <p className="small" role="status">{copied}</p>}
        {copied?.startsWith("Couldn't") && <input aria-label="Public profile link" readOnly value={profile} onFocus={(e) => e.currentTarget.select()} />}
        <nav className="profile-public-links" aria-label="Your public pages">
          {s?.collection_public && <a href={`${profile}/collection`} target="_blank" rel="noreferrer">Public collection</a>}
          {s?.wants_public && <a href={`${profile}/wants`} target="_blank" rel="noreferrer">Public want list</a>}
        </nav>
      </> : s && <>
        <p>Choose a handle to give friends a link to your public profile.</p>
        <ButtonLink variant="primary" to="/sharing#sharing">Set up public profile</ButtonLink>
      </>}
    </section>}

    <nav className="profile-library" aria-label="Your cards and activity">
      <Link to="/collection"><b>My collection</b><span>The cards and proxies you own.</span></Link>
      <Link to="/decks/plans/get"><b>My wish list</b><span>Cards to buy, print or find for your plans.</span></Link>
      <Link to="/decks"><b>My decks</b><span>Your decks and saved lists.</span></Link>
      <Link to="/decks/plans"><b>My plans</b><span>Upgrades to review and put into your decks.</span></Link>
      {!me.viewing && <Link to="/sharing"><b>Sharing and trades</b><span>Shared links and collection comparisons.</span></Link>}
      <Link to="/group"><b>My playgroup</b><span>Friends, games and results.</span></Link>
    </nav>
    <AccountSettings />
  </main>;
}
