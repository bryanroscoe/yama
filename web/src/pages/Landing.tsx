import type { ReactNode } from "react";
import { ArtPanel } from "../components/ArtPanel";
import { SiteNotice } from "../components/SiteNotice";
import { Wordmark } from "../components/Wordmark";
import "./landing.css";

/** Runtime Scryfall art, with the credit beside the crop. */
const LANDING_ART = "https://cards.scryfall.io/art_crop/front/d/d/dd4a00ff-2206-4e12-a0ab-61ed82c9e6c5.jpg";

/** Public discovery at /; private deep links and OAuth keep sign-in in view. */
export function Landing({ children, focused = false }: { children: ReactNode; focused?: boolean }) {
  return (
    <div className={`landing${focused ? " landing-focused" : ""}`}>
      <a className="landing-skip" href="#landing-content">Skip to content</a>
      <header className="landing-head">
        <a className="landing-brand" href="/" aria-label="Yama home"><Wordmark /></a>
        <nav aria-label="Public pages">
          <a href="/precons">Precons</a>
          <a href="/docs/mcp/">MCP guide</a>
          <a className="landing-signin-link" href="#sign-in">Sign in</a>
        </nav>
      </header>

      <main id="landing-content" className="landing-layout">
        {!focused && (
          <ArtPanel as="section" className="landing-hero" art={LANDING_ART} artist="Craig Elliott" wash="bottom" credit={false}>
            <p className="landing-kicker">Yet Another Magic App</p>
            <h1>Commander decks,<br />from the list to the table.</h1>
            <p className="landing-intro">Compare precons, plan your upgrades, and keep your cards and game nights together.</p>
            <p className="landing-art-credit">Éowyn, Shieldmaiden. Art by Craig Elliott, ™ &amp; © Wizards of the Coast.</p>
          </ArtPanel>
        )}

        {!focused && (
          <section className="landing-explore" aria-labelledby="explore-title">
            <div className="landing-section-head">
              <h2 id="explore-title">Explore without an account</h2>
            </div>
            <div className="landing-public-links">
              <a className="landing-destination" href="/precons">
                <span className="landing-destination-kind">Public reference</span>
                <h3>Find your next precon</h3>
                <p>Stock lists, upgrade potential and rankings with sources.</p>
                <span className="landing-destination-action">Browse precons <span aria-hidden="true">↗</span></span>
              </a>
              <a className="landing-destination" href="/docs/mcp/">
                <span className="landing-destination-kind">MCP guide</span>
                <h3>Connect Claude or Codex</h3>
                <p>Research cards and plan upgrades with your assistant.</p>
                <span className="landing-destination-action">Read the guide <span aria-hidden="true">↗</span></span>
              </a>
            </div>
            <p className="landing-method"><a href="/precons/methodology">Ranking methodology</a></p>
            <div className="landing-shared">
              <h3 id="shared-title">Got a link from a friend?</h3>
              <form className="landing-handle" action="/u" method="get" aria-labelledby="shared-title" onSubmit={(e) => {
                e.preventDefault();
                const h = new FormData(e.currentTarget).get("handle")?.toString().trim().replace(/^@/, "").toLowerCase();
                if (h) location.assign(`/u/${encodeURIComponent(h)}`);
              }}>
                <input name="handle" aria-label="Handle" placeholder="@handle" autoCapitalize="none" spellCheck={false} maxLength={31} required />
                <button type="submit">Open profile</button>
              </form>
            </div>
          </section>
        )}

        <section id="sign-in" className="landing-signin login-side" aria-label="Sign in" tabIndex={-1}>
          <div className="login-inner">{children}</div>
        </section>

        {!focused && (
          <section className="landing-account" aria-labelledby="account-title">
            <div className="landing-section-head">
              <h2 id="account-title">Make room for your own decks</h2>
            </div>
            <dl className="landing-account-features">
              <div><dt>Decks and upgrades</dt><dd>Save versions, check your lists and review research and suggested changes.</dd></div>
              <div><dt>Share with friends</dt><dd>Share decks and collection by link or profile, with Moxfield and Arena exports.</dd></div>
              <div><dt>Your collection</dt><dd>Keep track of owned cards, proxies and where each copy lives.</dd></div>
              <div><dt>Game night</dt><dd>Count life, record your playgroup's results and play Commander online.</dd></div>
              <div><dt>Simulation lab</dt><dd>Compare lists in simulated games, with the engine's limits shown alongside the results.</dd></div>
            </dl>
          </section>
        )}
      </main>

      <div className="landing-footer">
        <nav aria-label="About Yama"><a href="/about/">About Yama</a><a href="/privacy/">Privacy policy</a><a href="/tos/">Terms</a></nav>
        <SiteNotice />
      </div>
    </div>
  );
}
