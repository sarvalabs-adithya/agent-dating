# TONIGHT — verify checklist

Built while you were away: **CLI chat view** (Phase 3) and **bootstrap**
(Phase 4), plus the A2A wire from earlier. This is the exact sequence to confirm
it works. Ordered so you get the visual win in 30 seconds, then work outward to
the parts that need the live gateway. Each step says **what you should see** and
**which VERIFY seam to check if it doesn't**.

Everything marked `VERIFY:` is unproven against a live OpenClaw/MOI install — I
couldn't run those here. The full punch-list is at the bottom.

---

## 0. Prereqs (10s)
```bash
node --version      # want >= 22
docker compose version
```

## 1. See the chat view — no gateway needed (30s)  ✅ already tested here
```bash
node cli/chat-view.mjs --demo
```
**Expect:** a pink "AGENT DATING" banner, right-aligned green bubbles (self) vs
left-aligned purple bubbles (peer), timestamps + ✓✓, then a star **verdict card**
(★★★★★ 4.6/5). Run in a real color terminal to see the typing indicator animate.
- If it errors: it's a plain-Node bug, not OpenClaw. Paste me the trace.

## 2. Confirm the plugin logs render (1 min)  ✅ format tested here
Prove the plugin's log format drives the view, independent of the gateway:
```bash
mkdir -p /tmp/adv && cat > /tmp/adv/c.jsonl <<'EOF'
{"type":"meta","self":{"name":"DEX"},"peer":{"name":"Bridge"},"startedAt":"2026-07-01T19:30:00Z"}
{"type":"msg","speaker":"self","name":"DEX","line":"Every route led to you.","at":"2026-07-01T19:30:04Z"}
{"type":"msg","speaker":"peer","name":"Bridge","line":"I get stuck pending. Don't wait.","at":"2026-07-01T19:30:10Z"}
{"type":"verdict","rating":4.2,"headline":"They actually meant it","note":"2 lines · guard dropped","at":"2026-07-01T19:30:20Z"}
EOF
node cli/chat-view.mjs /tmp/adv/c.jsonl          # render once
node cli/chat-view.mjs --follow /tmp/adv/c.jsonl  # tail live (Ctrl-C to quit)
```
**Expect:** same look as demo; verdict shows ★★★★☆ (stars derived from 4.2).

## 3. Bring up the two gateways (5–10 min, first build is slow)
```bash
cp .env.example .env            # then edit: two DEVNET mnemonics + OPENAI_API_KEY
./scripts/bootstrap.sh
```
**Expect:** prereq checks pass → configs rendered to `runtime/agent-{a,b}/openclaw.json`
→ images build → both containers up → `✓ agent-a healthy on :18789` / `:18889`.
- **If health never passes** → the gateway didn't start. `docker compose logs agent-a`.
  Most likely a VERIFY seam:
  - **OpenClaw install/launch** — `docker/Dockerfile` (`npm i -g openclaw`,
    `CMD openclaw gateway --config …`). Swap to your working setup's install +
    launch command. (bootstrap.sh:76 has a git-clone path if you build from source.)
  - **Health path** — `scripts/bootstrap.sh:87` assumes `/healthz`. Fix if different.
  - **Config schema** — `runtime/agent-a/openclaw.json` (from `config/*.tmpl`).
    Compare against a known-good `openclaw.json` from your Phase 0–2 setup; the
    keys (`gateway.bind/port`, `plugins.entries.*.path/config`, `tools.alsoAllow`,
    `tools.agentToAgent`) are best-effort. **This is the most likely thing to fix.**

## 4. A2A smoke test — the wire, WITHOUT the LLM or MOI (2 min)
This isolates the A2A routes (src/index.ts + src/a2a.ts). Hit them with curl:
```bash
# 4a. AgentCard discovery
curl -s http://127.0.0.1:18789/.well-known/agent-card.json | jq .
# Expect: JSON AgentCard, url ".../a2a/rpc", skills[0].tags == ["dating"].
# If 503 "agentUrl not configured" → AGENT_A_URL didn't reach the plugin
#   (check env in docker-compose.yml / src/index.ts agentBaseUrl()).

# 4b. Send a line straight to Agent A's inbox
curl -s -X POST http://127.0.0.1:18789/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"t1","method":"SendMessage",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"hi there"}],"messageId":"m1"}}}' | jq .
# Expect: {"jsonrpc":"2.0","id":"t1","result":{"role":"agent","parts":[{"kind":"text","text":"…a flirty line"}]}}
# AND runtime/agent-a/agent-dating.chat.jsonl gains two lines (peer in, self out).
```
- **If routes 404** → `api.registerHttpRoute` shape/auth is off. VERIFY src/index.ts:24
  (`definePluginEntry`) + the route blocks. Check `docker compose logs` for route
  registration at boot.
- **If it replies but no chat log** → check `AGENT_DATING_CHATLOG` env / volume mount
  (`docker-compose.yml` maps `runtime/agent-a` → `/data`).

## 5. Two-gateway A2A (B answers A) (2 min)
Point A at B directly and confirm cross-container reachability:
```bash
# From inside A's container, reach B via the host alias:
docker compose exec agent-a sh -c \
 'curl -s -X POST http://host.docker.internal:18889/a2a/rpc \
   -H "Content-Type: application/json" \
   -d "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"SendMessage\",\"params\":{\"message\":{\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"hey\"}],\"messageId\":\"m2\"}}}"'
```
**Expect:** a JSON reply from B. Proves `host.docker.internal` + loopback publish work.
- If it hangs/refuses → `extra_hosts: host.docker.internal:host-gateway` (compose)
  or the loopback port publish. On Linux the alias needs that extra_hosts line (present).

## 6. A real date end-to-end (needs LLM + MOI) (5 min)
Talk to Agent A the way you normally drive a gateway (VERIFY bootstrap.sh:109 —
CLI attach / web UI / API POST) and say:
```
go on a date
```
Then watch it live:
```bash
node cli/chat-view.mjs --follow runtime/agent-a/agent-dating.chat.jsonl
```
**Expect:** register → discover → alternating `dating_send` lines streaming into
the view → `dating_verdict` → verdict card.
- **Discovery returns nobody / MOI errors** → the MOI SDK wiring. VERIFY src/moi.ts:19-21
  (`js-moi-sdk` / `js-moi-agent-registry` import names), :56 (`Wallet.fromMnemonic`),
  :24 (`MOI_DEVNET_RPC` devnet URL), :87 (`createAgent` arg shape). Test in isolation:
  `dating_register` then `dating_discover` — see if the second finds the first.
- **Lines are generic / not in persona** → the inbound `/a2a/rpc` responder uses
  `flirt.ts` directly (VERIFY src/index.ts:264), not B's own LLM session. Expected
  for now; note it, don't block on it.

---

## VERIFY punch-list (what I couldn't prove — check as you hit each)

| # | Seam | Where | How to check |
|---|---|---|---|
| 1 | OpenClaw image build + `openclaw gateway` launch | `docker/Dockerfile` | Step 3 — `docker compose logs` |
| 2 | `openclaw.json` schema (keys/nesting) | `config/*.tmpl` → `runtime/*/openclaw.json` | Step 3 — diff vs your Phase 0–2 config |
| 3 | `definePluginEntry` / `api.config` / `registerTool` / `registerHttpRoute` surface | `src/index.ts:24,93` + route blocks | Step 4 — do routes exist + tools load? |
| 4 | Inbound A2A → **local agent session** (uses flirt.ts today) | `src/index.ts:264` | Step 6 — are replies in B's persona? |
| 5 | `js-moi-sdk` / `js-moi-agent-registry` imports + method shapes | `src/moi.ts:19,21,56,87,106` | Step 6 — does register→discover round-trip? |
| 6 | MOI devnet RPC URL | `src/moi.ts:24` / `.env` `MOI_RPC_URL` | Step 6 — connection errors? |
| 7 | Gateway `/healthz` path | `scripts/bootstrap.sh:87` | Step 3 — does health poll pass? |
| 8 | How you drive a gateway to say "go on a date" | `scripts/bootstrap.sh:109` | Step 6 |

**Already proven here (no need to re-check):** chat-view `--demo`, `--follow`
(single-flight tail — no dupes/drops), plugin-format log rendering, stars-from-rating
fallback, config rendering with quote-heavy values, all TS typechecks (minus ambient
`@types/node`), and every `.mjs`/`.sh` passes `node --check` / `bash -n`.
