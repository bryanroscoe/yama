import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { SignInForm, useMe } from "../auth";

/** What each section keeps for an account, said where it asks someone to sign in. */
const SECTIONS: Record<string, { title: string; lede: string; extra?: ReactNode }> = {
  decks: { title: "Decks", lede: "Sign in to save your decks." },
  collection: { title: "Collection", lede: "Sign in to track your cards." },
  play: { title: "Play online", lede: "Sign in to play Commander online." },
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
 */
export function RequireAccount({ children }: { children?: ReactNode }) {
  const me = useMe();
  const { pathname } = useLocation();
  if (me.data) return children ?? <Outlet />;
  const section = SECTIONS[pathname.split("/")[1] ?? ""] ?? { title: "Sign in", lede: "Sign in to continue." };
  return (
    <main className="page account-gate">
      <div className="page-head">
        <h1>{section.title}</h1>
      </div>
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
