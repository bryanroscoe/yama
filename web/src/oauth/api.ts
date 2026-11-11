import { api } from "../api";
import type { Access, AuthParams, ConnectedApps, ConsentCheck } from "./logic";

/** Is this authorization request good, and what should the consent page show. */
export const checkAuthorize = (search: string) => api<ConsentCheck>(`/api/oauth/authorize${search.startsWith("?") ? search : `?${search}`}`);

/** Allow (with how much it may do) or Deny; the answer is where to send the browser next. */
export const decideAuthorize = (params: AuthParams, approve: boolean, access?: Access) =>
  api<{ redirect: string }>("/api/oauth/authorize", { method: "POST", json: access ? { ...params, approve, access } : { ...params, approve } });

export const listConnectedApps = () => api<ConnectedApps>("/api/me/connected-apps");

export const disconnectApp = (id: string) => api<void>(`/api/me/connected-apps/${encodeURIComponent(id)}`, { method: "DELETE" });
