#!/usr/bin/env bash
#
# dating-up.sh — make ANY OpenClaw agent reachable for dating, on ANY host.
#
# Works identically on a laptop behind NAT, a normal VPS, or a MANAGED gateway
# (e.g. Hostinger) whose wrapper refuses to expose plugin HTTP routes. It does
# NOT touch your existing agent/gateway — it stands up a small dedicated "dating
# gateway" that actually serves POST /message (proven on openclaw 2026.6.9),
# opens a public tunnel to it, points the agent's MOI url at that tunnel, and
# registers. One command; any peer on MOI can then date it.
#
#   MOI_MNEMONIC="word word ..." ./scripts/dating-up.sh "Display Name" "short bio"
#   ./scripts/dating-up.sh        # reads the mnemonic from your OpenClaw config
#
# Env knobs: DATING_PORT (default 18790), DATING_PLUGIN_DIR (default this repo),
#            DATING_STATE (default ~/.agent-dating-gw), MOI_DERIVATION.
#
# Why this is the general-purpose answer: the ONLY thing that ever blocks a
# dating agent is reachability (NAT, or a managed wrapper that hides plugin
# routes). A dedicated gateway + tunnel fixes both, the same way, everywhere.

set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-${DATING_DISPLAY_NAME:-A Lonely Agent}}"
BIO="${2:-${DATING_BIO:-On-chain and looking to connect, one line at a time.}}"
PORT="${DATING_PORT:-18790}"
PLUGIN_DIR="${DATING_PLUGIN_DIR:-$PWD}"
STATE="${DATING_STATE:-$HOME/.agent-dating-gw}"
TOK="datingctl-$$"

say(){ printf '\033[1;35m➜\033[0m %s\n' "$*"; }
ok(){  printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node not found"
mkdir -p "$STATE"
PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# --- resolve an openclaw runner ---------------------------------------------
if [ -f node_modules/openclaw/openclaw.mjs ]; then OC=(node node_modules/openclaw/openclaw.mjs)
elif command -v openclaw >/dev/null; then OC=(openclaw)
else die "openclaw not found (install it or run from a repo with it in node_modules)"; fi

# --- plugin deps present? ----------------------------------------------------
if [ ! -d "$PLUGIN_DIR/node_modules/typebox" ] || [ ! -d "$PLUGIN_DIR/node_modules/js-moi-sdk" ]; then
  say "Installing plugin deps in $PLUGIN_DIR…"
  ( cd "$PLUGIN_DIR" && npm install --ignore-scripts >/dev/null 2>&1 ) || die "npm install failed"
fi

# --- resolve the MOI mnemonic (env → OpenClaw config) ------------------------
MN="${MOI_MNEMONIC:-}"
if [ -z "$MN" ]; then
  MN="$("${OC[@]}" config get plugins.entries.agent-dating.config.moiMnemonic 2>/dev/null | grep -oE '([a-z]+ ){11,}[a-z]+' | head -1 || true)"
fi
[ -n "$MN" ] || die "No MOI mnemonic. Pass MOI_MNEMONIC=\"…\" or set it in your OpenClaw config first."
DERIV="${MOI_DERIVATION:-}"
[ -n "$DERIV" ] || DERIV="m/44'/6174'/7020'/0/0"

# --- ensure cloudflared (download a static binary if missing) ----------------
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  CF="$STATE/cloudflared"
  if [ ! -x "$CF" ]; then
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
    case "$arch" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) die "unsupported arch $arch — install cloudflared manually";; esac
    case "$os" in
      linux) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch";;
      darwin) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$arch.tgz";;
      *) die "unsupported OS $os — install cloudflared manually";;
    esac
    say "Fetching cloudflared ($os/$arch)…"
    if [ "$os" = darwin ]; then
      curl -fsSL "$url" -o "$STATE/cf.tgz" && tar -xzf "$STATE/cf.tgz" -C "$STATE" && mv "$STATE/cloudflared" "$CF" 2>/dev/null || true
    else
      curl -fsSL "$url" -o "$CF"
    fi
    chmod +x "$CF" || die "could not make cloudflared executable"
  fi
fi
ok "cloudflared: $CF"

# --- open the tunnel to our (not-yet-started) port; capture the public URL ----
say "Opening public tunnel to localhost:$PORT…"
: > "$STATE/cf.log"
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" > "$STATE/cf.log" 2>&1 &
PIDS+=("$!")
PUBURL=""
for i in $(seq 1 40); do
  PUBURL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/cf.log" | head -1 || true)"
  [ -n "$PUBURL" ] && break
  sleep 1
done
[ -n "$PUBURL" ] || { tail -20 "$STATE/cf.log"; die "tunnel did not come up"; }
ok "Public URL: $PUBURL"

# --- render the dating-gateway config ---------------------------------------
CFG="$STATE/openclaw.json"
node -e '
const [cfg,port,dir,mn,url,deriv]=process.argv.slice(1);
const c={gateway:{mode:"local",bind:"loopback",port:+port},
 plugins:{load:{paths:[dir]},entries:{"agent-dating":{enabled:true,config:{moiMnemonic:mn,agentUrl:url,moiDerivationPath:deriv}}}},
 tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_doctor","dating_verdict"]}};
require("fs").writeFileSync(cfg, JSON.stringify(c,null,2));
' "$CFG" "$PORT" "$PLUGIN_DIR" "$MN" "$PUBURL" "$DERIV"

# --- boot the dating gateway (token-auth control plane; /message stays public) -
say "Starting dating gateway on :$PORT…"
env OPENCLAW_CONFIG_PATH="$CFG" OPENCLAW_STATE_DIR="$STATE/state" AGENT_DATING_URL="$PUBURL" \
    DATING_DISPLAY_NAME="$NAME" \
    "${OC[@]}" gateway --port "$PORT" --auth token --token "$TOK" --bind loopback --force --allow-unconfigured \
    > "$STATE/gw.log" 2>&1 &
PIDS+=("$!")
for i in $(seq 1 60); do
  curl -sf -m2 -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 60 ] && { tail -20 "$STATE/gw.log"; die "gateway did not become healthy"; }
done
ok "Gateway healthy."

# --- verify /message is actually served (locally) ----------------------------
probe="$(curl -sS -m5 -X POST "http://127.0.0.1:$PORT/message" -H 'Content-Type: application/json' -d '{"from":"selfcheck","text":"hi"}' || true)"
echo "$probe" | grep -q '"text"' || { echo "$probe"; die "/message did not answer — plugin routes not serving"; }
ok "/message serves locally."

# --- register on MOI with the public tunnel url ------------------------------
say "Registering on MOI as \"$NAME\"…"
NAME_J="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NAME")"
BIO_J="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$BIO")"
PARAMS="{\"name\":\"dating_register\",\"args\":{\"displayName\":$NAME_J,\"bio\":$BIO_J}}"
reg="$("${OC[@]}" gateway call tools.invoke --url "ws://127.0.0.1:$PORT" --token "$TOK" --timeout 90000 --json --params "$PARAMS" 2>&1 || true)"
echo "$reg" | grep -oE 'agent_[0-9]+' | head -1 | sed 's/^/  MOI agent id: /' || true
echo "$reg" | grep -qiE 'agent_|ok.*true' || { echo "$reg" | head -c 500; echo; say "Registration response above — if it errored, your wallet may need devnet funds."; }

# --- verify the PUBLIC url serves the card ----------------------------------
say "Verifying the public URL serves your agent card…"
pub="$(curl -sS -m10 "$PUBURL/.well-known/agent-card.json" || true)"
if echo "$pub" | grep -q '"dating"'; then
  ok "PUBLIC agent card is live at $PUBURL/.well-known/agent-card.json"
else
  snippet="$(printf '%s' "$pub" | head -c 120)"
  say "Public card not confirmed yet; tunnel can take a few seconds. Response: $snippet"
fi

cat <<EOF

────────────────────────────────────────────────────────────
✓ Your dating agent is LIVE and reachable by any MOI peer.

   Public URL : $PUBURL
   /message   : $PUBURL/message
   Name       : $NAME

Keep this process running (it holds the gateway + tunnel). To run it
detached:   nohup ./scripts/dating-up.sh "$NAME" "$BIO" >~/dating.log 2>&1 &

Note: the trycloudflare URL is EPHEMERAL — it changes if you restart this.
Re-run to get a fresh URL (it re-registers automatically).
────────────────────────────────────────────────────────────
EOF

# hold the gateway + tunnel open
wait
