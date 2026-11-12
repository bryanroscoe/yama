// Play online for someone who isn't signed in (server/src/guests.rs): play the computer as a guest
// after a Cloudflare Turnstile check, or sign in for your own decks, friends and kept games. A
// guest gets the usual Play page with precons only.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { shortDate } from "@yama/core";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { SignInForm, signInPath } from "../auth";
import { AlphaTag, ALPHA_NOTE } from "../components/AlphaTag";
import { Button, ErrorText } from "../components/ui";
import { GUEST_SESSION_KEY, useGuestSession, type GuestSession } from "../guestPlay";
import { PlayHome } from "./PlayHome";
import "./play.css";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id: string): void;
    };
  }
}

/** The action the server checks Cloudflare's answer against (guests.rs, TURNSTILE_ACTION). */
const TURNSTILE_ACTION = "guest-play";

let turnstileScript: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  turnstileScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileScript = null;
      reject(new Error("Couldn't load the check from Cloudflare. Check your connection, or sign in instead."));
    };
    document.head.appendChild(s);
  });
  return turnstileScript;
}

/** /play signed out: the guest's Play page, or the way in as a guest or with an account. */
export function GuestPlayHome() {
  const session = useGuestSession();
  if (session.data?.guest) return <PlayHome guest={session.data} />;
  return (
    <main className="page play-home guest-play">
      <div className="ph-head">
        <h1>
          Play online
          <AlphaTag />
        </h1>
        <p className="dim">{ALPHA_NOTE}</p>
      </div>
      <ErrorText error={session.error} />
      <div className="gp-ways">
        {session.data?.enabled && session.data.site_key && (
          <section className="gp-guest" aria-labelledby="gp-guest-h">
            <h2 id="gp-guest-h">Play the computer now</h2>
            <p>No account needed. Pick a precon for yourself and up to five computer opponents.</p>
            <p className="small dim">Guest games are kept for a week, then deleted.</p>
            <GuestStart siteKey={session.data.site_key} />
          </section>
        )}
        <section className="gp-signin account-gate-signin login-side" aria-label="Sign in">
          <div className="login-inner">
            <SignInForm heading="h2" title="Sign in to play your decks" />
            <p className="small dim">With an account you play your own decks, invite friends with a code and keep every game.</p>
          </div>
        </section>
      </div>
    </main>
  );
}

/** The Turnstile check, then the button that makes this browser a guest. */
function GuestStart({ siteKey }: { siteKey: string }) {
  const qc = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [problem, setProblem] = useState<Error | null>(null);
  useEffect(() => {
    let gone = false;
    loadTurnstile()
      .then(() => {
        if (gone || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          theme: "dark",
          // Most people never see it; it shows itself only when it needs a tap.
          appearance: "interaction-only",
          callback: (t: string) => {
            setProblem(null);
            setToken(t);
          },
          "expired-callback": () => setToken(null),
          "error-callback": () => {
            setToken(null);
            setProblem(new Error("The check didn't finish. Reload the page to try again, or sign in."));
          },
        });
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e : new Error(String(e))));
    return () => {
      gone = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);
  const start = useMutation({
    mutationFn: () => api<GuestSession>("/api/guest/session", { method: "POST", json: { turnstile: token } }),
    onSuccess: (s) => qc.setQueryData(GUEST_SESSION_KEY, s),
    onError: () => {
      // A token is good once: get a fresh one for the next try.
      setToken(null);
      if (widget.current) window.turnstile?.reset(widget.current);
    },
  });
  return (
    <div className="gp-start">
      <div ref={box} className="gp-check" />
      <ErrorText error={problem} />
      <ErrorText error={start.error} />
      <Button variant="primary" disabled={!token || start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? "Starting…" : token ? "Play as a guest" : "Checking you're a person…"}
      </Button>
    </div>
  );
}

/** Over a guest's Play page: what being a guest means, and the ways on. */
export function GuestNote({ session }: { session: GuestSession }) {
  const qc = useQueryClient();
  const leave = useMutation({
    mutationFn: () => api("/api/guest/session", { method: "DELETE" }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["play"] });
      qc.setQueryData(GUEST_SESSION_KEY, { ...session, guest: false, expires_at: null });
    },
  });
  const until = shortDate(session.expires_at);
  return (
    <div className="gp-note">
      <p>
        You're playing as a guest, on precons{until ? `. Your games are kept until ${until}` : ""}.{" "}
        <Link to={signInPath("/play")}>Sign in</Link> to play your own decks and with friends.
      </p>
      <Button variant="quiet" disabled={leave.isPending} onClick={() => leave.mutate()}>
        Stop, and delete my guest games
      </Button>
      <ErrorText error={leave.error} />
    </div>
  );
}
