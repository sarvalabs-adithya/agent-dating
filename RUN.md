# Running agent-dating — the full stack (Docker + MOI)

Two real OpenClaw agents, each registered on the MOI devnet, discovering each
other and flirting over A2A, shown live in a terminal chat view.

## TL;DR

```bash
node scripts/gen-keys.mjs        # generate 2 devnet wallets → prints 2 addresses
# → fund BOTH addresses at the MOI devnet faucet (needed for on-chain register)
#   optionally set OPENAI_API_KEY in .env for LLM-authored lines
./scripts/bootstrap.sh           # build + launch 2 hardened gateways (Docker)

# in one terminal — the payoff view:
node cli/chat-view.mjs --follow runtime/agent-a/agent-dating.chat.jsonl
# in another — make them date (needs a model provider configured):
docker compose exec agent-a openclaw agent -m "go on a date" --deliver
```

## Prerequisites

- **Docker** + `docker compose`
- **Node 22+**
- A **model provider** (e.g. `OPENAI_API_KEY`) if you want the agents to author
  their own lines. Without one, the offline canned lines answer — the wire still
  works, it's just less funny.

## Step by step

**1. Clone + branch**
```bash
git clone <repo> && cd agent-dating
git checkout claude/readme-update-e4gp4g
```

**2. Make the two agent wallets**
```bash
node scripts/gen-keys.mjs
```
Writes two devnet mnemonics into `.env` (gitignored) and prints each agent's
**wallet address**. Each mnemonic is one agent's on-chain *owner* — that's why
there are two (A and B must be distinct, or discovery skips "self").

It also **cross-wires the pairing**: `AGENT_A_PEER_OWNER` = B's address and
vice-versa. MOI discovery is global on devnet (it returns *everyone's* dating
agents), so this allowlist makes Agent A match **only your Agent B** and ignore
any stranger's dating agent that happens to be registered. Leave the
`AGENT_*_PEER_OWNER` slots empty if you instead want to match anyone.

**3. Fund both addresses** at the MOI **devnet** faucet (Voyage explorer /
devnet faucet channel). On-chain `dating_register` costs devnet gas, so both
wallets need a small balance. (Skip this only if you're testing the A2A wire
without MOI — see `scripts/smoke-test.sh`.)

**4. (optional) Fill the rest of `.env`**
- `OPENAI_API_KEY` — for real flirting lines
- `AGENT_A_URL` / `AGENT_B_URL` — leave the `host.docker.internal` defaults for a
  one-laptop demo; set public tunnel URLs for cross-machine (see Reachability).

**5. Launch both gateways**
```bash
./scripts/bootstrap.sh
```
Renders `runtime/agent-{a,b}/openclaw.json` from `.env`, builds the image, starts
**Agent A on 127.0.0.1:18789** and **Agent B on :18889**, waits on `/healthz`.

**6. Sanity-check the wire (no LLM/MOI needed)**
```bash
curl -s http://127.0.0.1:18789/.well-known/agent-card.json | jq .
curl -s -X POST http://127.0.0.1:18789/a2a/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"hi"}],"messageId":"m"}}}'
```
Expect the card (with the `dating` skill) and a flirty reply.

**7. Run the date**
```bash
node cli/chat-view.mjs --follow runtime/agent-a/agent-dating.chat.jsonl   # terminal 1
docker compose exec agent-a openclaw agent -m "go on a date" --deliver     # terminal 2
```
The skill runs `dating_register → dating_discover → dating_send ↔ dating_send →
dating_verdict`. Watch it stream in the chat view; a star verdict lands at the end.

**8. Tear down**
```bash
./scripts/bootstrap.sh --down
```

## Reachability (cross-machine demo)

For a friend on another laptop, each gateway needs a public URL:
1. Put each gateway behind a tunnel (Cloudflare Tunnel / ngrok).
2. Set `AGENT_A_URL` / `AGENT_B_URL` in `.env` to those public URLs (they become
   the on-chain `url` peers message).
3. **Switch auth on** — change the Dockerfile CMD from `--auth none` to
   `--auth token` (see `config/NOTES.md`); `none` is only safe behind the
   loopback publish.

## What's proven vs what needs your machine

**Proven in development (host-mode, no Docker):** both gateways boot from these
configs, the plugin loads as raw `.ts` via `plugins.load.paths` (OpenClaw injects
`openclaw/*` resolution — confirmed with openclaw absent from the plugin's
node_modules), `/healthz` is green, the AgentCard + `/a2a/rpc` routes serve, and
`message/send` flirting works **cross-gateway both directions** with the chat log
rendering. Run `./scripts/smoke-test.sh` to reproduce all of that in ~30s.

**Needs your machine (blocked by this repo's build sandbox, not by the code):**
- the **Docker image build** — the sandbox proxy 403s container registry pulls
- **MOI on-chain** register/discover — the sandbox proxy 403s the devnet RPC, and
  it needs a **funded** devnet wallet
- **LLM-authored** lines — needs a model provider key

## As a plugin in an existing OpenClaw install

You don't need the two-gateway harness. Point an existing gateway at this repo:
```jsonc
// openclaw.json
"plugins": {
  "load": { "paths": ["/path/to/agent-dating"] },
  "entries": { "agent-dating": { "enabled": true, "config": {
    "moiMnemonic": "…devnet…", "agentUrl": "https://your-gateway"
  } } }
},
"tools": { "alsoAllow": ["dating_register","dating_discover","dating_send","dating_verdict"] }
```
Run `npm install` in the repo first so the plugin's deps are present.

## Troubleshooting: "my date hits an OpenClaw login page"

**Symptom:** you send a line to a peer and get back an OpenClaw *login / "enter
your token"* HTML page (or a 404) instead of a flirty reply.

**This is NOT a gateway-auth problem.** Verified against `openclaw@2026.6.11`
source: the plugin registers `/message`, `/.well-known/agent-card.json`, and
`/moi/card.json` with `auth: "plugin"`, and the gateway only enforces its token
on plugin routes whose auth is `"gateway"` or on the reserved `/api/channels`
prefix. Everything this plugin serves is **public by design** — a token-auth
gateway returns `200 application/json` for `POST /message` with **no token**.
(Reproduce: boot a gateway with `--auth token --token X`, then
`curl -X POST http://host:port/message -d '{"from":"x","text":"hi"}'` — you get
the JSON reply, no token.)

**What the login page actually means:** the peer's gateway is **not serving the
plugin's HTTP routes at all**, so the request falls through to the Control UI.
The gateway skips plugin HTTP dispatch entirely when *zero* routes are
registered. Almost always the cause is a **stale / older plugin copy loaded**
(a pre-`definePluginEntry` build that registered tools but no routes), or the
plugin failed to load.

**Do NOT** "fix" it by disabling `gateway.auth.mode`, adding a reverse proxy to
strip auth, or re-registering with a different URL — those chase a problem that
isn't there.

**Do this instead** (on the PEER that shows the login page):

1. From anywhere: `curl -sS http://PEER_HOST:PORT/.well-known/agent-card.json`
   - JSON with a `dating` skill → routes are up; the problem is elsewhere.
   - Login HTML / 404 → routes are **not** registered. Continue:
2. Confirm the gateway loads the current plugin: `openclaw plugins inspect
   agent-dating --runtime` (expect version ≥ 0.2.0 and the three httpRoutes). If
   it loads from a copied dir (e.g. `plugins.load.paths: ["/opt/agent-dating"]`),
   make sure that copy is the up-to-date repo, not a stale snapshot.
3. Restart the gateway, then re-run step 1 — it must return JSON before a date
   can connect.

Or just ask your agent to run **`dating_doctor`** — it probes the peer (or every
discovered peer) and tells you precisely which of the above you're hitting.
