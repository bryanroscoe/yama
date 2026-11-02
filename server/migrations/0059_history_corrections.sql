-- Operator corrections are separate from gameplay events and pending assistant proposals.
-- Changes and this row commit together; normal backups still cover disaster recovery.
CREATE TABLE history_corrections (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    request TEXT NOT NULL CHECK (json_valid(request)),
    changes TEXT NOT NULL CHECK (json_valid(changes)),
    subjects TEXT NOT NULL CHECK (json_valid(subjects)),
    reverts TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (reverts)
);
CREATE INDEX history_corrections_owner ON history_corrections(owner_id, created_at);

-- Privacy-safe counters survive audit-batch purges for other games/accounts. Otherwise
-- deleting one target of a multi-game batch could reopen an older undo on surviving games.
CREATE TABLE history_correction_targets (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('player', 'win_condition')),
    seat INTEGER NOT NULL, -- -1 for a game-level win condition
    revision INTEGER NOT NULL,
    PRIMARY KEY (game_id, kind, seat)
);

-- Audit retention follows privacy/deletion, including accounts mentioned in another
-- recorder's batch. Keep batches atomic: purge the entire batch if any target goes away.
CREATE TRIGGER history_corrections_forget_user BEFORE DELETE ON users BEGIN
    DELETE FROM history_corrections WHERE owner_id = OLD.id
      OR EXISTS (SELECT 1 FROM json_each(subjects) WHERE value = OLD.id)
      OR EXISTS (SELECT 1 FROM json_tree(request) WHERE type = 'text' AND atom = OLD.id)
      OR EXISTS (SELECT 1 FROM json_tree(changes) WHERE type = 'text' AND atom = OLD.id);
END;
CREATE TRIGGER history_corrections_forget_game BEFORE DELETE ON games BEGIN
    DELETE FROM history_corrections
      WHERE EXISTS (SELECT 1 FROM json_each(changes) WHERE json_extract(value, '$.game_id') = OLD.id);
END;
