-- A staging tool call may carry the caller's own op id (the MCP `op_id` argument), so a retried
-- call (a lost reply, a client that sends twice) answers with the change it already staged instead
-- of staging a second one. One op id per account. `op_hash` is what that call asked for (the
-- stored kind and its arguments, hashed), so an op id reused for a different request is refused
-- instead of answering with the earlier change.
--
-- `assistant_changes` is recreated whenever a kind is added to its CHECK (0067, 0071). A later
-- migration that does so must copy `op_id` and `op_hash` and recreate `assistant_changes_op`.
ALTER TABLE assistant_changes ADD COLUMN op_id TEXT;
ALTER TABLE assistant_changes ADD COLUMN op_hash TEXT;
CREATE UNIQUE INDEX assistant_changes_op ON assistant_changes (owner_id, op_id) WHERE op_id IS NOT NULL;
