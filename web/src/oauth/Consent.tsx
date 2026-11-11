import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError } from "../api";
import { Wordmark } from "../components/Wordmark";
import { checkAuthorize, decideAuthorize } from "./api";
import { ConsentView } from "./ConsentView";
import { authParams } from "./logic";
import "./oauth.css";
import { Loading } from "../components/ui";

/** How long a request the app got wrong stays on screen before the browser goes back to the app. */
const BOUNCE_MS = 2500;

/**
 * `/oauth/authorize` (server/src/oauth): Claude Code or a claude.ai connector asks to use Yama's
 * tools as you. You're signed in by the time this shows (App shows the sign-in page first, and
 * keeps the address, query and all). The server checks the request; Allow or Deny posts the
 * answer and sends the browser where the server says.
 */
export function OAuthConsent() {
  const search = window.location.search;
  const check = useQuery({ queryKey: ["oauth-check", search], queryFn: () => checkAuthorize(search), retry: false, staleTime: Infinity, gcTime: 0 });
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideAuthorize(authParams(search), approve),
    onSuccess: (r) => window.location.assign(r.redirect),
  });
  const bounce = check.data && !check.data.ok ? check.data : null;
  useEffect(() => {
    if (!bounce) return;
    const t = setTimeout(() => window.location.replace(bounce.redirect), BOUNCE_MS);
    return () => clearTimeout(t);
  }, [bounce]);

  return (
    <main className="oauth">
      <div className="oauth-inner">
        <Wordmark className="oauth-wordmark" />
        {check.isPending && <Loading>Checking what the app asks for…</Loading>}
        {check.error && (
          <section className="oauth-panel" role="alert">
            <h1>Yama can't connect this app</h1>
            <p>{problemText(check.error)}</p>
          </section>
        )}
        {bounce && (
          <section className="oauth-panel" role="status">
            <h1>The app's request didn't work</h1>
            <p>{bounce.error}</p>
            <Loading small quiet>Taking you back to the app to say so…</Loading>
          </section>
        )}
        {check.data?.ok && (
          <ConsentView
            info={check.data}
            busy={decide.isPending || decide.isSuccess}
            error={decide.error}
            onAllow={() => decide.mutate(true)}
            onDeny={() => decide.mutate(false)}
          />
        )}
        {decide.isSuccess && <Loading small>Taking you back to the app…</Loading>}
        <p className="dim small">Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast.</p>
      </div>
    </main>
  );
}

function problemText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "Signing in apps isn't set up on this Yama server.";
  return error instanceof Error ? error.message : String(error);
}
