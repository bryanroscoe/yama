-- A staging tool call may carry the caller's own op id (the MCP `op_id` argument), so a retried
-- call (a lost reply, a client that sends twice) answers with the change it already staged instead
-- of staging a second one. One op id per account.
ALTER TABLE assistant_changes ADD COLUMN op_id TEXT;
CREATE UNIQUE INDEX assistant_changes_op ON assistant_changes (owner_id, op_id) WHERE op_id IS NOT NULL;
