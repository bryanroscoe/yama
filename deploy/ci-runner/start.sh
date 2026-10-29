#!/bin/bash
set -euo pipefail
if [ ! -x ./run.sh ]; then cp -a /home/runner/. .; fi
if [ "${1:-}" = configure ]; then
  registration_token=$(cat)
  exec ./config.sh --unattended --url https://github.com/bryanroscoe/yama \
    --name saget-yama-ci --labels yama-ci --work _work \
    --token "$registration_token"
fi
exec ./run.sh
