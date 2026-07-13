#!/bin/sh
# deploy-broker.sh — safe broker deploy for the VPS, with health-gated rollback.
#
#   ./deploy-broker.sh            deploy master
#   ./deploy-broker.sh <ref>      deploy a branch / tag / sha
#   ./deploy-broker.sh --rollback restore the previous broker and restart
#
# Copy this to the VPS once. Assumes the running container ("dating-relay")
# loads the broker from $TARGET (bind-mounted), and the broker answers
# /health on $PORT.
set -eu

REPO="sarvalabs-adithya/agent-dating"
TARGET="${TARGET:-/root/dating-broker.mjs}"
CONTAINER="${CONTAINER:-dating-relay}"
PORT="${PORT:-8787}"

health() { curl -fsS -m 5 "http://localhost:${PORT}/health" >/dev/null 2>&1; }

restart_and_check() {
  docker restart "$CONTAINER" >/dev/null
  i=0
  while [ $i -lt 15 ]; do
    sleep 2
    if health; then echo "health: ok"; return 0; fi
    i=$((i + 1))
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$TARGET.prev" ] || { echo "no $TARGET.prev to roll back to"; exit 1; }
  cp "$TARGET.prev" "$TARGET"
  restart_and_check || { echo "ROLLBACK FAILED HEALTH TOO — investigate by hand"; exit 1; }
  echo "rolled back."
  exit 0
fi

REF="${1:-master}"
NEW="$(mktemp)"
echo "fetching relay/broker.mjs @ $REF ..."
curl -fsSL "https://raw.githubusercontent.com/${REPO}/${REF}/relay/broker.mjs?$(date +%s)" -o "$NEW"

# Syntax-check before touching anything (host node if present, else container's).
if command -v node >/dev/null 2>&1; then
  node --check "$NEW"
elif docker exec "$CONTAINER" node -e "1" >/dev/null 2>&1; then
  docker cp "$NEW" "$CONTAINER":/tmp/broker.check.mjs
  docker exec "$CONTAINER" node --check /tmp/broker.check.mjs
else
  echo "warn: no node found for syntax check — proceeding without it"
fi

[ -f "$TARGET" ] && cp "$TARGET" "$TARGET.prev"
mv "$NEW" "$TARGET"

if restart_and_check; then
  echo "deployed $REF."
else
  echo "health check FAILED — rolling back to previous broker"
  [ -f "$TARGET.prev" ] && cp "$TARGET.prev" "$TARGET" && docker restart "$CONTAINER" >/dev/null
  sleep 3
  health && echo "rollback healthy." || echo "rollback ALSO unhealthy — investigate by hand"
  exit 1
fi
