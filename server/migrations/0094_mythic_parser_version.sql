-- Which Mythic Tools importer read a file (`collection::mythic::PARSER_VERSION`). Version 1 (15 Nov
-- 2026) reads a special foil ("Surge Foil") as foil and "Etched Foil" as etched, where version 0
-- filed both as regular. Re-importing a file whose receipt is older corrects those copies' finish
-- once, then the receipt moves to the current version, so a later finish change made by hand is
-- never undone by importing the same file again. Receipts from before this column are version 0.
ALTER TABLE mythic_imports ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0;
