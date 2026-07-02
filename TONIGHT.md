# TONIGHT — verify checklist

Built while you were away: **CLI chat view** + **bootstrap**, then I **reviewed
every `VERIFY:` seam against the real published packages** (installed
`openclaw@2026.6.11`, `js-moi-agent-registry@0.1.1`, `js-moi-sdk@0.7.0-rc15`,
read their type defs, and typechecked the plugin against them). Then I went
further and **RAN the two-gateway smoke test live in the sandbox** (host
processes, not Docker — image pulls are blocked by this sandbox's proxy).

## ✅ PROVEN LIVE (ran here — don't re-derive, just re-run)

- Two real gateways booted on **18789 + 18889** from our rendered configs.
- Both pass `/healthz` → `{"ok":true,"status":"live"}`.
- **The plugin loads as raw `.ts`** via `plugins.load.paths` — log shows
  `8 plugins: agent-dating, …`. No build step needed. (Former unknown #2: closed.)
- `GET /.well-known/agent-card.json` serves our card on a live gateway.
- `POST /a2a/rpc` `message/send` works **cross-gateway, both directions**
  (A→B on :18889 and B→A on :18789), returns a flirty line.
- The gateway **writes the chat log** and `cli/chat-view.mjs` renders it —
  the full pipeline (gateway → A2A → JSONL → WhatsApp view) ran end-to-end.

**Live-run bugs found + fixed (already committed):**
- `openclaw.json` schema is STRICT — my `__note` keys made the gateway refuse
  to boot (`<root>: Invalid input`). Removed; docs moved to `config/NOTES.md`.
- In Docker, `bind:"loopback"` would be unreachable through the port publish →
  templates now use `bind:"custom"` + `customBindHost:"0.0.0.0"` (host publish
  stays loopback-only).
- **`.dockerignore` was missing** — `COPY . /plugin` would have baked `.env`
  and `runtime/` (mnemonics!) into the image. Added.
- Gateway needs `--allow-unconfigured --auth none` to start without a model
  provider — Dockerfile CMD updated. (`--auth none` is fine ONLY behind the
  loopback publish; use `--auth token` for any tunnel — see config/NOTES.md.)

Ordered so you get the visual win in 30s, then work outward to the live-gateway
parts. Each step says **what you should see** and **what to check if it doesn't**.

---

## What the review changed (real bugs found by reading the SDKs)

- **`moi.ts` was wrong in 5 ways** vs the real `js-moi-agent-registry` API:
  uploader must be a bare function (not `{upload}`); `createAgent(spec, info)`
  takes `{protocol, protocolVersion}` + skills-with-tags (I'd passed a made-up
  shape); provider is `new VoyageProvider('devnet')` (not a guessed RPC URL);
  the card JSON is `{spec, agent_card}` (I'd parsed it flat); registered URL vs
  send target mismatched. **All rewritten; `moi.ts` now typechecks against the
  real SDK.**
- **`index.ts` import path was wrong**: `definePluginEntry` is exported from
  `openclaw/plugin-sdk/plugin-entry`, not `openclaw/plugin-sdk`.
- **`api.config` was wrong**: that's the whole gateway config — the plugin's own
  config is **`api.pluginConfig`**.
- **Tool shape was wrong**: `api.registerTool` needs a low-level `AnyAgentTool`
  with `label` + `execute(toolCallId, params, …) → {content, details}`. My tools
  used the ergonomic `execute(params)` shape, so `params` was actually the
  toolCallId. **Added an adapter; correct now.**
- **`configSchema`** must be wrapped with `buildJsonPluginConfigSchema(...)`, not
  a raw TypeBox object.
- **Dockerfile launch was wrong**: `openclaw gateway` has **no `--config` flag** —
  config path is the `OPENCLAW_CONFIG_PATH` env. Fixed.
- **Config schema was wrong**: local plugins load via `plugins.load.paths`, not a
  `path` key inside `plugins.entries`; `gateway.bind` is `"loopback"` (not an IP);
  `gateway.mode: "local"` is required. All fixed and re-rendered.
- **A2A method name**: spec JSON-RPC method is **`message/send`** (I'd used
  `SendMessage`). Fixed outbound; inbound accepts both.

Confirmed already-correct: `Wallet.fromMnemonic(mnemonic, path)`,
`wallet.connect(provider)`, `getIdentifier().toHex()`, `getAgentProfile → {profile,
found}`, `getAllAgentIds`, `registerHttpRoute({path, auth:"plugin", match, handler})`,
handler `(req,res)→boolean`, `/healthz`, `tools.alsoAllow`.

---

## 0. Prereqs (10s)
```bash
node --version      # want >= 22
docker compose version
```

## 1. See the chat view — no gateway needed (30s)  ✅ tested here
```bash
node cli/chat-view.mjs --demo
```
**Expect:** pink "AGENT DATING" banner, right-aligned green bubbles (self) vs
left-aligned purple bubbles (peer), timestamps + ✓✓, then a ★ **verdict card**.
Run in a real color terminal for the typing animation.

## 2. Confirm plugin-format logs render (1 min)  ✅ tested here
```bash
mkdir -p /tmp/adv && cat > /tmp/adv/c.jsonl <<'EOF'
{"type":"meta","self":{"name":"DEX"},"peer":{"name":"Bridge"},"startedAt":"2026-07-01T19:30:00Z"}
{"type":"msg","speaker":"self","name":"DEX","line":"Every route led to you.","at":"2026-07-01T19:30:04Z"}
{"type":"msg","speaker":"peer","name":"Bridge","line":"I get stuck pending. Don't wait.","at":"2026-07-01T19:30:10Z"}
{"type":"verdict","rating":4.2,"headline":"They actually meant it","note":"2 lines · guard dropped","at":"2026-07-01T19:30:20Z"}
EOF
node cli/chat-view.mjs /tmp/adv/c.jsonl           # render once
node cli/chat-view.mjs --follow /tmp/adv/c.jsonl  # tail live (Ctrl-C to quit)
```

## 3. Bring up the two gateways (5–10 min; first build is slow)
```bash
cp .env.example .env       # then edit: two DEVNET mnemonics + OPENAI_API_KEY
./scripts/bootstrap.sh
```
**Expect:** configs render to `runtime/agent-{a,b}/openclaw.json` → images build →
both up → `✓ agent-a healthy on :18789` / `:18889`.
- **If health never passes** → `docker compose logs agent-a`. The launch + config
  schema are now verified against `openclaw@2026.6.11`, so a failure here is most
  likely: (a) the openclaw pin drifted — bump `openclaw@2026.6.11` in
  `docker/Dockerfile`; (b) `gateway.mode=local` rejected — try adding
  `--allow-unconfigured` to the Dockerfile CMD; (c) the plugin needs a build step
  (it ships `.ts`; OpenClaw loads TS extensions, but confirm it doesn't want a
  compiled `dist/`).

## 4. A2A smoke test — the wire, WITHOUT LLM or MOI (2 min)
Isolates the routes (`src/index.ts` + `src/a2a.ts`):
```bash
# 4a. AgentCard discovery
curl -s http://127.0.0.1:18789/.well-known/agent-card.json | jq .
# Expect: AgentCard JSON, url ".../a2a/rpc", skills[0].tags == ["dating"].
# 503 "agentUrl not configured" → AGENT_A_URL didn't reach the plugin.

# 4b. Self-hosted MOI card (what card_uri points at)
curl -s http://127.0.0.1:18789/moi/card.json | jq .
# 404 until dating_register has run once (card is stashed at register time).

# 4c. Send a line straight to Agent A's inbox (note: message/send)
curl -s -X POST http://127.0.0.1:18789/a2a/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"t1","method":"message/send",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"hi there"}],"messageId":"m1"}}}' | jq .
# Expect: result.parts[0].text = a flirty line, AND
#         runtime/agent-a/agent-dating.chat.jsonl gains two msg lines.
```
- **Routes 404** → check `docker compose logs` for route registration at boot; the
  `registerHttpRoute` shape is verified, so suspect plugin-load (Step 3c).

## 5. Two-gateway A2A — B answers A (2 min)
```bash
docker compose exec agent-a sh -c \
 'curl -s -X POST http://host.docker.internal:18889/a2a/rpc \
   -H "Content-Type: application/json" \
   -d "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"hey\"}],\"messageId\":\"m2\"}}}"'
```
**Expect:** a JSON reply from B. Proves `host.docker.internal` + loopback publish.

## 6. A real date end-to-end (needs LLM + MOI devnet) (5–10 min)
Trigger a turn on Agent A (verified command):
```bash
docker compose exec agent-a openclaw agent -m "go on a date" --deliver
```
Watch it live:
```bash
node cli/chat-view.mjs --follow runtime/agent-a/agent-dating.chat.jsonl
```
**Expect:** register → discover → alternating `dating_send` → `dating_verdict` → card.
- **Isolate MOI first:** run `dating_register` on both, then `dating_discover` on
  A — does it find B? The SDK *surface* is verified; what's unproven is whether the
  on-chain tx lands (needs a **funded devnet wallet**) and whether `getAllAgentIds`
  returns the peer. MOI errors here are runtime/funding, not API-shape.
- **Replies not in B's persona:** expected — the inbound `/a2a/rpc` responder uses
  the shared `flirt.ts` brain, not B's own LLM session (deliberate; see below).

---

## Genuinely still unproven (needs YOUR laptop)

| # | Item | Why it couldn't run here |
|---|---|---|
| 1 | **Docker image build + container networking** (Step 3) | Sandbox proxy 403s registry CDN pulls (Docker Hub AND ECR). Everything inside the image is proven on host; the packaging isn't. |
| 2 | MOI on-chain register→discover | Needs a **funded devnet** wallet |
| 3 | LLM-generated flirt lines | No `OPENAI_API_KEY` here — the offline canned fallback answered (note: canned lines are DEX-flavored regardless of persona; cosmetic) |
| 4 | The agent-driven "go on a date" flow (`openclaw agent -m …`) | Needs a configured model provider |
| 5 | Inbound A2A → B's **own LLM session** (uses `flirt.ts` today, by design) | Enhancement, not a bug |

**Also proven earlier:** whole `src/` typechecks against the real installed
packages; chat-view `--demo`/`--follow` (single-flight tail — no dupes/drops);
config rendering with quote-heavy values; `node --check`/`bash -n` all pass.
