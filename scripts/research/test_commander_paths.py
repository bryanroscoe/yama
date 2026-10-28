import copy
import unittest
from validate_commander_paths import eligible, fingerprint, validate, validate_document, partners


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

    def test_pairing_rules_are_specific_and_do_not_mix_mechanisms(self):
        def creature(name, text, kind='Legendary Creature — Human'):
            return {'name': name, 'oracle_text': text, 'type_line': kind}
        a, b = creature('A', 'Partner'), creature('B', 'Partner')
        self.assertTrue(partners(a, b))
        self.assertFalse(partners(a, creature('B', 'Friends forever')))
        self.assertTrue(partners(creature('A', 'Partner with B (Search)'), creature('B', 'Partner with A (Search)')))
        self.assertFalse(partners(creature('A', 'Partner with C (Search)'), creature('B', 'Partner with A (Search)')))
        background = creature('Background', '', 'Legendary Enchantment — Background')
        self.assertTrue(partners(creature('A', 'Choose a Background'), background))
        self.assertFalse(partners(a, background))
        doctor = creature('Doctor', '', 'Legendary Creature — Time Lord Doctor')
        self.assertTrue(partners(doctor, creature('B', "Doctor's companion")))
        self.assertFalse(partners(a, creature('B', "Doctor's companion")))

    def test_partner_configuration_uses_union_identity_and_preserves_the_stock_pool(self):
        facts = copy.deepcopy(self.facts)
        facts['a'].update(name='A', oracle_text='Partner')
        facts['b'].update(name='B', oracle_text='Partner', color_identity=['G'])
        pair = {'commanders': ['A', 'B'], 'stock': [['commander', 'A', 1], ['commander', 'B', 1], ['main', 'Island', 98]]}
        self.assertTrue(validate(pair, facts))
        facts['b']['oracle_text'] = 'Friends forever'
        with self.assertRaises(ValueError):
            validate(pair, facts)

    def test_color_choice_commanders_are_inventoried_but_not_exported_as_plain_lists(self):
        from inventory_precon_commanders import inventory
        def card(name, kind, text, colors):
            return {'name':name, 'type_line':kind, 'oracle_text':text, 'color_identity':colors,
                    'legalities':{'commander':'legal'}, 'oracle_id':name, 'scryfall_uri':'https://scryfall.com/card/test/'+name}
        facts = {
            'doctor': card('Doctor', 'Legendary Creature — Time Lord Doctor', '', ['G','U']),
            'clara': card('Clara', 'Legendary Creature — Human', "If Clara is your commander, choose a color before the game begins.\nDoctor's companion", []),
            'plains': card('Plains', 'Basic Land — Plains', '', ['W']),
        }
        base = {'commanders':['Doctor'], 'stock':[['commander','Doctor',1],['main','Clara',1],['main','Plains',98]]}
        options = inventory(base, facts, '2026-10-28')['options']
        self.assertEqual(len(options), 1)
        self.assertEqual(options[0]['pregame_colors'], {'Clara':['W']})
        self.assertIsNone(options[0]['fingerprint'])
        self.assertIn('simulation list format', options[0]['list_problem'])

    def test_grist_and_authoritative_eligibility_do_not_reduce_to_type_line(self):
        grist = {'name':'Grist, the Hunger Tide', 'type_line':'Legendary Planeswalker — Grist',
                 'oracle_text':"As long as Grist isn't on the battlefield, it's a 1/1 Insect creature in addition to its other types."}
        self.assertTrue(eligible(grist))
        self.assertTrue(eligible({**grist, 'commander_eligible':True}))
        self.assertTrue(eligible({'name':'Hama Pashar, Ruin Seeker', 'type_line':'Legendary Creature — Human Wizard', 'oracle_text':'', 'commander_eligible':False}))
        self.assertFalse(eligible({'type_line':'Legendary Enchantment — Background', 'oracle_text':'', 'commander_eligible':True}))

    def test_atomic_facts_checkpoint_preserves_previous_file_on_write_failure(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from fetch_package_facts import atomic
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'facts.json'
            target.write_text('{"previous":true}')
            with patch.object(Path, 'write_text', side_effect=OSError('No space left')):
                with self.assertRaises(OSError):
                    atomic(target, {'new':True})
            self.assertEqual(target.read_text(), '{"previous":true}')

    def test_spacecraft_needs_a_printed_power_and_toughness(self):
        ship={'type_line':'Legendary Artifact — Spacecraft','oracle_text':''}
        self.assertFalse(eligible(ship))
        self.assertTrue(eligible({**ship,'power':'8','toughness':'8'}))


if __name__=='__main__':unittest.main()
