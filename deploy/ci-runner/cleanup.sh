#!/bin/bash
set -euo pipefail
# Hooks support shell scripts; bound cleanup independently of the job timeout.
exec timeout 120s python3 /usr/local/lib/yama-ci-cleanup.py
