-- One plan per deck, approved as a whole (Bryan, 2026-11-06: the plans redesign; ARCHITECTURE.md,
-- "Plans: one plan per deck"). A deck's plan is in one state: waiting for your OK, in progress,
-- done or archived. Approving is one decision for the whole plan: every change you didn't skip
-- becomes a "want" answer and every skipped one a "no" (plan_reviews, as Review answers always
-- were, so the shopping list, prints and the export side's inbox read them unchanged). Each
-- decision is a numbered version of the deck's plan, kept here so earlier versions stay readable.
--
-- Nothing existing is rewritten: plans, swaps, marks and Review answers stay as they are. Every
-- live plan deck that already has planned swaps becomes version 1, approved when the deck was
-- first imported; a plan that is still only proposals (status 'proposals_only') has no version
-- and waits for your OK.

-- The owner archived this plan in Yama ("Not now"), or approving another plan for the same deck
-- replaced it. An import never writes these columns, so a later plan file can't undo it.
ALTER TABLE plan_decks ADD COLUMN archived_at TEXT;
ALTER TABLE plan_decks ADD COLUMN archived_note TEXT;
-- A plan made from a note's build after this change: its swaps are proposals, waiting for your OK,
-- instead of going straight into the plan. Older tracked builds keep their planned swaps.
ALTER TABLE plan_decks ADD COLUMN note_proposed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE plan_versions (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES users(id),
    plan_deck_id   TEXT NOT NULL,
    deck_name      TEXT NOT NULL,                    -- as it was, so an earlier version stays readable
    n              INTEGER NOT NULL CHECK (n >= 1),  -- the deck's version number (counted per deck name)
    status         TEXT NOT NULL CHECK (status IN ('approved', 'kept')),  -- kept: you kept the version before it
    changes        TEXT NOT NULL DEFAULT '[]',       -- JSON [{key, in, out, src, why}]: what the version holds (approved) or proposed (kept)
    skipped        TEXT NOT NULL DEFAULT '[]',       -- JSON [{key, in, out}]: changes you skipped
    answers        TEXT NOT NULL DEFAULT '[]',       -- JSON [{question, answer}]: the open questions, answered before approving
    prior          TEXT NOT NULL DEFAULT '{}',       -- JSON {key: {decision, note, cut, at, origin, op_id} | null}: answers before, for Undo
    source         TEXT NOT NULL DEFAULT '{}',       -- JSON: where the version came from {kind, app, guide_version, imported_at, note, title}
    proposed_at    TEXT,                             -- when its changes first arrived
    decided_at     TEXT NOT NULL,
    superseded_at  TEXT,                             -- a later version was approved
    op_id          TEXT,                             -- the plan op that decided it (plan_inputs)
    UNIQUE (owner_id, plan_deck_id, n),
    FOREIGN KEY (plan_deck_id, owner_id) REFERENCES plan_decks(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX plan_versions_owner ON plan_versions (owner_id, decided_at);

INSERT INTO plan_versions (id, owner_id, plan_deck_id, deck_name, n, status, changes, source, proposed_at, decided_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
             substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       d.owner_id, d.id, d.name, 1, 'approved',
       (SELECT json_group_array(json_object('key', s.ext_key, 'in', s.in_name, 'out', s.out_name, 'src', s.src, 'why', s.why))
        FROM (SELECT * FROM plan_swaps s WHERE s.plan_deck_id = d.id AND s.owner_id = d.owner_id AND s.stage = 'planned'
              AND s.role = 'swap' AND s.retired_at IS NULL ORDER BY s.sort, s.ext_key) s),
       json_object('kind', 'before_versions', 'note', 'In progress before plans had versions'),
       d.created_at, d.created_at
FROM plan_decks d
WHERE d.status = 'active'
  AND EXISTS (SELECT 1 FROM plan_swaps s WHERE s.plan_deck_id = d.id AND s.owner_id = d.owner_id AND s.stage = 'planned' AND s.retired_at IS NULL);

-- assistant_changes.kind gains 'approve_plan': Claude stages approving (or keeping the earlier
-- version of) a whole plan, and the person applies it in Yama like any other change.
CREATE TABLE assistant_changes_new (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('edit_deck', 'propose_swap', 'answer_review', 'mark_bought',
                                                   'mark_installed', 'start_lab_run', 'add_to_collection', 'move_cards',
                                                   'set_condition', 'more_lab_games', 'run_lab_again', 'cancel_lab_run',
                                                   'swap_in_prints', 'set_shopping_rules', 'set_store_preference',
                                                   'check_stores', 'add_wish', 'track_build', 'approve_plan')),
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
