-- The printing look's vectors, computed by the server (scan_look.rs; docs/scanner.md, "The printing
-- look", 21 Nov 2026). Bryan wants scanning as fast as CardVision: a phone that compares a card with
-- the printings sharing its art used to fetch and embed each printing's Scryfall picture itself
-- (about half a second each on a cold connection). The server now embeds each picture once per look
-- model, exactly as the phone would, and the phone asks for them first.
--
-- Keyed by the look model file's SHA-256 (a new model gets its own vectors) and the picture's URL as
-- the card data stores it (Scryfall's `normal`, with its cache-busting query): what the phone keys its
-- own cache by, so a picture Scryfall replaces gets a new row. No one's data: Scryfall's pictures,
-- embedded; the pictures themselves are never kept.
CREATE TABLE scan_looks (
    model      TEXT NOT NULL,
    url        TEXT NOT NULL,
    -- symbol then card, 2 × 128 float16 little-endian (512 bytes); NULL when it couldn't be made.
    vector     BLOB,
    -- Why it couldn't (no picture, refused, won't decode), and how many times it was tried.
    error      TEXT,
    tries      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (model, url)
) WITHOUT ROWID;
