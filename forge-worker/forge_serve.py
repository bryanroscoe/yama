"""Long-lived Forge JVMs for the worker: each plays games one after another instead of one JVM per game.

Forge's card database loads once per JVM and the JIT stays warm, which roughly halves the CPU a game costs. The
Java side is `yama-serve.jar` in Yama's Forge build (forge-referee `serve/`, GPL like Forge, so it isn't in this
repo). It sets every game up exactly as `forge sim` does and puts back the process-wide state a fresh JVM would
start the game with, so a game plays move for move as it does in its own JVM, and its output is the same text;
forge_runner.parse_game reads it.

  stdin:  game \t seed \t capSeconds \t outFile \t profile \t deckDir \t deck1.dck ...
  stdout: "ready" once the card database is loaded, then "done \t game \t ok|timeout|error \t heapUsedMB" per game
          (the heap after a full GC; "error": an exception escaped the game's setup, its trace in the game's stderr).
          Anything else on stdout (a Forge thread printing between games) is ignored.

A JVM is replaced after a game that hit Forge's own time limit (Forge only interrupts that game's thread, which may
still be running) or whose setup threw, after RECYCLE_GAMES games, when its heap is past RECYCLE_HEAP of -Xmx after a game, and when it
dies or is killed. The game that was playing when a JVM died or was killed gets an error result, as in one-JVM-per-
game mode.

Card scripts load eagerly, as in `forge sim`. Forge's lazy loading (LOAD_CARD_SCRIPTS_LAZILY) changes games here: a
game would depend on which cards earlier games in the same JVM had already loaded (checked 2026-10-30 on yama2: 7 of 9
games played differently from their first mulligan). Startup cost doesn't matter for a JVM that plays many games.
"""
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forge_runner as F  # noqa: E402

SERVE_JAR = "yama-serve.jar"
SERVE_CLASS = "yama.serve.Serve"
# Seconds to load the card database (about 5 s normally). A JVM that died is restarted inside the next game's /play,
# so this plus the game's cap plus forge_runner.KILL_GRACE must stay under the server's wait (cap + PLAY_GRACE, 300 s
# in server/src/lab/forge.rs).
START_TIMEOUT = 100
RECYCLE_GAMES = 200
RECYCLE_HEAP = 0.8
ERR_TAIL = 3
STOPPING = "Stopping slow match as draw"  # what Forge prints when a game hits its time limit


def serve_jar(forge):
    """The build's yama-serve.jar, or None for a Forge build without one."""
    d = getattr(forge, "dir", None)
    p = Path(d) / SERVE_JAR if d else None
    return p if p is not None and p.is_file() else None


def xmx_mb(xmx):
    """-Xmx value in MiB ("1536m", "2g", "2048k" or bytes)."""
    s = str(xmx).strip().lower()
    mult = {"k": 1 / 1024, "m": 1, "g": 1024}.get(s[-1:])
    return int(float(s[:-1]) * mult) if mult else int(s) // 2**20


class JvmFailed(Exception):
    """The JVM died, or was killed, before it answered."""


def _kill(proc):
    if os.name == "posix":
        F.kill_group(proc)
    else:
        proc.kill()


class ServeJvm:
    """One long-lived Forge JVM, started on first use and replaced as the module docstring says."""

    def __init__(self, forge, jar, n, xmx="1536m", jvm_cpus=2):
        self.forge, self.jar, self.n = forge, Path(jar), n
        self.xmx, self.jvm_cpus = xmx, jvm_cpus
        self.proc = None
        self.dir = None
        self.games = 0
        self.started = 0  # JVMs started over this slot's life (for the status page and tests)

    # ---- process

    def _cmd(self):
        cmd = [self.forge.java, f"-Xmx{self.xmx}", "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true"]
        if self.jvm_cpus:
            cmd.append(f"-XX:ActiveProcessorCount={self.jvm_cpus}")
        return cmd + ["-cp", f"{self.forge.jar}{os.pathsep}{self.jar}", SERVE_CLASS]

    def start(self):
        F.WORK_ROOT.mkdir(parents=True, exist_ok=True)
        w = Path(tempfile.mkdtemp(prefix=f"s{self.n}-", dir=F.WORK_ROOT))
        (w / "userdata").mkdir()
        (w / "cache").mkdir()
        (w / "res").symlink_to(self.forge.res)
        (w / "forge.profile.properties").write_text(f"userDir={w}/userdata/\ncacheDir={w}/cache/\n")
        self.dir = w
        self.err = open(w / "jvm.err", "wb")
        try:
            self.proc = subprocess.Popen(self._cmd(), cwd=w, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=self.err, start_new_session=os.name == "posix", text=True,
                                         encoding="utf-8", errors="replace", bufsize=1)
        except OSError as e:
            self.err.close()
            self.stop()
            raise JvmFailed(f"Forge didn't start: {e}") from None
        self.replies = queue.Queue()
        threading.Thread(target=self._read, args=(self.proc, self.replies), daemon=True).start()
        self.games = 0
        self.started += 1
        reply = self._reply(START_TIMEOUT, "killed: Forge hadn't loaded its cards {timeout}s after it started")
        if reply != "ready":
            raise JvmFailed(f"Forge didn't start: {reply}")

    @staticmethod
    def _read(proc, replies):
        try:
            for line in proc.stdout:
                if line.startswith(("ready", "done\t")):
                    replies.put(line.rstrip("\n"))
        finally:
            replies.put(None)

    def _reply(self, timeout, late="killed: Forge still running {timeout}s after the game was sent"):
        """The JVM's next reply line; JvmFailed if it exits or doesn't answer in time (then it's stopped)."""
        try:
            reply = self.replies.get(timeout=timeout)
        except queue.Empty:
            self.stop()
            raise JvmFailed(late.format(timeout=timeout)) from None
        if reply is None:
            code = self.proc.wait()
            tail = self._err_tail()
            self.stop()
            raise JvmFailed(f"Forge exited (exit {code})" + (f" | stderr: {tail}" if tail else ""))
        return reply

    def _err_tail(self):
        try:
            self.err.flush()
            lines = (self.dir / "jvm.err").read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return ""
        lines = [x for x in lines if x.strip() and "was not assigned to any set" not in x]
        return " / ".join(lines[-ERR_TAIL:])[:400]

    def stop(self):
        if self.proc is not None:
            _kill(self.proc)
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
            for f in (self.proc.stdin, self.proc.stdout):
                try:
                    f.close()
                except OSError:
                    pass
            self.err.close()
            self.proc = None
        if self.dir is not None:
            shutil.rmtree(self.dir, ignore_errors=True)
            self.dir = None

    @property
    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    # ---- one game

    def run(self, game, seed, cap, profile, deck_rels, timeout):
        """Play one game; (stdout text, stderr text, "ok" or "timeout"). JvmFailed if the JVM died or was killed."""
        if not self.alive:
            self.stop()
            self.start()
        out = self.dir / "game.out"
        fields = [game, str(seed), str(cap), str(out), profile, str(F.DECK_CACHE), *deck_rels]
        if any("\t" in x or "\n" in x for x in fields):
            raise ValueError("job fields can't hold tabs or newlines")
        try:
            self.proc.stdin.write("\t".join(fields) + "\n")
            self.proc.stdin.flush()
        except OSError:
            pass  # it died: _reply says how
        reply = self._reply(timeout).split("\t")
        if len(reply) < 4 or reply[1] != game:
            self.stop()
            raise JvmFailed(f"Forge answered for another game: {reply!r}")
        self.games += 1
        status, heap = reply[2], int(reply[3]) if reply[3].isdigit() else 0
        texts = []
        for p in (out, Path(f"{out}.err")):
            try:
                texts.append(p.read_text(encoding="utf-8", errors="replace"))
                p.unlink()
            except OSError:
                texts.append("")
        if status != "ok" or self.games >= RECYCLE_GAMES or heap > RECYCLE_HEAP * xmx_mb(self.xmx):
            self.stop()
        return texts[0], texts[1], status


def play(jvm, job, forge, decks, runner_label, profile, max_seconds=None):
    """One game on a ServeJvm, as forge_runner.Runner.play plays it in its own JVM; returns the result dict."""
    res = F.new_result(job, forge, runner_label, profile)
    ds = [decks[d] for d in job["decks"]]
    n = len(ds)
    rotation, _predicted = F.seat_rotation(job["seed"], [d.library for d in ds])
    order = [ds[(p - rotation) % n] for p in range(n)]
    cap = max_seconds or int(job["max_seconds"])
    t0 = time.monotonic()
    try:
        stdout, stderr, status = jvm.run(job["game"], F.java_long(job["seed"]), cap, profile,
                                         [d.dck_rel for d in order], cap + F.KILL_GRACE)
    except JvmFailed as e:
        res["error"] = str(e)
        res["ms"] = int((time.monotonic() - t0) * 1000)
        return res
    wall = time.monotonic() - t0
    if status == "timeout" and STOPPING not in stdout.splitlines():
        stdout += f"\n{STOPPING}\n"  # the JVM says Forge hit its time limit: score it as forge_runner would (time_cap)
    info = F.parse_game(stdout, stderr, n, rotation, int(job["max_turns"]))
    for k in ("first_seat", "winner", "placements", "eliminations", "end", "turns", "final_life"):
        if k in info:
            res[k] = info[k]
    res["ms"] = info.get("ms") if info.get("ms") is not None else int(wall * 1000)
    if info.get("unsupported"):
        res["end"], res["placements"], res["winner"] = "error", [], None
        res["error"] = f"{F.DECK_ERRORS} Forge {forge.version} doesn't support: " + "; ".join(info["unsupported"])
    elif info.get("error"):
        res["end"], res["placements"], res["winner"] = "error", [], None
        res["error"] = info["error"]
        tail = [x for x in stderr.splitlines() if x.strip() and "was not assigned to any set" not in x]
        if tail and "no game outcome" in res["error"]:
            res["error"] += " | stderr: " + " / ".join(tail[-3:])[:400]
    return res
