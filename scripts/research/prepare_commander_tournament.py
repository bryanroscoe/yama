#!/usr/bin/env python3
"""Prepare one MCP shared-field request from validated public commander configurations."""
import argparse
import json
from pathlib import Path
from inventory_precon_commanders import reboard
from validate_commander_paths import fingerprint

ROOT = Path(__file__).resolve().parents[2]


def prepare(document, roster):
    inputs, manifest = [], []
    for slug, base in document['decks'].items():
        if not base.get('alternatives'):
            continue
        for option in roster['decks'][slug]['options']:
            if not option['fingerprint']:
                raise ValueError(f'{slug}: stock needs legal replacements')
            entry = reboard(base, option['commanders'])
            if fingerprint(entry['stock']) != option['fingerprint']:
                raise ValueError(f'{slug}: stale inventory fingerprint')
            manifest.append({'precon': slug, 'commanders': entry['commanders'], 'scope': 'in_box', 'fingerprint': option['fingerprint']})
            inputs.append({'label': slug + ' / ' + ' + '.join(entry['commanders']), 'list': text(entry['stock'])})
        for alt in base['alternatives']:
            if alt['scope'] != 'on_theme_swap':
                continue
            if fingerprint(alt['stock']) != alt['validated_fingerprint']:
                raise ValueError(f'{slug}: stale outside-commander fingerprint')
            manifest.append({'precon': slug, 'commanders': alt['commanders'], 'scope': alt['scope'], 'fingerprint': alt['validated_fingerprint']})
            inputs.append({'label': slug + ' / ' + ' + '.join(alt['commanders']), 'list': text(alt['stock'])})
    return {'mode': 'tournament', 'entrant_lists': inputs, 'opponents': 'strongest', 'games': 100,
            'engine': 'both', 'ai': 'Easy', 'forge_ai': 'Default'}, manifest


def text(rows):
    return '\n\n'.join(label+'\n'+'\n'.join(f'{q} {n}' for b,n,q in rows if b==board)
                        for board,label in [('commander','Commander'),('main','Deck')])+'\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if any((args.output/name).exists() for name in ('stage-receipt.json','run-receipt.json')):
        raise SystemExit('This campaign has been staged or started; use a new output directory to preserve frozen inputs.')
    document = json.loads((ROOT/'server/resources/precon-upgradeability.json').read_text())
    roster = json.loads((ROOT/'server/resources/precon-commander-roster.json').read_text())
    request, manifest = prepare(document, roster)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'request.json').write_text(json.dumps(request, indent=2, ensure_ascii=False)+'\n')
    (args.output/'inputs.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+'\n')
    print(f"Prepared {len(manifest)} distinct commander inputs plus benchmark precons; 100 appearances per deck per engine.")


if __name__ == '__main__':
    main()
