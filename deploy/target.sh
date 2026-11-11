# shellcheck shell=sh
# Sourced by the deploy scripts that reach saget: sets HOST to user@host. Values already in the
# environment win, then this checkout's deploy/.env (gitignored; copy deploy/.env.example), then
# this machine's file, so a fresh worktree needs no setup: YAMA_DEPLOY_ENV, else
# ${XDG_CONFIG_HOME:-$HOME/.config}/yama/deploy.env. Within a file the first occurrence wins.
# The caller sets DEPLOY_DIR to this directory first. Never put saget's address in a tracked file.
yama_read_target_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      YAMA_DEPLOY_HOST=*|YAMA_DEPLOY_USER=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    eval "[ -n \"\${$key:-}\" ] || $key=\$value"
  done < "$1"
}
yama_read_target_env "$DEPLOY_DIR/.env"
yama_read_target_env "${YAMA_DEPLOY_ENV:-${XDG_CONFIG_HOME:-${HOME:-}/.config}/yama/deploy.env}"
YAMA_DEPLOY_USER=${YAMA_DEPLOY_USER:-root}
case "${YAMA_DEPLOY_HOST:-}" in
  '')
    echo "YAMA_DEPLOY_HOST is not set. Put saget's address in ~/.config/yama/deploy.env (every checkout on this machine reads it) or in deploy/.env (see deploy/.env.example), or export it." >&2
    exit 1 ;;
  -*|*[!A-Za-z0-9.:_-]*)
    echo "YAMA_DEPLOY_HOST must be a plain host name or address." >&2
    exit 1 ;;
esac
case "$YAMA_DEPLOY_USER" in
  -*|*[!A-Za-z0-9._-]*)
    echo "YAMA_DEPLOY_USER must be a plain user name." >&2
    exit 1 ;;
esac
# shellcheck disable=SC2034  # used by the scripts that source this file
HOST=$YAMA_DEPLOY_USER@$YAMA_DEPLOY_HOST
