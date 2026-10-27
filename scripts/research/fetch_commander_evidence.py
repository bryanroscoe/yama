#!/usr/bin/env python3
"""Refresh licensable public commander aggregates. No player/deck records are stored.

One endpoint supplies each observation's wins and games. Rates are raw, not seat
normalised. An unsuccessful refresh preserves the old observation and its date.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
API = 'https://playgroup.gg/api/public/v1/commanders'
UA = 'Yama-commander-evidence/2 (https://yama.saget.org; aggregate research)'


def canonical(name):
    return name.split(' // ')[0].casefold()


def observation(name, row, fetched_at, digest):
    if canonical(name) != canonical(row['name']):
        raise ValueError('commander identity mismatch')
    games, wins = row['stats']['games_count'], row['stats']['games_won']
    if type(games) is not int or type(wins) is not int or not 0 <= wins <= games:
        raise ValueError('invalid wins/games')
    id_ = row['id']
    if type(id_) is not int or id_ <= 0:
        raise ValueError('invalid commander ID')
    return dict(name=row['name'], commander_id=id_, url=f'https://playgroup.gg/commanders/{id_}',
                api_url=f'{API}/{id_}.json', fetched_at=fetched_at, provider_updated_at=None,
                games=games, wins=wins, raw_win_rate_percent=round(100*wins/games, 2) if games else None,
                population='All recorded lists under this commander; stock and modified lists, pod sizes and power levels are mixed.',
                sha256=digest)


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read()
    return json.loads(raw), dt.datetime.now(dt.timezone.utc).isoformat(), hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'server/resources/commander-evidence.json')
    args = parser.parse_args()
    assessments = json.loads((ROOT/'server/resources/precon-upgradeability.json').read_text())
    names = sorted({n for e in assessments['decks'].values() for n in e['commanders']})
    previous = json.loads(args.output.read_text()) if args.output.exists() else {}
    # Do not silently reuse a stale bulk directory when a current lookup fails.
    directory, _, _ = fetch(f'{API}.json')
    by_name = {canonical(r['name']): r for r in directory}
    out, errors = {}, []
    for i, name in enumerate(names):
        try:
            id_ = by_name[canonical(name)]['id']
            row, fetched_at, digest = fetch(f'{API}/{id_}.json')
            out[name] = observation(name, row, fetched_at, digest)
        except (KeyError, ValueError, OSError) as error:
            if name in previous.get('commanders', {}):
                out[name] = previous['commanders'][name]
            errors.append({'commander': name, 'error': str(error)})
        if (i+1) % 20 == 0:
            print(f'{i+1}/{len(names)} observations', flush=True)
        time.sleep(1)
    result = dict(source='Playgroup.gg (Arcane Digital B.V.)',
                  attribution='Aggregate statistics, CC BY 4.0; https://playgroup.gg/legal',
                  checked_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                  method='raw-wins-divided-by-games-v1',
                  limitations='Mixed lists, pilots, opponents and pod sizes. Not four-player normalised; not an upgrade-gain estimate. Partners are individual commander observations.',
                  commanders=out, refresh_errors=errors)
    temp = args.output.with_suffix('.tmp')
    temp.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
    temp.replace(args.output)
    print(f'{len(out)} observations; {len(errors)} refresh errors (old dates preserved).')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
