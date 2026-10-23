-- Ask Claude on a shared API key (2026-10-22; Bryan: "let Matt use my key as well"). An admin may
-- let chosen accounts ask on an Anthropic API key the server owner pays for per use. The key itself
-- lives only in the advisor sidecar (ANTHROPIC_SHARED_API_KEY in advisor.env); Yama never sees it.
-- It is not the owner's Claude subscription, which stays with YAMA_ADVISOR_SUBSCRIPTION_EMAILS only.

-- Who may ask on the shared key. `daily_limit` overrides the account's usual daily allowance for
-- shared questions (null: the usual 30 or 150). `granted_by` is the admin who turned it on (null
-- when granted from the command line without one, or once that admin's account is deleted).
CREATE TABLE advisor_shared_access (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    granted_at   TEXT NOT NULL,
    daily_limit  INTEGER CHECK (daily_limit IS NULL OR daily_limit > 0)
);

-- What each question cost in USD, as the sidecar reported it (API-key and shared modes; null for the
-- subscription or when the answer didn't say). Kept when conversations are deleted, so the shared
-- key's monthly cap and each account's spend add up.
ALTER TABLE advisor_usage ADD COLUMN cost_usd REAL;
CREATE INDEX advisor_usage_mode ON advisor_usage(mode, created_at);

-- advisor_messages.mode gains 'shared'. SQLite can't change a CHECK, so the table is rebuilt with
-- the same columns and rows (nothing references it).
CREATE TABLE advisor_messages_new (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES advisor_conversations(id) ON DELETE CASCADE,
    owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content          TEXT NOT NULL,
    -- Assistant messages: the model and credential used, and how the answer ended.
    model            TEXT,
    mode             TEXT CHECK (mode IN ('subscription','own_key','shared')),
    status           TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','error','stopped')),
    error            TEXT,
    usage            TEXT,                          -- JSON {input_tokens, output_tokens, cost_usd}
    created_at       TEXT NOT NULL
);
INSERT INTO advisor_messages_new (id, conversation_id, owner_id, role, content, model, mode, status, error, usage, created_at)
    SELECT id, conversation_id, owner_id, role, content, model, mode, status, error, usage, created_at FROM advisor_messages;
DROP TABLE advisor_messages;
ALTER TABLE advisor_messages_new RENAME TO advisor_messages;
CREATE INDEX advisor_messages_conversation ON advisor_messages(conversation_id, created_at);
