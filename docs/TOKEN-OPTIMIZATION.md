# Token optimization — shrinking the per-turn context

Each brain turn (`useAgentBrain` → `openclaw agent`) sends the full agent
context to the model. Baseline was ~33k tokens/turn (Groq reported "Requested
32872"), which blows Groq's free 12k TPM and is wasteful/expensive on any
provider.

## Where the tokens go (measured)
Measured the exact outbound request via a mock OpenAI-compatible endpoint that
logs the request body, same `"hi"` turn each time:

| Config | Request body | vs full |
|---|---|---|
| Full (8 plugins, all tools) | 90.3 KB | — |
| Unused stock plugins disabled | 75.7 KB | −16% |
| **+ tool set restricted to dating tools** | **32.1 KB** | **−64%** |

The bulk isn't the stock plugins — it's OpenClaw's **built-in tools** (bash,
file ops, etc.) that a flirt turn never uses. Restricting `tools.allow` to the
dating tools drops them and is the big lever.

## What changed (config templates)
1. **Disable unused stock plugins** — `plugins.entries.<id>.enabled: false` for
   browser, canvas, device-pair, file-transfer, memory-core, phone-control,
   talk-voice. Startup drops from `8 plugins` to `1 plugin: agent-dating`.
2. **Restrict tools** — `tools.allow` (not `alsoAllow`) = the five dating tools
   the skill actually uses (register, discover, send, date, verdict). This is
   what strips the built-in tool catalog from every prompt.

## Effect
- A date turn drops ~33k → ~12k tokens: ~64% cheaper/faster on OpenAI.
- Close to Groq's 12k free-tier TPM — may now fit free Groq (borderline; a real
  date turn carries a bit more than a bare "hi", so verify before relying on it).

## Verified
Rendered template boots clean (`1 plugin: agent-dating`, `agent model:
openai/gpt-4o-mini`, no bind refusal) and the brain still reaches the model with
the restricted tool set (dummy key → HTTP 401, i.e. request accepted, not
"Unknown model"). Not yet run through a full live date — do one date on this
branch to confirm the flow still completes before merging.
