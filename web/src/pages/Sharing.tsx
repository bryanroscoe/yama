import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError, publicOrigin, shareUrl, type DeckSummary, type Sharing, type TradeCompare, type TradeMatch, type Visibility } from "../api";
import { useMe } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { BackLink, Button, ButtonLink, CardImage, ErrorText, Loading } from "../components/ui";
import { SharingSettings } from "../decks/SharingSettings";
import { useCopy } from "../decks/ShareDeck";
import { noteShareUrl, reports } from "../research/api";
import "./group.css";
import "./sharing.css";
import { NO_PRICE, count, fmtDate, shortDate, usd } from "@yama/core";

function SharedLink({ name, manage, url, visibility }: { name: string; manage: string; url: string | null; visibility: Visibility }) {
  const [copied, copy] = useCopy();
  return <li className="sharing-item">
    <div><Link to={manage}>{name}</Link><p className="small dim">{visibility === "public" ? "Public" : "Link only"}</p></div>
    <div className="row">
      {url && <><ButtonLink variant="outline" href={url} target="_blank" rel="noreferrer">Open shared page<span className="visually-hidden">: {name}</span></ButtonLink><Button variant="outline" onClick={() => void copy(url)}>Copy link<span className="visually-hidden">: {name}</span></Button></>}
      <ButtonLink variant="quiet" to={manage}>Manage<span className="visually-hidden">: {name}</span></ButtonLink>
      {copied && <span className="small" role="status">{copied}</span>}
      {url && copied?.startsWith("Couldn't") && <input aria-label={`Shared link: ${name}`} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />}
    </div>
  </li>;
}

/** "Public decks, public plans, your wish list and your collection". */
function profileHolds(s: Sharing): string {
  const parts = ["Public decks", "public plans", ...(s.wants_public ? ["your wish list"] : []), ...(s.collection_public ? ["your collection"] : [])];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Collection, Trade with a friend: what both of you need to set up, comparing with a friend's
 * profile by handle, and your wish list's link. It was a section of Sharing until 12 Nov 2026.
 */
export function TradePage() {
  const me = useMe().data;
  const enabled = !!me && !me.viewing;
  const navigate = useNavigate();
  const [friend, setFriend] = useState("");
  const [copied, copy] = useCopy();
  const q = useQuery({ queryKey: ["sharing", me?.id], queryFn: () => api<Sharing>("/api/me/sharing"), enabled });
  // A disabled query may still have cached data. Never render it outside the current account.
  const sharing = enabled ? q.data : undefined;
  const wants = sharing?.handle && sharing.wants_public ? `${publicOrigin()}/u/${sharing.handle}/wants` : null;
  const handle = friend.trim().replace(/^@/, "").toLowerCase();
  return <main className="page sharing-page">
    <AreaHead title="Trade with a friend" index />
    <p className="dim">See which cards on a friend's wish list you have, and which cards on yours they have, from what each of you shares.</p>
    <ErrorText error={enabled ? q.error : null} />
    {/* Both people need a handle and something shared: said up front, with where this account stands. */}
    {enabled && sharing && (
      <p className="trade-you">
        {sharing.handle
          ? <>Your handle: <b>@{sharing.handle}</b>. You share {sharedText(sharing)}.</>
          : <>You don't have a handle yet. <Link to="/sharing#sharing">Choose a handle</Link> so a friend can find you.</>}
      </p>
    )}
    <ol className="trade-steps dim">
      <li>You both pick a handle in <Link to="/sharing#sharing">Sharing settings</Link>.</li>
      <li>You both turn on sharing there: your wish list, your collection, or both.</li>
      <li>Type their handle here.</li>
    </ol>
    <section className="grp-section" aria-labelledby="trade-compare">
      <h2 id="trade-compare">Compare with a friend</h2>
      <form className="sharing-compare" onSubmit={(e) => { e.preventDefault(); if (handle) void navigate(`/sharing/compare/${encodeURIComponent(handle)}`); }}>
        <label>
          Their handle
          <span className="hint">The cards on their wish list you have, and the cards on yours in their collection.</span>
          <span className="row">
            <input value={friend} onChange={(e) => setFriend(e.target.value)} placeholder="@handle" maxLength={31} autoCapitalize="none" spellCheck={false} />
            <Button type="submit" disabled={!handle}>Compare</Button>
          </span>
        </label>
      </form>
    </section>
    {enabled && <section className="grp-section" aria-labelledby="trade-wants">
      <h2 id="trade-wants">Your wish list</h2>
      {q.isPending && <Loading>Loading your wish list…</Loading>}
      {wants
        ? <><p>Friends see your wish list on your profile, together with the cards your decks and plans still need.</p><div className="row"><ButtonLink variant="outline" href={wants} target="_blank" rel="noreferrer">Open my wish list</ButtonLink><Button variant="outline" onClick={() => void copy(wants)}>Copy wish list link</Button>{copied && <span className="small" role="status">{copied}</span>}{copied?.startsWith("Couldn't") && <input className="share-fallback" aria-label="Wish list link" readOnly value={wants} onFocus={(e) => e.currentTarget.select()} />}</div></>
        : sharing && <p className="dim">To share your wish list with friends, {sharing.handle ? "" : "choose a handle and "}turn on sharing it in <Link to="/sharing#sharing">Sharing settings</Link>.</p>}
    </section>}
  </main>;
}

/** "your wish list and your collection", "your collection, not your wish list", "neither your wish list nor your collection yet". */
function sharedText(s: Pick<Sharing, "wants_public" | "collection_public">): string {
  if (s.wants_public && s.collection_public) return "your wish list and your collection";
  if (s.wants_public) return "your wish list, not your collection";
  if (s.collection_public) return "your collection, not your wish list";
  return "neither your wish list nor your collection yet";
}

/** "Nov 20", with the year only when it isn't this one: the way the rest of the app dates a price. */
export function priceDay(date: string, now: Date = new Date()): string {
  const day = date.slice(0, 10);
  return day.startsWith(`${now.getFullYear()}-`) ? (shortDate(day) ?? day) : fmtDate(day);
}

function money(n: number | null, date: string | null): string {
  if (n == null) return NO_PRICE;
  const day = date ? priceDay(date) : null;
  return `${usd(n)} market${day ? `, ${day}` : ""}`;
}

function finishName(f: string): string {
  return f === "foil" ? " foil" : f === "etched" ? " etched" : "";
}

function MatchRow({ m, mine }: { m: TradeMatch; mine: boolean }) {
  const wanted = `${m.qty} wanted${m.pending_qty ? `, ${m.pending_qty} from pending upgrades` : m.needed ? "" : ", low priority"}`;
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

/** "4 of the 764 cards on their wish list.", and for a list of one, "The one card on their wish list." */
function ofList(found: number, listed: number, list: string): string {
  return listed === 1 ? `The one card ${list}.` : `${count(found)} of the ${count(listed)} cards ${list}.`;
}

/** "None of the 764 cards on their wish list are in your collection.", and for a list of one, "The one card … isn't". */
function noneOf(listed: number, list: string, where: string): string {
  return listed === 1 ? `The one card ${list} isn't in ${where}.` : `None of the ${count(listed)} cards ${list} are in ${where}.`;
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
  // A handle nobody has: said in plain words, without the page's explanation above a dead end.
  const unknown = q.error instanceof ApiError && q.error.status === 404;
  return <main className="page sharing-page">
    <BackLink inline to="/collection/trade" label="Back to Trade with a friend" text="Trade with a friend" className="sharing-browse" />
    <AreaHead title={`You and ${at}`} />
    {unknown ? (
      <>
        <ErrorText error={`No one on Yama has the handle ${at}.`} />
        <p>Check the spelling with your friend: their handle is on their Sharing settings page. <Link to="/collection/trade">Try another handle</Link></p>
      </>
    ) : (
      <>
        <p className="dim">Cards you could trade, from what {at} shares. A wish list here is the list itself plus the real cards its owner's decks and plans still need. Market prices are dated TCGplayer market prices from Scryfall, not offers. Copies are real cards; proxies aren't counted.</p>
        {q.isPending && enabled && <Loading>Comparing…</Loading>}
        <ErrorText error={q.error} />
      </>
    )}
    {c && <>
      {c.yourself && <p className="small">This is your own profile, so both lists are yours.</p>}
      <section className="grp-section" aria-labelledby="trade-you-have">
        <h2 id="trade-you-have">{at} wants, you have</h2>
        {!c.wants_public
          ? <p>{at} doesn't share a wish list.</p>
          : c.you_have.length === 0
            ? <p>{c.their_wants === 0 ? `${at}'s wish list is empty.` : noneOf(c.their_wants, "on their wish list", "your collection")}</p>
            : <><p className="small dim">{ofList(c.you_have.length, c.their_wants, "on their wish list")}{total(c.you_have)}</p><ul className="sharing-list">{c.you_have.map((m) => <MatchRow key={m.name} m={m} mine />)}</ul></>}
        {c.wants_public && <a className="sharing-browse" href={`${profile}/wants`}>{at}'s whole wish list</a>}
      </section>
      <section className="grp-section" aria-labelledby="trade-they-have">
        <h2 id="trade-they-have">You want, {at} has</h2>
        {!c.collection_public
          ? <p>{at} doesn't share a collection, so there's nothing to check your wish list against.</p>
          : c.your_wants === 0
            ? <p>Your wish list is empty, and your decks aren't missing any cards. <Link to="/collection/wishlist">Add to your wish list</Link></p>
            : c.they_have.length === 0
              ? <p>{noneOf(c.your_wants, "on your wish list", "their collection")}</p>
              : <><p className="small dim">{ofList(c.they_have.length, c.your_wants, "on your wish list")}{total(c.they_have)}</p><ul className="sharing-list">{c.they_have.map((m) => <MatchRow key={m.name} m={m} mine={false} />)}</ul></>}
        {c.collection_public && <a className="sharing-browse" href={`${profile}/collection`}>{at}'s collection</a>}
      </section>
    </>}
  </main>;
}

/** You, Sharing settings: everything this account has already shared and the account-wide
 *  switches, without publishing anything. Each deck and plan has its own Share control. */
export function SharingPage() {
  const me = useMe().data;
  const enabled = !!me && !me.viewing;
  const { hash } = useLocation();
  const sharing = useQuery({ queryKey: ["sharing", me?.id], queryFn: () => api<Sharing>("/api/me/sharing"), enabled });
  const decks = useQuery({ queryKey: ["decks", me?.id], queryFn: () => api<DeckSummary[]>("/api/decks"), enabled });
  const notes = useQuery({ queryKey: ["research", me?.id, "list"], queryFn: reports, enabled });
  // Once the lists above the settings have drawn: scrolled to sooner, they pushed the section away.
  const drawn = !sharing.isPending && !decks.isPending && !notes.isPending;
  useEffect(() => {
    if (enabled && drawn && hash === "#sharing") document.getElementById("sharing-settings-title")?.scrollIntoView();
  }, [enabled, drawn, hash]);
  const [copied, copy] = useCopy();
  // A disabled query may still have cached data. Never render it outside the current account.
  if (!enabled) return <main className="page"><AreaHead title="Sharing settings" index /><p>Open Sharing settings from your own account to manage public pages and links.</p></main>;
  const sharedDecks = decks.data?.filter((d) => d.visibility === "public" || d.visibility === "link");
  const sharedNotes = notes.data?.filter((n) => n.visibility === "public" || n.visibility === "link");
  const profile = sharing.data?.handle ? `${publicOrigin()}/u/${sharing.data.handle}` : null;
  return <main className="page sharing-page">
    <BackLink inline to="/profile" label="Back to You" text="You" className="sharing-browse" />
    <AreaHead title="Sharing settings" index />
    <p className="dim">Open your public pages, copy their links or manage what you share. To share one deck or plan, open it and choose Share.</p>
    <nav className="sharing-jumps" aria-label="On this page"><a href="#sharing-decks">Decks</a><a href="#sharing-notes">Plans</a><a href="#sharing">Settings</a></nav>
    <section className="grp-section" aria-labelledby="sharing-profile">
      <h2 id="sharing-profile">Your public profile</h2>
      {sharing.isPending && <Loading>Loading profile…</Loading>}
      <ErrorText error={sharing.error} />
      {profile ? <><p>{profileHolds(sharing.data!)} appear here.</p><div className="row"><ButtonLink variant="outline" href={profile} target="_blank" rel="noreferrer">Open my public profile</ButtonLink><Button variant="outline" onClick={() => void copy(profile)}>Copy profile link</Button>{copied && <span className="small" role="status">{copied}</span>}{copied?.startsWith("Couldn't") && <input className="share-fallback" aria-label="Public profile link" readOnly value={profile} onFocus={(e) => e.currentTarget.select()} />}</div></> : sharing.data && <p><a href="#sharing">Choose a handle below</a> to give your public pages a profile.</p>}
    </section>
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
      <h2 id="sharing-settings-title">Settings</h2>
      <SharingSettings key={me.id} />
    </section>
  </main>;
}
