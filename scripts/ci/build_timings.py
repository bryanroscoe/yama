"""Print the slowest units of a `cargo --timings` build, then remove the report.

Usage: python3 scripts/ci/build_timings.py <target-dir> [count]

CI uses this to show where Rust build time goes. The report directory is removed so
saget's persistent target cache doesn't collect one HTML file per run. Standard library only.
"""

import json
import re
import shutil
import sys
from pathlib import Path


def units(html):
    match = re.search(r'const UNIT_DATA = (\[.*?\]);\n', html, re.S)
    return json.loads(match.group(1)) if match else []


def table(rows, count):
    rows = sorted(rows, key=lambda unit: unit.get('duration', 0), reverse=True)
    total = sum(unit.get('duration', 0) for unit in rows)
    lines = [f'{len(rows)} units, {total:.0f}s of compiler time in total. Slowest {count}:']
    for unit in rows[:count]:
        target = unit.get('target', '').strip() or '(lib)'
        lines.append(f"{unit.get('duration', 0):8.1f}s  {unit.get('name')} {target} [{unit.get('mode', '')}]")
    return '\n'.join(lines)


def main():
    directory = Path(sys.argv[1]) / 'cargo-timings'
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    report = directory / 'cargo-timing.html'
    if report.is_file():
        print(table(units(report.read_text(encoding='utf-8')), count))
    else:
        print(f'No timing report at {report}.')
    shutil.rmtree(directory, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
