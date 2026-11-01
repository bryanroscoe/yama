#!/usr/bin/env python3
"""Put the relay's flood guard in front of the Worker: a Cloudflare rate limiting rule on
relay.yama.ing, so a flood is blocked before it counts against the Worker's daily requests
(the in-Worker limit in src/index.ts can't do that). Part of deploying the relay (README).

The Free plan allows one rate limiting rule, per IP, counted over 10 seconds, blocking for 10
seconds. This sets the zone's rate limiting phase to exactly that rule. If the phase already has
other rules it stops and lists them, unless --replace says to drop them.

Usage (token with Zone WAF edit on yama.ing, as for wrangler):
  CLOUDFLARE_API_TOKEN=... python3 -I relay/waf-rule.py [--replace] [--dry-run]
"""

import json
import os
import sys
import urllib.error
import urllib.request

ZONE = "yama.ing"
HOST = "relay.yama.ing"  # for messages; the rule matches the relay's paths (see rule())
DESCRIPTION = "yama relay: connections per address"
# Requests per IP per 10 s at one Cloudflare location. The Free plan's 100,000 requests a day are
# shared with the WebSocket messages the Worker's MESSAGES limit allows (wrangler.toml), so the two
# are budgeted together: at most 4 per 10 s is about 34,600 a day, plus at most 57,600 for
# messages, about 92,000 from one address held at both limits all day. A table is a few phones
# connecting once and reconnecting now and then with backoff; one briefly over waits 10 s.
# The Free plan's one rule counts by IP only and can match only the path, which is the same for a
# host and its guests (the role is in the query), so a table's phones share this allowance, host
# included: guests spread their reconnects (GuestTable.tsx), and a host blocked for a moment gets
# in on its next try. Giving the host its own share here needs a paid plan.
REQUESTS_PER_10S = 4
API = "https://api.cloudflare.com/client/v4"


def call(method: str, path: str, token: str, body: object | None = None) -> dict:
    req = urllib.request.Request(f"{API}{path}", method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        payload = e.read().decode(errors="replace")
        if method == "GET" and e.code == 404:
            return {"success": False, "status": 404, "body": payload}
        sys.exit(f"{method} {path}: HTTP {e.code}: {payload}")


def rule() -> dict:
    return {
        "description": DESCRIPTION,
        # The Free plan's rule can match only the path (and verified bots), not the host. The
        # relay's paths are its own: the app's pages under /table/ never end in /ws, and Yama's
        # own relay is under /api/. Other paths on relay.yama.ing still reach the Worker uncounted
        # here (it answers 404 at once); moving the Worker to a route on /table/* and /health only
        # would close that.
        "expression": '(http.request.uri.path wildcard "/table/*/ws" or http.request.uri.path eq "/health")',
        "action": "block",
        "ratelimit": {
            "characteristics": ["cf.colo.id", "ip.src"],
            "period": 10,
            "requests_per_period": REQUESTS_PER_10S,
            "mitigation_timeout": 10,
        },
        "enabled": True,
    }


def main() -> None:
    replace = "--replace" in sys.argv
    dry = "--dry-run" in sys.argv
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        sys.exit("set CLOUDFLARE_API_TOKEN (relay/README.md, Deploy)")
    zones = call("GET", f"/zones?name={ZONE}", token)
    if not zones.get("result"):
        sys.exit(f"zone {ZONE} not found for this token")
    zone_id = zones["result"][0]["id"]
    phase = f"/zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint"
    current = call("GET", phase, token)
    rules = (current.get("result") or {}).get("rules", []) if current.get("success") else []
    others = [r for r in rules if r.get("description") != DESCRIPTION]
    if others and not replace:
        listed = "\n".join(f"  - {r.get('description') or r.get('id')}: {r.get('expression')}" for r in others)
        sys.exit(f"the zone already has other rate limiting rules (the Free plan allows one):\n{listed}\nRe-run with --replace to drop them.")
    body = {"rules": [rule()]}
    # No rate limiting rules on the zone yet: its ruleset for the phase has to be created first
    # (Cloudflare answers 404 for the entry point); after that it's updated in place.
    first = current.get("status") == 404
    if first:
        body = {"name": "default", "kind": "zone", "phase": "http_ratelimit", **body}
    if dry:
        print(("POST /rulesets" if first else "PUT entrypoint") + "\n" + json.dumps(body, indent=2))
        return
    result = call("POST", f"/zones/{zone_id}/rulesets", token, body) if first else call("PUT", phase, token, body)
    if not result.get("success"):
        sys.exit(f"Cloudflare refused the rule: {json.dumps(result.get('errors'))}")
    print(f"rate limiting rule set on {HOST}: {REQUESTS_PER_10S} requests per 10 s per IP, then blocked for 10 s")


if __name__ == "__main__":
    main()
