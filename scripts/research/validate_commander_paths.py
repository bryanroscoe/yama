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
    if 'Background' in kind and 'Creature' not in kind:
        return False
    if 'commander_eligible' in card:
        require(type(card['commander_eligible']) is bool, 'invalid commander eligibility fact')
        if card['commander_eligible']:
            return True
        # Search-index absence does not override an explicit rules-based eligibility check.
    if card.get('name') == 'Grist, the Hunger Tide' and "isn't on the battlefield" in text and 'creature in addition to its other types' in text:
        return True
    return 'can be your commander' in text.lower() or ('Legendary' in kind and (
        'Creature' in kind or (('Vehicle' in kind or 'Spacecraft' in kind)
                              and front.get('power') is not None and front.get('toughness') is not None)))


def front(card):
    return card.get('card_faces', [card])[0]


def partners(first, second):
    a, b = front(first), front(second)
    ta, tb = a.get('oracle_text', ''), b.get('oracle_text', '')
    named = lambda text: re.search(r'(?m)^Partner with ([^\n(]+)', text)
    pa, pb = named(ta), named(tb)
    if pa or pb:
        return bool(eligible(first) and eligible(second) and pa and pb and canonical(pa[1].strip()) == canonical(second['name'])
                    and canonical(pb[1].strip()) == canonical(first['name']))
    keyword = lambda text, word: bool(re.search(r'(?mi)^' + re.escape(word) + r'(?: \(|$)', text))
    if eligible(first) and eligible(second) and keyword(ta, 'Partner') and keyword(tb, 'Partner'):
        return True
    if eligible(first) and eligible(second) and keyword(ta, 'Friends forever') and keyword(tb, 'Friends forever'):
        return True
    def background(leader, other):
        return 'choose a background' in leader.get('oracle_text', '').lower() and 'Legendary' in other['type_line'] and 'Background' in other['type_line']
    if background(a, b) or background(b, a):
        return True
    def doctor(companion, other):
        return "doctor's companion" in companion.get('oracle_text', '').lower() and 'Legendary Creature' in other['type_line'] and other['type_line'].split(' — ')[-1] == 'Time Lord Doctor'
    return doctor(a, b) or doctor(b, a)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(entry, facts):
    rows = entry['stock']
    for board, _, qty in rows:
        require(board in ('commander', 'main') and type(qty) is int and qty > 0,
                'invalid board or quantity')
        require(board != 'commander' or qty == 1, 'command-zone rows must have quantity one')
    require(sum(q for _, _, q in rows) == 100, 'expected 100 cards')
    commanders = [n for b, n, _ in rows if b == 'commander']
    require(commanders == entry['commanders'], 'command zone does not match declared configuration')
    require(len(set(map(canonical, commanders))) == len(commanders), 'commanders must be distinct')
    require(len(commanders) in (1, 2), 'expected one commander or a legal pair')
    leaders = [facts[canonical(name)] for name in commanders]
    if len(leaders) == 1:
        require(eligible(leaders[0]), 'not eligible to be a commander')
    else:
        require(partners(*leaders), 'joint commander eligibility needs a valid pairing rule')
    identity = set().union(*(set(c['color_identity']) for c in leaders))
    combined = Counter()
    for board, name, qty in rows:
        c = facts[canonical(name)]
        require(c['legalities']['commander'] == 'legal', f'{name} is not Commander legal')
        require(set(c['color_identity']) <= identity, f'{name} is outside colour identity')
        combined[canonical(name)] += qty
        if combined[canonical(name)] > 1:
            text=c.get('oracle_text','').lower()
            finite=re.search(r'deck can have up to (\w+) cards named',text)
            words=dict(zip('one two three four five six seven eight nine ten'.split(),range(1,11)))
            limit=(int(finite[1]) if finite[1].isdigit() else words.get(finite[1],1)) if finite else 1
            require('Basic' in c['type_line'] or 'deck can have any number of cards named' in text
                    or combined[canonical(name)] <= limit, f'{name} is duplicated')
    return fingerprint(rows)


def validate_document(doc, facts, checked):
    pending = []
    count = 0
    for id_, base in doc['decks'].items():
        if not base.get('alternatives'):
            continue
        pending.append((base, 'catalog_validated_fingerprint', 'catalog_list_checked_on', validate(base, facts)))
        for alt in base['alternatives']:
            if alt['scope'] == 'separate_build':
                continue
            require(all(alt['continuity'].get(k, '').strip() for k in ('theme', 'retains', 'changes')),
                    f'{id_}: missing theme continuity')
            if alt['scope'] == 'in_box':
                def bag(e):
                    total=Counter()
                    for _,n,q in e['stock']:total[canonical(n)]+=q
                    return total
                require(bag(base) == bag(alt), f'{id_}: in-box alternative changed the card pool')
            pending.append((alt, 'validated_fingerprint', 'list_checked_on', validate(alt, facts)))
            count += 1
    for entry, hash_key, date_key, digest in pending:
        entry[hash_key] = digest
        entry[date_key] = checked
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--facts', required=True, type=Path)
    parser.add_argument('--document', type=Path, default=ROOT/'server/resources/precon-upgradeability.json')
    args = parser.parse_args()
    doc, facts = json.loads(args.document.read_text()), json.loads(args.facts.read_text())
    checked = dt.date.today().isoformat()
    count = validate_document(doc, facts, checked)
    args.document.write_text(json.dumps(doc, indent=2, ensure_ascii=False)+'\n')
    print(f'Validated {count} commander options and their reference lists; checked {checked}.')


if __name__ == '__main__':
    main()
