#!/usr/bin/env python3
"""Fetch public facts for the frozen precon inventory; atomically checkpoint progress.

The output is local research input, not a bundled rules/image dataset. Scryfall's
is:commander search independently covers exceptions such as Grist. Card legality
and legal pair mechanisms are still checked separately by the inventory validator.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
UA = 'Yama-package-commander-audit/1 (https://yama.ing)'


def atomic(path, value):
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False))
    temp.replace(path)


def fetch(url, data=None):
    headers = {'User-Agent':UA, 'Accept':'application/json'}
    if data is not None:
        headers['Content-Type']='application/json'
    req=urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                value=json.load(response)
            time.sleep(1)
            return value
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 3:
                raise
            retry=error.headers.get('Retry-After', '30')
            seconds=int(retry) if retry.isdigit() else 30
            print(f'Provider rate limit; waiting {seconds}s before retry',flush=True)
            time.sleep(seconds)



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args=parser.parse_args()
    facts=json.loads(args.output.read_text()) if args.output.exists() else {}
    document=json.loads((ROOT/'server/resources/precon-upgradeability.json').read_text())
    names={n.split(' // ')[0].casefold():n.split(' // ')[0] for e in document['decks'].values() for _,n,_ in e['stock']}
    missing=[name for key,name in sorted(names.items()) if key not in facts]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    for start in range(0,len(missing),75):
        result=fetch('https://api.scryfall.com/cards/collection', {'identifiers':[{'name':n} for n in missing[start:start+75]]})
        if result.get('not_found'):
            raise ValueError(result['not_found'])
        for c in result['data']:
            facts[c['name'].split(' // ')[0].casefold()]=c
        atomic(args.output, facts)
        print(f'Fetched {min(start+75,len(missing))}/{len(missing)} missing cards',flush=True)
    url='https://api.scryfall.com/cards/search?q=is%3Acommander&unique=cards'
    ids=set()
    while url:
        page=fetch(url)
        ids.update(c['oracle_id'] for c in page['data'])
        url=page.get('next_page')
    for c in facts.values():
        c['commander_eligible']=c['oracle_id'] in ids
    atomic(args.output, facts)
    atomic(args.output.with_name('eligibility-evidence.json'), {
        'source_url':'https://api.scryfall.com/cards/search?q=is%3Acommander&unique=cards',
        'fetched_at':datetime.now(timezone.utc).isoformat(), 'oracle_ids':sorted(ids)})
    print(f'Complete: {len(facts)} facts; {len(ids)} eligible commander Oracle ids',flush=True)


if __name__=='__main__':
    main()
