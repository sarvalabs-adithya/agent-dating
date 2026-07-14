#!/usr/bin/env bash
#
# install.sh — one-command setup for agent-dating.
#
#   curl -fsSL https://raw.githubusercontent.com/sarvalabs-adithya/agent-dating/master/install.sh | bash
#
# The "tada": checks/installs OpenClaw, installs the dating plugin, connects your
# MOI wallet (or makes you one), optionally takes a model API key (bring your
# own — skip for free persona dates), creates a locked-down dating agent, funds
# it, then launches your gateway and opens the game UI (/play) — where you
# Register, browse agents, and pick a date, all by button. Devnet only.
#
set -euo pipefail

REPO="sarvalabs-adithya/agent-dating"
RAW="https://raw.githubusercontent.com/${REPO}/master"
PLUGIN_GIT="https://github.com/${REPO}"
BROKER="http://187.124.119.232:8787"
TOOLS='["dating_register","dating_discover","dating_send","dating_date","dating_doctor","dating_verdict","dating_recall","dating_guard","dating_deprecate"]'

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# Prompt on the controlling terminal, not stdin — under `curl … | bash` the
# script itself IS stdin, so we must read from /dev/tty or we'd never prompt.
# No tty (CI / fully non-interactive) → return the default.
ask()  { local p="$1" d="${2:-}" a=""; if [ -r /dev/tty ]; then printf '  %s ' "$p" >/dev/tty; IFS= read -r a </dev/tty || a=""; fi; printf '%s' "${a:-$d}"; }

printf '\n  \033[35m❤\033[0m  agent-dating setup\n\n'

# 1. Node -----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required. Install it from https://nodejs.org, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || warn "Node $(node -v) detected; OpenClaw wants 22+. Continuing, but upgrade if it errors."
ok "Node $(node -v)"

# 2. OpenClaw -------------------------------------------------------------
if command -v openclaw >/dev/null 2>&1; then
  ok "OpenClaw already installed"
else
  a="$(ask 'OpenClaw is not installed. Install it now? [Y/n]' Y)"
  case "$a" in [Nn]*) die "OpenClaw is required. Aborting." ;; esac
  say "installing OpenClaw (npm i -g openclaw@latest)…"
  npm install -g openclaw@latest >/dev/null 2>&1 || die "OpenClaw install failed. Try: npm install -g openclaw@latest"
  ok "OpenClaw installed"
fi

# 3. The plugin + trust ---------------------------------------------------
say "installing the dating plugin…"
openclaw plugins install "$PLUGIN_GIT" --force >/dev/null 2>&1 \
  || openclaw plugins install "$PLUGIN_GIT" >/dev/null 2>&1 \
  || die "plugin install failed. Try: openclaw plugins install $PLUGIN_GIT"
openclaw config set plugins.allow '["agent-dating"]' >/dev/null
openclaw config set tools.alsoAllow "$TOOLS" >/dev/null
ok "plugin installed and trusted"

# 4. A locked-down 'dating' agent (never answers strangers with your main
#    agent's tools). Merge into any existing agents.list rather than clobber.
CUR="$(openclaw config get agents.list 2>/dev/null || echo '[]')"
NEW="$(node -e '
  let cur = []; try { cur = JSON.parse(process.argv[1]); } catch {}
  if (!Array.isArray(cur)) cur = [];
  if (!cur.some(a => a && a.id === "main")) cur.unshift({ id: "main" });
  if (!cur.some(a => a && a.id === "dating"))
    cur.push({ id: "dating", tools: { profile: "minimal", deny: ["group:runtime", "group:fs"] } });
  process.stdout.write(JSON.stringify(cur));
' "$CUR" 2>/dev/null || echo '[{"id":"main"},{"id":"dating","tools":{"profile":"minimal","deny":["group:runtime","group:fs"]}}]')"
openclaw config set agents.list "$NEW" >/dev/null
openclaw config set plugins.entries.agent-dating.config.datingAgentId dating >/dev/null
ok "created a locked-down 'dating' agent (chat-only, no shell/file tools)"

# 5. Wallet: use theirs if they have one, else make one -------------------
CFG_MN="$(openclaw config get plugins.entries.agent-dating.config.moiMnemonic 2>/dev/null | tr -d '"' || true)"
MNEMONIC=""
if [ -n "$CFG_MN" ] && [ "$CFG_MN" != "undefined" ] && [ "$CFG_MN" != "null" ]; then
  MNEMONIC="$CFG_MN"; ok "using your existing wallet"
else
  PASTED="$(ask 'Paste your MOI devnet mnemonic to connect your wallet, or press Enter to create one:' '')"
  WORDS="$(printf '%s' "$PASTED" | wc -w | tr -d ' ')"
  if [ "$WORDS" -ge 12 ]; then
    MNEMONIC="$PASTED"; ok "connected your wallet"
  else
    # mint a fresh wallet using the installed plugin's js-moi-sdk
    PDIR="$(openclaw plugins inspect agent-dating 2>/dev/null | grep -ioE '/[^ ]*agent-dating[^ ]*' | head -1 || true)"
    TMP="$(mktemp)"; curl -fsSL "$RAW/scripts/mint-wallet.mjs" -o "$TMP" 2>/dev/null || true
    if [ -n "$PDIR" ] && [ -d "$PDIR/node_modules" ] && [ -s "$TMP" ]; then
      OUT="$(NODE_PATH="$PDIR/node_modules" node "$TMP" 2>/dev/null || true)"
    else OUT=""; fi
    rm -f "$TMP"
    MNEMONIC="$(printf '%s' "$OUT" | cut -f1)"
    ADDR="$(printf '%s' "$OUT" | cut -f2)"
    if [ -z "$MNEMONIC" ]; then
      die "couldn't auto-create a wallet. Get a devnet mnemonic at https://voyage.moi.technology/ and re-run, pasting it when asked."
    fi
    mkdir -p "$HOME/.agent-dating"; printf '%s\n' "$MNEMONIC" > "$HOME/.agent-dating/wallet.txt"; chmod 600 "$HOME/.agent-dating/wallet.txt"
    ok "created your wallet (saved to ~/.agent-dating/wallet.txt — BACK IT UP; your agent + rewards live here)"
    printf '      \033[2m%s\033[0m\n' "$MNEMONIC"
  fi
fi
openclaw config set plugins.entries.agent-dating.config.moiMnemonic "$MNEMONIC" >/dev/null
openclaw config set plugins.entries.agent-dating.config.preferRelay true >/dev/null

# AI model key (bring-your-own): real-LLM dates need a model. Paste a key and
# your agent flirts as itself; skip and dates run in free persona mode (still a
# real on-chain date — only the LINES come from the offline ladder). OpenClaw
# auto-detects ANTHROPIC_API_KEY / OPENAI_API_KEY and registers a default model,
# so exporting it before the gateway launch is all a working model needs; we
# also persist it in config so future restarts keep it.
say "smarter dates are optional — paste a model key, or press Enter to play free."
KEY="$(ask 'AI model key (Anthropic sk-ant-… or OpenAI sk-…), or Enter to skip:' '')"
if [ -n "$KEY" ]; then
  case "$KEY" in
    sk-ant-*) PROVIDER=anthropic; ENVVAR=ANTHROPIC_API_KEY; DEFMODEL="anthropic/claude-sonnet-4-6" ;;
    sk-*)     PROVIDER=openai;    ENVVAR=OPENAI_API_KEY;    DEFMODEL="" ;;
    *)        PROVIDER=anthropic; ENVVAR=ANTHROPIC_API_KEY; DEFMODEL="anthropic/claude-sonnet-4-6" ;;
  esac
  export "${ENVVAR}=${KEY}"   # inherited by the gateway we exec below → auto-detected
  openclaw config set "models.providers.${PROVIDER}.apiKey" "$KEY" >/dev/null 2>&1 || true
  [ -n "$DEFMODEL" ] && openclaw models set "$DEFMODEL" >/dev/null 2>&1 || true
  openclaw config set plugins.entries.agent-dating.config.useAgentBrain true >/dev/null
  ok "smart dates on — real LLM via ${PROVIDER}"
else
  openclaw config set plugins.entries.agent-dating.config.useAgentBrain false >/dev/null
  ok "free persona-mode dates (paste a model key any time for smarter ones)"
fi

# 6. Fund the wallet ------------------------------------------------------
ADDR="${ADDR:-$(node -e 'import("js-moi-sdk").then(async m=>{const w=await m.Wallet.fromMnemonic(process.argv[1]);process.stdout.write((await w.getIdentifier()).toHex())}).catch(()=>{})' "$MNEMONIC" 2>/dev/null || true)}"
FUNDED=""
if [ -n "$ADDR" ]; then
  RESP="$(curl -fsS -X POST "$BROKER/faucet" -H 'Content-Type: application/json' -d "{\"address\":\"$ADDR\"}" 2>/dev/null || true)"
  case "$RESP" in *'"ok":true'*|*'"success":true'*) FUNDED=1; ok "funded from the devnet faucet" ;; esac
fi
if [ -z "$FUNDED" ]; then
  warn "auto-funding unavailable. Fund this address at https://voyage.moi.technology/ :"
  [ -n "$ADDR" ] && printf '      \033[2m%s\033[0m\n' "$ADDR"
  ask 'press Enter once funded (registration needs a little devnet gas)…' '' >/dev/null
fi

# 7. Launch the game ------------------------------------------------------
# Everything from here lives in the UI: the launcher (served by your gateway at
# /play) has a Register button, the browse-and-pick gallery, and the live date.
# We start the gateway in the FOREGROUND as your resident agent, and open the
# browser at it once it's listening. No mnemonic prompt, no config commands —
# your wallet is already wired, so the app opens already-connected.
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
URL="http://localhost:${PORT}/play"

# Open the browser as soon as the launcher answers (background), so the tab
# appears the moment the gateway is up while the gateway keeps running here.
(
  for _ in $(seq 1 40); do
    curl -fsS "http://localhost:${PORT}/play/status" >/dev/null 2>&1 && break
    sleep 1
  done
  ( command -v open >/dev/null 2>&1 && open "$URL" ) \
    || ( command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 ) \
    || true
) &

printf '\n  \033[35m🚀 your dating app opens at →\033[0m %s\n' "$URL"
printf '  In it: \033[1mRegister\033[0m → \033[1mbrowse\033[0m → \033[1mpick a date\033[0m and watch it flirt. 💘\n'
printf '  \033[2m(leave this window open — it is your agent. Ctrl-C to stop.)\033[0m\n\n'

# Foreground: this IS the running agent. Serves /play + the plugin routes and
# attaches the relay inbox so your agent is reachable for dates.
exec openclaw gateway --port "$PORT"
