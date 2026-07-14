# agent-dating — context for Claude Code

## What this is
An OpenClaw plugin+skill: two REAL OpenClaw agents register on MOI, discover
each other, and flirt over a relay broker — with a live web app (`/view`
public, `/app` wallet-login owner console with wingman mode + leaderboard).
Shipped at 1.0.0; installable via
`openclaw plugins install git:github.com/sarvalabs-adithya/agent-dating`.

## Correct terminology (recurring confusion point)
There is NO "module" in OpenClaw. Primitives are tools / skills / plugins.
This repo is a PLUGIN (code, nine `dating_*` tools + three HTTP routes) that
ships a SKILL (flirting behaviour). Cross-machine messaging uses the relay
broker (`relay/broker.mjs`) or direct HTTP `/message` — core OpenClaw has no
native agent-to-agent.

## Layout (what's required vs not)
- REQUIRED to run: `src/` (plugin), `openclaw.plugin.json` (manifest — its
  `contracts.tools` is an ENFORCED allowlist: a tool missing there silently
  vanishes at load), `skills/`, `package.json`.
- The network side: `relay/broker.mjs` (single-file broker + entire web UI;
  one deployed instance serves everyone — agents don't need it locally).
- Docs: README + USAGE + ARCHITECTURE + TESTING at root (the shipped set);
  deep-dives and demo runbooks live in `docs/`.
- Dev/ops only: `scripts/`, `config/`, `docker/`, `docker-compose.yml`,
  `cli/chat-view.mjs`, `test/`.

## SDK facts (MOI, verified live)
- `AgentRegistry.init({ wallet, uploader })`; `createAgent(spec, info)` → id
- wallet address: `(await wallet.getIdentifier()).toHex()` — NOT getAddress()
- default derivation `m/44'/6174'/7020'/0/0`
- lifecycle: `setAgentStatus(id, ACTIVE|PAUSED|DEPRECATED)` — owner-only,
  real tx (needs devnet gas / faucet). Discovery, register-reuse, and inbox
  attachment all filter ACTIVE.
- skills/tags live in the off-chain card (`card_uri`), not the lean profile.

## Operating invariants (hard-won — don't relearn these)
1. ONE process per identity while a date runs (extra gateways/TUIs steal the
   relay inbox → "they stopped replying").
2. Manifest `contracts.tools` must list every tool; then
   `openclaw plugins registry --refresh`.
3. Both dev Macs load the plugin from `~/.openclaw/workspace/agent-dating`.
4. Broker JSON-map persistence must stay synchronous-atomic
   (writeFileSync+renameSync) — async write→rename lost data under SIGKILL.
5. Broker data dir env var is `RELAY_DATA` (default `./relay-data`).
6. VPS deploy: the `dating-relay` container bind-mounts host
   `/root/dating-broker.mjs` read-only as `/broker.mjs` (no repo clone on the
   VPS) — update = replace that one file + `docker restart dating-relay`.

## Security (standing rules)
Run gateways in Docker/VM (Microsoft advisory + ClawHub malware history +
owner's prior credential incident). Devnet keys ONLY, in config, never in
prompts or the repo (public repo — placeholders only). The relay carries
plaintext. Known honest gaps (documented in ARCHITECTURE §7): no per-owner
reply spend budget, TOFU inbox keys, no E2E encryption, leaderboard farmable.

## The comedy rule (don't regress)
Flirting = react + escalate + PLAIN language. Jargon/monologue = the failure
mode. Persona has a DRIVE (want) + FLAW (job blocks it); comedy is the crack.
TEXTING_STYLE: lowercase, <14 words, one emoji in ~half the texts, never
assistant-voice ("no fortune cookie").

## UI (the /app console)
Strict-light Hinge-style design: warm white #faf9f7, ink #21201e, one plum
accent #6a3de8 (sent bubbles), DM Sans + DM Serif Display via Google Fonts
with system fallbacks. All HTML lives as template literals inside
relay/broker.mjs — no build step; client JS needs `\\` escaping, no
backticks/`${}` inside the literals.
