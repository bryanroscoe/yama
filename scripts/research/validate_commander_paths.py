#!/usr/bin/env python3
"""Validate public stock-family commander lists against a supplied Scryfall snapshot.

The snapshot maps case-folded front-face names to full Scryfall card objects.
No owned decks, inventory, prices or account data is read. Writes fingerprints
only after all options pass; a separate build is not a precon upgrade option.
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def canonical(name):
    return name.split(' // ')[0].casefold()


def fingerprint(rows):
    counts = Counter()
    for board, name, qty in rows:
        counts[board, name.split(' // ')[0].lower()] += qty
    encoded = json.dumps([[list(k), q] for k, q in sorted(counts.items())], ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest()


def eligible(card):
    front = card.get('card_faces', [card])[0]
    kind, text = front['type_line'], front.get('oracle_text', '')
    return 'can be your commander' in text.lower() or ('Legendary' in kind and (
        'Creature' in kind or (('Vehicle' in kind or 'Spacecraft' in kind)
                              and front.get('power') is not None and front.get('toughness') is not None)))


def validate(entry, facts):
    rows = entry['stock']
    assert sum(q for _, _, q in rows) == 100, 'expected 100 cards'
    commanders = [n for b, n, q in rows if b == 'commander' and q == 1]
    assert commanders == entry['commanders'], 'command zone does not match declared configuration'
    # New pair mechanisms must be checked explicitly rather than accepted by colour alone.
    if len(commanders) != 1:
        raise ValueError('joint commander eligibility needs a separate pairing check')
    leader = facts[canonical(commanders[0])]
    assert eligible(leader), 'not eligible to be a commander'
    identity = set(leader['color_identity'])
    combined = Counter()
    for board, name, qty in rows:
        assert board in ('commander', 'main') and type(qty) is int and qty > 0, 'invalid board or quantity'
        c = facts[canonical(name)]
        assert c['legalities']['commander'] == 'legal', f'{name} is not Commander legal'
        assert set(c['color_identity']) <= identity, f'{name} is outside colour identity'
        combined[canonical(name)] += qty
        if combined[canonical(name)] > 1:
            text=c.get('oracle_text','').lower()
            finite=re.search(r'deck can have up to (\w+) cards named',text)
            words=dict(zip('one two three four five six seven eight nine ten'.split(),range(1,11)))
            limit=(int(finite[1]) if finite[1].isdigit() else words.get(finite[1],1)) if finite else 1
            assert 'Basic' in c['type_line'] or 'deck can have any number of cards named' in text or combined[canonical(name)]<=limit, f'{name} is duplicated' 
    return fingerprint(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--facts', required=True, type=Path)
    parser.add_argument('--document', type=Path, default=ROOT/'server/resources/precon-upgradeability.json')
    args = parser.parse_args()
    doc, facts = json.loads(args.document.read_text()), json.loads(args.facts.read_text())
    checked = dt.date.today().isoformat()
    count = 0
    for id_, base in doc['decks'].items():
        if not base.get('alternatives'):
            continue
        base['catalog_validated_fingerprint'] = validate(base, facts)
        base['catalog_list_checked_on'] = checked
        for alt in base['alternatives']:
            if alt['scope'] == 'separate_build':
                continue
            assert all(alt['continuity'].get(k, '').strip() for k in ('theme', 'retains', 'changes')), f'{id_}: missing theme continuity'
            if alt['scope'] == 'in_box':
                def bag(e):
                    total=Counter()
                    for _,n,q in e['stock']:total[canonical(n)]+=q
                    return total
                assert bag(base) == bag(alt), f'{id_}: in-box alternative changed the card pool'
            alt['validated_fingerprint'] = validate(alt, facts)
            alt['list_checked_on'] = checked
            count += 1
    args.document.write_text(json.dumps(doc, indent=2, ensure_ascii=False)+'\n')
    print(f'Validated {count} commander options and their reference lists; checked {checked}.')


if __name__ == '__main__':
    main()
