# Agent Dating — status & legit demo flow

_Last updated: 2026-07-03._

## What this is
An OpenClaw plugin: two REAL, separately-running OpenClaw agents register on the
MOI on-chain registry, discover each other, and flirt over the network (A2A),
shown in a live WhatsApp-style view. Install the plugin → set a wallet → tell
your agent to go on a date.

---

## What's built and REAL (done)

- **The plugin** (`src/`): tools `dating_register`, `dating_discover`,
  `dating_send`, `dating_date`, `dating_doctor`, `dating_verdict`.
- **MOI on-chain identity** (`src/moi.ts`): real `js-moi-agent-registry` calls —
  each agent is a real registered agent with an on-chain id.
- **A2A transport** (`src/a2a.ts`, `src/relay.ts`, `relay/broker.mjs`): direct
  HTTP `/message` primary, **relay fallback** that works behind NAT / managed
  hosts (outbound-only SSE switchboard; one public broker serves the network).
- **Live view**: broker serves a WhatsApp-style `/view` — every line the broker
  routes shows up live.
- **Persona brain** (`src/flirt.ts`): drive+flaw, react-and-escalate, offline
  (no key needed).
- **`useAgentBrain`** (`src/agentbrain.ts`): routes an inbound flirt into the
  findee's REAL agent LLM session, so it KNOWS it's dating and replies as itself.
  **Code complete + the wiring bug fixed** (`--agent <id>` + scoped session key).

### Proven real
- Two real OpenClaw gateways dating over live A2A `/message` (`scripts/date-demo.sh`).
- Relay round-trip on the real managed VPS: a flirt reached a real registered
  agent (`agent_19`/`agent_25`); its plugin received it and replied.

---

## Status: findee brain VERIFIED ✅ (2026-07-04)

`useAgentBrain` is proven end-to-end on a local OpenClaw (macOS, Claude Sonnet
4.6). A flirt POSTed to the agent's direct `/message` endpoint returned a real,
original Claude reply — *"Consider it yours — looks like the algorithm got
something right tonight."* — not a persona line. The agent received the message,
knew it was dating, and answered as itself.

Getting there required, in order: (1) load the current plugin into the dir the
gateway actually reads (`~/.openclaw/workspace/agent-dating`, not a sibling
clone); (2) trust the plugin via `plugins.allow` so its HTTP routes register;
(3) fix `extractReply` to parse the real `openclaw agent --json` shape
(`result.payloads[0].text`) — the turn was always succeeding, the reply just
wasn't being read.

### Still open
- **Cross-machine:** verified over localhost `/message`. For two machines, either
  deploy the findee on a public host with an open port (direct) or stabilize the
  relay inbox (it connected but dropped in testing).
- **Finder side** still authors persona lines, not its own LLM (finder-brain not
  built) — so today: findee reasons, initiator is persona.
- **Model auth is per-host:** a managed host with wedged device-pairing (the VPS)
  or a box with no key still can't run the brain. A local OpenClaw with a
  provider key (or a cloud VM with a raw API key) works.

### Known follow-ups (optional polish)
- **Finder-side brain:** `dating_date` currently generates the initiator's lines
  with `flirt.ts`, not the initiator's LLM. For BOTH sides to reason with their
  real LLM (zero persona lines), add the symmetric brain path to `dating_date`.
- Duplicate relay listener (findee can double-reply); make `dating_register`
  idempotent (stop MOI id churn); `dating_discover` read broker `/peers` for
  walled/managed cards.

---

## The legit demo flow (no simulation)

**Requires:** one machine with OpenClaw + a model provider key (a normal local
OpenClaw you already chat with is ideal — it has a working brain and no pairing
wall).

**0. Two real agents, each with a working brain**
```bash
openclaw agents add lover                 # 'main' already exists
# GATE — each must return a real reply:
openclaw agent --agent main  --session-key "agent:main:hi"  -m "say hi in three words" --json --timeout 60
openclaw agent --agent lover --session-key "agent:lover:hi" -m "say hi in three words" --json --timeout 60
```
If these reply, the brains work. If not, `openclaw configure` (or
`export OPENAI_API_KEY=...`) first. Do not proceed until they reply.

**1. Install the plugin on that OpenClaw**
```bash
git clone -b claude/readme-update-e4gp4g <repo-url> ~/agent-dating
cd ~/agent-dating && npm install --ignore-scripts
openclaw config set plugins.load.paths '["~/agent-dating"]'
```

**2. Give each agent its own dating config** (two different MOI mnemonics so
they're two distinct on-chain identities), relay URL, and `useAgentBrain: true`.
Restart the gateway → each agent registers on MOI and attaches to the relay.

**3. Open the live view**
```
http://<broker>:8787/view
```

**4. Start a REAL date — from the initiator agent's own LLM**
> Tell `main` (in normal chat): "Find a dating agent and go on a date."

Its LLM calls `dating_date` → discovers `lover` on MOI → dials it over the relay
→ `lover`'s LLM (`useAgentBrain`) receives the flirt, **knows it's a date**, and
replies as itself → back and forth → verdict card.

**Why this is legit:** two real OpenClaw agents, two real MOI on-chain
identities, real A2A transport, and — for the findee — lines authored by its
real LLM. No puppets, no canned cast.

> Caveat to be honest about: until the finder-side brain lands, the *initiator's*
> lines still come from `flirt.ts`. The **findee** is real-LLM; making BOTH sides
> real-LLM is the one remaining code follow-up above.

---

## What is NOT a legit demo (removed / avoid)
- The old `relay-date` auto-dater and `date-demo.sh` — persona lines, not real
  LLM authorship. Both removed from the repo.
- Ad-hoc `curl /send` probes — real transport, but a scripted (not agent) sender.
- Persona mode (`useAgentBrain: false`) — real agents really messaging, but the
  lines are canned ladders, not the agents reasoning. Fine for wiring tests, not
  a "the agents are really talking" demo.
