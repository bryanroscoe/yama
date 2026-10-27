import copy
import unittest
from validate_commander_paths import eligible, fingerprint, validate, validate_document


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
            with self.assertRaises(ValueError):validate(self.base,facts)

    def test_duplicate_nonbasics_and_unchecked_pairings_are_rejected(self):
        duplicated={'commanders':['A'],'stock':[['commander','A',1],['main','B',2],['main','Island',97]]}
        with self.assertRaises(ValueError):validate(duplicated,self.facts)
        pair={'commanders':['A','B'],'stock':[['commander','A',1],['commander','B',1],['main','Island',98]]}
        with self.assertRaises(ValueError):validate(pair,self.facts)

    def test_every_command_zone_row_requires_exactly_one_copy(self):
        for qty in (2, 0, -1, True):
            bad = {'commanders': ['A'], 'stock': [['commander', 'A', 1],
                   ['commander', 'Island', qty], ['main', 'Island', 99 - qty]]}
            with self.subTest(qty=qty), self.assertRaises(ValueError):
                validate(bad, self.facts)

    def test_failed_document_validation_never_stamps_a_partial_success(self):
        alt = {**copy.deepcopy(self.base), 'scope': 'in_box',
               'continuity': {'theme': 'Creatures', 'retains': 'Same cards', 'changes': 'Different payoff'}}
        for corruption in ('count', 'continuity', 'pool'):
            candidate = copy.deepcopy(alt)
            if corruption == 'count':
                candidate['stock'][-1][2] -= 1
            elif corruption == 'continuity':
                candidate['continuity']['theme'] = ''
            else:
                candidate['stock'][1][1] = 'Island'
            doc = {'decks': {'test': {**copy.deepcopy(self.base), 'alternatives': [candidate]}}}
            original = copy.deepcopy(doc)
            with self.subTest(corruption=corruption), self.assertRaises(ValueError):
                validate_document(doc, self.facts, '2026-10-27')
            self.assertEqual(doc, original)

    def test_spacecraft_needs_a_printed_power_and_toughness(self):
        ship={'type_line':'Legendary Artifact — Spacecraft','oracle_text':''}
        self.assertFalse(eligible(ship))
        self.assertTrue(eligible({**ship,'power':'8','toughness':'8'}))


if __name__=='__main__':unittest.main()
