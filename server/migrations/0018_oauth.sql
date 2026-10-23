-- OAuth sign-in for Yama's tools (server/src/oauth/, docs/mcp-design.md slice 3): Claude Code and
-- claude.ai's custom connectors reach POST /mcp with a token from an OAuth sign-in instead of a
-- pasted script key. Every secret (client secret, code, access and refresh token) is stored as its
-- SHA-256 only. Deleting an account deletes its grants (their tokens go with them) and codes
-- (admin/delete.rs). Clients hold no account: the sweep in oauth/ removes ones nobody uses.

-- Apps registered through dynamic client registration (RFC 7591). The name is the app's own claim,
-- shown as plain text; redirect URIs are loopback or an allowlisted https host (oauth/redirect.rs).
CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    redirect_uris TEXT NOT NULL, -- JSON array of strings
    auth_method   TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
    secret_hash   TEXT,          -- confidential clients only
    created_at    TEXT NOT NULL,
    used_at       TEXT           -- last time a sign-in finished; NULL ones are swept after a day
);

-- One person's yes to one app: what Settings lists under "Connected apps". Made when the app
-- exchanges its code; revoking it (Disconnect, the app's revoke call, a replayed code or a reused
-- refresh token) deletes its tokens.
CREATE TABLE oauth_grants (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    client_id     TEXT NOT NULL REFERENCES oauth_clients(id),
    scope         TEXT NOT NULL,
    resource      TEXT NOT NULL,
    redirect_uri  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT,
    revoke_reason TEXT CHECK (revoke_reason IN ('disconnected', 'revoked by the app', 'replaced', 'code replayed', 'refresh token reused'))
);
CREATE INDEX oauth_grants_user ON oauth_grants (user_id, created_at);
CREATE INDEX oauth_grants_client ON oauth_grants (client_id);

-- Authorization codes: single use, about two minutes, bound to the client, the exact redirect URI,
-- the PKCE challenge, the account, the scope and the resource. `grant_id` is the grant the code
-- made, so a replay can revoke it.
CREATE TABLE oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id),
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope          TEXT NOT NULL,
    resource       TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_at        TEXT,
    grant_id       TEXT REFERENCES oauth_grants(id) ON DELETE SET NULL
);

-- Access tokens (`yama_oat_`, an hour, accepted only by POST /mcp) and refresh tokens (`yama_ort_`,
-- 30 days, rotated: `used_at` marks one that was exchanged, and using it again revokes the grant).
CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
