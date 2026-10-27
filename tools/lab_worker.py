#!/usr/bin/env python3
"""Phase worker and execution controls. Standard-library-only, outbound HTTPS, one pod at a time."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Worker API redirects are refused")


class API:
    def __init__(self, server, token_file, allow_http=False):
        parsed = urllib.parse.urlsplit(server)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Use a server origin without credentials, query or fragment")
        if parsed.scheme != "https" and not (allow_http and parsed.scheme == "http"):
            raise ValueError("HTTPS is required; --allow-http is for explicit local testing")
        if not parsed.hostname:
            raise ValueError("Missing server host")
        self.server = server.rstrip("/")
        self.token = Path(token_file).read_text().strip()
        if not self.token or "\n" in self.token:
            raise ValueError("Invalid token file")
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body, allow_nan=False).encode()
        request = urllib.request.Request(self.server + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if error.code == 400:
                try:
                    required = json.loads(error.read(65536)).get("required_github_minutes")
                    if isinstance(required, int) and required > 0:
                        raise ValueError(f"This execution needs at least {required} GitHub work minutes") from error
                except (json.JSONDecodeError, AttributeError):
                    pass
            raise
        with response:
            content = response.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise ValueError("Oversized API response")
            return json.loads(content)

    def download(self, kind, destination, expected):
        request = urllib.request.Request(self.server + "/api/lab/workers/runtime/" + kind,
            headers={"Authorization": "Bearer " + self.token})
        destination = Path(destination)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        digest, count = hashlib.sha256(), 0
        try:
            with self.opener.open(request, timeout=60) as response, private_file(temporary) as output:
                while block := response.read(65536):
                    count += len(block)
                    if count > expected["bytes"]:
                        raise ValueError("Runtime download exceeds declared size")
                    digest.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            if count != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
                raise ValueError("Runtime download SHA-256 mismatch")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


def private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb")


def save(path, body):
    temporary = path.with_suffix(".tmp")
    with private_file(temporary) as output:
        output.write(json.dumps(body, allow_nan=False).encode())
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def host_platform():
    system = {"Darwin": "macos", "Linux": "linux"}.get(platform.system())
    machine = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}.get(platform.machine())
    if not system or not machine:
        raise ValueError("The worker currently supports Linux and macOS on x64 or ARM64")
    return system + "-" + machine


def prepare(api, args):
    started = time.monotonic()
    remote = api.request("/api/lab/workers/runtime")
    if remote.get("protocol") != 1:
        raise ValueError("Unsupported worker protocol")
    root = Path(args.work_dir).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    cards = Path(args.card_data).resolve() if args.card_data else root / ("card-data-" + remote["build"]["card_data"] + ".json")
    if not cards.exists() or digest(cards) != remote["card_data"]["sha256"]:
        if args.card_data:
            raise ValueError("Configured card data differs from the server export")
        api.download("card-data", cards, remote["card_data"])
    binary = Path(args.binary).resolve() if args.binary else root / "yama-server"
    if not args.binary:
        if host_platform() != remote["platform"]:
            raise ValueError("Build yama-server natively and pass --binary on this platform")
        if not binary.exists() or digest(binary) != remote["binary"]["sha256"]:
            api.download("binary", binary, remote["binary"])
            binary.chmod(0o700)
    info = json.loads(subprocess.check_output([str(binary), "lab-worker-info", str(cards)],
        env={}, timeout=60))
    offered, expected = info["build"], remote["build"]
    if offered["engine"] != expected["engine"] or offered["card_data"] != expected["card_data"] or \
        offered["runner"].split("/")[0] != expected["runner"].split("/")[0]:
        raise ValueError("Worker binary source/engine differs from the server; rebuild it")
    offered["runner"] += "/worker-rss-" + str(args.max_game_mb) + "m-v1"
    return root, binary, cards, offered, time.monotonic() - started


def free_memory_mb():
    if platform.system() == "Linux":
        fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        return int(fields["MemAvailable"].split()[0]) / 1024
    # macOS: reclaimable inactive pages plus free pages; the caller can set a larger reserve.
    text = subprocess.check_output(["/usr/bin/vm_stat"], text=True, timeout=5)
    page_size = int(text.split("page size of ")[1].split()[0])
    fields = dict(line.rstrip(".").split(":", 1) for line in text.splitlines()[1:] if ":" in line)
    return sum(int(fields.get(name, "0").strip()) for name in ("Pages free", "Pages inactive")) * page_size / 1024**2


def ready(args):
    return os.getloadavg()[0] <= args.max_load and free_memory_mb() >= args.min_free_mb


def process_rss(pid):
    try:
        if platform.system() == "Linux":
            fields = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)
            return int(fields.get("VmRSS", "0 kB").split()[0]) * 1024
        return int(subprocess.check_output(["/bin/ps", "-o", "rss=", "-p", str(pid)],
            timeout=5, env={}, stderr=subprocess.DEVNULL).strip() or "0") * 1024
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0  # Process may have exited between wait4 and the sample.


def failure(request, build, why, milliseconds):
    spec = request["spec"]
    return dict(game=spec["game"], seed=spec["seed"], decks=spec["decks"], difficulty=spec["difficulty"],
        first_seat=None, winner=None, placements=[], eliminations=[], end="error", turns=0, actions=0,
        ms=milliseconds, final_life=[], engine=build["engine"], card_data=build["card_data"],
        runner=build["runner"], error=why, **({"pilots": spec["pilots"]} if spec.get("pilots") is not None else {}))


def play(api, binary, cards, request, lease, max_game_mb=2048):
    """No credentials in the child. wait4 measures this game's peak RSS, not the worker's lifetime."""
    started = time.monotonic()
    renewed = started
    next_heartbeat = started + lease["heartbeat_seconds"]
    next_memory_check = started
    deadline = started + request["spec"]["max_seconds"] * 4 + 30
    with tempfile.TemporaryFile() as source, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as log:
        source.write(json.dumps(request).encode())
        source.seek(0)
        child = subprocess.Popen([str(binary), "lab-game", str(cards)], stdin=source, stdout=output,
            stderr=log, env={}, start_new_session=True)
        usage, code = None, None
        try:
            while code is None:
                pid, status, measured = os.wait4(child.pid, os.WNOHANG)
                if pid:
                    code = os.waitstatus_to_exitcode(status)
                    child.returncode = code
                    usage = measured
                    break
                tick = time.monotonic()
                if tick >= next_memory_check:
                    if process_rss(child.pid) > max_game_mb * 1024**2:
                        raise TimeoutError("Worker RSS memory limit exceeded; game is unscored")
                    next_memory_check = tick + 2
                if tick >= deadline or tick - renewed > 150:
                    raise TimeoutError("Worker deadline or heartbeat safety limit")
                if tick >= next_heartbeat:
                    try:
                        api.request("/api/lab/workers/leases/" + lease["id"] + "/heartbeat", {})
                        renewed = tick
                    except (urllib.error.URLError, TimeoutError):
                        # HTTP 401/409 means revoked/cancelled/stale; stop immediately.
                        error = sys.exc_info()[1]
                        if isinstance(error, urllib.error.HTTPError) and error.code < 500:
                            raise
                    next_heartbeat = tick + lease["heartbeat_seconds"]
                time.sleep(0.2)
        except TimeoutError as error:
            result = failure(request, lease["build"], str(error), int((time.monotonic() - started) * 1000))
        finally:
            if code is None:
                os.killpg(child.pid, signal.SIGKILL)
                _, status, usage = os.wait4(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
        if code is not None:
            output.seek(0)
            raw = output.read(1024 * 1024 + 1)
            if code == 0 and len(raw) <= 1024 * 1024:
                result = json.loads(raw)
                # Explicitly label the extra parent-enforced resource policy.
                result["runner"] = lease["build"]["runner"]
            else:
                result = failure(request, lease["build"], "Isolated game exited with code " + str(code),
                    int((time.monotonic() - started) * 1000))
        rss = int(usage.ru_maxrss) * (1 if platform.system() == "Darwin" else 1024)
        return result, rss


def upload(api, path, state):
    body = {key: state[key] for key in ("results", "wall_seconds", "peak_rss_bytes", "setup_seconds")}
    try:
        api.request("/api/lab/workers/leases/" + state["lease"]["id"] + "/results", body)
    except urllib.error.HTTPError as error:
        if error.code == 409:
            # The lease was reassigned. Keep diagnostics, but never overwrite the newer attempt.
            path.rename(path.with_suffix(".stale"))
            print("Preserved stale lease results:", path.with_suffix(".stale"), file=sys.stderr)
            return
        raise
    path.unlink()


def work(api, args):
    root, binary, cards, build, setup = prepare(api, args)
    identity = root / ("worker-id-" + hashlib.sha256(api.token.encode()).hexdigest()[:16])
    if not identity.exists():
        with private_file(identity) as output:
            output.write(str(uuid.uuid4()).encode())
    worker_id = identity.read_text().strip()
    # Retry durable completed uploads before accepting more work. Partial pods are returned whole.
    for path in sorted(root.glob("*.pending")):
        state = json.loads(path.read_text())
        if len(state["results"]) == len(state["lease"]["requests"]):
            upload(api, path, state)
        else:
            try:
                api.request("/api/lab/workers/leases/" + state["lease"]["id"] + "/release", {})
            except urllib.error.HTTPError as error:
                if error.code != 409:
                    raise
            path.rename(path.with_suffix(".partial"))
    completed, idle_since = 0, time.monotonic()
    while completed < args.max_jobs or args.continuous:
        lease = api.request("/api/lab/workers/claim", dict(worker_id=worker_id, build=build, ready=ready(args), execution_id=args.execution))
        if lease is None:
            if not args.continuous and time.monotonic() - idle_since >= args.idle_seconds:
                break
            time.sleep(10)
            continue
        uuid.UUID(lease["id"])
        path = root / (lease["id"] + ".pending")
        state = dict(lease=lease, results=[], wall_seconds=0, peak_rss_bytes=0, setup_seconds=setup)
        save(path, state)
        for request in lease["requests"]:
            start = time.monotonic()
            result, rss = play(api, binary, cards, request, lease, args.max_game_mb)
            state["results"].append(result)
            state["wall_seconds"] += time.monotonic() - start
            state["peak_rss_bytes"] = max(rss, state["peak_rss_bytes"])
            save(path, state)
        # A lost response leaves the file in place; the next invocation retries the exact upload.
        upload(api, path, state)
        completed += 1
        setup = 0
        idle_since = time.monotonic()
        print("Completed leased pod", completed, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--token-file", required=True, help="Worker key for work; session token for execution/report")
    parser.add_argument("--allow-http", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)
    worker = commands.add_parser("work")
    worker.add_argument("--binary", help="Native yama-server; Linux may download the server binary")
    worker.add_argument("--execution", help="Claim only this execution UUID")
    worker.add_argument("--card-data", help="Matching export; otherwise downloaded and hash-checked")
    worker.add_argument("--work-dir", required=True)
    worker.add_argument("--max-jobs", type=int, default=1)
    worker.add_argument("--idle-seconds", type=int, default=60)
    worker.add_argument("--continuous", action="store_true")
    worker.add_argument("--max-load", type=float, default=max(1, (os.cpu_count() or 1) * 0.75))
    worker.add_argument("--min-free-mb", type=int, default=2560)
    worker.add_argument("--max-game-mb", type=int, default=2048)
    execution = commands.add_parser("execution")
    execution.add_argument("--id", default=None, help="Persist this UUID to retry creation safely")
    execution.add_argument("--experiment", required=True)
    execution.add_argument("--target", choices=["auto", "saget", "laptop", "github"], default="auto")
    execution.add_argument("--compare", nargs="+", choices=["saget", "laptop", "github"])
    execution.add_argument("--sample-units", type=int, default=3)
    execution.add_argument("--github-minutes", type=int, default=0)
    report = commands.add_parser("report")
    report.add_argument("id")
    report.add_argument("--json", action="store_true", help="Include individual game results and timings")
    cancel = commands.add_parser("cancel", help="Cancel an execution, preserving completed results")
    cancel.add_argument("id")
    budget = commands.add_parser("budget", help="Increase an execution's total GitHub work allowance")
    budget.add_argument("id")
    budget.add_argument("--minutes", type=int, required=True)
    budget.add_argument("--op-id", default=None)
    key = commands.add_parser("key", help="Create an owner-scoped worker key using a session token")
    key.add_argument("--target", choices=["saget", "laptop", "github"], required=True)
    key.add_argument("--output", required=True)
    key.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    api = API(args.server, args.token_file, args.allow_http)
    if args.command == "work":
        if args.max_jobs < 1 or args.idle_seconds < 0 or args.min_free_mb < 0 or args.max_game_mb < 1 or not math.isfinite(args.max_load):
            parser.error("Invalid worker capacity or job limits")
        if args.execution:
            uuid.UUID(args.execution)
        work(api, args)
    elif args.command == "execution":
        body = dict(id=args.id or str(uuid.uuid4()), experiment_id=args.experiment, target=args.target,
            comparison=bool(args.compare), targets=args.compare or [], sample_units=args.sample_units,
            github_minutes=args.github_minutes)
        print("Execution id:", body["id"], file=sys.stderr)
        print(json.dumps(api.request("/api/lab/executions", body), indent=2))
    elif args.command == "key":
        output = Path(args.output).resolve()
        if output.exists():
            raise ValueError("Key output already exists")
        created = api.request("/api/me/tokens", {"name": "Lab worker on " + args.target,
            "scope": "lab:worker:" + args.target, "days": args.days})
        with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as destination:
            destination.write(created["token"])
        print("Worker key saved to", output)
    elif args.command == "budget":
        uuid.UUID(args.id)
        operation = args.op_id or str(uuid.uuid4())
        uuid.UUID(operation)
        print("Operation id:", operation, file=sys.stderr)
        print(json.dumps(api.request("/api/lab/executions/" + args.id + "/budget",
            {"id": operation, "github_minutes": args.minutes}), indent=2))
    elif args.command == "cancel":
        uuid.UUID(args.id)
        print(json.dumps(api.request("/api/lab/executions/" + args.id + "/cancel", {}), indent=2))
    else:
        uuid.UUID(args.id)
        report = api.request("/api/lab/executions/" + args.id)
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            if report["cancelled_at"]:
                print("Cancelled:", report["cancel_reason"], "at", report["cancelled_at"])
            print("Target      Games   Games/min   Game seconds   Setup seconds   Peak MiB   Unscored")
            for target, measured in sorted(report["targets"].items()):
                pace = measured["games_per_minute"]
                pace = "unknown" if pace is None else format(pace, ".2f")
                print(f"{target:10} {measured['games']:6} {pace:>11} {measured['wall_seconds']:14.1f} "
                    f"{measured['setup_seconds']:15.1f} {measured['peak_rss_bytes'] / 1024**2:10.1f} {measured['unscored_games']:10}")
            print("Pod comparisons:", report["agreement"]["matched"], "agree,", report["agreement"]["mismatched"], "differ")
            print("Jobs complete:", sum(job["finished_at"] is not None for job in report["jobs"]), "/", len(report["jobs"]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not dump request bodies, deck lists, token values or response bodies to CI logs.
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
