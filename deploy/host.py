#!/usr/bin/env python3
"""Server-owned release gate, installed outside all runner-writable mounts.

A caller supplies an exact main SHA and an ephemeral GitHub read token on stdin.
Only published main with successful push CI reaches Docker. Importing is inert.
"""
import base64
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
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
BACKUP_RETENTION_SECONDS = 48 * 60 * 60
BACKUP_KEEP_NEWEST = 3


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


def push_ci(revision, token):
    """The latest push CI run for a main revision, or None."""
    runs = api('actions/workflows/ci.yml/runs?event=push&branch=main&head_sha='
               + revision + '&per_page=1', token)['workflow_runs']
    return runs[0] if runs else None


def passed(run, revision):
    expected = {'head_sha': revision, 'head_branch': 'main', 'event': 'push',
                'status': 'completed', 'conclusion': 'success'}
    return (run is not None and all(run.get(k) == v for k, v in expected.items())
            and run.get('path', '').split('@')[0] == '.github/workflows/ci.yml'
            and run.get('head_repository', {}).get('full_name') == REPO)


def ahead(base, head, token):
    """True when head is base or a descendant of it on GitHub."""
    return base == head or api('compare/' + base + '...' + head, token).get('status') == 'ahead'


def verify_ci(revision, token):
    main = api('git/ref/heads/main', token)['object']['sha']
    # Main may have moved on while this request waited, built or activated. A commit still on
    # main deploys, and newer commits' requests deploy after it. Requiring the exact tip starved
    # every release, and so did yielding to a newer main commit whose push CI passed (Bryan,
    # 2026-11-02): that CI passes in about a minute, so every merge discarded the ~20-minute
    # build in progress. Yielding before building isn't safe either: the deploy workflow keeps
    # one pending run, and any CI completion on main (a manual run, say) can replace the newer
    # commit's request with one that skips its jobs. At most one extra build runs instead.
    # A commit off main never deploys; release() separately refuses anything older than
    # production, and the release lock keeps production from changing during a build.
    if main != revision and not ahead(revision, main, token):
        log('Superseded: ' + revision + ' is no longer on main.')
        return False
    run = push_ci(revision, token)
    if run is None:
        raise Refused('No push CI exists for this main revision')
    if not passed(run, revision):
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

    def contains(older, newer):
        # A nonzero exit is "no": 1 when not an ancestor, 128 when the commit was never fetched
        # with main (so it isn't on main). A timeout or the release deadline is a failed
        # release, never a quiet supersession.
        try:
            run(['git', '-C', repo, 'merge-base', '--is-ancestor', older, newer])
            return True
        except Refused as error:
            if str(error).startswith('Command failed: '):
                return False
            raise

    # The revision must be on main (main may have moved past it), and never older than what
    # this checkout last deployed: fast-forward only.
    if not contains(revision, 'origin/main'):
        return None
    try:
        head = run(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'])
    except Refused:
        head = ''  # a new checkout has no commit yet
    if head and head != revision and not contains(head, revision):
        return None
    run(['git', '-C', repo, 'merge', '--ff-only', revision])
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
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    # Rebasing the fork's main keeps the previous line under an archive/* tag; a pin on
    # either is published, so the deployed engine stays releasable until Yama bumps it.
    run(['git', '-C', phase, 'fetch', '--no-tags', '--prune', 'https://github.com/bryanroscoe/yama-phase.git',
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


def health_url(container):
    # The yama container's published port, wherever server-local Compose
    # configuration binds it; an all-interfaces bind is checked on loopback.
    for binding in (container.get('NetworkSettings', {}).get('Ports') or {}).get('8787/tcp') or []:
        address, port = binding.get('HostIp') or '0.0.0.0', binding.get('HostPort')
        if ':' in address or not port:
            continue
        if address == '0.0.0.0':
            address = '127.0.0.1'
        return f'http://{address}:{port}/api/health'
    return None


def healthy(images):
    url = None
    for service, image in zip(SERVICES, images):
        container = inspect(service)
        if (container['Image'] != image or not container['State'].get('Running')
                or container['State'].get('Health', {}).get('Status') != 'healthy'):
            return False
        if service == 'yama':
            url = health_url(container)
    if url is None:
        return False
    try:
        with urlopen(url, timeout=5) as response:
            return response.status == 200 and response.read(32).strip() == b'ok'
    except (OSError, URLError):
        return False


def preflight_engine_data(source, service, image):
    """Verify the effective Compose data paths before touching running services.

    Only bind-mounted files can be verified here. An unsupported mount layout
    fails closed instead of letting HTTP health hide an unavailable engine.
    """
    # The separately installed gate must still release the old main while the
    # upgrade PR is pending. Never skip preflight for a historical-runtime build.
    if not (source / 'deploy/engine-data.json').exists() and not (source / 'runtime/historical.json').exists():
        return
    manifest = json.loads((source / 'deploy/engine-data.json').read_text())
    historical = json.loads((source / 'runtime/historical.json').read_text())
    settings = service.get('environment', {})
    data_dir = settings.get('YAMA_DATA_DIR', '/data')
    current = settings.get('YAMA_ENGINE_CARD_DATA', str(Path(data_dir) / manifest['current_file']))
    previous = settings.get('YAMA_HISTORICAL_CARD_DATA',
                            str(Path(current).with_name(manifest['historical_file'])))
    required = [('current', current, manifest['current_sha256']),
                ('historical', previous, historical['card_sha256'])]
    if (source / 'runtime/v0119/historical.json').exists():
        v0119 = json.loads((source / 'runtime/v0119/historical.json').read_text())
        configured = settings.get('YAMA_V0119_CARD_DATA',
                                  str(Path(current).with_name(manifest['historical_v0119_file'])))
        required.append(('historical v0.119', configured, v0119['card_sha256']))
    verified = []
    for label, configured, expected in required:
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise Refused('Invalid ' + label + ' engine data hash in release manifest')
        path = Path(configured)
        if not path.is_absolute() or '..' in path.parts:
            raise Refused('Engine data preflight requires absolute container paths')
        mounts = [m for m in service.get('volumes', [])
                  if path == Path(m['target']) or Path(m['target']) in path.parents]
        # A nested mount shadows its parent, including a named volume or tmpfs.
        mounts.sort(key=lambda m: len(Path(m['target']).parts), reverse=True)
        if not mounts or mounts[0].get('type') != 'bind':
            raise Refused('Engine data preflight requires a bind mount for ' + label + ' data')
        for temporary in service.get('tmpfs', []):
            target = Path(temporary.split(':', 1)[0])
            if path == target or target in path.parents:
                raise Refused('Engine data path is shadowed by tmpfs')
        mount = mounts[0]
        host_path = Path(mount['source']) / path.relative_to(mount['target'])
        # Container symlinks need container-relative resolution. Do not follow
        # them on the host, where an absolute link could name different bytes.
        boundary = Path(mount['source'])
        if boundary.is_symlink() or any(p.is_symlink() for p in (host_path, *host_path.parents)):
            raise Refused('Engine data preflight does not accept symlink paths')
        digest = hashlib.sha256()
        try:
            if not host_path.is_file():
                raise Refused('Missing or non-regular ' + label + ' engine data; stage the pinned artifact before release')
            with host_path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
        except OSError:
            raise Refused('Missing or unreadable ' + label + ' engine data; stage the pinned artifact before release') from None
        if digest.hexdigest() != expected:
            raise Refused('Wrong ' + label + ' engine data bytes; running production was preserved')
        verified.append((str(path), str(host_path), expected))
    verify_engine_image(service, image, verified)


def verify_engine_image(service, image, artifacts):
    """Probe only the candidate image and two read-only files, without DB/secrets."""
    binary = '/usr/local/bin/historical-runtime'
    binding = '/usr/local/share/yama/historical-runtime.sha256'
    if service.get('environment', {}).get('YAMA_HISTORICAL_RUNTIME', binary) != binary:
        raise Refused('Historical runtime override needs independently verified packaging')
    if service.get('environment', {}).get('YAMA_HISTORICAL_RUNTIME_DIGEST', binding) != binding:
        raise Refused('Historical runtime digest override needs independently verified packaging')
    protected = [binary, binding]
    if len(artifacts) == 3:
        for key, expected in [('YAMA_V0119_RUNTIME', '/usr/local/bin/historical-runtime-v0119'),
                              ('YAMA_V0119_RUNTIME_DIGEST', '/usr/local/share/yama/historical-runtime-v0119.sha256')]:
            if service.get('environment', {}).get(key, expected) != expected:
                raise Refused('v0.119 runtime override needs independently verified packaging')
            protected.append(expected)
    overlays = [Path(m['target']) for m in service.get('volumes', [])]
    overlays += [Path(m.split(':', 1)[0]) for m in service.get('tmpfs', [])]
    if any(Path(p) == target or target in Path(p).parents
           for target in overlays for p in protected):
        raise Refused('Server mounts shadow the packaged historical runtime or its digest')
    # Numeric container IDs must refer to the same filesystem IDs checked below.
    # Remapped/rootless configurations need a different, namespace-aware probe.
    security = json.loads(run(['docker', 'info', '--format', '{{json .SecurityOptions}}']))
    namespace = service.get('userns_mode')
    if namespace not in (None, 'host') or any('rootless' in opt or ('userns' in opt and namespace != 'host') for opt in security):
        raise Refused('Engine directory preflight requires an unremapped runtime identity')
    validate_engine_directories(service, artifacts)
    name = 'yama-engine-preflight-' + secrets.token_hex(12)
    args = ['docker', 'run', '--rm', '--name', name, '--network', 'none',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--user', service.get('user', '99:100'), '--pids-limit', '64', '--memory', '2g',
            '--cpus', '1', '--entrypoint', '/bin/sh']
    if namespace == 'host':
        args += ['--userns', 'host']
    for group in service.get('group_add', []):
        args += ['--group-add', str(group)]
    for container_path, host_path, _ in artifacts:
        if any(c in container_path + host_path for c in (',', '\n', '\r')):
            raise Refused('Engine data paths cannot contain Docker mount delimiters')
        if container_path in protected:
            raise Refused('Engine data path overlaps the packaged runtime')
        args += ['--mount', 'type=bind,source=' + host_path + ',target=' + container_path + ',readonly']
    # Values are positional shell arguments, never interpolated shell source.
    # The image owns the digest binding; server mounts cannot replace it.
    script = '''set -eu
actual="$(sha256sum -- "$1")"
test "${actual%% *}" = "$2"
read -r expected ignored < /usr/local/share/yama/historical-runtime.sha256
actual="$(sha256sum -- "$3")"
test "${actual%% *}" = "$expected"
exec "$3" --verify-data "$4"
'''
    values = [artifacts[0][0], artifacts[0][2], binary, artifacts[1][0]]
    if len(artifacts) == 3:
        script = script.replace('exec "$3" --verify-data "$4"', '\n'.join([
            '"$3" --verify-data "$4"',
            'read -r expected ignored < /usr/local/share/yama/historical-runtime-v0119.sha256',
            'actual="$(sha256sum -- /usr/local/bin/historical-runtime-v0119)"',
            'test "${actual%% *}" = "$expected"',
            'exec /usr/local/bin/historical-runtime-v0119 --verify-data "$5"']))
        values.append(artifacts[2][0])
    args += [image, '-c', script, 'engine-preflight', *values]
    try:
        run(args, timeout=180)
    finally:
        # A timed-out Docker client does not guarantee its container stopped.
        # Remove only our uniquely named probe, also when --rm already removed it.
        subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, check=False)


def validate_engine_directories(service, artifacts):
    """Check directory metadata omitted by the isolated per-file mounts.

    Check only container-visible directories: host ancestors above a bind root
    are irrelevant. ACLs and named IDs require a richer probe and fail closed.
    File read access is still checked by the real candidate process.
    """
    identity = str(service.get('user', '99:100'))
    extra = [str(g) for g in service.get('group_add', [])]
    if not re.fullmatch(r'[0-9]+:[0-9]+', identity) or any(not re.fullmatch(r'[0-9]+', g) for g in extra):
        raise Refused('Engine directory preflight requires numeric runtime UID and groups')
    uid, gid = map(int, identity.split(':'))
    groups = {gid, *(int(g) for g in extra)}
    if not hasattr(os, 'listxattr'):
        raise Refused('Engine directory preflight requires Linux extended-attribute support')
    checked = set()
    for container_path, _, _ in artifacts:
        for directory in Path(container_path).parents:
            mounts = [m for m in service.get('volumes', [])
                      if directory == Path(m['target']) or Path(m['target']) in directory.parents]
            if not mounts:
                continue  # Image-owned directories are traversed by the image probe.
            mount = max(mounts, key=lambda m: len(Path(m['target']).parts))
            if mount.get('type') != 'bind':
                raise Refused('Cannot verify engine directory access through a non-bind mount')
            path = Path(mount['source']) / directory.relative_to(mount['target'])
            if path in checked:
                continue
            checked.add(path)
            if path.is_symlink() or not path.is_dir():
                raise Refused('Engine directory must be a real directory')
            if 'system.posix_acl_access' in os.listxattr(path):
                raise Refused('Engine directory ACL requires a namespace-aware access probe')
            metadata = path.stat()
            execute = 0o100 if metadata.st_uid == uid else 0o010 if metadata.st_gid in groups else 0o001
            if not metadata.st_mode & execute:
                raise Refused('Runtime user cannot traverse the engine data directory; production was preserved')


def historical_build_context(source, scratch, repo, phase):
    # Install this host before merging the runtime change. Existing main has no
    # historical worker, and continues to build through the previous context.
    if not (source / 'runtime/historical.json').exists():
        return []
    run(['python3', source / 'runtime/build-historical.py', scratch / 'historical',
         '--prepare-only', '--yama-repo', repo, '--phase-repo', phase])
    contexts = ['--build-context', 'historical-source=' + str(scratch / 'historical')]
    if (source / 'runtime/v0119/historical.json').exists():
        run(['python3', source / 'runtime/build-v0119.py', scratch / 'historical-v0119',
             '--prepare-only', '--yama-repo', repo, '--phase-repo', phase])
        contexts += ['--build-context', 'historical-v0119-source=' + str(scratch / 'historical-v0119')]
    return contexts


def verify_board_image(source, service, image):
    """Read only the exact image's board, with no host data, credentials or network."""
    if not (source / 'deploy/build-board-client.sh').is_file():
        return
    board = Path('/app/board')
    if service.get('environment', {}).get('YAMA_BOARD_DIST', str(board)) != str(board):
        raise Refused('Board directory override would bypass the packaged client')
    overlays = [Path(os.path.normpath(m['target'])) for m in service.get('volumes', [])]
    overlays += [Path(os.path.normpath(m.split(':', 1)[0])) for m in service.get('tmpfs', [])]
    if any(target == board or target in board.parents or board in target.parents for target in overlays):
        raise Refused('Server mounts shadow the packaged board')
    pin = (source / 'deploy/phase-rev').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', pin):
        raise Refused('Board preflight requires the full Phase pin')
    name = 'yama-board-preflight-' + secrets.token_hex(12)
    args = ['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--user', service.get('user', '99:100'), '--pids-limit', '32', '--memory', '128m',
            '--cpus', '1', '--entrypoint', '/bin/sh']
    if service.get('userns_mode') == 'host':
        args += ['--userns', 'host']
    script = '''set -eu
test -r /app/board/index.html
test -s /app/board/index.html
expected=$(printf '{"phase_revision":"%s"}' "$1")
test "$(cat /app/board/yama-board.json)" = "$expected"
'''
    try:
        run([*args, image, '-c', script, 'board-preflight', pin], timeout=60)
    finally:
        subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, check=False)


def activate(source, revision, images, record, record_path, token):
    # Pin runtime image IDs, so unchanged sidecars keep the same Compose config
    # across main commits and are not restarted just because a tag changed.
    env = dict(os.environ, **dict(zip(IMAGE_VARS, images)))
    config = source / 'deploy/compose.yaml'
    resolved = json.loads(compose(config, env, 'config', '--format', 'json'))
    for service, image in zip(SERVICES, images):
        if resolved['services'][service]['image'] != image:
            raise Refused('Server override changes the release image for ' + service)
    preflight_engine_data(source, resolved['services']['yama'], images[0])
    verify_board_image(source, resolved['services']['yama'], images[0])
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
    # Each attempt keeps its own recovery inputs. prune_backups keeps the copies that
    # previous.json and current.json name, so a rollback never loses its backup.
    write_json(record_path.with_suffix('.previous.json'), previous)
    record.update(backup=previous['backup'], images=dict(zip(SERVICES, images)))
    write_json(record_path, record)
    with tempfile.NamedTemporaryFile(dir=APP, prefix='.compose.release-', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(config.read_bytes())
    try:
        # Resolve and validate Compose, inspect containers, and back up before
        # this last remote check. A commit that left main must never replace live config.
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


def rollback_backup(name):
    """The backup file name that BASE/<name> records, or None."""
    value = json.loads((BASE / name).read_text()).get('backup')
    if value is not None and not isinstance(value, str):
        raise Refused(name + ' names an invalid backup path')
    return Path(value).name if value else None


@contextmanager
def real_directory(path, dir_fd=None):
    """Open a directory by descriptor without following a symlink at its last component.

    Holding the descriptor pins the directory itself: a rename or symlink swap of the path
    afterwards cannot redirect what is later listed or deleted through it.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refused('Backup directory must be a real directory') from None
        raise
    try:
        yield fd
    finally:
        os.close(fd)


def prune_backups(release_backup, now=None):
    """Delete old deploy copies from data/backups. Call only after a healthy activation.

    Candidates are regular *.db files directly in that directory. Symlinks, subdirectories
    and other files are never touched. Kept: the newest few by mtime, anything younger than
    the window, this release's copy, and the copies named by the rollback inputs.
    """
    now = time.time() if now is None else now
    with ExitStack() as held:
        try:
            data = held.enter_context(real_directory(APP / 'data'))
            backups = held.enter_context(real_directory('backups', dir_fd=data))
        except FileNotFoundError:
            return  # first installation: no data folder or no deploy copies yet
        # Read the rollback inputs before deleting anything: if one is unreadable, keep every copy.
        kept = {rollback_backup('previous.json'), rollback_backup('current.json')}
        if release_backup:
            kept.add(Path(release_backup).name)
        copies = []
        # Scan and delete through the held descriptor, never through the path again.
        with os.scandir(backups) as entries:
            for entry in entries:
                if entry.name.startswith('.') or not entry.name.endswith('.db') or not entry.is_file(follow_symlinks=False):
                    continue
                status = entry.stat(follow_symlinks=False)
                copies.append((status.st_mtime, entry.name, status.st_size))
        copies.sort(reverse=True)
        kept.update(name for _, name, _ in copies[:BACKUP_KEEP_NEWEST])
        freed = removed = 0
        for modified, name, size in copies:
            if name in kept or now - modified < BACKUP_RETENTION_SECONDS:
                continue
            os.unlink(name, dir_fd=backups)
            freed += size
            removed += 1
            log('Removed old backup ' + name + ' (' + str(size) + ' bytes)')
        log('Backup retention freed ' + str(freed) + ' bytes; ' + str(len(copies) - removed) + ' copies kept')


def retain_backups(release_backup):
    # Housekeeping after a verified release: a failure is logged, never recorded as a failed release.
    try:
        prune_backups(release_backup)
    except Refused as error:
        log('Backup retention skipped: ' + str(error))
    except Exception as error:
        # Only the type: library messages are not printed or persisted here.
        log('Backup retention failed: ' + type(error).__name__)


def release(revision, token, check_only=False):
    global COMMAND_DEADLINE
    # Unready requests must not block the CI they need to become deployable.
    if not verify_ci(revision, token):
        log('Nothing deployed.')
        return 'superseded'
    if check_only:
        log('Host gate passed: current main has successful push CI. No deployment performed.')
        return 'ready'
    with release_lock():
        COMMAND_DEADLINE = time.monotonic() + RELEASE_SECONDS
        if not verify_ci(revision, token):
            log('Nothing deployed.')
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
                # Main may have moved on (verify_ci), but production never goes back.
                if saved.get('revision') and not ahead(saved['revision'], revision, token):
                    record['status'] = 'superseded'
                    log('Superseded: production already runs a newer main commit; nothing deployed.')
                    return 'superseded'
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
                if (source / 'deploy/build-board-client.sh').is_file():
                    # The board and native runtime come from the same published pin.
                    # Include build configuration/protocol records; omit Git and generated data.
                    export(phase, phase_rev, scratch / 'yama-phase',
                           'Cargo.toml', 'Cargo.lock', '.cargo', 'crates', 'client', 'scripts',
                           'protocol', 'data-files.json', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE')
                else:
                    # Installing this reviewed entrypoint before the upgrade must
                    # still support the previous main's native-only image.
                    export(phase, phase_rev, scratch / 'yama-phase', 'Cargo.toml', 'crates')
                # Export the historical Yama adapter AND its Phase source; old JSON alone
                # cannot preserve replay behavior. A missing artifact fails before build/deploy.
                historical_context = historical_build_context(source, scratch, repo, phase)
                forge_src = run(['git', '-C', repo, 'rev-parse', '--short=7', revision + ':forge-worker'])
                builds_args = (
                    ['--build-context', 'phase=' + str(scratch / 'yama-phase'),
                     *historical_context,
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
                retain_backups(record.get('backup'))
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
