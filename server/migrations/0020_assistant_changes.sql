-- Changes Claude staged through Yama's tools (docs/mcp-design.md, slice 2). A write tool never
-- changes anything: it checks the change, stores it here as pending and returns a summary. The
-- person applies or discards it in Yama (the Ask Claude panel, or Decks, Changes from Claude); an
-- outside client may also apply it with `apply_change` once the person has said yes. Applying runs
-- the change through the same code as the pages, with every check again, and a change made against
-- a deck version that is no longer current fails with the reason and stays pending.
--
-- Deleting an account deletes its changes (admin/delete.rs). Conversations aren't foreign keys:
-- deleting one leaves its changes on the review list.
CREATE TABLE assistant_changes (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('edit_deck', 'propose_swap', 'answer_review', 'mark_bought',
                                                   'mark_installed', 'start_lab_run', 'add_to_collection', 'move_cards')),
    summary          TEXT NOT NULL,  -- one line: "Lorehold Spirit: +Smothering Tithe, −Banishing Light"
    detail           TEXT,           -- more lines: the reasons, the checks of the list after
    payload          TEXT NOT NULL,  -- JSON: what applying does (tools.rs, changes.rs)
    -- How it was staged: Ask Claude ('question'), a script key ('key') or an OAuth sign-in ('oauth').
    via              TEXT NOT NULL CHECK (via IN ('question', 'key', 'oauth')),
    -- Ask Claude only: the conversation and the answer that staged it, so the panel shows it there.
    conversation_id  TEXT,
    message_id       TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
    -- The last failed apply (the change stays pending), or what applying made.
    error            TEXT,
    result           TEXT,
    created_at       TEXT NOT NULL,
    decided_at       TEXT
);
CREATE INDEX assistant_changes_owner ON assistant_changes (owner_id, status, created_at);
CREATE INDEX assistant_changes_conversation ON assistant_changes (owner_id, conversation_id);
