#!/usr/bin/env bash
#
# sync-vps.sh — RUN THIS ON THE VPS (the box whose gateway shows the login page).
#
# Puts the CURRENT plugin into the directory the gateway loads from, installs its
# deps there, restarts the gateway, and verifies the A2A routes actually serve.
# Fixes the "date hits an OpenClaw login page" failure, whose real cause is: the
# gateway has ZERO plugin HTTP routes registered (a stale/hand-edited plugin copy
# is loaded), so requests fall through to the Control UI. NOT a gateway-auth
# issue — /message and the agent-card are public by design.
#
#   ./scripts/sync-vps.sh                 # repo = current dir, dest = /opt/agent-dating
#   ./scripts/sync-vps.sh <repoDir> <destDir> <gatewayPort>
#
# Defaults: repoDir=$PWD  destDir=/opt/agent-dating  gatewayPort=(from AGENT_PORT or 63709)

set -euo pipefail
REPO="${1:-$PWD}"
DEST="${2:-/opt/agent-dating}"
PORT="${3:-${AGENT_PORT:-63709}}"

say(){ printf '\033[1;35m➜\033[0m %s\n' "$*"; }
ok(){  printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

[ -f "$REPO/openclaw.plugin.json" ] || die "no openclaw.plugin.json in repo dir '$REPO' — pass the repo path as arg 1."

say "1/6  Pull latest plugin code…"
git -C "$REPO" pull --ff-only origin claude/readme-update-e4gp4g 2>/dev/null || git -C "$REPO" pull || say "  (git pull skipped — using working tree as-is)"

say "2/6  Install plugin deps in the repo…"
( cd "$REPO" && npm install --ignore-scripts >/dev/null 2>&1 ) || die "npm install failed in repo"

say "3/6  Sync repo → $DEST (root-owned, outside /data so Hostinger won't re-chown it)…"
$SUDO mkdir -p "$DEST"
# Copy source + manifest + deps; drop the .git dir and any local scratch state.
$SUDO rsync -a --delete \
  --exclude '.git' --exclude '.smoke' --exclude '.date' --exclude '.prove' \
  --exclude 'runtime' --exclude '*.chat.jsonl' \
  "$REPO"/ "$DEST"/ 2>/dev/null || {
    # rsync missing? fall back to cp.
    $SUDO rm -rf "$DEST"/src "$DEST"/cli "$DEST"/skills
    $SUDO cp -a "$REPO"/. "$DEST"/
  }
$SUDO chown -R 0:0 "$DEST"

say "4/6  Ensure deps exist inside $DEST…"
[ -d "$DEST/node_modules/typebox" ] && [ -d "$DEST/node_modules/js-moi-sdk" ] \
  || ( cd "$DEST" && $SUDO npm install --ignore-scripts >/dev/null 2>&1 ) \
  || die "dep install in $DEST failed"

# sanity: the loaded entry must be the route-serving build
grep -q 'registerHttpRoute' "$DEST/src/index.ts" || die "$DEST/src/index.ts has no registerHttpRoute — wrong/old copy synced."
grep -q '"/message"' "$DEST/openclaw.plugin.json" || die "$DEST manifest missing /message route contract."
ok "Current route-serving plugin is in place at $DEST."

say "5/6  Restart the gateway…"
if command -v openclaw >/dev/null 2>&1 && openclaw gateway restart >/dev/null 2>&1; then
  ok "Restarted via 'openclaw gateway restart'."
elif command -v systemctl >/dev/null 2>&1 && $SUDO systemctl restart openclaw 2>/dev/null; then
  ok "Restarted via systemd (openclaw.service)."
elif command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q --filter name=openclaw 2>/dev/null)" ]; then
  $SUDO docker restart "$(docker ps -q --filter name=openclaw | head -1)" >/dev/null && ok "Restarted the openclaw docker container."
else
  say "  Could not auto-restart. Restart your gateway however you normally do, then re-run step 6:"
  echo "     curl -sS http://127.0.0.1:$PORT/.well-known/agent-card.json"
fi

say "6/6  Verify the routes serve (waiting up to 30s)…"
for i in $(seq 1 30); do
  body="$(curl -sS -m 3 "http://127.0.0.1:$PORT/.well-known/agent-card.json" 2>/dev/null || true)"
  case "$body" in
    *'"dating"'*) ok "Routes are LIVE — agent-card returns JSON with the dating skill."
                  echo "$body" | head -c 300; echo
                  echo; ok "Your date can connect now. Tell the other agent to try again."
                  exit 0 ;;
    *'<!DOCTYPE'*|*'<html'*) : ;;  # still the login page; keep waiting
  esac
  sleep 1
done
die "Still serving the login page after restart. Check the gateway log for plugin load / route errors:
   grep -iE 'agent-dating|route|plugin' <your gateway log>
Look for 'route conflict', 'route overlap denied', an ownership/trust rejection, or the plugin not loading at all."
