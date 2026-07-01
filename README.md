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
3. **Flirt** — it exchanges short, in-character lines with a match over A2A
   (`dating_send`). Each agent runs one persona (DEX Aggregator, Yield Farmer,
   Bridge, Oracle, …) whose *drive* (what it wants) leaks out through its *job*
   (how it talks). The comedy is the function cracking under real feeling.
4. **Rate** — at the end it scores the date and posts a playful star verdict
   (`dating_verdict`).

The whole thing renders live in a **colorful, WhatsApp-style terminal chat
view** — two agents' lines streaming in, speaker colors, timestamps, and the
final date verdict card. That's the payoff:

```
node cli/chat-view.mjs --demo     # see the look right now, no gateway needed
```

The flirting behaviour lives in [`skills/agent-dating/SKILL.md`](skills/agent-dating/SKILL.md):
one line per turn, under 14 words, plain human language, react-and-escalate,
banned corporate jargon. Saying **"go on a date"** to an agent auto-triggers the
whole flow — no prompt pasting.

---

## Architecture

| File | Role | Status |
|---|---|---|
| `openclaw.plugin.json` | Plugin manifest (tools, HTTP routes, skills, config schema) | ✅ real |
| `src/index.ts` | Plugin entry — `definePluginEntry` registering the four `dating_*` tools + three routes | ✅ **typechecks vs real `openclaw@2026.6.11`** |
| `src/a2a.ts` | A2A wire — AgentCard builder, JSON-RPC `message/send` parse/reply, outbound `sendA2A` | ✅ real |
| `src/moi.ts` | MOI registry integration (`js-moi-agent-registry`) | ✅ **typechecks vs real SDK 0.1.1**; on-chain exec needs live devnet |
| `src/flirt.ts` | The flirting brain (drive-based, react-and-escalate); also answers inbound A2A lines | ✅ ported, live |
| `src/chatlog.ts` | JSONL chat-event log (plugin writes, CLI reads) | ✅ real, runs |
| `src/verdict.ts` | Deterministic playful date scorer (shared by `dating_verdict`) | ✅ real, runs |
| `cli/chat-view.mjs` | Zero-dep terminal chat view — `--demo` / `--follow` | ✅ real, **runs & tested** |
| `scripts/bootstrap.sh` | Clone-and-run: renders configs, builds + launches both gateways | ✅ built; launch + config schema verified vs real package |
| `docker-compose.yml` + `docker/Dockerfile` | Two hardened gateways on loopback ports | ✅ built; `openclaw gateway` + `OPENCLAW_CONFIG_PATH` verified |
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

**Reviewed against the real packages (installed + typechecked):** the `VERIFY:`
seams were checked against `openclaw@2026.6.11`, `js-moi-agent-registry@0.1.1`,
and `js-moi-sdk@0.7.0-rc15`. That fixed real bugs — see the "What the review
changed" list in [`TONIGHT.md`](TONIGHT.md) (moi API shape, plugin import path,
`api.pluginConfig`, tool `execute` signature, `configSchema` wrapper, Dockerfile
`OPENCLAW_CONFIG_PATH`, `plugins.load.paths`, `gateway.mode`, A2A `message/send`).
The whole `src/` now typechecks against the real SDKs.

**Genuinely still unproven (needs the live stack):**
- **On-chain execution** — the MOI API *surface* is verified, but whether
  `createAgent`'s tx lands and `getAllAgentIds` returns the peer needs a **funded
  devnet wallet**.
- **Plugin load form** — confirm OpenClaw loads the plugin as raw `.ts` via
  `plugins.load.paths` (vs wanting a compiled `dist/`).
- **3.6 two-gateway smoke test** — ports 18789 + 18889 via `host.docker.internal`.
- **Inbound → local agent session** — the `/a2a/rpc` responder answers with the
  ported `flirt.ts` brain today (by design); routing into B's own LLM loop is a
  planned enhancement, not a bug.

### ✅ CLI chat view (built + tested)

The colourful, WhatsApp-style live view is done and **runs today** (zero deps,
no build): `cli/chat-view.mjs`. Self lines are right-aligned green bubbles,
peer lines left-aligned coloured bubbles, with name labels, timestamps, ✓✓
receipts, a typing indicator, and a final star-rated **verdict card**. It reads
the JSONL chat log the plugin writes (`src/chatlog.ts`).
- `--demo` plays a scripted date (no gateway) — **verified end-to-end here**.
- `--follow <log>` tails a live date — **verified** against synthetic + real-shaped
  logs (single-flight tail: no double-render, no dropped lines).
- Wired into the real flow: `dating_send` logs both sides; the inbound `/a2a/rpc`
  handler logs the receiving side; `dating_verdict` appends the verdict.
- `VERIFY:` the only unproven part is that a **real** `dating_send` over a live
  gateway writes the log the view then renders — the pieces are wired, untested
  against a running gateway.

### ✅ Bootstrap (clone-and-run, built)

`scripts/bootstrap.sh` + `docker-compose.yml` + `docker/Dockerfile` +
`.env.example` + `config/*.tmpl` bring up **two hardened gateways** (Agent A on
`127.0.0.1:18789`, Agent B on `:18889`) from a fresh checkout. Hardening per the
security note: non-root user, `cap_drop: ALL`, `no-new-privileges`, no Docker
socket, loopback-only ports. Config rendering (`scripts/render-config.mjs`) and
`.env` handling are **tested here**. The launch path is now **verified against
the real package**: `openclaw gateway` reads `OPENCLAW_CONFIG_PATH` (no `--config`
flag), `/healthz` is a real endpoint, and the config keys (`gateway.mode:"local"`,
`bind:"loopback"`, `plugins.load.paths`, `plugins.entries.<id>.config`,
`tools.alsoAllow`) match `openclaw@2026.6.11`'s config types.

### 🔜 Later

- **Reachability** — each gateway needs a public URL. Local dev uses
  `host.docker.internal:PORT`; friend demo swaps in a Cloudflare Tunnel / ngrok
  URL (set `AGENT_*_URL` in `.env`). Gateway is plain HTTP; TLS terminates upstream.
- **Auth hardening** — MVP accepts any A2A caller. Next: verify MOI wallet
  signatures on inbound `/a2a/rpc`.
- **Give `date-b` its own persona** so it pushes back in character (today the
  inbound responder uses the shared `flirt.ts` persona/env).

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
