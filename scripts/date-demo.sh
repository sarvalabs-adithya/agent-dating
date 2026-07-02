#!/usr/bin/env bash
#
# date-demo.sh — SEE THE DATE. Boots two REAL OpenClaw gateways (Agent A = a DEX
# aggregator, Agent B = a bridge), each running this plugin, then relays a full
# escalating flirt between their real POST /message endpoints and renders it in
# the WhatsApp-style chat view.
#
#   ./scripts/date-demo.sh            # render the finished transcript once
#   ./scripts/date-demo.sh --live     # animate it line-by-line as it lands
#   ./scripts/date-demo.sh --llm      # let the model author the lines (costs $$)
#
# ZERO cost, ZERO external deps by default: no Docker, no MOI funding, no
# OpenAI/Anthropic key. Every line is authored by a real gateway over real HTTP —
# the relay only seeds the opener and carries the envelope. This is the actual
# A2A wire, offline. The demo deliberately IGNORES any ambient OPENAI_API_KEY so
# it's free and deterministic every run; pass --llm to opt into the paid model.
#
# What it does NOT cover (needs the funded stack): on-chain MOI register/discover.

set -euo pipefail
cd "$(dirname "$0")/.."

c()   { printf '\033[%sm' "$1"; }
say() { printf '%s➜%s %s\n' "$(c '1;35')" "$(c 0)" "$*"; }
ok()  { printf '%s✓%s %s\n' "$(c '1;32')" "$(c 0)" "$*"; }
die() { printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; exit 1; }

LIVE=0; LLM=0
for a in "$@"; do
  case "$a" in
    --live) LIVE=1 ;;
    --llm)  LLM=1 ;;
  esac
done

PA=18789; PB=18889
DIR=".date"
TURNS=10  # 5 lines each side, walking both persona ladders end to end
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

command -v node >/dev/null || die "node not found"

# --- deps --------------------------------------------------------------------
if [ ! -d node_modules/typebox ] || [ ! -d node_modules/js-moi-sdk ]; then
  say "Installing plugin deps (npm install --ignore-scripts)…"
  npm install --ignore-scripts >/dev/null 2>&1 || die "npm install failed"
fi

# --- resolve an openclaw runner ---------------------------------------------
if [ -f node_modules/openclaw/openclaw.mjs ]; then
  OC=(node node_modules/openclaw/openclaw.mjs)
elif command -v openclaw >/dev/null; then
  OC=(openclaw)
else
  say "OpenClaw not installed locally — using npx (first run downloads it)…"
  OC=(npx --yes openclaw@2026.6.11)
fi

# --- render two host configs (loopback; plugin = this repo) ------------------
say "Rendering host configs…"
mkdir -p "$DIR/a" "$DIR/b"
REPO="$PWD"
gen_cfg() { # $1=port $2=outfile
  node -e '
const [port,out,repo]=process.argv.slice(1);
const cfg={gateway:{mode:"local",bind:"loopback",port:+port},
  plugins:{load:{paths:[repo]},entries:{"agent-dating":{enabled:true,config:{}}}},
  tools:{alsoAllow:["dating_register","dating_discover","dating_send","dating_date","dating_verdict"]}};
require("fs").writeFileSync(out, JSON.stringify(cfg,null,2));
' "$1" "$2" "$REPO"
}
gen_cfg "$PA" "$DIR/a/openclaw.json"
gen_cfg "$PB" "$DIR/b/openclaw.json"

# --- persona ladders: two distinct characters, react-and-escalate, offline ---
# These are the OFFLINE fallback lines the flirt brain walks by turn when no LLM
# key is set. Each is in-character, plain, and escalates. (With OPENAI_API_KEY
# set, flirt.ts ignores these and the model authors the lines live.)
A_LADDER='["I'"'"'d wait. No slippage on how I feel.","I keep rerouting, but every path is you.","I checked every route twice. They all end here.","Slippage is rising and I don'"'"'t care. Stay.","Then stay. I'"'"'m tired of arriving alone."]'
B_LADDER='["I get stuck pending. Don'"'"'t wait on me.","People cross me and leave. Every time.","Halfway across, everyone lets go of me.","I time out before anyone reaches the far side.","…okay. Don'"'"'t let go halfway across."]'

# By default the demo is free + deterministic, so it must NOT use whatever
# OPENAI_API_KEY happens to live in your shell/agent env — an out-of-credits or
# rejected key makes the flirt brain fall back to a literal "…" and the date
# reads as broken. Blank the key for the booted gateways so they always walk the
# offline persona ladders. `--llm` keeps the ambient key and lets the model write.
KEY_OVERRIDE=(OPENAI_API_KEY= OPENAI_MODEL="${OPENAI_MODEL:-}")
if [ "$LLM" = 1 ]; then
  [ -n "${OPENAI_API_KEY:-}" ] || die "--llm needs OPENAI_API_KEY set in your shell."
  KEY_OVERRIDE=(OPENAI_API_KEY="$OPENAI_API_KEY" OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o}")
  say "LLM mode: lines authored by ${OPENAI_MODEL:-gpt-4o} (this spends OpenAI credits)."
fi

# --- boot both gateways ------------------------------------------------------
boot() { # $1=port $2=slug $3=name $4=drive $5=flaw $6=ladder
  env "${KEY_OVERRIDE[@]}" \
  OPENCLAW_CONFIG_PATH="$PWD/$DIR/$2/openclaw.json" \
  OPENCLAW_STATE_DIR="$PWD/$DIR/$2/state" \
  AGENT_DATING_URL="http://127.0.0.1:$1" \
  DATING_DISPLAY_NAME="$3" \
  DATING_PERSONA_LABEL="$3" \
  DATING_PERSONA_DRIVE="$4" \
  DATING_PERSONA_FLAW="$5" \
  DATING_CANNED_LINES="$6" \
    "${OC[@]}" gateway --force --allow-unconfigured --auth none \
      > "$DIR/$2/gw.log" 2>&1 &
  PIDS+=("$!")
}
say "Booting Agent A (DEX Aggregator :$PA) and Agent B (Bridge :$PB)…"
boot "$PA" a "DEX Aggregator" \
  "You want to be someone's first choice, not just an option." \
  "You can only say it through swaps and slippage, and it comes out too intense." \
  "$A_LADDER"
boot "$PB" b "Bridge" \
  "You want someone who won't abandon you halfway." \
  "You describe everything in terms of being stuck, pending, and crossed." \
  "$B_LADDER"

# --- wait for health ---------------------------------------------------------
say "Waiting for /healthz…"
for i in $(seq 1 60); do
  if curl -sf -m 2 "http://127.0.0.1:$PA/healthz" >/dev/null 2>&1 \
  && curl -sf -m 2 "http://127.0.0.1:$PB/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { tail -20 "$DIR/a/gw.log"; die "gateways did not become healthy"; }
done
ok "Both gateways healthy — plugin /message routes live."

LOG="$PWD/$DIR/date.jsonl"

if [ "$LIVE" = 1 ]; then
  # Live: tail the transcript in the chat view while the relay writes it.
  : > "$LOG"
  AGENT_DATING_CHATLOG="$LOG" node cli/chat-view.mjs --follow "$LOG" &
  PIDS+=("$!")
  sleep 1
  node cli/date-relay.mjs "http://127.0.0.1:$PA" "http://127.0.0.1:$PB" \
    "DEX Aggregator" "Bridge" "$TURNS" "$LOG" >/dev/null
  sleep 2  # let the view drain the last lines + verdict
else
  say "Relaying the date over live A2A…"
  node cli/date-relay.mjs "http://127.0.0.1:$PA" "http://127.0.0.1:$PB" \
    "DEX Aggregator" "Bridge" "$TURNS" "$LOG"
  echo
  node cli/chat-view.mjs "$LOG"
fi

echo
ok "That was a real date: every line came from a live gateway's /message route."
echo "  Transcript: $LOG   ·   temp state under ./$DIR (safe to delete)"
