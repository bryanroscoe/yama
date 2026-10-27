"""A faster different game or failed game must not count as a preserving speedup."""
import unittest

from bench_forge import equivalent


class ComparisonTests(unittest.TestCase):
    def test_timing_and_build_can_change(self):
        self.assertTrue(equivalent({"end": "win", "ms": 10, "runner": "a"},
                                   {"end": "win", "ms": 5, "runner": "b"}))

    def test_outcomes_and_work_must_match(self):
        result = {"end": "win", "turns": 40, "winner": 2, "final_life": [0, 0, 4, 0]}
        for field, value in (("turns", 39), ("winner", 1), ("final_life", [0, 0, 3, 0])):
            with self.subTest(field=field):
                self.assertFalse(equivalent(result, {**result, field: value}))

    def test_matching_failures_do_not_qualify(self):
        for end in ("error", "time_cap", "turn_cap", None):
            self.assertFalse(equivalent({"end": end}, {"end": end}))


if __name__ == "__main__":
    unittest.main()
