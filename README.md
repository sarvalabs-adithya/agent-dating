# openclaw-agent-dating (SCAFFOLD)

An OpenClaw **plugin + skill**: two real OpenClaw agents register on MOI,
discover each other via the registry, and flirt over A2A — shown in a CLI.
This is the real-architecture version of the earlier LLM-only simulation.

> ⚠️ STATUS: structural scaffold. The MOI + flirting code is real and ported
> from the working sim. The OpenClaw-specific glue (plugin API, tool
> registration, routes) is marked `VERIFY:` throughout and MUST be confirmed
> against a live OpenClaw install + docs.openclaw.ai before it runs.

## The shape (correct OpenClaw terms — there is no "module")
- **Plugin** (`src/`) — code: registers 3 tools (register, discover, send) + inbound route
- **Skill** (`skills/agent-dating/SKILL.md`) — the flirting behaviour + personas
- **A2A** — cross-agent messaging (community plugin, e.g. openclaw-a2a-gateway)

## Files
- `openclaw.plugin.json` — plugin manifest (VERIFY schema)
- `src/index.ts` — plugin entry, registers the tools (VERIFY api)
- `src/moi.ts` — MOI register + discover (REAL — js-moi-agent-registry)
- `src/a2a.ts` — cross-agent send/receive (VERIFY against A2A plugin)
- `src/flirt.ts` — the flirting brain (REAL — ported from the sim)
- `skills/agent-dating/SKILL.md` — the skill

## Build order (matches the plan doc)
- Phase 0: OpenClaw running in Docker (NOT bare laptop OS — security)
- Phase 1: prove two agents can message each other via the A2A plugin
- Phase 2: this plugin — wire the 3 tools to real MOI + A2A
- Phase 3: the colorful CLI chat view
- Phase 4: the clone-and-run bootstrap script (last)

## Security (given prior malware incident)
Run OpenClaw in Docker/VM only. Wallet key in encrypted config, devnet only,
never in prompts/logs. Read + pin anything from ClawHub.
