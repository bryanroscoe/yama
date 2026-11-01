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
HOST = "relay.yama.ing"
DESCRIPTION = "yama relay: connections per address"
# Requests per IP per 10 s at one Cloudflare location. A table is a few phones that connect once
# and reconnect now and then; a flood is hundreds.
REQUESTS_PER_10S = 50
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
        "expression": f'(http.host eq "{HOST}")',
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
    if dry:
        print(json.dumps(body, indent=2))
        return
    result = call("PUT", phase, token, body)
    if not result.get("success"):
        sys.exit(f"Cloudflare refused the rule: {json.dumps(result.get('errors'))}")
    print(f"rate limiting rule set on {HOST}: {REQUESTS_PER_10S} requests per 10 s per IP, then blocked for 10 s")


if __name__ == "__main__":
    main()
