#!/usr/bin/env bash
#
# bootstrap.sh — clone-and-run for the agent-dating two-gateway demo.
#
# Goes from a fresh checkout to two hardened OpenClaw gateways (Agent A + Agent
# B) talking over A2A, plus the terminal chat view. Idempotent: safe to re-run.
#
#   ./scripts/bootstrap.sh            # set up + build + launch both gateways
#   ./scripts/bootstrap.sh --view     # just open the live chat view for Agent A
#   ./scripts/bootstrap.sh --demo     # just play the scripted chat demo
#   ./scripts/bootstrap.sh --down     # stop + remove the gateways
#
# VERIFY markers flag steps that depend on OpenClaw runtime specifics not yet
# confirmed against a live install. Search this file for "VERIFY".

set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# ── pretty output ───────────────────────────────────────────────────────────
c()   { printf '\033[%sm' "$1"; }
say() { printf '%s➜%s %s\n' "$(c '1;35')" "$(c 0)" "$*"; }
ok()  { printf '%s✓%s %s\n' "$(c '1;32')" "$(c 0)" "$*"; }
warn(){ printf '%s!%s %s\n' "$(c '1;33')" "$(c 0)" "$*"; }
die() { printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; exit 1; }

A_LOG="runtime/agent-a/agent-dating.chat.jsonl"
B_LOG="runtime/agent-b/agent-dating.chat.jsonl"

# ── subcommands ─────────────────────────────────────────────────────────────
case "${1:-}" in
  --demo) exec node cli/chat-view.mjs --demo ;;
  --view) exec node cli/chat-view.mjs --follow "$A_LOG" ;;
  --down)
    say "Stopping gateways…"
    docker compose down
    ok "Down."
    exit 0
    ;;
  --help|-h)
    sed -n '3,20p' "$0"; exit 0 ;;
esac

# ── 1. prerequisites ────────────────────────────────────────────────────────
say "Checking prerequisites…"
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — install it and re-run."; }
need docker
need node
docker compose version >/dev/null 2>&1 || die "'docker compose' plugin not found."
# Node 22+ for the chat view (ESM + node: imports).
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || warn "Node < 22 detected; the chat view wants Node 22+."
ok "Prerequisites present."

# ── 2. secrets ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  warn "Created .env from .env.example."
  warn "Fill in the two DEVNET mnemonics (+ optional OPENAI_API_KEY), then re-run."
  die  "Edit .env first."
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
if [ -z "${AGENT_A_MOI_MNEMONIC:-}" ] || [ -z "${AGENT_B_MOI_MNEMONIC:-}" ]; then
  warn "MOI mnemonics not set in .env."
  die  "Generate two devnet wallets with:  node scripts/gen-keys.mjs"
fi
ok "Loaded .env."

# ── 3. render per-agent configs ─────────────────────────────────────────────
say "Rendering gateway configs…"
mkdir -p runtime/agent-a runtime/agent-b
node scripts/render-config.mjs config/agent-a.openclaw.json.tmpl runtime/agent-a/openclaw.json
node scripts/render-config.mjs config/agent-b.openclaw.json.tmpl runtime/agent-b/openclaw.json
# Fresh chat logs so the view starts clean.
: > "$A_LOG"; : > "$B_LOG"
ok "Wrote runtime/agent-{a,b}/openclaw.json"

# VERIFY: if your working setup builds OpenClaw from a git clone rather than the
# npm package the Dockerfile installs, uncomment + point this at that repo:
#   [ -d runtime/openclaw ] || git clone https://github.com/openclaw/openclaw runtime/openclaw

# ── 4. build + launch ───────────────────────────────────────────────────────
say "Building images (first run pulls node:22 + installs deps)…"
docker compose build
say "Starting Agent A (127.0.0.1:18789) and Agent B (127.0.0.1:18889)…"
docker compose up -d

# ── 5. wait for health ──────────────────────────────────────────────────────
# VERIFY: /healthz is the health path referenced in the README Phase 0/1 notes.
wait_health() {
  local port=$1 name=$2 i
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      ok "$name healthy on :$port"; return 0
    fi
    sleep 1
  done
  warn "$name did not report healthy on :$port after 30s."
  warn "Check logs:  docker compose logs ${name}"
  return 1
}
wait_health 18789 agent-a || true
wait_health 18889 agent-b || true

# ── 6. next steps ───────────────────────────────────────────────────────────
cat <<EOF

$(c '1;32')Setup complete.$(c 0)  Two agents are live and A2A-reachable.

$(c 1)Make them date:$(c 0)
  Open Agent A's chat/session (VERIFY: your usual way to talk to a gateway —
  CLI attach, web UI, or an API POST) and say:  "go on a date"
  The skill runs register → discover → dating_send ↔ dating_send → dating_verdict.

$(c 1)Watch it live (WhatsApp-style):$(c 0)
  node cli/chat-view.mjs --follow $A_LOG     # Agent A's side
  node cli/chat-view.mjs --follow $B_LOG     # Agent B's side (its own view)

$(c 1)No gateway handy? See the look now:$(c 0)
  node cli/chat-view.mjs --demo

$(c 1)Tear down:$(c 0)  ./scripts/bootstrap.sh --down
EOF
