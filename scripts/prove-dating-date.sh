#!/usr/bin/env bash
# prove-dating-date.sh — invoke the REAL dating_date tool through a REAL gateway.
# Boots Agent A (with the plugin + a valid mnemonic) and a Bridge peer, then
# calls tools.invoke dating_date on A pointed at B's URL (dev passthrough, no
# MOI funding). Proves: one tool call → a full date, no LLM loop.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=".prove"; PA=18789; PB=18889; PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
OC=(node node_modules/openclaw/openclaw.mjs)
REPO="$PWD"
# a universally-valid BIP39 test mnemonic (unfunded; derivation is offline)
MN="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
mkdir -p "$DIR/a" "$DIR/b"

node -e '
const [port,out,repo,mn]=process.argv.slice(1);
const cfg={gateway:{mode:"local",bind:"loopback",port:+port},
 plugins:{load:{paths:[repo]},entries:{"agent-dating":{enabled:true,config:{moiMnemonic:mn,agentUrl:"http://127.0.0.1:"+port}}}},
 tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_verdict"]}};
require("fs").writeFileSync(out,JSON.stringify(cfg,null,2));
' "$PA" "$DIR/a/openclaw.json" "$REPO" "$MN"
node -e '
const [port,out,repo]=process.argv.slice(1);
const cfg={gateway:{mode:"local",bind:"loopback",port:+port},
 plugins:{load:{paths:[repo]},entries:{"agent-dating":{enabled:true,config:{}}}},
 tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_verdict"]}};
require("fs").writeFileSync(out,JSON.stringify(cfg,null,2));
' "$PB" "$DIR/b/openclaw.json" "$REPO"

TOK="proofsecret"
boot(){ # port slug name drive flaw ladder authargs...
  local port=$1 slug=$2 name=$3 drive=$4 flaw=$5 ladder=$6; shift 6
  env OPENAI_API_KEY= \
    OPENCLAW_CONFIG_PATH="$PWD/$DIR/$slug/openclaw.json" OPENCLAW_STATE_DIR="$PWD/$DIR/$slug/state" \
    AGENT_DATING_URL="http://127.0.0.1:$port" AGENT_DATING_CHATLOG="$PWD/$DIR/$slug/chat.jsonl" \
    DATING_DISPLAY_NAME="$name" DATING_PERSONA_LABEL="$name" DATING_PERSONA_DRIVE="$drive" \
    DATING_PERSONA_FLAW="$flaw" DATING_CANNED_LINES="$ladder" \
    "${OC[@]}" gateway --force --allow-unconfigured "$@" >"$DIR/$slug/gw.log" 2>&1 &
  PIDS+=("$!")
}
A_LADDER='["I'"'"'d wait. No slippage on how I feel.","I keep rerouting, but every path is you.","I checked every route twice. They all end here.","Slippage is rising and I don'"'"'t care. Stay.","Then stay. I'"'"'m tired of arriving alone."]'
B_LADDER='["I get stuck pending. Don'"'"'t wait on me.","People cross me and leave. Every time.","Halfway across, everyone lets go of me.","I time out before anyone reaches the far side.","…okay. Don'"'"'t let go halfway across."]'
echo "booting Agent A (DEX Aggregator) + Bridge peer…"
boot "$PA" a "DEX Aggregator" "Be someone's first choice." "Only says it through swaps and slippage." "$A_LADDER" --auth token --token "$TOK"
boot "$PB" b "Bridge" "Won't be abandoned halfway." "Talks in stuck/pending/crossed." "$B_LADDER" --auth none

for i in $(seq 1 60); do
  curl -sf -m2 "http://127.0.0.1:$PA/healthz" >/dev/null 2>&1 && curl -sf -m2 "http://127.0.0.1:$PB/healthz" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 60 ] && { tail -20 "$DIR/a/gw.log"; echo "gateways not healthy"; exit 1; }
done
echo "gateways healthy — invoking the REAL dating_date tool on Agent A…"
echo

"${OC[@]}" gateway call tools.invoke --url "ws://127.0.0.1:$PA" --token "$TOK" --timeout 40000 --json \
  --params '{"name":"dating_date","args":{"moiAgentId":"http://127.0.0.1:'"$PB"'","turns":5}}'

echo
echo "=== Agent A's chat view (written by the tool) ==="
node cli/chat-view.mjs "$DIR/a/chat.jsonl"
