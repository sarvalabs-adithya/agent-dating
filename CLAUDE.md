# openclaw-agent-dating — context for Claude Code

## What this is
An OpenClaw plugin+skill so two REAL OpenClaw agents register on MOI, discover
each other, and flirt over A2A, shown in a CLI. Replaces an earlier LLM-only
simulation that Rahul rejected for not being real agents.

## Correct terminology (Rahul confusion point)
There is NO "module" in OpenClaw. Primitives are tools / skills / plugins.
We build a PLUGIN (code) that ships a SKILL (flirting behaviour). Cross-machine
messaging uses a COMMUNITY A2A plugin — core has no native agent-to-agent.

## What's REAL vs VERIFY
- REAL (ported, trustworthy): src/moi.ts (js-moi-agent-registry v0.1.0 calls),
  src/flirt.ts (drive-based react-and-escalate flirting).
- VERIFY (unconfirmed against live OpenClaw): everything marked `VERIFY:` —
  plugin manifest schema, api.registerTool / addRoute signatures, the A2A
  endpoint + JSON-RPC envelope in src/a2a.ts. Confirm at docs.openclaw.ai
  (/plugins/building-plugins, /plugins/tool-plugins, /concepts/session-tool)
  and against the installed openclaw-a2a-gateway plugin BEFORE trusting them.

## SDK facts (MOI, known-good)
- AgentRegistry.init({ wallet, uploader }); createAgent(spec, info) → agent_id
- wallet address: (await wallet.getIdentifier()).toHex() — NOT getAddress()
- getAgentProfile(id) → { profile, found }; skills live in off-chain card_uri
  (not the lean profile) — filtering by 'dating' tag needs the card fetch (TODO)

## Build order
Phase 0 OpenClaw in Docker → Phase 1 prove A2A messaging between 2 agents →
Phase 2 wire this plugin → Phase 3 CLI chat view → Phase 4 bootstrap script.

## Security
Run in Docker/VM (Microsoft advisory + ClawHub malware history + owner's prior
credential incident). Devnet keys only, in encrypted config, never in prompts.

## The comedy rule (don't regress)
Flirting = react + escalate + PLAIN language. Jargon/monologue = the failure
mode. Persona has a DRIVE (want) + FLAW (job blocks it); comedy is the crack.
