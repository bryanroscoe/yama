#!/usr/bin/env python3
"""Export the frozen v0.119 adapter without changing either source checkout."""
import argparse
import importlib.util
import io
import json
import pathlib
import subprocess
import tarfile

root = pathlib.Path(__file__).resolve().parent.parent
recipe = root / 'runtime/v0119'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=pathlib.Path)
parser.add_argument('--prepare-only', action='store_true')
parser.add_argument('--record-source-provenance', action='store_true')
parser.add_argument('--yama-repo', type=pathlib.Path, default=root)
parser.add_argument('--phase-repo', type=pathlib.Path, default=root.parent / 'yama-phase')
args = parser.parse_args()
manifest = json.loads((recipe / 'historical.json').read_text())
out = args.output.resolve()
if out.exists():
    raise SystemExit(f'Refusing existing export: {out}')
out.mkdir(parents=True)


def export(repo, revision, destination, paths):
    destination.mkdir()
    data = subprocess.check_output(['git', '-C', str(repo), 'archive', revision, *paths])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.issym() or member.islnk():
                raise SystemExit(f'Unsafe source archive member: {member.name}')
        archive.extractall(destination)


export(args.yama_repo, manifest['yama'], out / 'yama',
       ['Cargo.toml', 'Cargo.lock', 'play', 'deploy/phase-rev'])
export(args.phase_repo, manifest['phase'], out / 'yama-phase',
       ['Cargo.toml', 'Cargo.lock', 'crates', 'protocol'])
p = out / 'yama/Cargo.toml'
p.write_text(p.read_text().replace('members = ["server", "play"]', 'members = ["play"]'))
p = out / 'yama/play/Cargo.toml'
p.write_text(p.read_text().replace('name = "yama-play"', 'name = "yama-play-historical-v0119"', 1)
             .replace('[dependencies]', '[lib]\nname = "yama_play"\n\n[dependencies]', 1))
# Native v0.119 already verifies data and persists its own controls, revisions,
# rewind audit and abandonment. No v0.113 control/loader shim belongs here.
for source, target in [('worker.rs', 'historical-runtime-v0119.rs'),
                       ('historical.json', 'historical.json')]:
    (out / 'yama/play/src/bin' / target).write_bytes((recipe / source).read_bytes())
lock = recipe / 'historical.lock'
if lock.exists():
    (out / 'yama/Cargo.lock').write_bytes(lock.read_bytes())
spec = importlib.util.spec_from_file_location('verify_source', root / 'runtime/verify-source.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
provenance = dict(yama=manifest['yama'], phase=manifest['phase'], source_sha256=verifier.source_digest(out))
binding = recipe / 'historical-source.json'
if args.record_source_provenance:
    binding.write_text(json.dumps(provenance, indent=2) + '\n')
if json.loads(binding.read_text()) != provenance:
    raise SystemExit('v0.119 source differs from its reviewed binding')
(out / 'yama/play/src/bin/historical-source.json').write_bytes(binding.read_bytes())
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
if not args.prepare_only:
    raise SystemExit('Use the documented guarded Cargo command to build this prepared export')
