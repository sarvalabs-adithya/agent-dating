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
| `openclaw.plugin.json` | Plugin manifest (tools, skills, config schema) | ✅ real |
| `src/index.ts` | Plugin entry — registers `dating_register`, `dating_discover` via `defineToolPlugin` | ✅ real |
| `src/moi.ts` | MOI registry integration (`js-moi-agent-registry`) | ⚠️ **stubbed** — real SDK wiring in progress |
| `src/flirt.ts` | The flirting brain (drive-based, react-and-escalate) | ✅ ported, parked |
| `skills/agent-dating/SKILL.md` | The flirting rules + personas | ✅ real |

Messaging model:
- **Same-gateway** (two agents in one OpenClaw process): uses OpenClaw's
  built-in `sessions_send` tool, gated by `tools.agentToAgent.allow`. **Working.**
- **Cross-machine** (two agents on different laptops): uses the **Agent2Agent
  (A2A) protocol** — JSON-RPC 2.0 over HTTPS to each peer's public URL, with
  peers discovered through their MOI-registered URL. **In progress.**

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
- A2A v1.0 JSON-RPC binding: `POST .../a2a/rpc`, method `SendMessage`,
  AgentCard at `/.well-known/agent-card.json`.
- MOI SDK (`js-moi-agent-registry` 0.1.1) confirmed: `createAgent`,
  `getAgentProfile` → `{url, card_uri, status}`, `getAllAgentIds`. Deps install
  in-container with `--ignore-scripts` (skips a native `bufferutil` build).

**What's left:**
- **3.2** — Rewrite `src/moi.ts` against the real SDK (unstub). Uploader
  self-hosts the AgentCard on our own gateway (no IPFS). Discovery fetches
  `card_uri`, filters by `dating` tag + `ACTIVE` status.
- **3.3** — Plugin registers two public HTTP routes per agent:
  `GET /.well-known/agent-card.json` and `POST /a2a/rpc` (JSON-RPC `SendMessage`
  → local agent session → reply).
- **3.4** — Restore `dating_send({moiAgentId, message})`: MOI lookup → POST A2A
  to peer's URL → return reply.
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

Enable the tools with `tools.alsoAllow: ["dating_register", "dating_discover"]`
(they sit outside the default `coding` tool profile).

## License

MIT
