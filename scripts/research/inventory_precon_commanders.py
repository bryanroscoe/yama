#!/usr/bin/env python3
"""Inventory stock-compatible in-box commander configurations. Does not assign grades.

Uses local public Scryfall facts; emits identities and links, never Oracle text/images.
Every commander and allowed pair is considered against the full stock card pool.
Banned stock cards remain blockers, not silently substituted upgrades.
"""
import argparse
import copy
from collections import Counter
from datetime import date
from itertools import combinations
import json
from pathlib import Path
import re
from validate_commander_paths import canonical, eligible, partners, fingerprint, validate

ROOT = Path(__file__).resolve().parents[2]


def reboard(base, commanders):
    chosen = set(map(canonical, commanders))
    rows = []
    for _, name, qty in base['stock']:
        rows.append(['commander' if canonical(name) in chosen else 'main', name, qty])
    return {'commanders': [n for b, n, q in rows if b == 'commander'], 'stock': rows}


def key(names):
    return '-and-'.join(re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-') for n in names)


def inventory(base, facts, checked):
    stock = [(n, facts[canonical(n)]) for _, n, _ in base['stock']]
    identity = set().union(*(set(c['color_identity']) for _, c in stock))
    candidates = [(n, c) for n, c in stock if eligible(c) or ('Legendary' in c['type_line'] and 'Background' in c['type_line'])]
    def color_choices(cards):
        missing = sorted(identity - set().union(*(set(c['color_identity']) for c in cards)))
        flexible = [c for c in cards if 'choose a color before the game begins' in c.get('oracle_text', '').lower()]
        if len(missing) > len(flexible):
            return None
        selected = missing + [sorted(identity or {'W'})[0]] * (len(flexible) - len(missing))
        return {c['name']: [color] for c, color in zip(flexible, selected)}
    configurations = [(n,) for n, c in candidates if eligible(c) and color_choices([c]) is not None]
    configurations += [(a[0], b[0]) for a, b in combinations(candidates, 2)
                       if partners(a[1], b[1]) and color_choices([a[1], b[1]]) is not None]
    options = []
    for names in configurations:
        entry = reboard(base, names)
        problem = None
        choices = color_choices([facts[canonical(n)] for n in names])
        checked_facts = facts
        if choices:
            checked_facts = dict(facts)
            for n, colors in choices.items():
                card = copy.deepcopy(facts[canonical(n)])
                card['color_identity'] = sorted(set(card['color_identity']) | set(colors))
                checked_facts[canonical(n)] = card
        try:
            digest = validate(entry, checked_facts)
            if choices:
                digest = None
                problem = 'Legal with pregame colour choice ' + ', '.join(f'{n}: {"".join(c)}' for n,c in choices.items()) + '; the simulation list format cannot preserve this choice yet.'
        except ValueError as error:
            digest, problem = None, str(error)
        options.append({'key': key(entry['commanders']), 'commanders': entry['commanders'],
                        'fingerprint': digest, 'list_problem': problem, 'pregame_colors': choices,
                        'commander_cards': [{'name': n, 'url': facts[canonical(n)]['scryfall_uri'],
                                             'oracle_id': facts[canonical(n)]['oracle_id'], 'checked_on': checked}
                                            for n in entry['commanders']]})
    return {'reference_fingerprint': fingerprint(base['stock']), 'checked_on': checked,
            'complete': True, 'options': options,
            'other_legends': [n for n, c in candidates if not any(n in o['commanders'] for o in options)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--facts', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'server/resources/precon-commander-roster.json')
    args = parser.parse_args()
    facts = json.loads(args.facts.read_text())
    source = json.loads((ROOT/'server/resources/precon-upgradeability.json').read_text())
    checked = date.today().isoformat()
    decks = {slug: inventory(base, facts, checked) for slug, base in source['decks'].items()}
    for o in decks['the-fantastic-four']['options']:
        o['featured'] = o['commanders'][0] in ('Invisible Woman', 'Mister Fantastic', 'Human Torch', 'The Thing')
    result = {'method': 'in-box-commanders-v1', 'checked_on': checked,
              'basis': 'Eligible commanders and explicit legal pairs whose combined colour identity covers the unchanged stock pool. Legal lists are checked; banned stock cards block downloads. This inventory does not establish theme fit, power or an upgrade grade.',
              'decks': decks}
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
    print(f"Inventoried {len(decks)} packages, {sum(len(d['options']) for d in decks.values())} configurations; {sum(bool(o['list_problem']) for d in decks.values() for o in d['options'])} blocked by stock legality or unsupported pregame colour choices.")


if __name__ == '__main__':
    main()
