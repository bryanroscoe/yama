"""Yama's Forge worker: plays Lab games on Forge for the Yama server (server/src/lab/forge.rs).

Forge (https://github.com/Card-Forge/forge, GPL-3.0) runs as separate programs. With a Forge build that has
yama-serve.jar (Yama's builds from yama3 on), each slot keeps one long-lived JVM that plays its games one after
another (forge_serve.py); otherwise every game gets its own JVM, exactly as the deck lab's batch runner runs it
(forge_runner.py beside this file, a copy of commander-decks scripts/sim/forge_runner.py; keep the two in step).
Both read Forge's output with the same parser. No Forge code is in Yama. This worker is only an HTTP front
for that runner, on a private Docker network that only the yama container shares, behind a shared secret.

  GET  /health   "ok" (no secret: the container health check)
  GET  /status   {engine, card_data, runner, slots, running, profiles}
  POST /check    {names: [...]} -> {unknown: [...]}: the names Forge's card scripts don't know
  POST /play     {key, profile, spec, decks: [{id, cards: [{name, qty, commander}]}]} -> {result}: one game,
                 played to its end; the result line is in Yama's contract (play/src/lab.rs GameResult)

Every route but /health needs the header x-forge-secret (FORGE_SECRET). A /play with a key it is already
playing waits for that game; one it played recently gets the same answer, so a repeated request never plays a
game twice.

Settings (environment): FORGE_SECRET (required, 32+ characters), FORGE_DIR, FORGE_JAVA, FORGE_SLOTS (games at
once, default 2), FORGE_XMX (JVM heap, default 1536m), FORGE_JVM_CPUS (default 2), FORGE_PORT (default 8791),
FORGE_WORK (writable scratch, default /work), FORGE_INDEX (where the card index is kept, default the runner's),
FORGE_SERVE (0: one JVM per game even when the build has yama-serve.jar).
"""
import hashlib
import hmac
import json
import os
import re
import queue
import shutil
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forge_runner as F  # noqa: E402
import forge_serve as S  # noqa: E402

MAX_BODY = 2 * 1024 * 1024
MAX_NAMES = 5_000
CACHE_ANSWERS = 500
RESULT_KEYS = ("game", "seed", "difficulty", "decks", "first_seat", "winner", "placements", "eliminations", "end",
               "turns", "actions", "ms", "final_life", "engine", "card_data", "runner", "error")


def worker_label():
    """The runner stamp on every result: this worker's and the runner's source, hashed."""
    here = Path(__file__).resolve().parent
    h = hashlib.sha256()
    for name in ("worker.py", "forge_runner.py", "forge_serve.py", "common.py"):
        h.update((here / name).read_bytes())
    sha = os.environ.get("FORGE_WORKER_GIT_SHA", "").strip()
    return f"yama forge-worker {sha + '-' if sha else ''}{h.hexdigest()[:8]}"


def forge_seed(seed):
    """A seed Forge accepts: a non-negative Java long (the low 63 bits)."""
    return seed & ((1 << 63) - 1)


def safe(s):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", s)[:80]


class BadRequest(Exception):
    pass


class Worker:
    """Plays at most `slots` games at once: on long-lived JVMs (forge_serve) when the Forge build has
    yama-serve.jar and `serve` is on, else with forge_runner's Runner, one JVM per game."""

    def __init__(self, forge, names, slots=2, xmx="1536m", jvm_cpus=2, serve=True):
        self.forge = forge
        self.names = names
        self.slots = slots
        self.xmx = xmx
        self.jvm_cpus = jvm_cpus
        self.label = worker_label()
        self.sem = threading.BoundedSemaphore(slots)
        jar = S.serve_jar(forge) if serve else None
        self.jvms = None
        if jar is not None:
            self.jvms = queue.SimpleQueue()
            for n in range(slots):
                self.jvms.put(S.ServeJvm(forge, jar, n, xmx=xmx, jvm_cpus=jvm_cpus))
        self.lock = threading.Lock()
        self.playing = {}  # key -> threading.Event
        self.answers = OrderedDict()  # key -> result, newest last
        self.running = 0

    # ---- cards

    def resolve(self, name):
        """Forge's own name for a card name, or None. "A // B" falls back to its front face."""
        e = self.names.get(F.norm_name(name))
        if e is None and " // " in name:
            e = self.names.get(F.norm_name(name.split(" // ")[0]))
        return e[0] if e else None

    def check(self, names):
        return [n for n in names if self.resolve(n) is None]

    # ---- one game

    def status(self):
        return {"engine": self.forge.engine, "card_data": self.forge.card_data, "runner": self.label,
                "slots": self.slots, "running": self.running, "profiles": list(F.PROFILES)}

    def play(self, req):
        key = req.get("key")
        if not isinstance(key, str) or not key or len(key) > 300:
            raise BadRequest("key is required")
        with self.lock:
            if key in self.answers:
                return self.answers[key]
            waiting = self.playing.get(key)
            if waiting is None:
                self.playing[key] = threading.Event()
        if waiting is not None:
            waiting.wait()
            with self.lock:
                if key in self.answers:
                    return self.answers[key]
            raise BadRequest("the game with that key failed; ask again")
        try:
            result = self._play(req)
            with self.lock:
                self.answers[key] = result
                while len(self.answers) > CACHE_ANSWERS:
                    self.answers.popitem(last=False)
            return result
        finally:
            with self.lock:
                self.playing.pop(key).set()

    def _job(self, req):
        spec = req.get("spec")
        if not isinstance(spec, dict):
            raise BadRequest("spec is required")
        for k in ("game", "seed", "decks", "max_turns", "max_seconds"):
            if k not in spec:
                raise BadRequest(f"spec.{k} is required")
        if not isinstance(spec["decks"], list) or not 2 <= len(spec["decks"]) <= 6:
            raise BadRequest("spec.decks: 2 to 6 decks")
        profile = req.get("profile") or "Default"
        if profile not in F.PROFILES:
            raise BadRequest(f"profile: one of {', '.join(F.PROFILES)}")
        decks = req.get("decks")
        if not isinstance(decks, list) or [d.get("id") for d in decks] != spec["decks"]:
            raise BadRequest("decks must match spec.decks, seat by seat")
        # Yama's seeds are 64-bit. Forge reads `-s` as a Java long, and a negative one ("-s -24…") as another
        # flag, so the game never starts: Forge gets the seed's low 63 bits (the same for both games of a pod).
        job = {"game": str(spec["game"]), "seed": forge_seed(int(spec["seed"])), "decks": list(spec["decks"]),
               "max_turns": int(spec["max_turns"]), "max_seconds": int(spec["max_seconds"])}
        return job, profile, decks

    def _play(self, req):
        job, profile, decks = self._job(req)
        seed = int(req["spec"]["seed"])
        res = F.new_result(job, self.forge, self.label, profile)
        res["actions"] = 0
        res["seed"] = seed
        # Forge's names for every card; a deck with a card Forge doesn't know isn't played.
        by_id, problems = {}, []
        folder = f"yama/{safe(req['key'])}"
        for d in decks:
            commanders, main, unknown = [], [], []
            for c in d.get("cards", []):
                name, qty = str(c.get("name", "")), int(c.get("qty", 0))
                if qty <= 0:
                    continue
                canon = self.resolve(name)
                if canon is None:
                    unknown.append(name)
                    continue
                (commanders if c.get("commander") else main).append((qty, canon))
            if unknown:
                problems.append(f"{d['id']}: not in Forge {self.forge.version}: {'; '.join(unknown)}")
                continue
            if not commanders:
                problems.append(f"{d['id']}: no commander")
                continue
            rel = f"{folder}/{len(by_id)}-{safe(d['id'])}.dck"
            out = Path(F.DECK_CACHE) / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(F.dck_text(d["id"], commanders, main), encoding="utf-8")
            by_id[d["id"]] = F.Deck(d["id"], commanders, main, rel)
        try:
            if problems:
                res["error"] = f"{F.DECK_ERRORS} " + " | ".join(problems)
                return self._shape(res)
            with self.sem:
                with self.lock:
                    self.running += 1
                try:
                    played = self._run(job, by_id, profile)
                finally:
                    with self.lock:
                        self.running -= 1
            played["actions"] = 0
            played["seed"] = seed  # the result names the game Yama scheduled
            return self._shape(played)
        finally:
            shutil.rmtree(Path(F.DECK_CACHE) / folder, ignore_errors=True)

    def _run(self, job, by_id, profile):
        if self.jvms is not None:
            jvm = self.jvms.get()
            try:
                return S.play(jvm, job, self.forge, by_id, self.label, profile)
            finally:
                self.jvms.put(jvm)
        args = SimpleNamespace(threads=1, profile=profile, xmx=self.xmx, jvm_cpus=self.jvm_cpus, max_seconds=None,
                               keep_logs="none", keep_work=False, logs_dir=None)
        runner = F.Runner(args, self.forge, by_id, self.label)
        try:
            return runner.play(job)[0]
        finally:
            runner.cleanup()

    def warm(self):
        """Start every long-lived JVM now (in the background), so the first games don't wait for Forge to load."""
        if self.jvms is None:
            return
        def start(jvm):
            try:
                jvm.start()
            except Exception as e:  # the game that gets this JVM starts it again and reports the failure
                print(f"forge-worker: JVM {jvm.n} didn't start: {e}", file=sys.stderr)
                jvm.stop()
            finally:
                self.jvms.put(jvm)
        for _ in range(self.slots):
            jvm = self.jvms.get()
            threading.Thread(target=start, args=(jvm,), daemon=True).start()

    @staticmethod
    def _shape(res):
        """The result line in Yama's contract: every field, actions a number."""
        out = {k: res.get(k) for k in RESULT_KEYS}
        out["actions"] = out["actions"] or 0
        out["placements"] = out["placements"] or []
        out["eliminations"] = out["eliminations"] or []
        out["final_life"] = out["final_life"] or []
        out["turns"] = out["turns"] or 0
        out["ms"] = int(out["ms"] or 0)
        return out


def make_handler(worker, secret):
    class Handler(BaseHTTPRequestHandler):
        server_version = "yama-forge-worker"

        def log_message(self, fmt, *args):  # one short line per request, never bodies
            sys.stderr.write(f"forge-worker: {self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            given = self.headers.get("x-forge-secret", "")
            return hmac.compare_digest(given.encode(), secret.encode())

        def _body(self):
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BODY:
                raise BadRequest("request too large")
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError as e:
                raise BadRequest(f"not JSON: {e}")

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True})
            if not self._authorized():
                return self._send(401, {"error": "wrong or missing x-forge-secret"})
            if self.path == "/status":
                return self._send(200, worker.status())
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"error": "wrong or missing x-forge-secret"})
            try:
                body = self._body()
                if self.path == "/check":
                    names = body.get("names")
                    if not isinstance(names, list) or len(names) > MAX_NAMES:
                        raise BadRequest(f"names: a list of at most {MAX_NAMES}")
                    return self._send(200, {"unknown": worker.check([str(n) for n in names])})
                if self.path == "/play":
                    return self._send(200, {"result": worker.play(body)})
                return self._send(404, {"error": "not found"})
            except BadRequest as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:  # the game failed in the runner: say so, Yama retries or writes it off
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def main():
    secret = os.environ.get("FORGE_SECRET", "").strip()
    if len(secret) < 32:
        raise SystemExit("FORGE_SECRET must be set (32 or more characters)")
    work = Path(os.environ.get("FORGE_WORK", "/work"))
    # Scratch (deck files, one Forge user dir per game) goes to the writable work dir; the card index can be
    # prebuilt in the image (FORGE_INDEX).
    F.DECK_CACHE = work / "forge-decks"
    F.WORK_ROOT = work / "forge-work"
    F.LOG_ROOT = work / "forge-logs"
    if os.environ.get("FORGE_INDEX"):
        F.CACHE = Path(os.environ["FORGE_INDEX"])
    forge = F.Forge(F.default_forge_dir(), F.default_java())
    major = F.java_major(forge.java)
    if major is not None and major >= 20:
        print(f"forge-worker: warning: Java {major}; Forge's AI time-outs need Java 17 (see forge_runner.py)", file=sys.stderr)
    names = F.card_index(forge)
    worker = Worker(forge, names, slots=int(os.environ.get("FORGE_SLOTS", "2")), xmx=os.environ.get("FORGE_XMX", "1536m"),
                    jvm_cpus=int(os.environ.get("FORGE_JVM_CPUS", "2")), serve=os.environ.get("FORGE_SERVE", "1") != "0")
    worker.warm()
    port = int(os.environ.get("FORGE_PORT", "8791"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(worker, secret))
    server.daemon_threads = True
    mode = "long-lived JVMs" if worker.jvms is not None else "one JVM per game"
    print(f"forge-worker: {forge.engine}, {len(names)} card names, {worker.slots} slots ({mode}), listening on {port}",
          file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
