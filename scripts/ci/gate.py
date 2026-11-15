"""Decide which of CI's web, Rust and Python jobs a change still needs.

The CI gate job runs this for ready (non-draft) pull requests and for pushes to main;
manual runs never reach it and always test in full. Standard library only.

Each job covers one area (`AREAS`). A changed file needs the area that owns it
(`owners`) and every area whose code reads it (`cross_reads`: the gate scans Rust,
TypeScript/JavaScript and Python sources for the repository paths they name, such as
the server's `include_str!` of web CSS or a web test reading `server/src/public_page.rs`).
Documentation nothing reads needs no job; a file no rule knows needs Python, and an
unreadable file list or source scan needs every job.

For a pull request, every job is skipped when either:
- the PR carries the `skip-ci` label (a manual override), or
- the PR head commit has a `Local-CI: passed tree=<sha>` trailer naming that
  commit's own tree (written by scripts/local-ci.sh after the checks pass), and
  the head already contains the base branch, so the merge CI would test is that
  same tree.
Otherwise each job runs when the PR's changed files need its area.

A push to main is compared with the newest main commit whose push CI passed with tests
on: only the areas the difference needs run. Any of those a pull request run already
passed on this very same tree (its `ci-passed-tree-<tree>` artifact) are skipped too,
unless the push changes a cache key, since only main's push CI saves the caches.

Any error reading GitHub falls back to running CI.
"""

import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import urllib.parse
import urllib.request

LABEL = 'skip-ci'
TRAILER = re.compile(r'^Local-CI: passed tree=([0-9a-f]{40}(?:[0-9a-f]{24})?)(?:\s|$)', re.M)


def attested_trees(message):
    # Only the trailer block (the last paragraph) counts, not a body that quotes one.
    return set(TRAILER.findall(message.strip().split('\n\n')[-1]))


def decide(labels, message, tree, behind_by, base_ref='main'):
    """Return (skip, reason) for a PR head commit."""
    if LABEL in labels:
        return True, f'The PR has the `{LABEL}` label. Remove it and re-run (or push) to run CI.'
    trees = attested_trees(message)
    if not trees:
        return False, ('The head commit has no `Local-CI` trailer; '
                       'run `scripts/local-ci.sh` to record local checks.')
    if tree not in trees:
        return False, (f'The head commit\'s `Local-CI` trailer names another tree, not `{tree}`; '
                       'the checks did not run on this content.')
    if behind_by:
        return False, (f'Local checks passed on this tree, but the branch is {behind_by} commit(s) '
                       f'behind `{base_ref}`, so CI tests a different merge. '
                       'Rebase or merge, then run `scripts/local-ci.sh` again to skip.')
    return True, f'Local checks passed on tree `{tree}`, and the branch contains `{base_ref}`.'


AREAS = ('web', 'rust', 'python')
# The jobs that test each area, by name. "Rust and Python tests" is the job that covered
# both areas before they were split (passed-tree artifacts from it stay readable).
JOBS = {'web': ('Web checks',), 'rust': ('Rust tests', 'Rust and Python tests'),
        'python': ('Python tests', 'Rust and Python tests')}
MAX_FILES = 3000  # GitHub lists at most this many files for one PR.
CI_WORKFLOW = '.github/workflows/ci.yml'

RUST_OWNS = ('server/', 'play/', '.cargo/')
RUST_FILES = {'Cargo.toml', 'Cargo.lock', 'deploy/phase-rev', 'deploy/phase-repo'}
# `npm test` runs vitest from the root, which finds tests anywhere (relay/, extension/).
WEB_OWNS = ('web/', 'packages/', 'relay/', 'extension/')
WEB_FILES = {'package.json', 'package-lock.json'}
SCRIPT_SUFFIXES = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts')
# Documentation and design notes: no job, unless a scanned source reads the file.
DOCS = ('docs/', 'design/', '.claude/')
DOC_FILES = {'LICENSE', 'COPYRIGHT'}


def owners(path):
    """The areas a change to `path` needs before counting who else reads it."""
    if path == CI_WORKFLOW:
        return set(AREAS)
    name = path.rsplit('/', 1)[-1]
    areas = set()
    if path.startswith(RUST_OWNS) or path in RUST_FILES or name.startswith('rust-toolchain'):
        # The Python suites are cheap and some read the Rust side (build stamps, pins).
        areas |= {'rust', 'python'}
    if path.startswith(WEB_OWNS) or path in WEB_FILES or path.endswith(SCRIPT_SUFFIXES):
        areas.add('web')
    if path.endswith('.py'):
        areas.add('python')
    documentation = path.startswith(DOCS) or path in DOC_FILES or ('/' not in path and path.endswith('.md'))
    if not areas and not documentation:
        areas.add('python')  # deploy/, scripts/, tools/, runtime/, workflows, anything new
    return areas


# Sources scanned for the repository paths they read, per area: (path prefixes, suffixes).
READERS = {
    'rust': (RUST_OWNS, ('.rs',)),
    'web': (WEB_OWNS, SCRIPT_SUFFIXES),
    'python': (('',), ('.py',)),
}
# The gate and its tests name paths as test data, not as files they read.
NOT_READERS = {'scripts/ci/gate.py', 'scripts/ci/test_gate.py'}
QUOTED = {'rust': re.compile(r'"((?:[^"\\\n]|\\.){1,240})"'),  # 'a is a lifetime in Rust
          'web': re.compile(r'"((?:[^"\\\n]|\\.){1,240})"|\'((?:[^\'\\\n]|\\.){1,240})\'|`([^`\n]{1,240})`'),
          'python': re.compile(r'"((?:[^"\\\n]|\\.){1,240})"|\'((?:[^\'\\\n]|\\.){1,240})\'')}
# Where a format string or glob starts, the rest of the literal is a pattern.
PATTERN = re.compile(r'\$\{|[{*?%]')


def tracked_files(root='.'):
    """Every file in HEAD's tree (a sparse checkout lists them all)."""
    out = subprocess.run(['git', 'ls-tree', '-r', '-z', '--name-only', 'HEAD'], cwd=root,
                         check=True, capture_output=True, timeout=60).stdout
    return [name for name in out.decode().split('\0') if name]


def resolve(literal, source):
    """Repository paths a string literal in `source` may name, as (path, is_prefix)."""
    is_prefix = False
    cut = PATTERN.search(literal)
    if cut:
        literal, is_prefix = literal[:cut.start()], True
    if not literal or literal.startswith(('/', '~')) or '://' in literal or any(c.isspace() for c in literal):
        return set()
    folder = posixpath.dirname(source)
    # include_str! is relative to the file, Cargo and Node run tests from the crate or
    # package directory, and some code names paths from the repository root.
    bases = {folder, source.split('/', 1)[0] if '/' in source else '', ''}
    if source.startswith('packages/'):
        bases.add('/'.join(source.split('/')[:2]))
    found = set()
    for base in bases:
        path = posixpath.normpath(posixpath.join(base, literal))
        if path.startswith('..') or path == '.':
            continue
        found.add((path, is_prefix))
    return found


def cross_reads(root='.', files=None):
    """{(path, kind): areas} for repository paths each area's sources name.

    kind is 'file', 'dir' or 'prefix' (a format string cut short). Only paths that exist
    in the tree count, and never a whole top-level directory: `"web"` in Rust is a word.
    """
    files = tracked_files(root) if files is None else files
    tracked = set(files)
    folders = {'/'.join(f.split('/')[:i]) for f in files for i in range(2, f.count('/') + 1)}
    reads = {}
    for area, (prefixes, suffixes) in READERS.items():
        for source in files:
            if not source.startswith(prefixes) or not source.endswith(suffixes) or source in NOT_READERS:
                continue
            try:
                text = Path(root, source).read_text(encoding='utf-8', errors='replace')
            except FileNotFoundError:
                continue  # not in this (sparse) checkout
            for match in QUOTED[area].finditer(text):
                literal = next(group for group in match.groups() if group is not None)
                # "cargo:rerun-if-changed=../path" and "--flag=path" name a path after "=".
                found = resolve(literal, source) | resolve(literal.rsplit('=', 1)[-1], source)
                for path, is_prefix in found:
                    if is_prefix:
                        if '/' not in path or not any(f.startswith(path) for f in files):
                            continue
                        key = (path, 'prefix')
                    elif path in tracked:
                        key = (path, 'file')
                    elif path in folders:
                        key = (path, 'dir')
                    else:
                        continue
                    reads.setdefault(key, set()).add(area)
    return reads


def readers(path, reads):
    areas = set()
    for (read, kind), by in reads.items():
        if (path == read if kind == 'file' else path.startswith(read + '/') if kind == 'dir'
                else path.startswith(read)):
            areas |= by
    return areas


def areas_needed(files, reads):
    """The areas a change to `files` needs. Unknown (no list, no scan) means all of them."""
    if not files or len(files) >= MAX_FILES or reads is None:
        return set(AREAS)
    needed = set()
    for path in files:
        needed |= owners(path) | readers(path, reads)
    return needed


def explain(path, reads):
    return sorted(owners(path) | readers(path, reads))


PASSED_ARTIFACT = 'ci-passed-tree-'
TESTS_OFF_JOB = 'Tests are off (checked locally before merge)'
# Only main's push CI saves the Rust and npm caches PRs restore, so a push that changes
# their keys tests (and saves) in full. The workflow sets the keys and cache paths.
CACHE_KEYS = ('Cargo.lock', 'package-lock.json', 'deploy/phase-rev', CI_WORKFLOW)
GREEN_RUNS = 20  # how many recent successful main runs to consider as the base


def changes_cache_key(files):
    return any(path in CACHE_KEYS or path.endswith('Cargo.toml')
               or path.split('/')[-1].startswith('rust-toolchain') for path in files)


def passed_areas(run, jobs, repo):
    """The areas a same-repository PR run of this workflow passed (job concluded success)."""
    if (run.get('path', '').split('@')[0] != CI_WORKFLOW or run.get('event') != 'pull_request'
            or run.get('head_repository', {}).get('full_name') != repo):
        return set()
    passed = {job.get('name') for job in jobs if job.get('conclusion') == 'success'}
    return {area for area in AREAS if passed & set(JOBS[area])}


def green_base(repo, sha):
    """The newest earlier main commit whose push CI passed with tests on, and its run."""
    runs = api(f'/repos/{repo}/actions/workflows/ci.yml/runs?branch=main&event=push'
               f'&status=success&per_page={GREEN_RUNS}').get('workflow_runs', [])
    for run in runs:
        base = run.get('head_sha', '')
        if (base == sha or run.get('conclusion') != 'success'
                or run.get('path', '').split('@')[0] != CI_WORKFLOW
                or run.get('head_repository', {}).get('full_name') != repo):
            continue
        jobs = api(f'/repos/{repo}/actions/runs/{run["id"]}/jobs?filter=latest&per_page=100')['jobs']
        # A run from while tests were off vouches for nothing.
        if any(job.get('name') == TESTS_OFF_JOB and job.get('conclusion') == 'success' for job in jobs):
            continue
        if api(f'/repos/{repo}/compare/{base}...{sha}').get('status') == 'ahead':
            return base, run
    return None, None


def decide_push(repo, sha, reads):
    """Return (areas still needed, reason) for a push to main."""
    base, base_run = green_base(repo, sha)
    if base is None:
        return set(AREAS), 'No earlier main commit passed push CI with tests on, so main tests in full.'
    files = [entry['filename'] for entry in api(f'/repos/{repo}/compare/{base}...{sha}').get('files', [])]
    link = f'[`{base[:12]}`]({base_run.get("html_url", "")})'
    if not files or len(files) >= 300:
        return set(AREAS), f'The change since {link} has no readable file list, so main tests in full.'
    needed = areas_needed(files, reads)
    reason = f'Compared with {link}, the last main commit whose push CI passed: '
    if not needed:
        return needed, reason + 'nothing any check reads changed.'
    reason += f'{len(files)} changed file(s) need {", ".join(sorted(needed))}.'
    if changes_cache_key(files):
        return needed, reason + (' The push changes the Rust or npm cache key, so those run here '
                                 'and save fresh caches.')
    tree = api(f'/repos/{repo}/git/commits/{sha}')['tree']['sha']
    artifacts = api(f'/repos/{repo}/actions/artifacts?per_page=30&name={PASSED_ARTIFACT}{tree}')
    for artifact in artifacts.get('artifacts', []):
        if artifact.get('expired') or artifact.get('name') != PASSED_ARTIFACT + tree:
            continue
        run_id = int(artifact['workflow_run']['id'])
        run = api(f'/repos/{repo}/actions/runs/{run_id}')
        jobs = api(f'/repos/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100')['jobs']
        covered = needed & passed_areas(run, jobs, repo)
        if covered:
            needed -= covered
            reason += (f' PR CI run [{run_id}]({run.get("html_url", "")}) already passed '
                       f'{", ".join(sorted(covered))} on this exact tree `{tree}`.')
            if not needed:
                break
    return needed, reason


def api(path):
    request = urllib.request.Request(
        os.environ.get('GITHUB_API_URL', 'https://api.github.com') + path,
        headers={'Accept': 'application/vnd.github+json',
                 'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def gather(repo, number, head_sha, base_ref):
    # Labels are read live so a re-run notices a removed label.
    labels = {label['name'] for label in api(f'/repos/{repo}/pulls/{number}')['labels']}
    commit = api(f'/repos/{repo}/git/commits/{head_sha}')
    base = urllib.parse.quote(base_ref, safe='')
    behind_by = api(f'/repos/{repo}/compare/{base}...{head_sha}')['behind_by']
    return labels, commit['message'], commit['tree']['sha'], behind_by


def changed_files(repo, number):
    files = []
    for page in range(1, MAX_FILES // 100 + 1):
        batch = api(f'/repos/{repo}/pulls/{number}/files?per_page=100&page={page}')
        for entry in batch:
            files.append(entry['filename'])
            if entry.get('previous_filename'):
                files.append(entry['previous_filename'])
        if len(batch) < 100:
            break
    return files


def write(name, text):
    path = os.environ.get(name)
    if path:
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(text)


def main():
    head_sha = os.environ['HEAD_SHA']
    base_ref = os.environ.get('BASE_REF', 'main')
    push = os.environ.get('EVENT_NAME') == 'push'
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    try:
        reads = cross_reads()
    except Exception as error:  # Fail safe: without the scan nothing is known to be unread.
        print(f'::warning::CI gate could not scan the sources ({error}); every job runs.')
        reads = None
    try:
        if not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', head_sha):
            raise ValueError('HEAD_SHA is not a full commit SHA')
        if push:
            needed, reason = decide_push(repo, head_sha, reads)
            skip = False
        else:
            number = int(os.environ['PR_NUMBER'])
            labels, message, tree, behind_by = gather(repo, number, head_sha, base_ref)
            skip, reason = decide(labels, message, tree, behind_by, base_ref)
            needed = set() if skip else areas_needed(changed_files(repo, number), reads)
            if not skip:
                reason += (f' The changed files need {", ".join(sorted(needed))}.' if needed
                           else ' Nothing any check reads changed.')
    except Exception as error:  # Fail safe: unreadable GitHub runs CI.
        print(f'::warning::CI gate could not read GitHub ({error}); running CI.')
        skip, reason = False, f'The gate could not read GitHub ({type(error).__name__}), so CI runs.'
        needed = set(AREAS)
    if reads is None and not skip:
        needed = set(AREAS)
        reason += ' The source scan failed, so every job runs.'
    return finish(head_sha, skip, needed, reason, push)


def finish(head_sha, skip, needed, reason, push):
    title = 'CI skipped' if skip or not needed else 'CI runs'
    print(f'{title}: {reason}')
    jobs = ''.join(f'- {JOBS[area][0]}: {"runs" if area in needed else "skipped"}\n' for area in AREAS)
    note = ''
    if skip or not needed:
        note = ('This push CI still authorizes deployment.\n' if push else
                'Push CI on main still checks what changed before deployment.\n')
    write('GITHUB_STEP_SUMMARY', f'### {title} for `{head_sha[:12]}`\n\n{reason}\n\n{jobs}\n{note}')
    # Last, so a failure anywhere above leaves no skip behind.
    write('GITHUB_OUTPUT', ''.join(f'{area}={"true" if area in needed else "false"}\n' for area in AREAS)
          + f'skip={"true" if skip else "false"}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
