// The OAuth consent page and Connected apps (server/src/oauth): the words they show, kept apart
// from React so they can be tested.

/** The authorization request parameters the server checks; anything else in the URL is ignored. */
export const AUTH_KEYS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;
export type AuthParams = Partial<Record<(typeof AUTH_KEYS)[number], string>>;

/** The request's parameters from the page's query string, first value of each. */
export function authParams(search: string): AuthParams {
  const q = new URLSearchParams(search);
  const out: AuthParams = {};
  for (const k of AUTH_KEYS) {
    const v = q.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** What the server says about a good request. */
export interface ConsentInfo {
  ok: true;
  /** The app's own name for itself, unchecked; null when it gave none. */
  client_name: string | null;
  redirect_host: string;
  /** Codes go to a program on this computer (Claude Code), not a website. */
  loopback: boolean;
  scopes: string[];
  /** What the app asks to do with the tools. */
  access: Access;
  /** What you may give it instead: that or less, least first. */
  access_choices: Access[];
  account: { display_name: string; email: string };
}

/** What a connection may do with the tools; each level includes the ones before it. */
export type Access = "read" | "stage" | "apply";

/** The most a list of scopes allows: `mcp` is everything, as every older connection has. */
export function accessOf(scopes: string[]): Access | null {
  if (scopes.includes("mcp") || scopes.includes("mcp:apply")) return "apply";
  if (scopes.includes("mcp:stage")) return "stage";
  if (scopes.includes("mcp:read")) return "read";
  return null;
}

/** A level as a choice on the consent page. */
export function accessLabel(access: Access): string {
  switch (access) {
    case "read":
      return "Read only";
    case "stage":
      return "Read and suggest changes";
    default:
      return "Read, suggest changes and apply the ones you say yes to";
  }
}

/** A request the app got wrong: say so, then send the browser back to the app with the error. */
export interface ConsentBounce {
  ok: false;
  error: string;
  redirect: string;
}

export type ConsentCheck = ConsentInfo | ConsentBounce;

/** An app as it named itself, or a plain stand-in. */
export function appName(name: string | null | undefined): string {
  const n = name?.trim();
  return n ? n : "An app that gave no name";
}

/** Where the app sends people back to, in words. */
export function returnsTo(host: string, loopback: boolean): string {
  return loopback ? `a program on this computer (${host})` : host;
}

/**
 * What a connection may do, matching the tools (server/src/mcp): read, stage changes for review,
 * and apply one after your yes. `access` is the level chosen on the page; without it, what the
 * scopes ask for.
 */
export function allows(scopes: string[], access: Access | null = accessOf(scopes)): string[] {
  const out: string[] = [];
  if (access) out.push("Read your decks, plans, Review, collection and lab runs", "Search cards");
  if (access === "stage") out.push("Suggest changes to your decks, plans, lab and collection, and save research notes. Each change waits in Yama for you to apply or discard; this app can't apply one");
  if (access === "apply")
    out.push("Suggest changes to your decks, plans, lab and collection. Each one waits in Yama for you to apply or discard, and Claude applies one only after you say yes to it");
  if (scopes.includes("offline_access")) out.push("Stay connected until you disconnect it, without asking again");
  return out;
}

/** The warning under the facts: when to say no. */
export function caution(loopback: boolean): string {
  return loopback
    ? "Any program on this computer can ask for this. Allow it only if you just started the sign-in yourself, for example with /mcp in Claude Code."
    : "Allow this only if you just added Yama in Claude yourself. Never allow a sign-in link someone sent you.";
}

/** A connected app as Settings lists it. */
export interface ConnectedApp {
  id: string;
  name: string | null;
  redirect_host: string;
  loopback: boolean;
  /** What it may do with the tools. */
  access: Access;
  connected_at: string;
  last_used_at: string | null;
}

export interface ConnectedApps {
  /** OAuth is set up on this server (YAMA_PUBLIC_URL). */
  enabled: boolean;
  /** The address to give Claude, e.g. https://yama.ing/mcp. */
  mcp_url: string | null;
  apps: ConnectedApp[];
}

/** The Claude Code command that adds Yama, signing in through the browser (no key). */
export function claudeCodeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http yama ${mcpUrl}`;
}

/** A connected app's kind, from where it sends people back. */
export function appKind(app: Pick<ConnectedApp, "redirect_host" | "loopback">): string {
  if (app.loopback) return "On this computer";
  if (app.redirect_host === "claude.ai" || app.redirect_host === "claude.com") return "Claude on the web, desktop and phone";
  return app.redirect_host;
}
