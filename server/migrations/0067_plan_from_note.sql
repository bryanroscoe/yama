-- Plans made from a note's build (Bryan, 2026-11-04: "I would expect plans to be part of the MCP",
-- and notes and plans "are hard to use today"). Tracking one build of a saved note makes a
-- Yama-made plan deck (source 'yama') whose swaps, quotes and lists are derived from that build and
-- re-derived when the note is saved again. One plan deck per note deck; switching builds keeps the
-- row, stopping archives it.
ALTER TABLE plan_decks ADD COLUMN note_id TEXT;
ALTER TABLE plan_decks ADD COLUMN note_deck_key TEXT;
ALTER TABLE plan_decks ADD COLUMN note_build_id TEXT;
CREATE UNIQUE INDEX plan_decks_note ON plan_decks (owner_id, note_id, note_deck_key) WHERE note_id IS NOT NULL;

-- assistant_changes.kind gains 'track_build': Claude stages tracking (or stopping) a note's build,
-- and the person applies it in Yama like any other change.
CREATE TABLE assistant_changes_new (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('edit_deck', 'propose_swap', 'answer_review', 'mark_bought',
                                                   'mark_installed', 'start_lab_run', 'add_to_collection', 'move_cards',
                                                   'set_condition', 'more_lab_games', 'run_lab_again', 'cancel_lab_run',
                                                   'swap_in_prints', 'set_shopping_rules', 'set_store_preference',
                                                   'check_stores', 'add_wish', 'track_build')),
    summary          TEXT NOT NULL,
    detail           TEXT,
    payload          TEXT NOT NULL,
    via              TEXT NOT NULL CHECK (via IN ('question', 'key', 'oauth')),
    conversation_id  TEXT,
    message_id       TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
    error            TEXT,
    result           TEXT,
    created_at       TEXT NOT NULL,
    decided_at       TEXT
);
INSERT INTO assistant_changes_new (id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at)
    SELECT id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at
    FROM assistant_changes;
DROP TABLE assistant_changes;
ALTER TABLE assistant_changes_new RENAME TO assistant_changes;
CREATE INDEX assistant_changes_owner ON assistant_changes (owner_id, status, created_at);
CREATE INDEX assistant_changes_conversation ON assistant_changes (owner_id, conversation_id);
