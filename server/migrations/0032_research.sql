-- Research is private, reviewable advice. These rows never install decks or move inventory.
CREATE TABLE research_reports (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    document TEXT NOT NULL CHECK(json_valid(document)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id, id)
);
CREATE TABLE research_reviews (
    owner_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    target TEXT NOT NULL,
    decision TEXT,
    note TEXT,
    target_hash TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id, report_id, target),
    FOREIGN KEY(owner_id, report_id) REFERENCES research_reports(owner_id, id) ON DELETE CASCADE
);
CREATE TABLE research_review_ops (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    receipt TEXT NOT NULL CHECK(json_valid(receipt)),
    PRIMARY KEY(owner_id, op_id)
);
