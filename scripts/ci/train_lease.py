#!/usr/bin/env python3
"""The release coordinator's lease (docs/release-trains.md).

One thread at a time may coordinate release trains. The lease is a small JSON file,
COORDINATOR.json, in the trains folder; every read-decide-write on it happens under an exclusive
lock on COORDINATOR.lock beside it, so two threads can't both take it and a thread whose lease
lapsed can't merge after another took over. The lock is an OS file lock: it goes when the process
does, so there is nothing stale to clean up.

    train_lease.py status
    train_lease.py acquire --thread ID [--title TEXT] [--hours N]
    train_lease.py renew   --thread ID [--hours N]
    train_lease.py release --thread ID
    train_lease.py run     --thread ID -- COMMAND...   # COMMAND runs only while ID holds the lease

Exit 0 on success, 1 when another thread holds the lease (or `run` isn't authorized), 3 from
`status` when nobody does. `run` exits with COMMAND's status and holds the lock while it runs.
The folder is $YAMA_TRAINS_DIR, default ~/Developer/.agent-tasks/yama-release-trains.
"""

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

MAX_HOURS = 24
STAMP = "%Y-%m-%dT%H:%M:%SZ"


def folder():
    return Path(os.environ.get("YAMA_TRAINS_DIR") or Path.home() / "Developer/.agent-tasks/yama-release-trains")


@contextlib.contextmanager
def locked(root):
    root.mkdir(parents=True, exist_ok=True)
    with open(root / "COORDINATOR.lock", "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def read(root):
    try:
        lease = json.loads((root / "COORDINATOR.json").read_text())
    except (OSError, ValueError):
        return None
    return lease if isinstance(lease, dict) else None


def write(root, lease):
    scratch = root / f"COORDINATOR.json.{os.getpid()}"
    scratch.write_text(json.dumps(lease, indent=2) + "\n")
    os.replace(scratch, root / "COORDINATOR.json")


def holder(lease, now):
    """The thread holding a live lease, else None: a missing, inactive, malformed or lapsed file."""
    if not lease or lease.get("active") is not True:
        return None
    try:
        until = dt.datetime.strptime(str(lease.get("lease_until")), STAMP).replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    thread = lease.get("coordinator_thread")
    return thread if until > now and isinstance(thread, str) and thread else None


def grant(root, thread, hours, now, old=None, title=None):
    lease = {
        "active": True,
        "coordinator_thread": thread,
        "title": title or (old or {}).get("title") or "",
        "since": (old or {}).get("since") if (old or {}).get("coordinator_thread") == thread else None,
        "lease_until": (now + dt.timedelta(hours=hours)).strftime(STAMP),
        "note": "Only the coordinator merges to main while this lease is live. docs/release-trains.md",
    }
    lease["since"] = lease["since"] or now.strftime(STAMP)
    write(root, lease)
    return lease


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=["status", "acquire", "renew", "release", "run"])
    parser.add_argument("--thread")
    parser.add_argument("--title")
    parser.add_argument("--hours", type=float, default=MAX_HOURS)
    argv = list(sys.argv[1:] if argv is None else argv)
    # Everything after "--" is the command for `run`; argparse only sees what comes before it.
    command = argv[argv.index("--") + 1:] if "--" in argv else []
    args = parser.parse_args(argv[: argv.index("--")] if "--" in argv else argv)
    if args.action != "status" and not args.thread:
        parser.error("--thread is required")
    if not 0 < args.hours <= MAX_HOURS:
        parser.error(f"--hours is more than 0 and at most {MAX_HOURS}")
    if args.action == "run" and not command:
        parser.error("run needs a command after --")
    root = folder()
    with locked(root):
        now = now or dt.datetime.now(dt.timezone.utc)
        lease = read(root)
        held_by = holder(lease, now)
        if args.action == "status":
            print(json.dumps({"coordinator_thread": held_by, "lease_until": (lease or {}).get("lease_until") if held_by else None}))
            return 0 if held_by else 3
        if held_by and held_by != args.thread:
            print(f"the lease is held by {held_by} until {lease.get('lease_until')}", file=sys.stderr)
            return 1
        if args.action in ("acquire", "renew"):
            if args.action == "renew" and (lease or {}).get("coordinator_thread") != args.thread:
                print("nothing to renew: this thread is not the coordinator on file (use acquire)", file=sys.stderr)
                return 1
            print(json.dumps(grant(root, args.thread, args.hours, now, old=lease, title=args.title)))
            return 0
        if args.action == "release":
            if (lease or {}).get("coordinator_thread") == args.thread:
                write(root, {**lease, "active": False})
            return 0
        # run: only for the thread whose lease is live, and nobody can take the lease meanwhile.
        if held_by != args.thread:
            print("not authorized: this thread does not hold a live lease", file=sys.stderr)
            return 1
        return subprocess.run(command).returncode


if __name__ == "__main__":
    sys.exit(main())
