"""Decide whether a pull request's CI may skip its web and Rust jobs.

The CI gate job runs this for ready (non-draft) pull requests only; pushes to main
and manual runs never reach it and always test in full. Standard library only.

CI is skipped when either:
- the PR carries the `skip-ci` label (a manual override), or
- the PR head commit has a `Local-CI: passed tree=<sha>` trailer naming that
  commit's own tree (written by scripts/local-ci.sh after the checks pass), and
  the head already contains the base branch, so the merge CI would test is that
  same tree.

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


def write(name, text):
    path = os.environ.get(name)
    if path:
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(text)


def main():
    head_sha = os.environ['HEAD_SHA']
    base_ref = os.environ.get('BASE_REF', 'main')
    try:
        if not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', head_sha):
            raise ValueError('HEAD_SHA is not a full commit SHA')
        labels, message, tree, behind_by = gather(
            os.environ['GITHUB_REPOSITORY'], int(os.environ['PR_NUMBER']), head_sha, base_ref)
        skip, reason = decide(labels, message, tree, behind_by, base_ref)
    except Exception as error:  # Fail safe: an unreadable PR runs CI.
        print(f'::warning::CI gate could not read the PR ({error}); running CI.')
        skip, reason = False, f'The gate could not read the PR ({type(error).__name__}), so CI runs.'
    title = 'CI skipped' if skip else 'CI runs'
    print(f'{title}: {reason}')
    write('GITHUB_STEP_SUMMARY',
          f'### {title} for `{head_sha[:12]}`\n\n{reason}\n\n'
          + ('The web and Rust jobs show as skipped. Push CI on main still runs every check '
             'before deployment.\n' if skip else ''))
    # Last, so a failure anywhere above leaves no skip behind.
    write('GITHUB_OUTPUT', f'skip={"true" if skip else "false"}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
