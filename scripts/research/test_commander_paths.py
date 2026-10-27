import copy
import unittest
from validate_commander_paths import eligible, fingerprint, validate


class CommanderListTests(unittest.TestCase):
    def setUp(self):
        self.facts={
            'a':{'type_line':'Legendary Creature — Wizard','color_identity':['U'],'legalities':{'commander':'legal'}},
            'b':{'type_line':'Legendary Creature — Wizard','color_identity':['U'],'legalities':{'commander':'legal'}},
            'island':{'type_line':'Basic Land — Island','color_identity':['U'],'legalities':{'commander':'legal'}},
        }
        self.base={'commanders':['A'],'stock':[['commander','A',1],['main','B',1],['main','Island',98]]}

    def test_command_zone_changes_have_distinct_identities_with_the_same_cards(self):
        other={'commanders':['B'],'stock':[['commander','B',1],['main','A',1],['main','Island',98]]}
        self.assertNotEqual(validate(self.base,self.facts),validate(other,self.facts))
        self.assertEqual(fingerprint(self.base['stock']),fingerprint(list(reversed(self.base['stock']))))

    def test_colour_and_ban_failures_are_not_validated(self):
        for change in [{'color_identity':['R']},{'legalities':{'commander':'banned'}}]:
            facts=copy.deepcopy(self.facts);facts['b'].update(change)
            with self.assertRaises(AssertionError):validate(self.base,facts)

    def test_duplicate_nonbasics_and_unchecked_pairings_are_rejected(self):
        duplicated={'commanders':['A'],'stock':[['commander','A',1],['main','B',2],['main','Island',97]]}
        with self.assertRaises(AssertionError):validate(duplicated,self.facts)
        pair={'commanders':['A','B'],'stock':[['commander','A',1],['commander','B',1],['main','Island',98]]}
        with self.assertRaises(ValueError):validate(pair,self.facts)

    def test_spacecraft_needs_a_printed_power_and_toughness(self):
        ship={'type_line':'Legendary Artifact — Spacecraft','oracle_text':''}
        self.assertFalse(eligible(ship))
        self.assertTrue(eligible({**ship,'power':'8','toughness':'8'}))


if __name__=='__main__':unittest.main()
