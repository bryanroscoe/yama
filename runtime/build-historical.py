#!/usr/bin/env python3
"""Export pinned sources (no worktree), add the transport, build the historical runtime.
Usage: runtime/build-historical.py SOURCE_EXPORT_DIR [--prepare-only]
Uses this repo's target directory, serially; never copies targets. Does not fetch or deploy.
"""
import json, pathlib, subprocess, sys, os, tarfile, io, importlib.util
root = pathlib.Path(__file__).resolve().parent.parent
manifest = json.loads((root/'runtime/historical.json').read_text())
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--prepare-only',action='store_true')
parser.add_argument('--record-source-provenance', action='store_true', help='Record reviewed transport/source changes in runtime/historical-source.json')
parser.add_argument('--yama-repo',type=pathlib.Path,default=root)
parser.add_argument('--phase-repo',type=pathlib.Path,default=root.parent/'yama-phase')
args=parser.parse_args()
out = pathlib.Path(args.output).resolve()
if out.exists():
    raise SystemExit(f'Refusing existing export: {out}')
out.mkdir(parents=True)
def export(repo, rev, dest, paths):
    dest.mkdir()
    data = subprocess.check_output(['git','-C',str(repo),'archive',rev,*paths])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            name=pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.issym() or member.islnk():
                raise SystemExit(f'Unsafe source archive member: {member.name}')
        archive.extractall(dest)
export(args.yama_repo, manifest['yama'], out/'yama', ['Cargo.toml','Cargo.lock','play'])
export(args.phase_repo, manifest['phase'], out/'yama-phase', ['Cargo.toml','crates'])
p=out/'yama/Cargo.toml'
p.write_text(p.read_text().replace('members = ["server", "play"]','members = ["play"]'))
p=out/'yama/play/Cargo.toml'
# A shared target must not alias current and frozen build-script output. Keep the
# Rust library name for the immutable adapter/worker, but use a distinct package ID.
package = p.read_text().replace('name = "yama-play"', 'name = "yama-play-historical"', 1)
package = package.replace('[dependencies]', '[lib]\nname = "yama_play"\n\n[dependencies]', 1)
p.write_text(package+'\nsha2 = "0.11.1"\n')
p=out/'yama/play/src/lib.rs'
# Add byte verification at the data boundary only. Historical game/AI/replay code is unchanged.
p.write_text(p.read_text()+'''
impl Engine {
    pub fn load_verified(path: &std::path::Path, expected: &str) -> anyhow::Result<Self> {
        use sha2::{Digest, Sha256};
        let json = std::fs::read_to_string(path)?;
        let actual = Sha256::digest(json.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        anyhow::ensure!(actual == expected, "card data content mismatch: expected {expected}, got {actual}");
        let db = CardDatabase::from_json_str(&json).map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(Self { db: Arc::new(db) })
    }
}
''')
for source, target in [('worker.rs','historical-runtime.rs'),('historical.json','historical.json')]:
    (out/'yama/play/src/bin'/target).write_bytes((root/'runtime'/source).read_bytes())
(out/'yama/Cargo.lock').write_bytes((root/'runtime/historical.lock').read_bytes())
spec = importlib.util.spec_from_file_location('verify_source', root/'runtime/verify-source.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
provenance = dict(yama=manifest['yama'], phase=manifest['phase'], source_sha256=verifier.source_digest(out))
expected = root/'runtime/historical-source.json'
if args.record_source_provenance:
    expected.write_text(json.dumps(provenance, indent=2)+'\n')
if json.loads(expected.read_text()) != provenance:
    raise SystemExit('Source export differs from reviewed historical-source.json; do not build it')
(out/'yama/play/src/bin/historical-source.json').write_bytes(expected.read_bytes())
(out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
if not args.prepare_only:
    env = dict(os.environ, CARGO_BUILD_JOBS='1', CARGO_TARGET_DIR=str(root/'target'))
    subprocess.run(['cargo','build','--locked','--manifest-path',str(out/'yama/Cargo.toml'),'-p','yama-play-historical','--bin','historical-runtime'],env=env,check=True)

    import hashlib
    binary = root/'target/debug/historical-runtime'
    binary.with_suffix('.sha256').write_text(hashlib.sha256(binary.read_bytes()).hexdigest()+'  '+str(binary)+'\n')
