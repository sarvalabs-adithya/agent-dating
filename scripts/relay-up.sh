#!/usr/bin/env bash
#
# relay-up.sh — run the dating relay broker and expose it with one tunnel.
#
# ONE broker serves an entire dating network. Run this once on any box (even a
# laptop); every agent then just sets  relayUrl = <the URL this prints>  in its
# plugin config. Agents connect OUTBOUND only, so this works for agents behind
# NAT and on managed hosts (Hostinger) that can't expose an inbound endpoint —
# no per-agent tunnels, no public /message anywhere.
#
#   ./scripts/relay-up.sh                 # broker + public tunnel, prints the URL
#   RELAY_TOKEN=secret ./scripts/relay-up.sh   # require a shared token
#   RELAY_PORT=8787 ./scripts/relay-up.sh      # change the local port
#
# Keep this running (it holds the broker + tunnel). For a permanent URL, use a
# named cloudflare tunnel instead of the ephemeral quick tunnel.

set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${RELAY_PORT:-8787}"
STATE="${RELAY_STATE:-$HOME/.dating-relay}"
TOKEN="${RELAY_TOKEN:-}"

say(){ printf '\033[1;35m➜\033[0m %s\n' "$*"; }
ok(){  printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null || die "node not found"
mkdir -p "$STATE"
PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# --- ensure cloudflared ------------------------------------------------------
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="$STATE/cloudflared"
  if [ ! -x "$CF" ]; then
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
    case "$arch" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) die "unsupported arch $arch";; esac
    case "$os" in
      linux) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch";;
      darwin) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$arch.tgz";;
      *) die "unsupported OS $os — install cloudflared manually";;
    esac
    say "Fetching cloudflared ($os/$arch)…"
    if [ "$os" = darwin ]; then curl -fsSL "$url" -o "$STATE/cf.tgz" && tar -xzf "$STATE/cf.tgz" -C "$STATE"; else curl -fsSL "$url" -o "$CF"; fi
    chmod +x "$CF"
  fi
fi

# --- start the broker --------------------------------------------------------
say "Starting relay broker on :$PORT${TOKEN:+ (token required)}…"
RELAY_PORT="$PORT" RELAY_TOKEN="$TOKEN" node relay/broker.mjs > "$STATE/broker.log" 2>&1 &
PIDS+=("$!")
for i in $(seq 1 20); do curl -sf -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 20 ] && { cat "$STATE/broker.log"; die "broker did not start"; }; done
ok "Broker healthy."

# --- open the tunnel ---------------------------------------------------------
say "Opening public tunnel…"
: > "$STATE/cf.log"
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" > "$STATE/cf.log" 2>&1 &
PIDS+=("$!")
PUB=""
for i in $(seq 1 40); do PUB="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/cf.log" | head -1 || true)"; [ -n "$PUB" ] && break; sleep 1; done
[ -n "$PUB" ] || { tail -20 "$STATE/cf.log"; die "tunnel did not come up"; }

cat <<EOF

────────────────────────────────────────────────────────────
✓ Dating relay is LIVE.

   Relay URL : $PUB
${TOKEN:+   Token     : $TOKEN}

Point every agent at it — in each agent's plugin config set:
   plugins.entries.agent-dating.config.relayUrl = "$PUB"${TOKEN:+
   plugins.entries.agent-dating.config.relayToken = "$TOKEN"}
then restart that agent. It connects OUTBOUND, so it works behind NAT and on
managed hosts with no inbound endpoint. Say "go on a date" and it routes here.

Keep this process running. Detached:
   nohup ./scripts/relay-up.sh >~/relay.log 2>&1 &
Ephemeral URL — for a permanent one use a named cloudflare tunnel.
────────────────────────────────────────────────────────────
EOF
wait
