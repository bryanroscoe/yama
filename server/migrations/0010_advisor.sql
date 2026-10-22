-- The advisor ("Ask Claude", 2026-10-22): conversations about your own decks, plans and lab runs,
-- answered by Claude through the advisor sidecar. Everything here is private to its owner.
--
-- Who may ask, and on whose account: accounts listed in YAMA_ADVISOR_SUBSCRIPTION_EMAILS use the
-- server's Claude subscription (Bryan's own); anyone else only with an Anthropic API key they
-- saved themselves (advisor_keys). Anthropic doesn't allow an app to share one person's
-- subscription with other people, so there is no third way.

-- A user's own Anthropic API key, encrypted with YAMA_ADVISOR_KEY_SECRET (ChaCha20-Poly1305, the
-- user id as associated data, so a row can't be moved to another account). Never sent back to
-- any browser; `hint` is the last four characters, for "the key ending abcd".
CREATE TABLE advisor_keys (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext  BLOB NOT NULL,
    nonce       BLOB NOT NULL,
    hint        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- The model each person picked (default claude-opus-5-5).
CREATE TABLE advisor_settings (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- A conversation is about one thing: a plan deck, Review, a deck, a precon, an experiment, or
-- nothing in particular. The context is rebuilt from the owner's current data on every question.
CREATE TABLE advisor_conversations (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    context_kind  TEXT NOT NULL CHECK (context_kind IN ('general','plan_deck','review','deck','precon','experiment')),
    context_ref   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX advisor_conversations_owner ON advisor_conversations(owner_id, context_kind, context_ref, updated_at);

CREATE TABLE advisor_messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES advisor_conversations(id) ON DELETE CASCADE,
    owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content          TEXT NOT NULL,
    -- Assistant messages: the model and credential used, and how the answer ended.
    model            TEXT,
    mode             TEXT CHECK (mode IN ('subscription','own_key')),
    status           TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','error','stopped')),
    error            TEXT,
    usage            TEXT,                          -- JSON {input_tokens, output_tokens, cost_usd}
    created_at       TEXT NOT NULL
);
CREATE INDEX advisor_messages_conversation ON advisor_messages(conversation_id, created_at);

-- One row per question asked, kept when conversations are deleted, so deleting doesn't give an
-- account a fresh daily allowance.
CREATE TABLE advisor_usage (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode        TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX advisor_usage_owner ON advisor_usage(owner_id, created_at);
