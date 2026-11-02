import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { SignInForm, useMe } from "../auth";

/** What each section keeps for an account, said where it asks someone to sign in. */
const SECTIONS: Record<string, { title: string; lede: string; extra?: ReactNode }> = {
  sharing: { title: "Sharing", lede: "Find your public profile, shared decks and build notes, and manage who can see them." },
  decks: { title: "Decks", lede: "Save your decks and their versions, check your lists, plan upgrades and review research and suggested changes." },
  collection: { title: "Collection", lede: "Keep track of the cards you own, your proxies and where each copy lives." },
  play: { title: "Play online", lede: "Play Commander online with friends, each on their own device." },
  group: { title: "Playgroup", lede: "Record your playgroup's games and stats, and share decks and your collection with friends by link or profile." },
  mythic: { title: "Playgroup", lede: "Bring your playgroup's games over from Mythic Tools." },
  table: { title: "Saved games", lede: "Games saved to Yama, with your playgroup's stats, belong to an account. The life counter works without one." },
  lab: {
    title: "Lab",
    lede: "Compare lists in simulated games, with the engine's limits shown alongside the results.",
    extra: (
      <p className="account-gate-public">
        No account needed for the <a href="/precons">public precon reference</a> or the <a href="/commanders">commander ranking</a>.
      </p>
    ),
  },
  admin: { title: "Admin", lede: "For Yama's admins." },
};

/**
 * The pages that keep someone's own data (decks, collection, playgroup, simulations): the page
 * once an account is signed in, otherwise a sign-in prompt in its place, under the usual nav. The
 * same address shows the page as soon as the sign-in finishes.
 */
export function RequireAccount({ children }: { children?: ReactNode }) {
  const me = useMe();
  const { pathname } = useLocation();
  if (me.data) return children ?? <Outlet />;
  const section = SECTIONS[pathname.split("/")[1] ?? ""] ?? { title: "Sign in", lede: "This page belongs to an account." };
  return (
    <main className="page account-gate">
      <div className="page-head">
        <h1>{section.title}</h1>
      </div>
      <p className="account-gate-lede">{section.lede}</p>
      {section.extra}
      <section className="account-gate-signin login-side" aria-label="Sign in">
        <div className="login-inner">
          <SignInForm heading="h2" title="Sign in to continue" />
        </div>
      </section>
    </main>
  );
}
