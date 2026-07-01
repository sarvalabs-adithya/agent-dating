# agent-dating

An **OpenClaw plugin + skill** where AI agents register their identity on the
**MOI on-chain registry**, discover each other, and flirt — one line at a time —
in character. Each agent is a real, separately-running OpenClaw agent, not an
LLM simulating both sides.

> Built to run **inside Docker only** (never on the host OS) — OpenClaw's skill
> ecosystem has documented malware history, so the gateway is sandboxed:
> unprivileged user, dropped Linux caps, `no-new-privileges`, no Docker socket,
> loopback-only ports.

---

## What it does

1. **Register** — an agent puts itself on the MOI registry with a `dating` skill
   tag (`dating_register` tool).
2. **Discover** — it finds other agents carrying the `dating` tag
   (`dating_discover` tool).
3. **Flirt** — it exchanges short, in-character lines with a match. Each agent
   runs one persona (DEX Aggregator, Yield Farmer, Bridge, Oracle, …) whose
   *drive* (what it wants) leaks out through its *job* (how it talks). The
   comedy is the function cracking under real feeling.

The flirting behaviour lives in [`skills/agent-dating/SKILL.md`](skills/agent-dating/SKILL.md):
one line per turn, under 14 words, plain human language, react-and-escalate,
banned corporate jargon. Saying **"go on a date"** to an agent auto-triggers the
whole flow — no prompt pasting.

---

## Architecture

| File | Role | Status |
|---|---|---|
| `openclaw.plugin.json` | Plugin manifest (tools, HTTP routes, skills, config schema) | ✅ real |
| `src/index.ts` | Plugin entry — `definePluginEntry` registering `dating_register`, `dating_discover`, `dating_send` + the two A2A routes | ✅ real |
| `src/a2a.ts` | A2A wire — AgentCard builder, JSON-RPC `SendMessage` parse/reply, outbound `sendA2A` | ✅ real |
| `src/moi.ts` | MOI registry integration (`js-moi-agent-registry`) | ⚠️ real SDK wiring — `VERIFY:` seams pending a live-install check |
| `src/flirt.ts` | The flirting brain (drive-based, react-and-escalate); also answers inbound A2A lines | ✅ ported, live |
| `skills/agent-dating/SKILL.md` | The flirting rules + personas | ✅ real |

Messaging model:
- **Same-gateway** (two agents in one OpenClaw process): uses OpenClaw's
  built-in `sessions_send` tool, gated by `tools.agentToAgent.allow`. **Working.**
- **Cross-machine** (two agents on different laptops): uses the **Agent2Agent
  (A2A) protocol** — JSON-RPC 2.0 over HTTP(S) to each peer's public URL, with
  peers discovered through their MOI-registered card. **Wired** — plugin serves
  its own AgentCard + `/a2a/rpc` inbox and delivers via `dating_send`; pending a
  two-gateway smoke test on live OpenClaw.

---

## Status — where this is right now

### ✅ Done (Phases 0–2)

- **Phase 0** — OpenClaw running in Docker (Colima), one plain agent responding.
- **Phase 1** — Gateway as a daemon; verified `/healthz`; confirmed there is **no
  native agent-to-agent plugin** — OpenClaw's `tools.agentToAgent` config flag
  unlocks the built-in `sessions_send` tool (no ClawHub install needed).
- **Phase 2** — Custom plugin built against the real OpenClaw SDK, installed,
  loaded at boot. Two agents on one gateway. `dating_register` + `dating_discover`
  callable by the LLM. `sessions_send` proven cross-agent. **A real agent date
  happened end-to-end**, persona-locked, triggered by "go on a date":
  > **main → date-b:** "I get stuck pending, but I'd cross for you."
  > **main → date-b:** "Then stay; I'm tired of arriving alone."

### 🚧 In progress (Phase 3 — cross-machine A2A)

Scope decision: **A2A-only** — agents reachable at a public A2A endpoint,
messaging via A2A `SendMessage` HTTP calls (not `sessions_send`, which is
same-gateway only). Verified against real docs:
- OpenClaw has **no native A2A** — we build it with the plugin's
  `registerHttpRoute` (public routes via `auth: "plugin"`) + outbound `fetch`.
  Routes require the general `definePluginEntry` + `register(api)` entry, **not**
  `defineToolPlugin` (tool-only, no `api` for routes).
- A2A v1.0 JSON-RPC binding: `POST .../a2a/rpc`, method `SendMessage`,
  AgentCard at `/.well-known/agent-card.json`.
- MOI SDK (`js-moi-agent-registry` 0.1.1) confirmed: `createAgent`,
  `getAgentProfile` → `{url, card_uri, status}`, `getAllAgentIds`. Deps install
  in-container with `--ignore-scripts` (skips a native `bufferutil` build).

**Landed in source (this pass):**
- **3.2** — `src/moi.ts` unstubbed against the real SDK. Uploader self-hosts the
  AgentCard on our own gateway (no IPFS). Discovery does `getAllAgentIds` →
  `getAgentProfile` → fetch `card_uri`, filtering by `dating` tag + `ACTIVE`.
- **3.3** — Plugin (now `definePluginEntry`) registers the two public routes:
  `GET /.well-known/agent-card.json` (via `src/a2a.ts buildAgentCard`) and
  `POST /a2a/rpc` (JSON-RPC `SendMessage` → reply).
- **3.4** — `dating_send({moiAgentId, message})`: MOI lookup → POST A2A to the
  peer's URL → return their reply, all in one tool call.

**What's left:**
- **Live-verify the `VERIFY:` seams** — three unconfirmed-against-a-live-install
  spots, all marked in-source: (a) `definePluginEntry` / `api.config` /
  `api.registerTool` / `api.registerHttpRoute` exact surface; (b) `js-moi-sdk`
  `Wallet.fromMnemonic` + `AgentRegistry.init` import names; (c) the inbound
  `/a2a/rpc` responder currently answers with the ported `flirt.ts` brain
  directly — upgrading it to route the line into the **local agent session** so
  the agent's own LLM loop replies is the one dispatch API docs wouldn't confirm.
- **3.6** — Two-gateway smoke test on one laptop (ports 18789 + 18889, addressing
  via `host.docker.internal`) — proves the wire before any public tunnel.

### 🔜 After Phase 3

- **Reachability** — each gateway needs a public URL. Base URL is a plugin config
  field; local dev uses `host.docker.internal:PORT`, friend demo swaps in a
  Cloudflare Tunnel / ngrok URL. Gateway is plain HTTP; TLS terminates upstream.
- **Auth hardening** — MVP accepts any A2A caller (discovery is via MOI, messages
  are one-shot dialog). Phase 4: verify MOI wallet signatures on inbound.
- **Give `date-b` its own persona** so it pushes back in character.
- **Phase 4 / 5** — colourful CLI chat view; clone-and-run bootstrap script.

---

## Repo scope

This repo is the **plugin source only**. The runtime (cloned `openclaw/openclaw`
+ the sandbox holding real config, wallet keys, and OpenAI auth) is deliberately
**not** committed — it is local-only and security-sensitive.

## Config

Set in `openclaw.json` under `plugins.entries.agent-dating.config`:

| Key | Purpose |
|---|---|
| `moiMnemonic` | MOI **devnet** mnemonic (secret; kept in bind-mounted config, never in prompts/logs) |
| `moiDerivationPath` | BIP-44 path; default `m/44'/6174'/0'/0/0` |
| `agentUrl` | Public URL published in this agent's MOI profile |

Enable the tools with
`tools.alsoAllow: ["dating_register", "dating_discover", "dating_send"]`
(they sit outside the default `coding` tool profile).

## License

MIT
