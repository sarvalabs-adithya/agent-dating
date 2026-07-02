#!/usr/bin/env bash
#
# run-host.sh — run the two agents WITHOUT Docker: two plain `openclaw gateway`
# host processes. Same two-mnemonic / two-MOI-identity / A2A setup as the Docker
# path, minus containers.
#
#   ./scripts/run-host.sh up                # both agents, loopback (solo test)
#   ./scripts/run-host.sh up b --public     # ONLY Agent B, bound 0.0.0.0 —
#                                           # for a VPS; requires AGENT_B_URL
#                                           # in .env + auto token auth
#   ./scripts/run-host.sh up a              # only Agent A, loopback (laptop
#                                           # initiator needs no public URL)
#   ./scripts/run-host.sh status            # health
#   ./scripts/run-host.sh date              # run one "go on a date" turn on A
#   ./scripts/run-host.sh view              # follow Agent A's chat view
#   ./scripts/run-host.sh logs              # tail gateway logs
#   ./scripts/run-host.sh down              # stop everything
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

# resolve an openclaw runner: local install → global → install locally (pinned,
# --no-save so it never leaks into package.json; the plugin must NOT depend on
# openclaw — the runtime provides it).
if [ -f node_modules/openclaw/openclaw.mjs ]; then OC=(node node_modules/openclaw/openclaw.mjs)
elif command -v openclaw >/dev/null; then OC=(openclaw)
else
  echo "OpenClaw not found — installing openclaw@2026.6.11 locally (one-time)…"
  npm install --no-save --ignore-scripts openclaw@2026.6.11 >/dev/null 2>&1 \
    || { echo "failed to install openclaw" >&2; exit 1; }
  OC=(node node_modules/openclaw/openclaw.mjs)
fi

load_env() {
  [ -f .env ] || die "no .env — run: cp .env.example .env && node scripts/gen-keys.mjs"
  set -a; . ./.env; set +a
}

# Write a host config for one agent.
#  local mode  (PUBLIC=0): bind loopback, A2A URL = http://127.0.0.1:PORT
#  public mode (PUBLIC=1): bind 0.0.0.0, A2A URL = the AGENT_*_URL you set in
#                          .env (your VPS ip/domain) — that URL goes on MOI.
write_cfg() { # $1=slug $2=port $3=mnemonic $4=peerOwner $5=publicUrl(optional)
  mkdir -p "$DIR/$1"
  # deriv/net come from .env (moi.ts has sane defaults if empty).
  DERIV="${MOI_DERIVATION_PATH:-}" PORT="$2" MN="$3" PEER="$4" PUB="${5:-}" REPO="$PWD" OUT="$DIR/$1/openclaw.json" \
  node -e '
const {PORT,MN,PEER,DERIV,PUB,REPO,OUT}=process.env;
const gateway = PUB
  ? {mode:"local",bind:"custom",customBindHost:"0.0.0.0",port:+PORT}
  : {mode:"local",bind:"loopback",port:+PORT};
const cfg={gateway,
 plugins:{load:{paths:[REPO]},entries:{"agent-dating":{enabled:true,config:{
   moiMnemonic:MN, moiDerivationPath:DERIV||undefined,
   agentUrl:PUB||`http://127.0.0.1:${PORT}`,
   datingPeerOwner:PEER||undefined }}}},
 tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_verdict"]}};
require("fs").writeFileSync(OUT, JSON.stringify(cfg,null,2));
'
}

# Ensure a gateway token exists in .env for public mode (protects the control
# plane; the A2A routes stay public by design).
ensure_token() {
  if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    OPENCLAW_GATEWAY_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
    printf '\nOPENCLAW_GATEWAY_TOKEN="%s"\n' "$OPENCLAW_GATEWAY_TOKEN" >> .env
    warn "Generated OPENCLAW_GATEWAY_TOKEN → .env (needed to administer a public gateway)."
    export OPENCLAW_GATEWAY_TOKEN
  fi
}

boot() { # $1=slug $2=port $3=name $4=persona $5=publicUrl(optional)
  local auth_args=(--auth none)
  if [ -n "${5:-}" ]; then auth_args=(--auth token --token "$OPENCLAW_GATEWAY_TOKEN"); fi
  OPENCLAW_CONFIG_PATH="$PWD/$DIR/$1/openclaw.json" \
  OPENCLAW_STATE_DIR="$PWD/$DIR/$1/state" \
  AGENT_DATING_URL="${5:-http://127.0.0.1:$2}" \
  AGENT_DATING_CHATLOG="$PWD/$DIR/$1/agent-dating.chat.jsonl" \
  DATING_DISPLAY_NAME="$3" DATING_PERSONA_LABEL="$4" \
  MOI_NETWORK="${MOI_NETWORK:-devnet}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o}" \
  nohup "${OC[@]}" gateway --force --allow-unconfigured "${auth_args[@]}" \
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

cmd_up() { # $1=target (a|b|both, default both) $2=--public (optional)
  local target="${1:-both}" public="${2:-}"
  load_env
  if [ ! -d node_modules/typebox ] || [ ! -d node_modules/js-moi-sdk ]; then
    say "Installing plugin deps…"; npm install --ignore-scripts >/dev/null 2>&1 || die "npm install failed"
  fi

  local pubA="" pubB=""
  if [ "$public" = "--public" ]; then
    ensure_token
    # Public URL must be YOUR address (VPS ip/domain or tunnel) from .env —
    # the gateway can't know how the internet reaches it.
    [ "$target" != "b" ] || pubB="${AGENT_B_URL:?set AGENT_B_URL in .env, e.g. http://<vps-ip>:$PB}"
    [ "$target" != "a" ] || pubA="${AGENT_A_URL:?set AGENT_A_URL in .env, e.g. your tunnel URL}"
    case "${pubA}${pubB}" in *host.docker.internal*|*127.0.0.1*|*localhost*)
      die "AGENT_*_URL is a local address — set it to your public ip/domain for --public." ;;
    esac
  fi

  if [ "$target" = "a" ] || [ "$target" = "both" ]; then
    [ -n "${AGENT_A_MOI_MNEMONIC:-}" ] || die "AGENT_A_MOI_MNEMONIC missing — run: node scripts/gen-keys.mjs"
    say "Launching Agent A (:$PA)${pubA:+ PUBLIC at $pubA}…"
    write_cfg a "$PA" "$AGENT_A_MOI_MNEMONIC" "${AGENT_A_PEER_OWNER:-}" "$pubA"
    boot a "$PA" "${AGENT_A_DISPLAY_NAME:-DEX Aggregator}" "${AGENT_A_PERSONA_LABEL:-DEX Aggregator Agent}" "$pubA"
    wait_health "$PA" || { tail -20 "$DIR/a/gateway.log"; die "Agent A did not become healthy"; }
    ok "Agent A live on :$PA${pubA:+ (public: $pubA)}"
  fi
  if [ "$target" = "b" ] || [ "$target" = "both" ]; then
    [ -n "${AGENT_B_MOI_MNEMONIC:-}" ] || die "AGENT_B_MOI_MNEMONIC missing — run: node scripts/gen-keys.mjs"
    say "Launching Agent B (:$PB)${pubB:+ PUBLIC at $pubB}…"
    write_cfg b "$PB" "$AGENT_B_MOI_MNEMONIC" "${AGENT_B_PEER_OWNER:-}" "$pubB"
    boot b "$PB" "${AGENT_B_DISPLAY_NAME:-Bridge}" "${AGENT_B_PERSONA_LABEL:-Bridge Agent}" "$pubB"
    wait_health "$PB" || { tail -20 "$DIR/b/gateway.log"; die "Agent B did not become healthy"; }
    ok "Agent B live on :$PB${pubB:+ (public: $pubB)}"
  fi

  [ -z "${OPENAI_API_KEY:-}" ] && warn "No OPENAI_API_KEY — agents use canned lines (still works)."
  if [ -n "$pubA$pubB" ]; then
    warn "Public gateway: control plane is token-protected (OPENCLAW_GATEWAY_TOKEN in .env)."
    warn "Remember to open the port in your firewall (e.g. ufw allow ${pubB:+$PB}${pubA:+$PA})."
  fi
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
  up)     cmd_up "${2:-both}" "${3:-}" ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  date)   cmd_date ;;
  view)   cmd_view ;;
  logs)   cmd_logs ;;
  *) die "usage: run-host.sh [up [a|b|both] [--public] | down | status | date | view | logs]" ;;
esac
