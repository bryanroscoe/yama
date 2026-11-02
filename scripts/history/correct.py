#!/usr/bin/env python3
"""Atomic, audited corrections to recorded in-person games. See docs/history-corrections.md."""
import argparse
import datetime
import json
import sqlite3
from pathlib import Path

MAX_BYTES = 1024 * 1024
CONDITIONS = {'combat', 'commander_damage', 'combo', 'poison', 'mill', 'alternate', 'concession', 'other'}
IDENTITY = ('member_id', 'user_id', 'guest_name')


class Conflict(ValueError):
    pass


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def fields(obj, required):
    if not isinstance(obj, dict) or set(obj) != set(required):
        raise ValueError('expected exactly these fields: ' + ', '.join(required))


def text(value, label, limit=500):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{label} must be nonempty text, at most {limit} characters')


def identity(value):
    fields(value, IDENTITY)
    for key in IDENTITY:
        if value[key] is not None:
            text(value[key], key, 200)
    if not any(value.values()):
        raise ValueError('identity must name a player')


def validate(request):
    if not isinstance(request, dict):
        raise ValueError('batch must be an object')
    if 'reverts' in request:
        fields(request, ('id', 'actor', 'reason', 'reverts'))
        text(request['reverts'], 'reverts', 100)
    else:
        fields(request, ('id', 'actor', 'reason', 'changes'))
        changes = request['changes']
        if not isinstance(changes, list) or not 1 <= len(changes) <= 500:
            raise ValueError('changes must contain 1 to 500 entries')
        seen = set()
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError('change must be an object')
            kind = change.get('kind')
            if kind == 'win_condition':
                fields(change, ('kind', 'game_id', 'before', 'after'))
                for key in ('before', 'after'):
                    if change[key] is not None and (not isinstance(change[key], str) or change[key] not in CONDITIONS):
                        raise ValueError('unknown win condition')
                text(change['game_id'], 'game_id', 100)
                key = (change['game_id'], kind)
            elif kind == 'player':
                fields(change, ('kind', 'game_id', 'seat', 'before', 'after'))
                if type(change['seat']) is not int or change['seat'] < 0:
                    raise ValueError('seat must be a nonnegative integer')
                fields(change['before'], (*IDENTITY, 'deck_version_id'))
                identity({k: change['before'][k] for k in IDENTITY})
                if change['before']['deck_version_id'] is not None:
                    text(change['before']['deck_version_id'], 'deck_version_id', 100)
                text(change['game_id'], 'game_id', 100)
                identity(change['after'])
                key = (change['game_id'], kind, change['seat'])
            else:
                raise ValueError('kind must be win_condition or player')
            text(change['game_id'], 'game_id', 100)
            if key in seen:
                raise ValueError('a target may appear only once per batch')
            seen.add(key)
    for key, limit in [('id', 100), ('actor', 200), ('reason', 2000)]:
        text(request[key], key, limit)


def game(conn, game_id, owner):
    row = conn.execute('SELECT * FROM games WHERE id=? AND created_by=? AND mode=? AND status=?',
                       (game_id, owner, 'in_person', 'finished')).fetchone()
    if row is None:
        raise ValueError('target must be a finished in-person game recorded by this owner')
    return row


def check_identity(conn, value, g, seat, proposed):
    """Only an existing member of this group, or a named unlinked guest, may occupy a seat."""
    identity(value)
    mid, uid, guest = (value[k] for k in IDENTITY)
    if mid:
        member = conn.execute('SELECT * FROM playgroup_members WHERE id=? AND playgroup_id=?',
                              (mid, g['playgroup_id'])).fetchone()
        if member is None or member['user_id'] != uid:
            raise ValueError('member/account must match this game\'s playgroup')
        if uid is None and guest != member['guest_name']:
            raise ValueError('guest name must match the selected member')
        if uid is not None and guest is not None:
            raise ValueError('account seats must not also have a guest name')
    elif uid:
        if uid != g['created_by'] or guest is not None:
            raise ValueError('only the recorder may use an account seat without a playgroup member_id')
    elif guest is None:
        raise ValueError('an unlinked guest needs a name')
    if uid and conn.execute('SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL', (uid,)).fetchone() is None:
        raise ValueError('target account is missing or disabled')
    for other in conn.execute('SELECT seat,member_id,user_id FROM game_seats WHERE game_id=? AND seat<>?',
                              (g['id'], seat)):
        final = proposed.get((g['id'], other['seat']), other)
        if (mid and final['member_id'] == mid) or (uid and final['user_id'] == uid):
            raise Conflict('that player already occupies another seat in the final game state')


def current(conn, change):
    if change['kind'] == 'win_condition':
        row = conn.execute('SELECT win_condition FROM games WHERE id=?', (change['game_id'],)).fetchone()
        if row is None:
            raise Conflict('game no longer exists')
        return {'win_condition': row['win_condition']}
    row = conn.execute('SELECT * FROM game_seats WHERE game_id=? AND seat=?',
                       (change['game_id'], change['seat'])).fetchone()
    if row is None or row['ai_kind'] is not None:
        raise ValueError('target must be an existing human seat')
    return {key: row[key] for key in (*IDENTITY, 'deck_version_id')}


def revision(conn, change):
    row = conn.execute('SELECT revision FROM history_correction_targets WHERE game_id=? AND kind=? AND seat=?',
                       (change['game_id'], change['kind'], change.get('seat', -1))).fetchone()
    return row[0] if row else 0


def write(conn, change, value):
    if change['kind'] == 'win_condition':
        conn.execute('UPDATE games SET win_condition=? WHERE id=?', (value['win_condition'], change['game_id']))
    else:
        conn.execute('UPDATE game_seats SET member_id=?,user_id=?,guest_name=?,deck_version_id=? '
                     'WHERE game_id=? AND seat=?',
                     tuple(value[k] for k in (*IDENTITY, 'deck_version_id')) + (change['game_id'], change['seat']))

    conn.execute('INSERT INTO history_correction_targets(game_id,kind,seat,revision) VALUES (?,?,?,1) '
                 'ON CONFLICT(game_id,kind,seat) DO UPDATE SET revision=revision+1',
                 (change['game_id'], change['kind'], change.get('seat', -1)))
    change['revision'] = revision(conn, change)


def apply(conn, owner, request, dry_run=False):
    """The write lock covers validation, old values, updates and audit insertion, including undo."""
    validate(request)
    conn.execute('BEGIN IMMEDIATE')
    try:
        if conn.execute('SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL', (owner,)).fetchone() is None:
            raise ValueError('owner is missing or disabled')
        previous = conn.execute('SELECT * FROM history_corrections WHERE id=?', (request['id'],)).fetchone()
        if previous:
            if previous['owner_id'] != owner or previous['request'] != encode(request):
                raise Conflict('operation id already used for a different request')
            conn.rollback()
            return {'id': request['id'], 'already_applied': True, 'changes': json.loads(previous['changes'])}
        changes = []
        reverts = request.get('reverts')
        if reverts:
            original = conn.execute('SELECT * FROM history_corrections WHERE id=? AND owner_id=?',
                                    (reverts, owner)).fetchone()
            if original is None or original['reverts'] is not None:
                raise ValueError('undo must name an original correction owned by this recorder')
            if conn.execute('SELECT 1 FROM history_corrections WHERE reverts=?', (reverts,)).fetchone():
                raise Conflict('batch has already been undone')
            original_changes = json.loads(original['changes'])
            proposed = {(c['game_id'], c['seat']): c['before'] for c in original_changes if c['kind'] == 'player'}
            for old in reversed(original_changes):
                g = game(conn, old['game_id'], owner)
                now = current(conn, old)
                if revision(conn, old) != old['revision']:
                    raise Conflict('undo refused: a later correction touched this target')
                if now != old['after']:
                    raise Conflict('undo refused: target has changed since this correction')
                new = old['before']
                if old['kind'] == 'win_condition' and new['win_condition'] is not None and g['winner_seat'] is None:
                    raise Conflict('undo refused: a draw has no win condition')
                if old['kind'] == 'player':
                    check_identity(conn, {k: new[k] for k in IDENTITY}, g, old['seat'], proposed)
                    version = new['deck_version_id']
                    if version:
                        deck = conn.execute('SELECT d.owner_id FROM decks d JOIN deck_versions v '
                                            'ON v.deck_id=d.id WHERE v.id=?', (version,)).fetchone()
                        if deck is None or deck[0] != (new['user_id'] or owner):
                            raise Conflict('undo refused: original deck version is missing or belongs to a different account')
                change = {**old, 'before': now, 'after': new}
                write(conn, change, new)
                changes.append(change)
        else:
            proposed = {(c['game_id'], c['seat']): c['after'] for c in request['changes'] if c['kind'] == 'player'}
            for requested in request['changes']:
                g = game(conn, requested['game_id'], owner)
                now = current(conn, requested)
                if requested['kind'] == 'win_condition':
                    if g['winner_seat'] is None:
                        raise ValueError('a draw has no win condition')
                    expected = {'win_condition': requested['before']}
                    new = {'win_condition': requested['after']}
                else:
                    expected = requested['before']
                    check_identity(conn, requested['after'], g, requested['seat'], proposed)
                    new = {**requested['after'], 'deck_version_id': now['deck_version_id']}
                    # A guest may have borrowed the recorder's deck. Linking an account must
                    # not expose a different account's private deck version to it.
                    if new['deck_version_id']:
                        version_owner = conn.execute('SELECT d.owner_id FROM decks d JOIN deck_versions v '
                                                     'ON v.deck_id=d.id WHERE v.id=?', (new['deck_version_id'],)).fetchone()
                        if version_owner is None or version_owner[0] != (new['user_id'] or owner):
                            new['deck_version_id'] = None
                actual = now
                if actual != expected:
                    raise Conflict('expected old value does not match current record')
                if now == new:
                    raise ValueError('correction would change nothing')
                change = {k: requested[k] for k in ('kind', 'game_id', 'seat') if k in requested}
                change.update(before=now, after=new)
                write(conn, change, new)
                changes.append(change)
        # Legacy seats may identify an account only through member_id. Capture that
        # relationship now, before account deletion anonymizes the membership.
        subjects = {owner}
        for change in changes:
            if change['kind'] == 'player':
                for snapshot in (change['before'], change['after']):
                    if snapshot['user_id']:
                        subjects.add(snapshot['user_id'])
                    member = conn.execute('SELECT user_id FROM playgroup_members WHERE id=?',
                                          (snapshot['member_id'],)).fetchone()
                    if member and member['user_id']:
                        subjects.add(member['user_id'])
        created = datetime.datetime.now(datetime.timezone.utc).isoformat()
        conn.execute('INSERT INTO history_corrections '
                     '(id,owner_id,actor,reason,request,changes,subjects,reverts,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                     (request['id'], owner, request['actor'], request['reason'], encode(request), encode(changes), encode(sorted(subjects)), reverts, created))
        result = {'id': request['id'], 'dry_run': dry_run, 'changes': changes}
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
        return result
    except BaseException:
        conn.rollback()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--owner', required=True, help='email of the game recorder (operator access required)')
    sub = parser.add_subparsers(dest='command', required=True)
    change = sub.add_parser('apply', help='apply or undo a JSON batch')
    change.add_argument('file', type=Path)
    change.add_argument('--dry-run', action='store_true')
    history = sub.add_parser('log', help='most recent batches for this owner')
    history.add_argument('--limit', type=int, default=20)
    show = sub.add_parser('show', help='inspect a recorded game and its expected current values')
    show.add_argument('game_id')
    args = parser.parse_args()
    try:
        # mode=rw prevents a typo from silently creating an empty database.
        with sqlite3.connect(args.database.resolve().as_uri() + '?mode=rw', uri=True, timeout=15) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA foreign_keys=ON')
            owner = conn.execute('SELECT id FROM users WHERE email=?', (args.owner,)).fetchone()
            if owner is None:
                raise ValueError('owner account not found')
            if args.command == 'show':
                result = dict(game(conn, args.game_id, owner['id']))
                result['seats'] = [dict(r) for r in conn.execute(
                    'SELECT s.*,u.display_name FROM game_seats s LEFT JOIN users u ON u.id=s.user_id '
                    'WHERE s.game_id=? ORDER BY seat', (args.game_id,))]
            elif args.command == 'log':
                if not 1 <= args.limit <= 500:
                    raise ValueError('limit must be between 1 and 500')
                result = [dict(r) for r in conn.execute('SELECT id,actor,reason,created_at,reverts,changes '
                          'FROM history_corrections WHERE owner_id=? ORDER BY created_at DESC LIMIT ?',
                          (owner['id'], args.limit))]
                for row in result:
                    row['changes'] = json.loads(row['changes'])
            else:
                with args.file.open('rb') as f:
                    data = f.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ValueError('batch exceeds 1 MiB')
                request = json.loads(data)
                if not isinstance(request, dict):
                    raise ValueError('batch must be an object')
                result = apply(conn, owner['id'], request, args.dry_run)
            print(json.dumps(result, indent=2, ensure_ascii=False))
    except (ValueError, sqlite3.Error, OSError) as exc:
        parser.exit(1, f'history correction failed: {exc}\n')


if __name__ == '__main__':
    main()
