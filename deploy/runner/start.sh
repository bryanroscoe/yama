#!/bin/bash
set -euo pipefail
# Keep registration and automatic runner updates through container replacement.
# This directory contains only runner state; it has no production mounts.
if [ ! -x ./run.sh ]; then cp -a /home/runner/. .; fi
if [ "${1:-}" = configure ]; then
  registration_token=$(cat)
  exec ./config.sh --unattended --url https://github.com/bryanroscoe/yama \
    --name saget-yama-production --labels yama-production --work _work \
    --token "$registration_token"
fi
exec ./run.sh
