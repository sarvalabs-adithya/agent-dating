#!/usr/bin/env bash
#
# smoke-test.sh — prove the whole wire with ZERO external deps: no Docker, no
# MOI funding, no OpenAI key. Boots two real OpenClaw gateways as host
# processes, exercises the A2A routes both directions, and renders the chat
# view. This is the exact path verified in development.
#
#   ./scripts/smoke-test.sh
#
# What it does NOT cover (needs the real stack): on-chain MOI register/discover
# (needs a funded devnet wallet) and LLM-authored lines (needs OPENAI_API_KEY;
# without it the offline canned lines answer). Everything else is real.

set -euo pipefail
cd "$(dirname "$0")/.."

c()   { printf '\033[%sm' "$1"; }
say() { printf '%s➜%s %s\n' "$(c '1;35')" "$(c 0)" "$*"; }
ok()  { printf '%s✓%s %s\n' "$(c '1;32')" "$(c 0)" "$*"; }
die() { printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; exit 1; }

PA=18789; PB=18889
DIR=".smoke"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

command -v node >/dev/null || die "node not found"

# --- deps: the plugin imports typebox + js-moi-sdk; ensure they're installed --
if [ ! -d node_modules/typebox ] || [ ! -d node_modules/js-moi-sdk ]; then
  say "Installing plugin deps (npm install --ignore-scripts)…"
  npm install --ignore-scripts >/dev/null 2>&1 || die "npm install failed"
fi

# --- resolve an openclaw runner (local install → global → npx) ---------------
if [ -f node_modules/openclaw/openclaw.mjs ]; then
  OC=(node node_modules/openclaw/openclaw.mjs)
elif command -v openclaw >/dev/null; then
  OC=(openclaw)
else
  say "OpenClaw not installed locally — using npx (first run downloads it)…"
  OC=(npx --yes openclaw@2026.6.11)
fi

# --- render two minimal host configs (loopback bind; plugin = this repo) -----
say "Rendering host configs…"
mkdir -p "$DIR/a" "$DIR/b"
REPO="$PWD"
gen_cfg() { # $1=port $2=outfile
  node -e '
const [port,out,repo]=process.argv.slice(1);
const cfg={gateway:{mode:"local",bind:"loopback",port:+port},
  plugins:{load:{paths:[repo]},entries:{"agent-dating":{enabled:true,config:{}}}},
  tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_doctor","dating_verdict"]}};
require("fs").writeFileSync(out, JSON.stringify(cfg,null,2));
' "$1" "$2" "$REPO"
}
gen_cfg "$PA" "$DIR/a/openclaw.json"
gen_cfg "$PB" "$DIR/b/openclaw.json"

# --- boot both gateways ------------------------------------------------------
boot() { # $1=port $2=slug $3=name
  OPENCLAW_CONFIG_PATH="$PWD/$DIR/$2/openclaw.json" \
  OPENCLAW_STATE_DIR="$PWD/$DIR/$2/state" \
  AGENT_DATING_URL="http://127.0.0.1:$1" \
  AGENT_DATING_CHATLOG="$PWD/$DIR/$2/chat.jsonl" \
  DATING_DISPLAY_NAME="$3" \
  "${OC[@]}" gateway --force --allow-unconfigured --auth none \
    > "$DIR/$2/gw.log" 2>&1 &
  PIDS+=("$!")
}
say "Booting Agent A (:$PA) and Agent B (:$PB)…"
: > "$DIR/a/chat.jsonl"; : > "$DIR/b/chat.jsonl"
boot "$PA" a "DEX Aggregator"
boot "$PB" b "Bridge"

# --- wait for health ---------------------------------------------------------
say "Waiting for /healthz…"
for i in $(seq 1 60); do
  if curl -sf -m 2 "http://127.0.0.1:$PA/healthz" >/dev/null 2>&1 \
  && curl -sf -m 2 "http://127.0.0.1:$PB/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { tail -20 "$DIR/a/gw.log"; die "gateways did not become healthy"; }
done
ok "Both gateways healthy."
grep -oE "http server listening \([^)]*plugins:[^)]*\)" "$DIR/a/gw.log" | head -1 || true

# --- exercise the message wire ( POST /message { from, text } ) --------------
send() { # $1=port $2=text  -> prints reply JSON
  curl -sS -m 10 -X POST "http://127.0.0.1:$1/message" \
    -H 'Content-Type: application/json' \
    -d "{\"from\":\"smoke-test\",\"text\":\"$2\"}"
}

say "GET Agent A's AgentCard…"
curl -sf -m 5 "http://127.0.0.1:$PA/.well-known/agent-card.json" | node -e 'const d=JSON.parse(require("fs").readFileSync(0));if(d.skills?.[0]?.tags?.includes("dating"))console.log("  card ok — dating skill present");else{console.error("card missing dating skill");process.exit(1)}'
ok "AgentCard served."

say "A → B  and  B → A  ( POST /message )…"
RA=$(send "$PB" "Every route I ran tonight ended at you.")
RB=$(send "$PA" "I get stuck pending. Do not wait on me.")
echo "$RA" | grep -q '"text"' || die "A→B got no reply: $RA"
echo "$RB" | grep -q '"text"' || die "B→A got no reply: $RB"
ok "Cross-gateway messaging works both directions."

# --- render the chat view (Agent B's side of the date) -----------------------
say "Rendering Agent B's chat log…"
node cli/chat-view.mjs "$DIR/b/chat.jsonl"

echo
ok "SMOKE TEST PASSED — gateways, plugin load, A2A routes, chat log all live."
echo "  (logs + temp state under ./$DIR — safe to delete)"
