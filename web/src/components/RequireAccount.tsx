import { Fragment, useLayoutEffect, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { KeptAccount, SignInForm, useMe } from "../auth";
import { accountPageOpen, releaseSession, useKeptAccount } from "../session";
import { ALPHA_NOTE } from "./AlphaTag";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { PageHeader } from "./PageHeader";

/** What each section keeps for an account, said where it asks someone to sign in. */
const SECTIONS: Record<string, { title: string; lede: string; extra?: ReactNode }> = {
  profile: { title: "Your profile", lede: "Sign in to see your cards, wish list and public profile." },
  sharing: { title: "Sharing", lede: "Sign in to manage your public profile, shared decks and build notes." },
  "sharing/compare": { title: "Compare collections", lede: "Sign in to see which of a friend's wanted cards you have, and which of yours they have." },
  decks: { title: "Decks", lede: "Sign in to save your decks." },
  collection: { title: "Collection", lede: "Sign in to track your cards." },
  play: { title: "Play online", lede: `Sign in to play Commander online. ${ALPHA_NOTE}` },
  "play/watch": { title: "Watch AIs play", lede: "Sign in to watch the computer play your decks or precons." },
  group: { title: "Playgroup", lede: "Sign in to see your group's games and stats." },
  mythic: { title: "Playgroup", lede: "Bring your playgroup's games over from Mythic Tools." },
  table: { title: "Saved games", lede: "Sign in for saved games. The life counter works without an account." },
  lab: {
    title: "Lab",
    lede: "Sign in to see your simulations.",
    extra: (
      <p className="account-gate-public">
        Browse <a href="/precons">precons</a> and <a href="/commanders">commanders</a> without an account.
      </p>
    ),
  },
  admin: { title: "Admin", lede: "For Yama's admins." },
};

/**
 * The pages that keep someone's own data (decks, collection, playgroup, simulations): the page
 * once an account is signed in, otherwise a sign-in prompt in its place, under the usual nav. The
 * same address shows the page as soon as the sign-in finishes.
 *
 * A sign-in that ends while a page is open (a save or a read refused with 401) is different: the
 * page stays as it is, typed work included, with the sign-in prompt over it (session.ts). The
 * same account signing in again carries on; another account gets the page afresh.
 */
export function RequireAccount({ children }: { children?: ReactNode }) {
  const me = useMe();
  const { pathname } = useLocation();
  // The account whose page is being kept through a sign-in that ended.
  const kept = useKeptAccount();
  // Counted while on screen, so a sign-in that ends knows there is a page to keep. A layout
  // effect: when the page closes while waiting, its account's data is dropped before the next
  // page is painted, not a frame after.
  useLayoutEffect(() => accountPageOpen(), []);
  const shownAs = me.data?.id ?? kept?.id;
  if (shownAs) {
    return (
      <>
        {/* The kept page goes on reading as its account (useMe), so it doesn't empty itself. */}
        <KeptAccount.Provider value={me.data ? null : kept}>
          {/* Keyed by account: a different one never inherits this page's state. */}
          <Fragment key={shownAs}>{children ?? <Outlet />}</Fragment>
        </KeptAccount.Provider>
        {!me.data && <SignInAgain />}
      </>
    );
  }
  const [, first = "", second = ""] = pathname.split("/");
  const section = SECTIONS[`${first}/${second}`] ?? SECTIONS[first] ?? { title: "Sign in", lede: "Sign in to continue." };
  return (
    <main className="page account-gate">
      <PageHeader title={section.title} />
      <p className="account-gate-lede">{section.lede}</p>
      {section.extra}
      <section className="account-gate-signin login-side" aria-label="Sign in">
        <div className="login-inner">
          <SignInForm heading="h2" />
        </div>
      </section>
    </main>
  );
}

/** Escape and a tap outside do nothing here: closing would drop what's typed underneath. */
const stayOpen = () => {};

/**
 * Over a page whose sign-in ended: the ways back in, or carrying on signed out (which closes the
 * page). The shared Dialog keeps focus in it and the page under it out of reach meanwhile.
 */
function SignInAgain() {
  return (
    <Dialog label="Sign in again" centered onClose={stayOpen}>
      <div className="login-side session-ended">
        <div className="login-inner">
          <SignInForm heading="h2" title="Sign in again" />
          <p className="small dim">Your sign-in ended. This page is kept as it is: sign in to carry on where you were.</p>
          <Button variant="quiet" onClick={releaseSession}>Continue signed out</Button>
        </div>
      </div>
    </Dialog>
  );
}
