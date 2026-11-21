-- Where a plan and its changes came from (Bryan, 2026-11-21, after asking why changes from an
-- earlier request were in his Riders of Rohan plan: "record where these plans came from ... so it
-- can have the history of that and the ability to find it in the future easily and quickly").
--
-- An entry is what an assistant recorded about a plan (`record_plan_history`, `track_build`):
-- what happened, the person's request in their own words, when, and where the conversation and
-- the work are. Yama's own record of a plan (its import, versions, answers, archiving) stays in
-- the tables that hold it; `plan::history` reads them into one timeline with these entries.
CREATE TABLE plan_history (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    plan_deck_id  TEXT NOT NULL,
    on_date       TEXT NOT NULL,                 -- YYYY-MM-DD: when it happened (the request, the audit), not when it was recorded
    what          TEXT NOT NULL,                 -- what happened, in a sentence or two
    asked         TEXT,                          -- the person's own words, when a request started it
    conversation  TEXT,                          -- where the conversation is: a thread's link or title, a session id
    work          TEXT,                          -- where the work is: a commit, a file, a note
    group_label   TEXT,                          -- the proposal group it is about, as the plan names it
    cards         TEXT NOT NULL DEFAULT '[]',    -- JSON [card name]: the changes it is about, by the card each puts in
    via           TEXT NOT NULL,                 -- how the assistant got in: key | oauth | question, or staged (a staged track_build applied)
    op_id         TEXT,                          -- the caller's id: a retry with the same id records nothing new
    recorded_at   TEXT NOT NULL,
    UNIQUE (owner_id, op_id),
    FOREIGN KEY (plan_deck_id, owner_id) REFERENCES plan_decks(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX plan_history_plan ON plan_history (owner_id, plan_deck_id, on_date);
