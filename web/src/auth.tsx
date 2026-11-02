import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, ApiError, setToken, type User } from "./api";
import { Details, ErrorText } from "./components/ui";
import { outbox } from "./plan/outbox";
import { discardQuestion, signOut, within } from "./plan/signout";
import { clearPlanData } from "./plan/store";
import "./auth.css";
import { noteViewing } from "./viewing";
import { Landing } from "./pages/Landing";
import { chooseGuest } from "./guest";

const ME_KEY = "yama.me";

/** The signed-in user. Offline, the last known user is used so the life counter still opens. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await api<User>("/api/me");
        localStorage.setItem(ME_KEY, JSON.stringify(me));
        noteViewing(me);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          localStorage.removeItem(ME_KEY);
          noteViewing(null);
          return null;
        }
        const cached = localStorage.getItem(ME_KEY);
        if (cached) return JSON.parse(cached) as User;
        throw e;
      }
    },
    // Checked again after five minutes (on the next mount or focus), so a power-user grant or its
    // withdrawal reaches an open app without a reload; the cached account shows meanwhile.
    staleTime: 5 * 60_000,
  });
}

/**
 * Whether the signed-in account may start simulations and watched AI games and use Ask Claude:
 * an admin or a power user. The server refuses everyone else; this only hides what they can't use.
 */
export function usePower(): boolean {
  return useMe().data?.power === true;
}

/**
 * Sign out. Plan data and unsent taps leave the device first (web/src/plan/signout.ts has the
 * order), so neither a failed logout request (no connection) nor the Cloudflare Access redirect
 * can leave them behind. Resolves false if the person chose to keep unsent answers; throws when
 * the server couldn't be reached, after the plan data is already gone.
 */
export function useLogout() {
  const qc = useQueryClient();
  return async (): Promise<boolean> => {
    const me = qc.getQueryData<User | null>(["me"]);
    const userId = me?.id;
    // Signing out while viewing as someone: the admin's own plan data leaves the device too.
    const alsoClear = me?.viewing?.admin_id;
    const result = await signOut({
      userId,
      pending: () => outbox.pendingCount(userId),
      flush: () => within(userId ? outbox.sync(userId) : Promise.resolve(), 4000),
      confirmDiscard: (n) => window.confirm(discardQuestion(n, outbox.sending(userId))),
      clearPlan: async (id) => {
        await clearPlanData(id);
        if (alsoClear) await clearPlanData(alsoClear);
      },
      dropQueries: () => {
        qc.removeQueries({ queryKey: ["plan"] });
        qc.removeQueries({ queryKey: ["plan-cache"] });
      },
      logoutRequest: () => api("/api/auth/logout", { method: "POST" }),
      authConfig: async () => qc.getQueryData<AuthConfig>(["auth-config"]) ?? (await api<AuthConfig>("/api/auth/config")),
      cloudflareLogout: () => {
        localStorage.removeItem(ME_KEY);
        location.href = "/cdn-cgi/access/logout";
      },
      finish: () => {
        setToken(null);
        localStorage.removeItem(ME_KEY);
        // Not qc.clear(): it removes the "me" query out from under the mounted observer, which keeps
        // showing the signed-in user. Set "me" first, drop the rest, then load the page afresh so no
        // cache, socket or timer from the signed-in session survives.
        qc.setQueryData(["me"], null);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
        window.location.replace("/");
      },
    }).catch((e: unknown) => {
      throw new Error(
        `Couldn't reach Yama to sign out (${e instanceof Error ? e.message : String(e)}). Your plans are already off this device; try again when you're online.`,
      );
    });
    return result !== "cancelled";
  };
}

/**
 * Delete the signed-in account and everything it owns (`DELETE /api/me`), and forget it on this
 * device as signing out does: plan data and unsent answers, the token and the cached user. The
 * person types their email to confirm; the server checks it too. Plan data leaves first, so a
 * deletion whose answer is lost on the way back doesn't leave prices paid on the phone. Trying
 * again after such a lost answer gets 401 (the session went with the account), which finishes the
 * rest; a 401 on a first try is only an expired sign-in, and the account is still there.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  const answerLost = useRef(false);
  return useMutation({
    mutationFn: async (confirmEmail: string) => {
      const userId = qc.getQueryData<User | null>(["me"])?.id;
      await clearPlanData(userId);
      qc.removeQueries({ queryKey: ["plan"] });
      qc.removeQueries({ queryKey: ["plan-cache"] });
      try {
        await api("/api/me", { method: "DELETE", json: { confirm_email: confirmEmail } });
      } catch (e) {
        if (!(e instanceof ApiError)) {
          answerLost.current = true;
          throw new Error("Couldn't reach Yama. Try again when you're online; if your account was already deleted, that finishes signing this phone out.");
        }
        if (e.status !== 401) throw e;
        if (!answerLost.current) throw new Error("Your sign-in has run out. Sign in again to delete your account.");
      }
      setToken(null);
      localStorage.removeItem(ME_KEY);
      qc.setQueryData(["me"], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      window.location.replace("/");
    },
  });
}

/** The sign-in page, coming back to `from` (a path on Yama) once signed in. */
export function signInPath(from?: string): string {
  return from && from !== "/" && from !== "/signin" ? `/signin?next=${encodeURIComponent(from)}` : "/signin";
}

/** Where the sign-in page goes once signed in: its `next`, if that's a path on Yama, else home. */
export function afterSignIn(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** A hairline either side of a few words, between two ways to sign in. */
function Or({ children }: { children: string }) {
  return (
    <div className="login-or" aria-hidden="true">
      {children}
    </div>
  );
}

export interface AuthConfig {
  google_client_id: string | null;
  dev_login: boolean;
  password_login: boolean;
  cf_access: boolean;
  /** Anyone with a Google account may join (YAMA_OPEN_SIGNUP). Missing on older servers. */
  open_signup?: boolean;
}

/** The server's sign-in settings, shared by the sign-in page and the admin rows in Group. */
export function useAuthConfig(enabled = true) {
  return useQuery({ queryKey: ["auth-config"], queryFn: () => api<AuthConfig>("/api/auth/config"), enabled });
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(opts: { client_id: string; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
        };
      };
    };
  }
}

function loadGoogle(): Promise<void> {
  if (window.google) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Google sign-in. Check your connection."));
    document.head.appendChild(s);
  });
}

/**
 * The sign-in page at /signin (the public landing page around the ways in), and the focused one
 * in front of a full-screen address that needs an account (an app asking to connect, a shared
 * table on Yama's own relay, an online game).
 */
export function Login() {
  const focused = useLocation().pathname !== "/signin";
  return (
    <Landing focused={focused}>
      <SignInForm heading={focused ? "h1" : "h2"} countLife />
    </Landing>
  );
}

/**
 * The ways into Yama. On the sign-in page, and inside a page that needs an account
 * (RequireAccount), which shows the page once the account is signed in.
 */
export function SignInForm({ heading: SignInTitle, title = "Sign in to Yama", countLife = false }: { heading: "h1" | "h2"; title?: string; countLife?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const config = useAuthConfig();
  const googleRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const signedIn = (r: { user: User; token: string }) => {
    setToken(r.token);
    // Remembered now, not at the next check: games started or saved from here on are this account's.
    localStorage.setItem(ME_KEY, JSON.stringify(r.user));
    chooseGuest(false);
    qc.setQueryData(["me"], r.user);
  };

  const google = useMutation({
    mutationFn: (credential: string) => api<{ user: User; token: string }>("/api/auth/google", { method: "POST", json: { credential } }),
    onSuccess: signedIn,
    onError: setError,
  });
  const dev = useMutation({
    mutationFn: () => api<{ user: User; token: string }>("/api/auth/dev", { method: "POST", json: { email, name } }),
    onSuccess: signedIn,
    onError: setError,
  });

  const withPassword = useMutation({
    mutationFn: () => api<{ user: User; token: string }>("/api/auth/password", { method: "POST", json: { email, password } }),
    onSuccess: signedIn,
    onError: setError,
  });

  const clientId = config.data?.google_client_id;
  useEffect(() => {
    if (!clientId || !googleRef.current) return;
    let cancelled = false;
    loadGoogle()
      .then(() => {
        if (cancelled || !window.google || !googleRef.current) return;
        window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => google.mutate(r.credential) });
        window.google.accounts.id.renderButton(googleRef.current, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with" });
      })
      .catch(setError);
    return () => {
      cancelled = true;
    };
    // google.mutate is stable enough for a one-time button render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <>
      <div>
        <SignInTitle className="login-title">{title}</SignInTitle>
        {pathname === "/oauth/authorize" && (
          <p style={{ margin: "0 0 8px" }}>An app wants to connect to your Yama. Sign in first; you'll see what it asks for before anything is shared.</p>
        )}
        {config.data?.open_signup ? (
          <p className="dim" style={{ margin: 0 }}>Free with a verified Google account.</p>
        ) : (
          <p className="dim" style={{ margin: 0 }}>Yama is invite-only. Use the {clientId ? "Google account" : "account"} your host added.</p>
        )}
      </div>
      {/* Google's button is a light-scheme iframe. Inside our dark page Chrome paints an opaque
          white backdrop behind an iframe whose scheme differs, so give its box the light scheme. */}
      {clientId && <div ref={googleRef} style={{ colorScheme: "light" }} />}
      {/* The life counter works without an account (guest.ts); sharing a table needs one. */}
      {countLife && (
        <button className="login-secondary" onClick={() => navigate("/", { replace: true })}>
          Count life without an account
        </button>
      )}
      {config.data?.cf_access && (
        <div className="stack">
          <p className="dim">Yama signs you in with the email your host invited.</p>
          <button className="primary" onClick={() => location.reload()}>Sign in</button>
        </div>
      )}
      {config.data && !clientId && !config.data.dev_login && !config.data.cf_access && !config.data.password_login && (
        <p className="dim">
          Sign-in isn't set up on this server yet. Set YAMA_GOOGLE_CLIENT_IDS, add an account with <code>yama-server user add</code>, or set
          YAMA_DEV_LOGIN=1 for local use.
        </p>
      )}
      {config.data?.password_login && (
        // Accounts made with `yama-server user add`. Under Google's button when that's the usual
        // way in, so its own button is the secondary one.
        <>
          {(clientId || config.data.cf_access) && <Or>or with a password</Or>}
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              withPassword.mutate();
            }}
          >
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
            <button className={clientId || config.data.cf_access ? "login-secondary" : "primary"} disabled={withPassword.isPending}>
              {withPassword.isPending ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </>
      )}
      {config.data?.dev_login && (
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            dev.mutate();
          }}
        >
          {(clientId || config.data.password_login) && <Or>or for development</Or>}
          <p className="dim small" style={{ margin: 0 }}>Development sign-in: any email, no password. Only works on a local server.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
          </label>
          <button className={clientId || config.data.password_login ? "login-secondary" : "primary"} disabled={dev.isPending}>
            Sign in (development)
          </button>
        </form>
      )}
      <ErrorText error={error ?? config.error} />
      <Details label="Accounts and offline use">
        <p>Your data stays private unless you choose to share a deck or collection.</p>
        <p>The life counter works offline on a phone that has signed in before.</p>
      </Details>
    </>
  );
}
