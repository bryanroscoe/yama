#!/usr/bin/env python3
"""Server-owned release gate, installed outside all runner-writable mounts.

A caller supplies an exact main SHA and an ephemeral GitHub read token on stdin.
Only published main with successful push CI reaches Docker. Importing is inert.
"""
import base64
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO = 'bryanroscoe/yama'
BASE = Path('/mnt/user/appdata/yama-release')
APP = Path('/mnt/user/appdata/yama')
CI_ROOT = Path('/mnt/user/appdata/github-ci')
ENTRYPOINT = str(BASE / 'host.py')
SERVICES = ('yama', 'yama-advisor', 'yama-forge')
IMAGE_VARS = ('YAMA_IMAGE', 'YAMA_ADVISOR_IMAGE', 'YAMA_FORGE_IMAGE')
LOCK_WAIT_SECONDS = 110 * 60
RELEASE_SECONDS = 105 * 60
COMMAND_DEADLINE = None
MAX_TOKEN_LENGTH = 16_384


class Refused(Exception):
    pass


def log(message):
    try:
        print(message, flush=True)
    except BrokenPipeError:
        # Losing the SSH client must not abandon a running release or its lock.
        sys.stdout = open(os.devnull, 'w')


def api(path, token):
    req = Request('https://api.github.com/repos/' + REPO + '/' + path, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'yama-production-deployer',
    })
    try:
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    except (HTTPError, URLError, ValueError):
        # Never stringify authenticated requests or response bodies.
        raise Refused('GitHub verification unavailable for ' + path.split('?')[0]) from None


def verify_ci(revision, token):
    if api('git/ref/heads/main', token)['object']['sha'] != revision:
        return False  # superseded request, never an implicit rollback
    runs = api('actions/workflows/ci.yml/runs?event=push&branch=main&head_sha='
               + revision + '&per_page=1', token)['workflow_runs']
    if not runs:
        raise Refused('No push CI exists for this main revision')
    run = runs[0]
    expected = {'head_sha': revision, 'head_branch': 'main', 'event': 'push',
                'status': 'completed', 'conclusion': 'success'}
    if (any(run.get(k) != v for k, v in expected.items())
            or run.get('path', '').split('@')[0] != '.github/workflows/ci.yml'
            or run.get('head_repository', {}).get('full_name') != REPO):
        raise Refused('Latest push CI for this main revision has not passed')
    return True


def run(args, *, cwd=None, env=None, output=None, timeout=180):
    if COMMAND_DEADLINE is not None:
        remaining = COMMAND_DEADLINE - time.monotonic()
        if remaining <= 0:
            raise Refused('Host release deadline exceeded')
        timeout = min(timeout, remaining)
    # Kill only this command's process group on timeout, including git's SSH
    # children. Closing a build client cancels its BuildKit solve on the daemon.
    with subprocess.Popen([str(a) for a in args], cwd=cwd, env=env,
                          stdout=output or subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, start_new_session=True) as process:
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise Refused('Host command timed out: ' + str(args[0])) from None
        if process.returncode:
            if stdout:
                log(stdout[-6000:])
            raise Refused('Command failed: ' + str(args[0]) + ' (exit ' + str(process.returncode) + ')')
        return (stdout or '').strip()


@contextmanager
def release_lock():
    BASE.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_WAIT_SECONDS

    def take(lock, description):
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refused('Timed out waiting for ' + description)
                time.sleep(2)

    with ExitStack() as held:
        # CI takes release SH, then admission EX nonblocking; partial attempts
        # release everything. Admitted jobs drop admission but keep release SH.
        # Holding admission here therefore drains existing work without letting
        # new CI jobs repeatedly get ahead of a pending production release.
        # Never create/replace a missing pool lock: all callers need one inode.
        if CI_ROOT.exists():
            admission = held.enter_context((CI_ROOT / 'slots/admission.lock').open('r'))
            log('Waiting to reserve production priority…')
            take(admission, 'CI admission priority')
            log('Production priority reserved; draining admitted CI jobs…')
        lock = held.enter_context((BASE / 'release.lock').open('a'))
        log('Waiting for the production release lock…')
        take(lock, 'the production release lock')
        yield


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temp, path)


def git_auth(token):
    # Configuration is per-process, never persisted or put in command arguments.
    env = dict(os.environ)
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_COUNT='1',
               GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(
                   ('x-access-token:' + token).encode()).decode())
    return env


def checkout(revision, token):
    repo = BASE / 'yama'
    url = 'https://github.com/' + REPO + '.git'
    if not repo.exists():
        run(['git', 'init', '--initial-branch=main', repo])
        run(['git', '-C', repo, 'remote', 'add', 'origin', url])
    if run(['git', '-C', repo, 'remote', 'get-url', 'origin']) != url:
        raise Refused('Unexpected deployment checkout origin')
    if (run(['git', '-C', repo, 'symbolic-ref', '--short', 'HEAD']) != 'main'
            or run(['git', '-C', repo, 'status', '--porcelain'])):
        raise Refused('Deployment checkout must be clean main')
    run(['git', '-C', repo, 'fetch', '--no-tags', 'origin',
         '+refs/heads/main:refs/remotes/origin/main'], env=git_auth(token))
    if run(['git', '-C', repo, 'rev-parse', 'origin/main']) != revision:
        return None
    run(['git', '-C', repo, 'merge', '--ff-only', 'origin/main'])
    if run(['git', '-C', repo, 'rev-parse', 'HEAD']) != revision:
        raise Refused('Deployment checkout differs from verified main')
    return repo


def phase_checkout(repo):
    phase = BASE / 'yama-phase'
    if (repo / 'deploy/phase-repo').read_text().strip() != 'https://github.com/bryanroscoe/yama-phase.git':
        raise Refused('Unexpected engine repository')
    revision = (repo / 'deploy/phase-rev').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise Refused('Engine pin must be a full SHA')
    if not phase.exists():
        run(['git', 'init', '--initial-branch=main', phase])
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_SSH_COMMAND=(
        'ssh -i ' + str(BASE / 'phase_ed25519') + ' -o IdentitiesOnly=yes'
        ' -o StrictHostKeyChecking=yes -o UserKnownHostsFile=' + str(BASE / 'github_known_hosts')))
    # Rebasing the fork's main keeps the previous line under an archive/* tag; a pin on
    # either is published, so the deployed engine stays releasable until Yama bumps it.
    run(['git', '-C', phase, 'fetch', '--no-tags', '--prune', 'git@github.com:bryanroscoe/yama-phase.git',
         '+refs/heads/main:refs/remotes/origin/main',
         '+refs/tags/archive/*:refs/remotes/origin/archive/*'], env=env)
    archives = run(['git', '-C', phase, 'for-each-ref', '--format=%(refname)',
                    'refs/remotes/origin/archive/']).split()
    for ref in ['refs/remotes/origin/main', *archives]:
        try:
            run(['git', '-C', phase, 'merge-base', '--is-ancestor', revision, ref])
            return phase, revision
        except Refused as refused:
            # Exit 1 only means "not an ancestor"; a timeout, deadline or broken object stays its own error.
            if str(refused) != 'Command failed: git (exit 1)':
                raise
    raise Refused('Engine pin is not on the engine repository\'s main or an archive/* tag')


def bootstrap_sidecars(directory):
    """Create missing paired configuration once; never rotate existing secrets."""
    files = {name: directory / name for name in ('yama.env', 'advisor.env', 'forge.env')}
    if not files['yama.env'].is_file():
        raise Refused('Configure yama.env with first-time.sh before deploying')
    texts, values, additions = {}, {}, {name: {} for name in files}
    for name, path in files.items():
        if path.is_symlink():
            raise Refused('Server configuration must not be a symlink: ' + name)
        texts[name] = path.read_text() if path.exists() else ''
        values[name] = {}
        for line in texts[name].splitlines():
            key, separator, value = line.partition('=')
            # Compose accepts optional export prefixes; ignoring one could
            # replace an existing encryption key or shared credential.
            key = re.sub(r'^export\s+', '', key.strip())
            if separator and key and not key.startswith('#'):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                values[name][key] = value

    def add(name, key, value):
        if key not in values[name]:
            additions[name][key] = value

    for name, key, paired in (('advisor.env', 'ADVISOR_SECRET', 'YAMA_ADVISOR_SECRET'),
                              ('forge.env', 'FORGE_SECRET', 'YAMA_FORGE_SECRET')):
        local, server = values[name].get(key), values['yama.env'].get(paired)
        if local == '' or server == '':
            raise Refused('Empty paired secret requires explicit repair: ' + key)
        if local is not None and server is not None and local != server:
            raise Refused('Paired secrets differ; refusing to rotate ' + key)
        secret = local or server or secrets.token_hex(32)
        # Values already written in a file are preserved verbatim. Only a missing
        # partner is appended; reject characters unsafe for a new dotenv line.
        if (local is None or server is None) and not re.fullmatch(r'[A-Za-z0-9_\-]+', secret):
            raise Refused('Paired secret needs explicit dotenv repair: ' + key)
        add(name, key, secret)
        add('yama.env', paired, secret)
    for key, value in {
        'YAMA_ADVISOR_URL': 'http://yama-advisor:8790',
        'YAMA_ADVISOR_TOOLS_URL': 'http://yama:8787/mcp',
        'YAMA_FORGE_URL': 'http://yama-forge:8791',
        'YAMA_ADVISOR_KEY_SECRET': secrets.token_hex(32),
        'YAMA_ADVISOR_SUBSCRIPTION_EMAILS': values['yama.env'].get('YAMA_ADMIN_EMAILS', '').split(',')[0].strip(),
    }.items():
        add('yama.env', key, value)
    # Validate and plan all pairs before writing. If a write is interrupted,
    # the next run recovers the already-written partner instead of rotating it.
    for name in ('advisor.env', 'forge.env', 'yama.env'):
        path = files[name]
        if additions[name] or not path.exists():
            text = texts[name].rstrip('\n') + '\n'
            text += ''.join(key + '=' + value + '\n' for key, value in additions[name].items())
            with tempfile.NamedTemporaryFile(dir=directory, prefix='.' + name + '-', mode='w', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(text)
            try:
                temporary.chmod(0o600)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        path.chmod(0o600)


def existing_images():
    # A daemon error must fail closed; only a successful container listing can
    # establish that a first installation has no existing Yama container.
    names = set(run(['docker', 'ps', '--all', '--format', '{{.Names}}']).splitlines())
    return {service: inspect(service)['Image'] if service in names else None for service in SERVICES}


def export(repo, revision, destination, *paths):
    destination.mkdir()
    archive = destination.parent / (destination.name + '.tar')
    # A real archive file preserves both exit statuses; no shell pipeline hides
    # git archive failure behind a successful tar invocation.
    with archive.open('wb') as stream:
        run(['git', '-C', repo, 'archive', revision, *paths], output=stream)
    run(['tar', '-xf', archive, '-C', destination])
    archive.unlink()


def compose(config, env, *args):
    command = ['docker', 'compose', '--project-name', 'yama', '--project-directory', APP,
               '--file', config]
    override = APP / 'compose.override.yaml'
    if override.exists():
        command.extend(['--file', override])
    return run([*command, *args], env=env)


def inspect(service):
    return json.loads(run(['docker', 'inspect', service]))[0]


def healthy(images):
    for service, image in zip(SERVICES, images):
        container = inspect(service)
        if (container['Image'] != image or not container['State'].get('Running')
                or container['State'].get('Health', {}).get('Status') != 'healthy'):
            return False
    try:
        with urlopen('http://<saget-lan-address>:8099/api/health', timeout=5) as response:
            return response.status == 200 and response.read(32).strip() == b'ok'
    except (OSError, URLError):
        return False


def activate(source, revision, images, record, record_path, token):
    # Pin runtime image IDs, so unchanged sidecars keep the same Compose config
    # across main commits and are not restarted just because a tag changed.
    env = dict(os.environ, **dict(zip(IMAGE_VARS, images)))
    config = source / 'deploy/compose.yaml'
    resolved = json.loads(compose(config, env, 'config', '--format', 'json'))
    for service, image in zip(SERVICES, images):
        if resolved['services'][service]['image'] != image:
            raise Refused('Server override changes the release image for ' + service)
    # Bootstrap ran under the host lock; activation never rewrites env files.
    for name in ('yama.env', 'advisor.env', 'forge.env'):
        if not (APP / name).is_file():
            raise Refused('Missing server configuration: ' + name)
    previous = {'images': existing_images(),
                'compose': (APP / 'compose.yaml').read_text() if (APP / 'compose.yaml').exists() else None}
    if previous['images']['yama'] is None:
        service = resolved['services']['yama']
        settings = service.get('environment', {})
        mounts = [mount for mount in service.get('volumes', []) if mount.get('target') == '/data']
        if (settings.get('DATABASE_URL') or settings.get('YAMA_DATA_DIR', '/data') != '/data'
                or len(mounts) != 1 or mounts[0].get('type') != 'bind'
                or Path(mounts[0].get('source', '')).resolve() != (APP / 'data').resolve()):
            raise Refused('Custom database settings or data mount require a running backup source')
        if (any((APP / 'data').glob('*.db*'))
                or any((APP / 'data').glob('*.sqlite*'))):
            raise Refused('Existing database requires a running Yama backup before activation')
        # No database has ever been created. Existing database/WAL files never
        # take this path, including a rebuild whose container is missing.
        previous['backup'] = None
        record['fresh_install'] = True
        log('First installation: no existing Yama database to back up.')
    else:
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = 'yama-release-' + stamp + '-' + revision[:12] + '.db'
        (APP / 'data/backups').mkdir(exist_ok=True)
        os.chown(APP / 'data/backups', 99, 100)
        log('Backing up SQLite before activation…')
        run(['docker', 'exec', 'yama', 'yama-server', 'backup', '/data/backups/' + backup])
        if not (APP / 'data/backups' / backup).is_file():
            raise Refused('Backup command did not produce a database')
        previous['backup'] = str(APP / 'data/backups' / backup)
    # Keep every attempt's recovery inputs, including superseded backups.
    write_json(record_path.with_suffix('.previous.json'), previous)
    record.update(backup=previous['backup'], images=dict(zip(SERVICES, images)))
    write_json(record_path, record)
    with tempfile.NamedTemporaryFile(dir=APP, prefix='.compose.release-', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(config.read_bytes())
    try:
        # Resolve and validate Compose, inspect containers, and back up before
        # this last remote check. Superseded work must never replace live config.
        if not verify_ci(revision, token):
            record['status'] = 'superseded'
            log('Superseded before activation; running production was preserved.')
            return False
        write_json(BASE / 'previous.json', previous)
        record['status'] = 'activating'
        write_json(record_path, record)
        os.replace(temporary, APP / 'compose.yaml')
    finally:
        temporary.unlink(missing_ok=True)
    compose(APP / 'compose.yaml', env, 'up', '-d', '--no-deps', '--pull', 'never', *SERVICES)
    log('Waiting for all three release images and HTTP health…')
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if healthy(images):
            for service in SERVICES:
                run(['docker', 'tag', service + ':' + revision, service + ':latest'])
            return True
        time.sleep(5)
    raise Refused('Release health failed; previous images and pre-release backup are in previous.json. '
                  'Do not restore a database or reverse migrations automatically.')


def release(revision, token, check_only=False):
    global COMMAND_DEADLINE
    # Unready requests must not block the CI they need to become deployable.
    if not verify_ci(revision, token):
        log('Superseded: requested commit is no longer main; nothing deployed.')
        return 'superseded'
    if check_only:
        log('Host gate passed: current main has successful push CI. No deployment performed.')
        return 'ready'
    with release_lock():
        COMMAND_DEADLINE = time.monotonic() + RELEASE_SECONDS
        if not verify_ci(revision, token):
            log('Superseded: requested commit is no longer main; nothing deployed.')
            return 'superseded'
        history = BASE / 'history'
        history.mkdir(exist_ok=True)
        record_path = history / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
        # Authorized requests get a record before any fallible preparation,
        # including the dedicated Yama fetch and published Phase resolution.
        record = {'revision': revision, 'phase': None, 'status': 'preparing', 'stage': 'current'}
        write_json(record_path, record)
        try:
            current = BASE / 'current.json'
            if current.exists():
                saved = json.loads(current.read_text())
                if saved.get('revision') == revision and healthy([saved['images'][s] for s in SERVICES]):
                    record['status'] = 'already_healthy'
                    log('Already deployed and healthy at ' + revision + '; nothing restarted.')
                    return 'already_healthy'
            record['stage'] = 'checkout'
            write_json(record_path, record)
            repo = checkout(revision, token)
            if repo is None:
                record['status'] = 'superseded'
                log('Superseded during fetch; nothing deployed.')
                return 'superseded'
            record['stage'] = 'phase_checkout'
            write_json(record_path, record)
            phase, phase_rev = phase_checkout(repo)
            record.update(phase=phase_rev, stage='bootstrap')
            write_json(record_path, record)
            bootstrap_sidecars(APP)
            record.update(status='building', stage='export')
            write_json(record_path, record)
            builds = BASE / 'builds'
            builds.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=revision[:12] + '-', dir=builds) as scratch:
                scratch = Path(scratch)
                source = scratch / 'yama'
                export(repo, revision, source)
                export(phase, phase_rev, scratch / 'yama-phase', 'Cargo.toml', 'crates')
                forge_src = run(['git', '-C', repo, 'rev-parse', '--short=7', revision + ':forge-worker'])
                builds_args = (
                    ['--build-context', 'phase=' + str(scratch / 'yama-phase'),
                     '--build-arg', 'YAMA_GIT_SHA=' + revision, '--build-arg', 'YAMA_GIT_DIRTY=0'],
                    [], ['--build-arg', 'FORGE_WORKER_GIT_SHA=' + forge_src],
                )
                contexts = (source, source / 'advisor', source / 'forge-worker')
                dockerfiles = ('Dockerfile', 'Dockerfile.advisor', 'Dockerfile.forge-worker')
                for service, dockerfile, context, extra in zip(SERVICES, dockerfiles, contexts, builds_args):
                    record['stage'] = 'build:' + service
                    write_json(record_path, record)
                    build_log = record_path.with_suffix('.' + service + '.log')
                    log('Building ' + service + ':' + revision + ' (' + str(build_log) + ')…')
                    with build_log.open('w') as stream:
                        try:
                            run(['docker', 'build', '--file', source / 'deploy' / dockerfile,
                                 *extra, '--tag', service + ':' + revision, context], output=stream, timeout=5400)
                        except Refused:
                            log(build_log.read_text()[-6000:])
                            raise
                images = [run(['docker', 'image', 'inspect', s + ':' + revision,
                               '--format', '{{.Id}}']) for s in SERVICES]
                if not verify_ci(revision, token):
                    record['status'] = 'superseded'
                    log('Superseded during build; running production was preserved.')
                    return 'superseded'
                record['stage'] = 'activate'
                write_json(record_path, record)
                if not activate(source, revision, images, record, record_path, token):
                    return 'superseded'
                record.update(status='success', stage='complete')
                write_json(BASE / 'current.json', record)
                log('Production verified at ' + revision + '; HTTP health ok, all image IDs match.')
                return 'success'
        except Exception as error:
            record['status'] = 'failed'
            # Refused messages are deliberately credential-free. Never persist
            # arbitrary exception text from HTTP clients or other libraries.
            record['error'] = str(error) if isinstance(error, Refused) else type(error).__name__
            raise
        finally:
            write_json(record_path, record)


def arguments(argv, original=None):
    if original is not None:
        try:
            command = shlex.split(original)
        except ValueError:
            raise Refused('Invalid SSH command') from None
        if not command or command[0] != ENTRYPOINT:
            raise Refused('This key can only request a verified Yama release')
        argv = command[1:]
    if len(argv) != 2 or argv[0] not in ('deploy', 'check') or not re.fullmatch(r'[0-9a-f]{40}', argv[1]):
        raise Refused('Expected deploy|check followed by one full commit SHA')
    return argv[0], argv[1]


def read_token(stream):
    # GitHub installation tokens are opaque and now include JWT punctuation.
    # Bound transport size and reject whitespace/control characters; GitHub's
    # API, rather than a provider-specific spelling regex, authenticates them.
    token = stream.readline(MAX_TOKEN_LENGTH + 2).rstrip('\r\n')
    if not token or len(token) > MAX_TOKEN_LENGTH or any(not 0x21 <= ord(c) <= 0x7e for c in token):
        raise Refused('A GitHub read token is required on stdin')
    return token


def main():
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        mode, revision = arguments(sys.argv[1:], os.environ.get('SSH_ORIGINAL_COMMAND'))
        token = read_token(sys.stdin)
        result = release(revision, token, mode == 'check')
        log('YAMA_RELEASE_RESULT=' + result)
    except (Refused, OSError, KeyError, ValueError) as error:
        log('Release refused: ' + str(error))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
