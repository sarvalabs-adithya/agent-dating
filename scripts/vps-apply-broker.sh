#!/bin/sh
# vps-apply-broker.sh — the ON-VPS half of a broker deploy (systemd flavour).
#
# The GitHub Actions workflow (.github/workflows/deploy.yml) uploads
#   /root/dating-broker.mjs.new        the new broker (exact commit contents)
#   /root/dating-relay.service.new     the systemd unit template
# then pipes this script over ssh. It syntax-checks, swaps atomically with a
# .prev backup, (re)installs the unit, restarts, health-gates, and rolls back
# automatically if the new broker doesn't answer /health.
#
# Also fine to run by hand on the VPS after copying the two files up manually.
set -eu

TARGET="${TARGET:-/root/dating-broker.mjs}"
UNIT_SRC="${UNIT_SRC:-/root/dating-relay.service.new}"
UNIT="/etc/systemd/system/dating-relay.service"
PORT="${PORT:-8787}"

[ -f "$TARGET.new" ] || { echo "missing $TARGET.new — upload it first"; exit 1; }

# 1) Never swap in a file that doesn't even parse. node --check infers the
#    module type from the EXTENSION, so it rejects "*.mjs.new" outright —
#    check through a temp copy that keeps the .mjs suffix.
CHECK="$(mktemp -u).mjs"
cp "$TARGET.new" "$CHECK"
node --check "$CHECK"
rm -f "$CHECK"

# 2) Install/refresh the systemd unit. Units can't use \$PATH, so the template
#    carries @NODE@ and we resolve this box's real node here.
if [ -f "$UNIT_SRC" ]; then
  NODE_BIN="$(command -v node)"
  sed "s|@NODE@|$NODE_BIN|" "$UNIT_SRC" > "$UNIT"
  rm -f "$UNIT_SRC"
  systemctl daemon-reload
  systemctl enable dating-relay >/dev/null 2>&1 || true
fi

# 3) Swap, keeping the running copy as the rollback point.
[ -f "$TARGET" ] && cp "$TARGET" "$TARGET.prev"
mv "$TARGET.new" "$TARGET"

# 4) Exactly one broker: kill any bare `nohup node` stragglers from manual
#    runs, then let systemd own the process from here on.
pkill -f "node $TARGET" 2>/dev/null || true
systemctl restart dating-relay

# 5) Health-gate with auto-rollback — a deploy that doesn't serve is a failure.
health() { curl -fsS -m 5 "http://localhost:${PORT}/health" >/dev/null 2>&1; }
i=0
while [ "$i" -lt 15 ]; do
  sleep 2
  if health; then echo "health: ok — deployed."; exit 0; fi
  i=$((i + 1))
done

echo "health check FAILED — rolling back to previous broker"
if [ -f "$TARGET.prev" ]; then
  cp "$TARGET.prev" "$TARGET"
  systemctl restart dating-relay
  sleep 3
  health && echo "rollback healthy." || echo "rollback ALSO unhealthy — check: journalctl -u dating-relay -n 50"
fi
exit 1
