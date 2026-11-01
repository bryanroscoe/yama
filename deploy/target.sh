# shellcheck shell=sh
# Sourced by the deploy scripts that reach saget: sets HOST to user@host from the environment
# or from deploy/.env (gitignored; copy deploy/.env.example). Values already in the environment
# win, then the first occurrence in the file. The caller sets DEPLOY_DIR to this directory first. Never put saget's address in a
# tracked file.
if [ -f "$DEPLOY_DIR/.env" ]; then
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
  done < "$DEPLOY_DIR/.env"
fi
YAMA_DEPLOY_USER=${YAMA_DEPLOY_USER:-root}
case "${YAMA_DEPLOY_HOST:-}" in
  '')
    echo "YAMA_DEPLOY_HOST is not set. Copy deploy/.env.example to deploy/.env and fill in saget's address, or export it." >&2
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
