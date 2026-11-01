"""Decide which of CI's web and Rust jobs a change still needs.

The CI gate job runs this for ready (non-draft) pull requests and for pushes to main;
manual runs never reach it and always test in full. Standard library only.

A push to main skips both jobs only when a pull request run already passed both on the
very same tree: its Rust job publishes a `ci-passed-tree-<tree>` artifact after every
check passes, and the run's web job must have passed too. A merge commit whose tree is
the tree the PR tested (the PR contained main) is then not tested twice. Anything else,
including a PR that skipped CI on local checks, runs both jobs on main.

For a pull request:

CI is skipped when either:
- the PR carries the `skip-ci` label (a manual override), or
- the PR head commit has a `Local-CI: passed tree=<sha>` trailer naming that
  commit's own tree (written by scripts/local-ci.sh after the checks pass), and
  the head already contains the base branch, so the merge CI would test is that
  same tree.

Otherwise the web job always runs, and the Rust job is skipped when every changed
file is web-only (see `rust_needed`).

Any error reading GitHub falls back to running CI.
"""

import json
import os
import re
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


# Paths the Rust/Python job cannot see: the web app and its shared TypeScript package.
WEB_ONLY = ('web/', 'packages/')
WEB_ONLY_FILES = {'package.json', 'package-lock.json'}
# ...except files the server compiles in with include_str! (site notice, page CSS).
RUST_READS = ('web/public/',)
RUST_READS_SUFFIXES = ('.css', '.html')
MAX_FILES = 3000  # GitHub lists at most this many files for one PR.


def rust_needed(files):
    """Whether a PR changing `files` needs the Rust and Python job. Unknown means yes."""
    if not files or len(files) >= MAX_FILES:
        return True
    for path in files:
        web_only = path in WEB_ONLY_FILES or path.startswith(WEB_ONLY)
        if not web_only or path.startswith(RUST_READS) or path.endswith(RUST_READS_SUFFIXES):
            return True
    return False


PASSED_ARTIFACT = 'ci-passed-tree-'
CI_WORKFLOW = '.github/workflows/ci.yml'
REQUIRED_JOBS = ('Web checks', 'Rust and Python tests')


def passed_run(run, jobs, repo):
    """Whether a CI run is a same-repository PR run whose web and Rust jobs both passed."""
    if (run.get('path', '').split('@')[0] != CI_WORKFLOW or run.get('event') != 'pull_request'
            or run.get('head_repository', {}).get('full_name') != repo):
        return False
    results = {job.get('name'): job.get('conclusion') for job in jobs}
    return all(results.get(name) == 'success' for name in REQUIRED_JOBS)


def decide_push(repo, sha):
    """Return (skip, reason) for a push to main."""
    tree = api(f'/repos/{repo}/git/commits/{sha}')['tree']['sha']
    artifacts = api(f'/repos/{repo}/actions/artifacts?per_page=30&name={PASSED_ARTIFACT}{tree}')
    for artifact in artifacts.get('artifacts', []):
        if artifact.get('expired') or artifact.get('name') != PASSED_ARTIFACT + tree:
            continue
        run_id = int(artifact['workflow_run']['id'])
        run = api(f'/repos/{repo}/actions/runs/{run_id}')
        jobs = api(f'/repos/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100')['jobs']
        if passed_run(run, jobs, repo):
            return True, (f'PR CI run [{run_id}]({run.get("html_url", "")}) already passed the web '
                          f'and Rust jobs on this exact tree `{tree}`.')
    return False, f'No PR run passed both jobs on tree `{tree}`, so main tests it in full.'


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
    try:
        if not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', head_sha):
            raise ValueError('HEAD_SHA is not a full commit SHA')
        if push:
            skip, reason = decide_push(os.environ['GITHUB_REPOSITORY'], head_sha)
            rust = True
        else:
            labels, message, tree, behind_by = gather(
                os.environ['GITHUB_REPOSITORY'], int(os.environ['PR_NUMBER']), head_sha, base_ref)
            skip, reason = decide(labels, message, tree, behind_by, base_ref)
            rust = skip or rust_needed(changed_files(os.environ['GITHUB_REPOSITORY'],
                                                     int(os.environ['PR_NUMBER'])))
    except Exception as error:  # Fail safe: unreadable GitHub runs CI.
        print(f'::warning::CI gate could not read GitHub ({error}); running CI.')
        skip, reason = False, f'The gate could not read GitHub ({type(error).__name__}), so CI runs.'
        rust = True
    if not skip and not rust:
        reason += ' Only web files changed, so the Rust and Python job is skipped.'
    return finish(head_sha, skip, rust, reason, push)


def finish(head_sha, skip, rust, reason, push):
    title = 'CI skipped' if skip else 'CI runs'
    print(f'{title}: {reason}')
    note = ('The web and Rust jobs show as skipped; this push CI still authorizes deployment.\n'
            if push else 'The web and Rust jobs show as skipped. Push CI on main still tests '
            'before deployment unless a PR run passed on the same tree.\n')
    write('GITHUB_STEP_SUMMARY', f'### {title} for `{head_sha[:12]}`\n\n{reason}\n\n'
          + (note if skip else ''))
    # Last, so a failure anywhere above leaves no skip behind.
    write('GITHUB_OUTPUT', f'rust={"true" if rust else "false"}\n'
                           f'skip={"true" if skip else "false"}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
