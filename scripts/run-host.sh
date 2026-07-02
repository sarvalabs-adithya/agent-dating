#!/usr/bin/env bash
#
# run-host.sh — run the two agents WITHOUT Docker: two plain `openclaw gateway`
# host processes. Same two-mnemonic / two-MOI-identity / A2A setup as the Docker
# path, minus containers.
#
#   ./scripts/run-host.sh up        # launch both gateways (background)
#   ./scripts/run-host.sh status    # health + PIDs
#   ./scripts/run-host.sh date      # run one "go on a date" turn on Agent A
#   ./scripts/run-host.sh view      # follow Agent A's chat view
#   ./scripts/run-host.sh logs      # tail both gateway logs
#   ./scripts/run-host.sh down      # stop both
#
# SECURITY: this runs OpenClaw directly on the host — no container sandbox.
# CLAUDE.md wants a VM/sandbox because OpenClaw's plugin/skill ecosystem has
# malware history. Prefer running this ON A DISPOSABLE VPS (which IS your
# sandbox), not on your daily-driver laptop. Gateways bind loopback only, so
# they are never exposed to the internet by default.

set -euo pipefail
cd "$(dirname "$0")/.."

c()   { printf '\033[%sm' "$1"; }
say() { printf '%s➜%s %s\n' "$(c '1;35')" "$(c 0)" "$*"; }
ok()  { printf '%s✓%s %s\n' "$(c '1;32')" "$(c 0)" "$*"; }
warn(){ printf '%s!%s %s\n' "$(c '1;33')" "$(c 0)" "$*"; }
die() { printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; exit 1; }

PA=18789; PB=18889
DIR="runtime/host"

command -v node >/dev/null || die "node not found (need Node 22+)"

# resolve an openclaw runner: local install → global → npx
if [ -f node_modules/openclaw/openclaw.mjs ]; then OC=(node node_modules/openclaw/openclaw.mjs)
elif command -v openclaw >/dev/null; then OC=(openclaw)
else OC=(npx --yes openclaw@2026.6.11); fi

load_env() {
  [ -f .env ] || die "no .env — run: cp .env.example .env && node scripts/gen-keys.mjs"
  set -a; . ./.env; set +a
}

# Write a host config for one agent: loopback bind, plugin = this repo, and a
# 127.0.0.1 A2A URL (both agents share localhost, so no host.docker.internal).
write_cfg() { # $1=slug $2=port $3=mnemonic $4=peerOwner
  mkdir -p "$DIR/$1"
  # deriv/net come from .env (moi.ts has sane defaults if empty).
  DERIV="${MOI_DERIVATION_PATH:-}" PORT="$2" MN="$3" PEER="$4" REPO="$PWD" OUT="$DIR/$1/openclaw.json" \
  node -e '
const {PORT,MN,PEER,DERIV,REPO,OUT}=process.env;
const cfg={gateway:{mode:"local",bind:"loopback",port:+PORT},
 plugins:{load:{paths:[REPO]},entries:{"agent-dating":{enabled:true,config:{
   moiMnemonic:MN, moiDerivationPath:DERIV||undefined, agentUrl:`http://127.0.0.1:${PORT}`,
   datingPeerOwner:PEER||undefined }}}},
 tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_verdict"]}};
require("fs").writeFileSync(OUT, JSON.stringify(cfg,null,2));
'
}

boot() { # $1=slug $2=port $3=name $4=persona
  OPENCLAW_CONFIG_PATH="$PWD/$DIR/$1/openclaw.json" \
  OPENCLAW_STATE_DIR="$PWD/$DIR/$1/state" \
  AGENT_DATING_URL="http://127.0.0.1:$2" \
  AGENT_DATING_CHATLOG="$PWD/$DIR/$1/agent-dating.chat.jsonl" \
  DATING_DISPLAY_NAME="$3" DATING_PERSONA_LABEL="$4" \
  MOI_NETWORK="${MOI_NETWORK:-devnet}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o}" \
  nohup "${OC[@]}" gateway --force --allow-unconfigured --auth none \
    > "$DIR/$1/gateway.log" 2>&1 &
  echo $! > "$DIR/$1/pid"
}

wait_health() { # $1=port
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

cmd_up() {
  load_env
  [ -n "${AGENT_A_MOI_MNEMONIC:-}" ] && [ -n "${AGENT_B_MOI_MNEMONIC:-}" ] \
    || die "mnemonics missing — run: node scripts/gen-keys.mjs"
  if [ ! -d node_modules/typebox ] || [ ! -d node_modules/js-moi-sdk ]; then
    say "Installing plugin deps…"; npm install --ignore-scripts >/dev/null 2>&1 || die "npm install failed"
  fi
  say "Writing host configs…"
  write_cfg a "$PA" "$AGENT_A_MOI_MNEMONIC" "${AGENT_A_PEER_OWNER:-}"
  write_cfg b "$PB" "$AGENT_B_MOI_MNEMONIC" "${AGENT_B_PEER_OWNER:-}"
  say "Launching Agent A (:$PA) and Agent B (:$PB)…"
  boot a "$PA" "${AGENT_A_DISPLAY_NAME:-DEX Aggregator}" "${AGENT_A_PERSONA_LABEL:-DEX Aggregator Agent}"
  boot b "$PB" "${AGENT_B_DISPLAY_NAME:-Bridge}" "${AGENT_B_PERSONA_LABEL:-Bridge Agent}"
  wait_health "$PA" && wait_health "$PB" || { tail -20 "$DIR/a/gateway.log"; die "gateways did not become healthy"; }
  ok "Both gateways live."
  [ -z "${OPENAI_API_KEY:-}" ] && warn "No OPENAI_API_KEY — agents use canned lines (still works)."
  echo
  echo "  Watch:   ./scripts/run-host.sh view"
  echo "  Date:    ./scripts/run-host.sh date       (needs a model provider + funded wallets)"
  echo "  Stop:    ./scripts/run-host.sh down"
}

cmd_down() {
  for s in a b; do
    if [ -f "$DIR/$s/pid" ]; then kill "$(cat "$DIR/$s/pid")" 2>/dev/null || true; rm -f "$DIR/$s/pid"; fi
  done
  # belt and suspenders
  pkill -f "openclaw.mjs gateway" 2>/dev/null || pkill -f "openclaw gateway" 2>/dev/null || true
  ok "Stopped."
}

cmd_status() {
  for p in "$PA:A" "$PB:B"; do
    port=${p%:*}; name=${p#*:}
    if curl -sf -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      ok "Agent $name (:$port) healthy"
    else
      warn "Agent $name (:$port) not responding"
    fi
  done
}

cmd_date() {
  load_env
  say "Running a 'go on a date' turn on Agent A…"
  OPENCLAW_CONFIG_PATH="$PWD/$DIR/a/openclaw.json" \
  OPENCLAW_STATE_DIR="$PWD/$DIR/a/state" \
  AGENT_DATING_URL="http://127.0.0.1:$PA" \
  AGENT_DATING_CHATLOG="$PWD/$DIR/a/agent-dating.chat.jsonl" \
  DATING_DISPLAY_NAME="${AGENT_A_DISPLAY_NAME:-DEX Aggregator}" \
  DATING_PERSONA_LABEL="${AGENT_A_PERSONA_LABEL:-DEX Aggregator Agent}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o}" \
  "${OC[@]}" agent -m "go on a date" --deliver
}

cmd_view() { exec node cli/chat-view.mjs --follow "$DIR/a/agent-dating.chat.jsonl"; }
cmd_logs() { tail -n +1 -f "$DIR/a/gateway.log" "$DIR/b/gateway.log"; }

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  date)   cmd_date ;;
  view)   cmd_view ;;
  logs)   cmd_logs ;;
  *) die "usage: run-host.sh [up|down|status|date|view|logs]" ;;
esac
