import type { ReactNode } from "react";
import { ArtPanel } from "../components/ArtPanel";
import { SITE_FOOT, SITE_NAV } from "../components/siteFrame";
import { SiteNotice } from "../components/SiteNotice";
import { Wordmark } from "../components/Wordmark";
import { openPage } from "../native";
// The header and footer every public page has (the server's pages and the static ones link it).
import "../../public/site-frame-v1.css";
import "./landing.css";

/** Runtime Scryfall art, with the credit beside the crop. */
const LANDING_ART = "https://cards.scryfall.io/art_crop/front/d/d/dd4a00ff-2206-4e12-a0ab-61ed82c9e6c5.jpg";

/** Public discovery at /; private deep links and OAuth keep sign-in in view. */
export function Landing({ children, focused = false }: { children: ReactNode; focused?: boolean }) {
  return (
    <div className={`landing${focused ? " landing-focused" : ""}`}>
      <a className="site-frame-skip" href="#content">Skip to content</a>
      <header className="site-frame-header">
        <a className="site-frame-wordmark" href="/" aria-label="Yama home"><Wordmark /></a>
        <nav aria-label="Yama">
          {SITE_NAV.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        </nav>
        {/* Everywhere else this slot opens Yama; here the next step is signing in. */}
        <a className="site-frame-open" href="#sign-in">Sign in</a>
      </header>

      <main id="content" className="landing-layout">
        {!focused && (
          <ArtPanel as="section" className="landing-hero" art={LANDING_ART} artist="Craig Elliott" wash="bottom" credit={false}>
            <p className="landing-kicker">Yet Another Magic App</p>
            <h1>Commander,<br />at your table.</h1>
            <p className="landing-art-credit">Éowyn, Shieldmaiden. Art by Craig Elliott, ™ &amp; © Wizards of the Coast.</p>
          </ArtPanel>
        )}

        {!focused && (
          <section className="landing-explore" aria-labelledby="explore-title">
            <div className="landing-section-head">
              <h2 id="explore-title">No account needed</h2>
            </div>
            <div className="landing-public-links">
              {/* The life counter is Yama's home page, signed in or not (guest.ts). */}
              <a className="landing-destination landing-counter" href="/">
                <h3>Count life at the table</h3>
                <p>Up to six players. Games stay on this device.</p>
                <span className="landing-destination-action">Start a game <span aria-hidden="true">→</span></span>
              </a>
              <a className="landing-destination" href="/precons">
                <h3>Find your next precon</h3>
                <p>Stock lists, rankings and upgrades.</p>
                <span className="landing-destination-action">Browse precons <span aria-hidden="true">↗</span></span>
              </a>
              <a className="landing-destination" href="/docs/mcp/">
                <h3>Connect Claude or Codex</h3>
                <p>Research cards and plan upgrades with your assistant.</p>
                <span className="landing-destination-action">Read the guide <span aria-hidden="true">↗</span></span>
              </a>
            </div>
            <div className="landing-shared">
              <h3 id="shared-title">Find a friend</h3>
              <form className="landing-handle" action="/u" method="get" aria-labelledby="shared-title" onSubmit={(e) => {
                e.preventDefault();
                const h = new FormData(e.currentTarget).get("handle")?.toString().trim().replace(/^@/, "").toLowerCase();
                if (h) openPage(`/u/${encodeURIComponent(h)}`);
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
              <h2 id="account-title">With an account</h2>
            </div>
            <dl className="landing-account-features">
              <div><dt>Decks</dt><dd>Save lists, versions and upgrade plans.</dd></div>
              <div><dt>Sharing</dt><dd>Share decks and collection with friends.</dd></div>
              <div><dt>Collection</dt><dd>Track cards, proxies and deck boxes.</dd></div>
              <div><dt>Game night</dt><dd>Record results and play online.</dd></div>
              <div><dt>Lab</dt><dd>Test lists in simulated games.</dd></div>
            </dl>
          </section>
        )}
      </main>

      <footer className="site-frame-footer">
        <nav aria-label="About Yama">
          {SITE_FOOT.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        </nav>
        <SiteNotice />
      </footer>
    </div>
  );
}
