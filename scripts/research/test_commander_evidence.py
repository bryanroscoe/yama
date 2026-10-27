import unittest
from fetch_commander_evidence import observation


class ObservationTests(unittest.TestCase):
    def test_raw_rate_and_zero_are_distinct(self):
        row = {'name': 'Example', 'id': 123, 'stats': {'games_count': 3, 'games_won': 1}, 'top_decks': [{'user': 'must not ship'}]}
        out = observation('Example', row, '2026-10-27T00:00:00Z', 'hash')
        self.assertEqual(out['raw_win_rate_percent'], 33.33)
        self.assertNotIn('top_decks', out)
        self.assertIsNone(out['provider_updated_at'])
        row['stats'] = {'games_count': 0, 'games_won': 0}
        self.assertIsNone(observation('Example', row, 'date', 'hash')['raw_win_rate_percent'])

    def test_invalid_counts_and_wrong_identity_are_rejected(self):
        for games, wins in [(2, 3), (-1, 0), (True, 0), (1, None)]:
            with self.assertRaises(ValueError):
                observation('One', {'name': 'One', 'id': 1, 'stats': {'games_count': games, 'games_won': wins}}, 'date', 'hash')
        with self.assertRaises(ValueError):
            observation('Partner pair', {'name': 'One', 'id': 1, 'stats': {'games_count': 4, 'games_won': 1}}, 'date', 'hash')


if __name__ == '__main__':
    unittest.main()
