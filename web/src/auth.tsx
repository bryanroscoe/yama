import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, setToken, type User } from "./api";
import { ErrorText, Pips } from "./components/ui";
import { clearPlanData } from "./plan/store";

const ME_KEY = "yama.me";

/** The signed-in user. Offline, the last known user is used so the life counter still opens. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await api<User>("/api/me");
        localStorage.setItem(ME_KEY, JSON.stringify(me));
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          localStorage.removeItem(ME_KEY);
          return null;
        }
        const cached = localStorage.getItem(ME_KEY);
        if (cached) return JSON.parse(cached) as User;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    // Plans hold prices paid: clear them first, so neither the Cloudflare Access path below nor
    // a failed (offline) logout request can leave them on the device.
    await clearPlanData(qc.getQueryData<User | null>(["me"])?.id);
    qc.removeQueries({ queryKey: ["plan"] });
    qc.removeQueries({ queryKey: ["plan-cache"] });
    await api("/api/auth/logout", { method: "POST" });
    const config = qc.getQueryData<AuthConfig>(["auth-config"]) ?? (await api<AuthConfig>("/api/auth/config").catch(() => null));
    if (config?.cf_access) {
      // Cloudflare Access holds the real session; end it there.
      localStorage.removeItem(ME_KEY);
      location.href = "/cdn-cgi/access/logout";
      return;
    }
    setToken(null);
    localStorage.removeItem(ME_KEY);
    qc.clear();
    qc.setQueryData(["me"], null);
  };
}

interface AuthConfig {
  google_client_id: string | null;
  dev_login: boolean;
  password_login: boolean;
  cf_access: boolean;
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

export function Login() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: () => api<AuthConfig>("/api/auth/config") });
  const googleRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const signedIn = (r: { user: User; token: string }) => {
    setToken(r.token);
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
    <main className="login">
      <div className="login-inner">
        <div>
          <Pips identity="WUBRG" label={false} />
          <h1>Yama</h1>
          <p className="dim">Life totals, cards, collection and decks for our playgroup.</p>
        </div>
        {clientId && <div ref={googleRef} />}
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
          // Accounts made with `yama-server user add`. Tucked away when Google sign-in is the usual way in.
          <details open={!clientId && !config.data.cf_access && !config.data.dev_login}>
            <summary className="dim small">Sign in with a password</summary>
            <form
              className="stack"
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
              <button className="primary" disabled={withPassword.isPending}>
                {withPassword.isPending ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </details>
        )}
        {config.data?.dev_login && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              dev.mutate();
            }}
          >
            <p className="dim small">Development sign-in: any email, no password. Only works on a local server.</p>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
            </label>
            <button className="primary" disabled={dev.isPending}>
              Sign in (development)
            </button>
          </form>
        )}
        <ErrorText error={error ?? config.error} />
      </div>
    </main>
  );
}
