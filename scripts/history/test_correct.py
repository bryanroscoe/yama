"""Real-schema SQLite integration tests; never opens production data."""
import copy
import json
import sqlite3
import subprocess
import sys
import re
import tempfile
import unittest
from pathlib import Path
import correct

ROOT = Path(__file__).resolve().parents[2]


class Corrections(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'test.db'
        self.c = sqlite3.connect(self.path)
        self.c.row_factory = sqlite3.Row
        self.c.execute('PRAGMA foreign_keys=ON')
        for migration in sorted((ROOT / 'server/migrations').glob('*.sql')):
            self.c.executescript(migration.read_text())
        for uid in ('bryan', 'chelsey', 'other'):
            self.c.execute('INSERT INTO users(id,email,display_name,created_at) VALUES (?,?,?,?)',
                           (uid, uid+'@example.com', uid, 'now'))
        self.c.execute("INSERT INTO playgroups(id,name,owner_id,join_code,created_at) VALUES ('group','friends','bryan','TEST','now')")
        for uid in ('bryan', 'chelsey', 'other'):
            self.c.execute('INSERT INTO playgroup_members(id,playgroup_id,user_id,created_at) VALUES (?,?,?,?)',
                           (uid+'-member', 'group', uid, 'now'))
        for gid in ('g1', 'g2'):
            self.c.execute("INSERT INTO games(id,mode,playgroup_id,created_by,status,started_at,winner_seat,note) "
                           "VALUES (?,'in_person','group','bryan','finished','now',0,'keep this')", (gid,))
            self.c.execute("INSERT INTO game_seats(game_id,seat,member_id,user_id) VALUES (?,0,'bryan-member','bryan')", (gid,))
            self.c.execute("INSERT INTO game_seats(game_id,seat,guest_name,deck_label,commander_name) "
                           "VALUES (?,1,'Guest 1','Riders of Rohan','Éowyn')", (gid,))
        self.c.commit()
        self.req = {'id': 'batch1', 'actor': 'operator:codex', 'reason': 'Bryan confirmed historical games', 'changes': [
            {'kind': 'win_condition', 'game_id': 'g1', 'before': None, 'after': 'combat'},
            {'kind': 'player', 'game_id': 'g1', 'seat': 1,
             'before': {'member_id': None, 'user_id': None, 'guest_name': 'Guest 1', 'deck_version_id': None},
             'after': {'member_id': 'chelsey-member', 'user_id': 'chelsey', 'guest_name': None}}]}

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def apply(self, req=None, **kwargs):
        return correct.apply(self.c, 'bryan', self.req if req is None else req, **kwargs)

    def undo(self, op='undo1'):
        return {'id': op, 'actor': 'operator:codex', 'reason': 'Bryan corrected attribution', 'reverts': 'batch1'}

    def scalar(self, sql):
        return self.c.execute(sql).fetchone()[0]

    def logs(self):
        return self.scalar('SELECT count(*) FROM history_corrections')

    def test_batch_preserves_other_fields_and_logs_actual_values(self):
        before = dict(self.c.execute("SELECT * FROM games WHERE id='g1'").fetchone())
        result = self.apply()
        before['win_condition'] = 'combat'
        self.assertEqual(before, dict(self.c.execute("SELECT * FROM games WHERE id='g1'").fetchone()))
        seat = self.c.execute("SELECT * FROM game_seats WHERE game_id='g1' AND seat=1").fetchone()
        self.assertEqual((seat['user_id'], seat['deck_label'], seat['commander_name']), ('chelsey', 'Riders of Rohan', 'Éowyn'))
        self.assertEqual(json.loads(self.scalar('SELECT changes FROM history_corrections')), result['changes'])
        self.assertFalse(self.c.execute('PRAGMA foreign_key_check').fetchall())

    def test_dry_run_rolls_back_everything(self):
        self.assertTrue(self.apply(dry_run=True)['dry_run'])
        self.assertEqual(self.logs(), 0)
        self.assertIsNone(self.scalar("SELECT win_condition FROM games WHERE id='g1'"))
        self.assertIsNone(self.scalar("SELECT user_id FROM game_seats WHERE game_id='g1' AND seat=1"))
        self.apply()

    def test_late_conflict_rolls_back_earlier_change_and_log(self):
        req = copy.deepcopy(self.req)
        req['changes'][1]['before']['guest_name'] = 'Someone else'
        with self.assertRaises(correct.Conflict):
            self.apply(req)
        self.assertEqual(self.logs(), 0)
        self.assertIsNone(self.scalar("SELECT win_condition FROM games WHERE id='g1'"))

    def test_audit_insert_failure_rolls_back_data(self):
        self.c.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON history_corrections BEGIN SELECT RAISE(ABORT,'failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.apply()
        self.assertIsNone(self.scalar("SELECT win_condition FROM games WHERE id='g1'"))
        self.assertEqual(self.logs(), 0)

    def test_retries_and_id_collision(self):
        self.apply()
        self.assertTrue(self.apply()['already_applied'])
        req = copy.deepcopy(self.req)
        req['reason'] = 'different request'
        with self.assertRaises(correct.Conflict):
            self.apply(req)
        with self.assertRaises(correct.Conflict):
            correct.apply(self.c, 'other', self.req)
        self.assertEqual(self.logs(), 1)

    def test_undo_is_logged_retryable_and_only_once(self):
        self.apply()
        self.apply(self.undo())
        self.assertEqual(self.logs(), 2)
        self.assertTrue(self.apply(self.undo())['already_applied'])
        self.assertIsNone(self.scalar("SELECT win_condition FROM games WHERE id='g1'"))
        self.assertEqual(self.scalar("SELECT guest_name FROM game_seats WHERE game_id='g1' AND seat=1"), 'Guest 1')
        with self.assertRaises(correct.Conflict):
            self.apply(self.undo('undo2'))

    def test_stale_undo_rolls_back_earlier_reversal(self):
        self.apply()
        self.c.execute("UPDATE games SET win_condition='combo' WHERE id='g1'")
        self.c.commit()
        with self.assertRaises(correct.Conflict):
            self.apply(self.undo())
        self.assertEqual(self.scalar("SELECT user_id FROM game_seats WHERE game_id='g1' AND seat=1"), 'chelsey')
        self.assertEqual(self.logs(), 1)

    def test_wrong_owner_online_unfinished_and_draw_rejected(self):
        for assignment in ["created_by='other'", "mode='online'", "status='in_progress'", 'winner_seat=NULL']:
            with self.subTest(assignment=assignment):
                self.c.execute('UPDATE games SET '+assignment+" WHERE id='g1'")
                self.c.commit()
                with self.assertRaises(ValueError):
                    self.apply()
                self.c.execute("UPDATE games SET created_by='bryan',mode='in_person',status='finished',winner_seat=0 WHERE id='g1'")
                self.c.commit()
                self.assertEqual(self.logs(), 0)

    def test_invalid_member_disabled_account_duplicate_player(self):
        for target in [dict(member_id='missing', user_id='chelsey', guest_name=None),
                       dict(member_id='chelsey-member', user_id='other', guest_name=None),
                       dict(member_id='bryan-member', user_id='bryan', guest_name=None)]:
            req = copy.deepcopy(self.req)
            req['changes'][1]['after'] = target
            with self.assertRaises(ValueError):
                self.apply(req)
        self.c.execute("UPDATE users SET disabled_at='now' WHERE id='chelsey'")
        self.c.commit()
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual(self.logs(), 0)

    def test_borrowed_version_detached_and_restored_and_newer_selection_fences_apply(self):
        self.c.execute("INSERT INTO decks(id,owner_id,name,created_at,updated_at) VALUES ('d','bryan','Riders','now','now')")
        self.c.execute("INSERT INTO deck_versions(id,deck_id,cards,created_at) VALUES ('v','d','[]','now')")
        self.c.execute("UPDATE game_seats SET deck_version_id='v' WHERE game_id='g1' AND seat=1")
        self.c.commit()
        with self.assertRaises(correct.Conflict):
            self.apply()
        self.req['changes'][1]['before']['deck_version_id'] = 'v'
        self.apply()
        self.assertIsNone(self.scalar("SELECT deck_version_id FROM game_seats WHERE game_id='g1' AND seat=1"))
        self.apply(self.undo())
        self.assertEqual(self.scalar("SELECT deck_version_id FROM game_seats WHERE game_id='g1' AND seat=1"), 'v')

    def test_deleted_player_and_game_purge_private_audit_batches(self):
        self.apply()
        self.c.execute("UPDATE game_seats SET user_id=NULL,member_id=NULL WHERE user_id='chelsey'")
        self.c.execute("DELETE FROM playgroup_members WHERE user_id='chelsey'")
        self.c.execute("DELETE FROM users WHERE id='chelsey'")
        self.c.commit()
        self.assertEqual(self.logs(), 0)
        req = copy.deepcopy(self.req)
        req['id'] = 'batch2'
        req['changes'] = [{'kind': 'win_condition', 'game_id': 'g2', 'before': None, 'after': 'combat'}]
        self.apply(req)
        self.c.execute("DELETE FROM games WHERE id='g2'")
        self.c.commit()
        self.assertEqual(self.logs(), 0)

    def test_undo_refuses_later_corrections_even_when_values_return(self):
        self.apply()
        for op, before, after in [('b', 'combat', 'combo'), ('c', 'combo', 'combat')]:
            req = {**self.req, 'id': op, 'changes': [
                {'kind': 'win_condition', 'game_id': 'g1', 'before': before, 'after': after}]}
            self.apply(req)
        with self.assertRaisesRegex(correct.Conflict, 'later correction'):
            self.apply(self.undo())
        self.assertEqual(self.scalar("SELECT win_condition FROM games WHERE id='g1'"), 'combat')
        self.assertEqual(self.logs(), 3)

    def test_undo_never_adds_win_reason_to_draw(self):
        self.c.execute("UPDATE games SET win_condition='combat' WHERE id='g1'")
        self.c.commit()
        req = {**self.req, 'changes': [
            {'kind': 'win_condition', 'game_id': 'g1', 'before': 'combat', 'after': None}]}
        self.apply(req)
        self.c.execute("UPDATE games SET winner_seat=NULL WHERE id='g1'")
        self.c.commit()
        with self.assertRaisesRegex(correct.Conflict, 'draw'):
            self.apply(self.undo())
        self.assertIsNone(self.scalar("SELECT win_condition FROM games WHERE id='g1'"))

    def test_writer_lock_serializes_validation_and_audit(self):
        other = sqlite3.connect(self.path, timeout=0.05)
        other.row_factory = sqlite3.Row
        try:
            self.c.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError):
                correct.apply(other, 'bryan', self.req)
            self.c.rollback()
            correct.apply(other, 'bryan', self.req)
            self.assertEqual(self.logs(), 1)
        finally:
            other.close()

    def test_cli_show_preview_apply_log_and_missing_database(self):
        base = [sys.executable, '-B', str(Path(correct.__file__)), '--database', str(self.path), '--owner', 'bryan@example.com']
        batch = Path(self.tmp.name) / 'batch.json'
        batch.write_text(json.dumps(self.req))
        def run(*args):
            return subprocess.run([*base, *args], text=True, capture_output=True)
        self.assertEqual(json.loads(run('show', 'g1').stdout)['seats'][1]['guest_name'], 'Guest 1')
        self.assertTrue(json.loads(run('apply', str(batch), '--dry-run').stdout)['dry_run'])
        self.assertEqual(self.logs(), 0)
        self.assertEqual(run('apply', str(batch)).returncode, 0)
        self.assertEqual(json.loads(run('log').stdout)[0]['id'], 'batch1')
        self.assertNotEqual(run('log', '--limit', '0').returncode, 0)
        missing = Path(self.tmp.name) / 'missing.db'
        result = subprocess.run([*base, '--database', str(missing), 'log'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(missing.exists())

    def test_conditions_match_server(self):
        source = (ROOT / 'server/src/stats.rs').read_text()
        declaration = re.search(r'pub const WIN_CONDITIONS:.*?= \[(.*?)\];', source).group(1)
        self.assertEqual(correct.CONDITIONS, set(re.findall(r'"(.*?)"', declaration)))

    def test_deleted_legacy_member_account_purges_log_after_anonymization(self):
        self.c.execute("UPDATE game_seats SET member_id='chelsey-member',guest_name='Chelsey' WHERE game_id='g1' AND seat=1")
        self.c.commit()
        self.req['changes'][1]['before'].update(member_id='chelsey-member', guest_name='Chelsey')
        self.req['changes'][1]['after'].update(member_id='other-member', user_id='other')
        self.apply()
        self.c.execute("UPDATE playgroup_members SET user_id=NULL,guest_name='Former member' WHERE user_id='chelsey'")
        self.c.execute("DELETE FROM users WHERE id='chelsey'")
        self.c.commit()
        self.assertEqual(self.logs(), 0)

    def test_multi_game_purge_does_not_reopen_stale_undo(self):
        self.apply()
        for op, before, after, g2before, g2after in [
                ('b', 'combat', 'combo', None, 'combat'), ('c', 'combo', 'combat', 'combat', 'combo')]:
            self.apply({**self.req, 'id': op, 'changes': [
                {'kind': 'win_condition', 'game_id': 'g1', 'before': before, 'after': after},
                {'kind': 'win_condition', 'game_id': 'g2', 'before': g2before, 'after': g2after}]})
        self.c.execute("DELETE FROM games WHERE id='g2'")
        self.c.commit()
        self.assertEqual(self.logs(), 1)
        with self.assertRaisesRegex(correct.Conflict, 'later correction'):
            self.apply(self.undo())
        self.assertEqual(self.scalar("SELECT win_condition FROM games WHERE id='g1'"), 'combat')

    def test_atomic_swap_players_and_undo_validate_final_state(self):
        self.apply()
        changes = []
        for seat, target in [(0, 'chelsey'), (1, 'bryan')]:
            c = {'kind': 'player', 'game_id': 'g1', 'seat': seat}
            c['before'] = correct.current(self.c, c)
            c['after'] = dict(member_id=target+'-member', user_id=target, guest_name=None)
            changes.append(c)
        self.apply({**self.req, 'id': 'swap', 'changes': changes})
        self.assertEqual(self.scalar("SELECT user_id FROM game_seats WHERE game_id='g1' AND seat=0"), 'chelsey')
        self.apply({**self.undo(), 'reverts': 'swap'})
        self.assertEqual(self.scalar("SELECT user_id FROM game_seats WHERE game_id='g1' AND seat=0"), 'bryan')
        self.assertEqual(self.scalar("SELECT user_id FROM game_seats WHERE game_id='g1' AND seat=1"), 'chelsey')

    def test_validation_duplicate_targets_and_bad_types(self):
        bad = [[], {'id': 'x'}, {**self.req, 'extra': 1}, {**self.req, 'changes': []},
               {**self.req, 'changes': [self.req['changes'][0]] * 2}]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                correct.validate(value)
        for key, value in [('game_id', []), ('after', []), ('after', 'bogus')]:
            req = copy.deepcopy(self.req)
            req['changes'][0][key] = value
            with self.assertRaises(ValueError):
                correct.validate(req)


if __name__ == '__main__':
    unittest.main()
