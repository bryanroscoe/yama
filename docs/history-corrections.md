# Correcting recorded game history

Use `scripts/history/correct.py` for operator corrections to finished in-person games:
player attribution and win conditions. This is a privileged maintenance command, not an
HTTP endpoint or a new permission for group members. It requires filesystem write access
to the database, Python 3 with SQLite JSON support, and migration
`0059_history_corrections.sql` installed by the normal Yama release. Do not apply migrations
by hand or point the command at a copied database when intending to correct production.

A correction and its audit entry commit in one `BEGIN IMMEDIATE` transaction. The log records
the recorder account, operator-supplied actor label, reason, operation ID, timestamp, and
before/after values of the affected fields. The actor label is operator attribution, not an
authenticated web identity. Up to 500 changes (1 MiB input) form one batch. A failure rolls
back the entire batch. No per-correction backup file is needed; normal scheduled and release
backups still protect against database loss. SQLite's WAL is not the audit log.

## Inspect, preview, apply

Run on the host with the database mounted locally. Keep request files in a restrictive task
folder outside the repository (directory 700, files 600); they contain private player data.
The examples use placeholder IDs; never commit real requests or command output.

```sh
python3 scripts/history/correct.py --database /path/to/yama.db --owner recorder@example.com show GAME_ID
python3 scripts/history/correct.py --database /path/to/yama.db --owner recorder@example.com apply /private/task/batch.json --dry-run
python3 scripts/history/correct.py --database /path/to/yama.db --owner recorder@example.com apply /private/task/batch.json
python3 scripts/history/correct.py --database /path/to/yama.db --owner recorder@example.com log --limit 20
```

Create one stable, unique operation ID (e.g. a UUID), and retain the exact request until the
outcome is known. Retrying that ID and payload returns the original result; changing the
payload under that ID is refused. Even after an undo, retrying the original request reports
its original application and does not apply it again. Use a new operation for a new change.
The database must already exist; a typo cannot silently create an empty one.

```json
{
  "id": "UNIQUE_BATCH_ID",
  "actor": "operator:codex",
  "reason": "Recorder confirmed these historical results",
  "changes": [
    {"kind": "win_condition", "game_id": "GAME_ID", "before": null, "after": "combat"},
    {
      "kind": "player", "game_id": "GAME_ID", "seat": 1,
      "before": {"member_id": null, "user_id": null, "guest_name": "Guest 1", "deck_version_id": null},
      "after": {"member_id": "MEMBER_ID", "user_id": "ACCOUNT_ID", "guest_name": null}
    }
  ]
}
```

Copy expected values from `show`. Every change must still match its `before` values at apply
time; the preview makes no lasting changes and reserves nothing. Only the game's recorder's
finished in-person games qualify. Online games, AI seats, duplicate player assignments,
missing/disabled accounts and members of a different group are refused. Win-condition
changes require a winner, so draws are never assigned combat. Existing reasons are preserved
by explicitly expecting `null` when filling missing ones. Allowed values are `combat`,
`commander_damage`, `combo`, `alternate`, `mill`, `poison`, `concession`, `other`, or `null`
(to clear an incorrect reason).

For account assignments, specify that account's member ID in the game's group, its user ID,
and a null guest name. A named group guest uses its member ID, null user ID and matching
guest name; an unlinked guest uses null member/user IDs and a guest name. The command does
not create memberships or globally rename "Guest 1": attribution is per game seat.

Reassigning a player preserves the recorded deck label, commander and result. It detaches a
private deck-version link if the newly seated account does not own that deck. A guest may
retain the recorder's borrowed deck link. The detached ID is logged for guarded undo.

## Undo

An undo is another batch request, with a new ID, actor and reason:

```json
{"id": "UNIQUE_UNDO_ID", "actor": "operator:codex", "reason": "Recorder corrected the attribution", "reverts": "UNIQUE_BATCH_ID"}
```

Preview and apply it using the same commands. Undo refuses any batch whose targets have a later logged correction. It also verifies the affected fields still equal
the original batch's `after` values, validates membership and deck access again, and restores
the old values atomically. If any value differs, or a needed member/deck no longer exists,
the whole undo is refused; inspect and prepare a new targeted correction. Other fields are
not overwritten. The log fences newer corrections even if values later return to the same answer. For writes
made outside this command, conflict detection compares current values; it cannot detect such
external changes if they were subsequently changed back. Undo never assigns a win reason to a draw. Each batch can be undone once; undo entries cannot themselves be
undone. A deliberate redo is a new correction with current expected values.

## Retention and scope

The command only inserts audit entries. It never edits a past entry or captures unrelated
rows, credentials, or a database snapshot. The audit is private operator data and is not
exposed in group statistics, exports, or public pages. Account/game deletion takes precedence
over history retention: a batch is removed if its owner, an account mentioned in its stored
request/changes, or any affected game is deleted. Undo is unavailable after that purge.

This first command covers future operator corrections. It does not backdate today’s earlier
manual edits, import the old rollback files, delete old backups, add an in-app edit screen,
or audit arbitrary SQL writes. Future correction entry points should use the same atomic
log semantics rather than bypassing the audit.

Tests: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/history -v`.
