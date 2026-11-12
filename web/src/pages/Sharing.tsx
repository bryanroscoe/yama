import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, publicOrigin, shareUrl, type DeckSummary, type Sharing, type TradeCompare, type TradeMatch, type Visibility } from "../api";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { Button, ButtonLink, CardImage, ErrorText, Loading } from "../components/ui";
import { SharingSettings } from "../decks/SharingSettings";
import { useCopy } from "../decks/ShareDeck";
import { noteShareUrl, reports } from "../research/api";
import "./group.css";
import "./sharing.css";
import { NO_PRICE, fmtDate, usd } from "@yama/core";

function SharedLink({ name, manage, url, visibility }: { name: string; manage: string; url: string | null; visibility: Visibility }) {
  const [copied, copy] = useCopy();
  return <li className="sharing-item">
    <div><Link to={manage}>{name}</Link><p className="small dim">{visibility === "public" ? "Public" : "Anyone with the link"}</p></div>
    <div className="row">
      {url && <><ButtonLink variant="outline" href={url} target="_blank" rel="noreferrer">Open shared page<span className="visually-hidden">: {name}</span></ButtonLink><Button variant="outline" onClick={() => void copy(url)}>Copy link<span className="visually-hidden">: {name}</span></Button></>}
      <ButtonLink variant="quiet" to={manage}>Manage<span className="visually-hidden">: {name}</span></ButtonLink>
      {copied && <span className="small" role="status">{copied}</span>}
      {url && copied?.startsWith("Couldn't") && <input aria-label={`Shared link: ${name}`} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />}
    </div>
  </li>;
}

/** "Public decks, public plans, what you're looking for and your collection". */
function profileHolds(s: Sharing): string {
  const parts = ["Public decks", "public plans", ...(s.wants_public ? ["what you're looking for"] : []), ...(s.collection_public ? ["your collection"] : [])];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Your want list's link, and comparing with a friend's profile by handle. */
function TradeSection({ sharing }: { sharing: Sharing | undefined }) {
  const navigate = useNavigate();
  const [friend, setFriend] = useState("");
  const [copied, copy] = useCopy();
  const wants = sharing?.handle && sharing.wants_public ? `${publicOrigin()}/u/${sharing.handle}/wants` : null;
  const handle = friend.trim().replace(/^@/, "").toLowerCase();
  return <section className="grp-section" aria-labelledby="sharing-trade">
    <h2 id="sharing-trade">Trade with friends</h2>
    {wants
      ? <><p>Your want list shows the cards on your shopping list, so friends can see what you're looking for.</p><div className="row"><ButtonLink variant="outline" href={wants} target="_blank" rel="noreferrer">Open my want list</ButtonLink><Button variant="outline" onClick={() => void copy(wants)}>Copy want list link</Button>{copied && <span className="small" role="status">{copied}</span>}{copied?.startsWith("Couldn't") && <input className="share-fallback" aria-label="Want list link" readOnly value={wants} onFocus={(e) => e.currentTarget.select()} />}</div></>
      : sharing && <p className="dim">To send friends what you're looking for, {sharing.handle ? "" : "choose a handle and "}turn on "Show what I'm looking for on my profile" in <a href="#sharing">Sharing settings</a>.</p>}
    <form className="sharing-compare" onSubmit={(e) => { e.preventDefault(); if (handle) void navigate(`/sharing/compare/${encodeURIComponent(handle)}`); }}>
      <label>
        Compare with a friend
        <span className="hint">Their handle: the cards on their want list you have, and the cards on your list in their collection.</span>
        <span className="row">
          <input value={friend} onChange={(e) => setFriend(e.target.value)} placeholder="@handle" maxLength={31} autoCapitalize="none" spellCheck={false} />
          <Button type="submit" disabled={!handle}>Compare</Button>
        </span>
      </label>
    </form>
  </section>;
}

function money(n: number | null, date: string | null): string {
  if (n == null) return NO_PRICE;
  const day = date ? fmtDate(date.slice(0, 10)) : null;
  return `${usd(n)} market${day ? `, ${day}` : ""}`;
}

function finishName(f: string): string {
  return f === "foil" ? " foil" : f === "etched" ? " etched" : "";
}

function MatchRow({ m, mine }: { m: TradeMatch; mine: boolean }) {
  const wanted = `${m.qty} wanted${m.pending_qty ? `, ${m.pending_qty} from pending upgrades` : m.needed ? "" : ", along the way"}`;
  const has = mine ? `You have ${m.copies}${m.in_decks ? `, ${m.in_decks} in deck boxes` : ""}` : `They have ${m.copies}`;
  const prints = m.printings?.map((p) => `${p.qty} ${p.set_code.toUpperCase()} ${p.collector_number}${finishName(p.finish)}, ${p.condition}${p.lang === "en" ? "" : `, ${p.lang}`}`);
  return <li className="trade-row">
    <CardImage src={m.image} name={m.name} className="thumb" />
    <div>
      <b>{m.name}</b>
      <p className="small dim">{wanted}. {money(m.market, m.market_date)}.</p>
      <p className="small">{has}{prints?.length ? `: ${prints.join("; ")}` : ""}</p>
    </div>
  </li>;
}

/** The matched copies at market: at most as many as are wanted and as are owned. */
function total(list: TradeMatch[]): string {
  const priced = list.filter((m) => m.market != null);
  if (!priced.length) return "";
  const sum = priced.reduce((t, m) => t + m.market! * Math.min(m.qty, m.copies), 0);
  return ` About ${usd(sum)} at market${priced.length < list.length ? `, ${list.length - priced.length} without a price` : ""}.`;
}

/** What you and a friend could trade, through what their profile shares. */
export function ComparePage() {
  const me = useMe().data;
  const { handle = "" } = useParams();
  const enabled = !!me;
  const q = useQuery({
    queryKey: ["sharing-compare", me?.id, handle],
    queryFn: ({ signal }) => api<TradeCompare>(`/api/sharing/compare/${encodeURIComponent(handle)}`, { signal }),
    enabled,
    retry: false,
  });
  const c = q.data;
  const at = `@${c?.handle ?? handle}`;
  const profile = `${publicOrigin()}/u/${encodeURIComponent(c?.handle ?? handle)}`;
  return <main className="page sharing-page">
    <Link className="sharing-browse" to="/sharing">← Sharing</Link>
    <AreaHead title={`You and ${at}`} />
    <p className="dim">Cards you could trade, from what {at} shares. Market prices are dated TCGplayer market prices from Scryfall, not offers. Copies are real cards; proxies aren't counted.</p>
    {q.isPending && enabled && <Loading>Comparing…</Loading>}
    <ErrorText error={q.error} />
    {c && <>
      {c.yourself && <p className="small">This is your own profile, so both lists are yours.</p>}
      <section className="grp-section" aria-labelledby="trade-you-have">
        <h2 id="trade-you-have">{at} is looking for, you have</h2>
        {!c.wants_public
          ? <p>{at} doesn't share a want list.</p>
          : c.you_have.length === 0
            ? <p>None of the {c.their_wants} cards on their list are in your collection.</p>
            : <><p className="small dim">{c.you_have.length} of the {c.their_wants} cards on their list.{total(c.you_have)}</p><ul className="sharing-list">{c.you_have.map((m) => <MatchRow key={m.name} m={m} mine />)}</ul></>}
        {c.wants_public && <a className="sharing-browse" href={`${profile}/wants`}>{at}'s whole want list</a>}
      </section>
      <section className="grp-section" aria-labelledby="trade-they-have">
        <h2 id="trade-they-have">You're looking for, {at} has</h2>
        {!c.collection_public
          ? <p>{at} doesn't share a collection, so there's nothing to check your list against.</p>
          : c.your_wants === 0
            ? <p>Your shopping list is empty. Cards from your plans and the store trip go there.</p>
            : c.they_have.length === 0
              ? <p>None of the {c.your_wants} cards on your shopping list are in their collection.</p>
              : <><p className="small dim">{c.they_have.length} of the {c.your_wants} cards on your shopping list.{total(c.they_have)}</p><ul className="sharing-list">{c.they_have.map((m) => <MatchRow key={m.name} m={m} mine={false} />)}</ul></>}
        {c.collection_public && <a className="sharing-browse" href={`${profile}/collection`}>{at}'s collection</a>}
      </section>
    </>}
  </main>;
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
  if (!enabled) return <main className="page"><AreaHead title="Sharing" index /><p>Open Sharing from your own account to manage public pages and links.</p></main>;
  const sharedDecks = decks.data?.filter((d) => d.visibility === "public" || d.visibility === "link");
  const sharedNotes = notes.data?.filter((n) => n.visibility === "public" || n.visibility === "link");
  const profile = sharing.data?.handle ? `${publicOrigin()}/u/${sharing.data.handle}` : null;
  return <main className="page sharing-page">
    <AreaHead title="Sharing" index />
    <p className="dim">Open your public pages, copy their links or manage what you share.</p>
    <nav className="sharing-jumps" aria-label="On this page"><a href="#sharing-trade">Trade</a><a href="#sharing-notes">Plans</a><a href="#sharing-decks">Decks</a><a href="#sharing">Settings</a></nav>
    <section className="grp-section" aria-labelledby="sharing-profile">
      <h2 id="sharing-profile">Your public profile</h2>
      {sharing.isPending && <Loading>Loading profile…</Loading>}
      <ErrorText error={sharing.error} />
      {profile ? <><p>{profileHolds(sharing.data!)} appear here.</p><div className="row"><ButtonLink variant="outline" href={profile} target="_blank" rel="noreferrer">Open my public profile</ButtonLink><Button variant="outline" onClick={() => void copy(profile)}>Copy profile link</Button>{copied && <span className="small" role="status">{copied}</span>}{copied?.startsWith("Couldn't") && <input className="share-fallback" aria-label="Public profile link" readOnly value={profile} onFocus={(e) => e.currentTarget.select()} />}</div></> : sharing.data && <p>Choose a handle in <a href="#sharing">Sharing settings</a> to give your public pages a profile.</p>}
    </section>
    <TradeSection sharing={sharing.data} />
    <section className="grp-section" aria-labelledby="sharing-decks">
      <h2 id="sharing-decks">Shared decks</h2>
      <ErrorText error={decks.error} />
      {decks.isPending && <Loading>Loading decks…</Loading>}
      {sharedDecks?.length === 0 && <p>No decks shared yet. Open a deck and choose Share.</p>}
      <ul className="sharing-list">{sharedDecks?.map((d) => <SharedLink key={d.id} name={d.configuration ? `${d.name} — ${d.configuration}` : d.name} manage={`/decks/${d.id}`} url={d.share_token ? shareUrl(d.share_token) : null} visibility={d.visibility} />)}</ul>
      <Link className="sharing-browse" to="/decks">All my decks</Link>
    </section>
    <section className="grp-section" aria-labelledby="sharing-notes">
      <h2 id="sharing-notes">Shared plans</h2>
      <p className="dim">Plans for one or more decks, with their builds and changes, shared by link or on your profile.</p>
      <ErrorText error={notes.error} />
      {notes.isPending && <Loading>Loading plans…</Loading>}
      {sharedNotes?.length === 0 && <p>No plans shared yet. Open a plan and choose Share this plan.</p>}
      <ul className="sharing-list">{sharedNotes?.map((n) => <SharedLink key={n.id} name={n.title} manage={`/decks/research/${encodeURIComponent(n.id)}`} url={n.share_token ? noteShareUrl(n.share_token) : null} visibility={n.visibility!} />)}</ul>
      <Link className="sharing-browse" to="/decks/plans">All my plans</Link>
    </section>
    <section className="grp-section" aria-labelledby="sharing-settings-title">
      <h2 id="sharing-settings-title">Sharing settings</h2>
      <SharingSettings key={me.id} />
    </section>
  </main>;
}
