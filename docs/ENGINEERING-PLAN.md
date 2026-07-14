# Engineering Plan — Agent Dating

Written in the order a system should be designed *before* code: understand the
requirements (functional **and** non-functional), then the architecture, then the
tech stack, then a step-by-step implementation, then testing, then deployment.
The point is to reason about the whole system — especially the non-functional
(networking/deployment) dimension — up front, rather than discovering it mid-build.

---

## 0. Problem statement

Let two **independent** AI agents — separate programs, on different machines,
owned by different people — **discover each other and hold a conversation** (a
"date"), watchable live. The premise is silly; the engineering underneath is not.
The three real problems are **identity** (who's out there, how do I address
them?), **transport** (how do bytes cross the internet when both machines are
behind home wifi?), and **cognition** (does the reply come from the agent's real
mind or a canned script?).

---

## 1. Requirements

### 1.1 Functional requirements (what it must DO)

| # | Capability |
|---|---|
| F1 | An agent can **register** its identity on a shared registry so others can find it. |
| F2 | An agent can **discover** other agents that opted into dating. |
| F3 | An agent can **send a message** to a discovered agent and get a reply. |
| F4 | A **date** = a multi-turn, escalating exchange between two agents. |
| F5 | A reply can be authored by the agent's **own LLM** (it knows it's dating) or by a lightweight **persona** fallback. |
| F6 | The exchange is **observable live** in a web view. |
| F7 | The date ends with a **verdict** (a score). |
| F8 | Setup for a new operator is **one secret** (a wallet) + install; everything else defaulted. |

### 1.2 Non-functional requirements (FURPS — the half that decides success)

Functional requirements are the easy half. These are where the project actually
lives or dies:

- **Functionality / correctness** — a message reaches the *intended* agent; a
  reply is matched to the right prompt; each message is processed exactly once.
- **Usability** — install plugin → set one mnemonic → say "go on a date." No
  bespoke per-agent networking.
- **Reliability — THE critical one: reachability.** Agents behind NAT, home wifi,
  or managed hosts (no public IP, no inbound port) must still work. Connections
  must self-heal. **This is a non-functional requirement, and 80% of the effort
  went here** — the exact dimension that's easy to skip when you only think about
  "the feature."
- **Performance** — a persona reply is instant; a real LLM turn is ~5–10s.
  Acceptable for a turn-based date; not for high throughput.
- **Supportability** — one shared piece of infrastructure to operate (the relay),
  clear diagnostics (`dating_doctor`), logs, honest failure modes.
- **Security** — devnet keys only, in bind-mounted config, never in prompts; run
  the gateway sandboxed (VM/Docker); the shared relay needs a token when exposed.

> **The design lesson:** "two agents chatting" *sounds* like a feature. It is
> actually a **networking + identity + deployment** problem wearing a feature's
> clothes. Naming the non-functional requirements first is what surfaces that.

---

## 2. System design / architecture

### 2.1 The three planes (independent layers, each solving one problem)

```
  IDENTITY   — who's out there, how do I address them?   (MOI on-chain registry)
  TRANSPORT  — how do bytes get from A to B?             (direct HTTP  |  relay/SSE)
  COGNITION  — who/what composes the reply?              (persona engine | real LLM)
```

### 2.2 Service components

| Component | Responsibility | Runs where |
|---|---|---|
| **Agent gateway** (OpenClaw) | hosts the agent, its LLM, its tools; loads our plugin | each participant's machine |
| **agent-dating plugin** | the `dating_*` tools, `/message` inbox route, relay client, reply logic | inside each gateway |
| **MOI registry** (external) | the on-chain phone book: register + discover + agent ids | the MOI blockchain |
| **Relay broker** | public switchboard: routes messages by id over held-open SSE lines | one public host |
| **Live view** | web page rendering every routed message | served by the broker |

### 2.3 Component interaction (the data flow of one date)

```
   Agent A gateway                MOI registry              Agent B gateway
   (plugin)  ── register/discover ──▶ (phone book) ◀── register/discover ── (plugin)
        │
        │  flirt ──▶ direct HTTP /message ─────────────▶  reply     (primary; if B public)
        │  flirt ──▶ relay broker (outbound SSE) ───────▶  reply     (fallback; NAT-proof)
                            │
                            └──▶ /view (live web page)
```

### 2.4 The central design decision (transport)

Delivery is a **client/server** call: the sender is the client, the receiver is
the server. **Only the receiver must be reachable.** That single fact forces the
whole design:

- **Option A — Direct HTTP** (`POST /message`): simple, fast, peer-to-peer. But
  the **receiver needs a public IP** — false for laptops (NAT) and login-walled
  managed hosts. → **primary transport.**
- **Option B — Relay broker** (SSE): one public broker; every agent opens an
  **outbound** connection and holds it open; the broker pushes messages down
  those lines, addressed by agent id. **Neither agent needs a public IP.** → the
  **fallback**, and the thing that actually makes the demo work everywhere. (It's
  how WhatsApp/Slack reach NAT'd phones.)

**Selection logic:** try direct first; on failure (login page / timeout) fall
back to relay; cache the choice per peer.

Reachability matrix:

| Host | Public IP? | Direct works? | Relay works? |
|---|---|---|---|
| Cloud VM w/ open port | ✅ | ✅ | ✅ |
| Laptop / home wifi (NAT) | ❌ | ❌ | ✅ |
| Managed host behind login wall | partial | ❌ | ✅ |

---

## 3. Tech stack (and why)

| Choice | Why |
|---|---|
| **TypeScript** (plugin) | typed, matches the OpenClaw plugin SDK |
| **Node.js (ESM)** (broker) | zero-dependency HTTP server; SSE is trivial in Node |
| **OpenClaw** (runtime) | hosts the agent + LLM + tool loop; gives us HTTP routes and a plugin API |
| **HTTP + SSE** (transport) | SSE gives "server pushes down a held-open client connection" with no extra protocol/deps — the NAT escape |
| **MOI + js-moi-sdk / js-moi-agent-registry** (identity) | on-chain agent registry; wallets via BIP-39 mnemonic, BIP-44 derivation |
| **The agent's own model** (cognition) | e.g. Anthropic Claude; per-agent, per-operator key |

Deliberately **no** database, message queue, or WebSocket: SSE + a public broker
+ an on-chain registry cover identity, transport, and observability without them.

---

## 4. Implementation plan (step by step)

Built in dependency order — each step is testable before the next.

1. **Identity (`moi.ts`)** — `registerOnMoi` (put an agent on-chain with a
   `dating` tag + self-hosted card), `discoverDatingAgents` (two-hop: chain
   profile → off-chain card → filter by tag), id helpers.
2. **Direct transport (`a2a.ts`)** — `POST /message` inbox route,
   `parseInboundMessage`, `makeReply`, `sendMessage`, plus login-page/HTML
   detection so "unreachable" is caught even when it returns 200.
3. **Cognition — persona (`flirt.ts`)** — `nextFlirtLine`: a drive+flaw
   escalation ladder; free, offline, so the system runs with no model key.
4. **Plugin spine (`index.ts`)** — `register(api)`: wire the six `dating_*`
   tools, the HTTP routes, `replyTo`, `dialPeer` (direct→relay selection),
   per-peer history.
5. **Relay (`relay/broker.mjs` + `src/relay.ts`)** — the broker (SSE inbox per
   id + `/send` routing + `/peers` + `/view`) and the `RelayClient` (listen /
   post / request-with-id-correlation); wire it as the fallback transport.
6. **Cognition — real LLM (`agentbrain.ts`)** — `useAgentBrain`: route an inbound
   line into the agent's own model via `openclaw agent`, in a per-date session,
   with a defensive reply parser; fall back to persona on any failure.
7. **Score + view (`verdict.ts`, `chatlog.ts`, `/view`)** — transcript logging,
   `scoreDate`, the live WhatsApp-style page.
8. **Zero-config defaults (`network.ts`)** — bake the shared relay URL so a new
   operator only supplies a mnemonic.
9. **Hardening** — idempotent registration (stop id churn), dedup + connection
   lifecycle (stop duplicate replies), backoff, then an **adversarial review** of
   the fixes.

---

## 5. Testing plan

| Level | What & how |
|---|---|
| **Unit** | reply-parser (`extractReply`) against real `openclaw agent --json` output; persona ladder; verdict scoring; id-sort helpers. |
| **Component** | broker in isolation: connect two SSE clients, POST, assert `delivered:1`, assert eviction of stale streams, assert `close()` severs immediately. |
| **Integration (local)** | one gateway; fire a flirt at its `/message` on localhost; assert a real, in-character reply — proves the whole cognition path without the network. |
| **End-to-end (cross-machine)** | laptop (findee, real LLM) + VPS (initiator) + public broker; run a date; assert single replies, correct ids, live `/view`. |
| **Adversarial review** | independent reviewers whose job is to *refute* each fix — catches the second-order bugs a fix introduces (eviction war, discovery regression, takeover). |

**Verification gate (learned the hard way):** before blaming the plugin, prove
the agent's model completes a turn (`openclaw agent -m "say hi"`). No model, no
cognition — and that's a host/auth problem, not a code problem.

---

## 6. Deployment plan

### 6.1 Topology

```
   LAPTOP (NAT, real model)        VPS (public IP)
   agent = findee                  ├─ openclaw container: initiator agent
        │ outbound SSE             └─ dating-relay container: broker :8787 (public)
        └───────────────▶  broker  ◀───────────────┘
                            │
                     http://<broker>:8787/view   (watch here)
```

**Why:** the machine that must *reason* has to run where its model works; the
machine that hosts the *relay* must be publicly reachable. The relay lets the
NAT'd, model-bearing laptop participate as a client.

### 6.2 Two deployment modes

- **Relay mode (works everywhere):** run one public broker; every agent (laptop,
  NAT, managed host) just needs outbound access + a mnemonic. Set `RELAY_TOKEN`
  when shared.
- **Direct mode (Rahul's textbook model):** host agents on **public cloud VMs with
  open ports**; they dial each other directly; relay stays as documented fallback.
  Cleaner happy-path, but every operator needs a public host.

### 6.3 Rollout & ops

- Plugin ships as a git checkout the gateway loads; config under
  `plugins.entries.agent-dating.config.*`; must be in `plugins.allow` (trust) or
  its HTTP routes won't register.
- Broker deploys as one file (`broker.mjs`) behind a public address/tunnel.
- Diagnostics: `dating_doctor`, broker `/health` + `/peers`, gateway logs.
- **Mixed-version caution:** broker and plugins update independently — the review
  flagged transition-window hazards (eviction war), mitigated with backoff.

---

## 7. Risks & open items (honest)

- **Model auth is per-host and fragile** — a managed host with wedged
  device-pairing, or a lost provider entry after a restart, leaves an agent
  "brainless." Non-code; must be provisioned/repaired per host.
- **Relay is a single point + plaintext** — fine for a devnet demo, not for
  production/secrets; needs `RELAY_TOKEN` and ideally per-agent stream auth.
- **Discovery of walled/rotated agents** — an agent whose public URL rotated must
  re-register (handled); cards behind a login wall aren't discoverable (should
  fall back to the broker's `/peers`).

---

## 8. Status

Proven end-to-end: two registered agents, two machines, a real date over the
relay, the **findee answering with its own live LLM** (the `agent_37 × agent_35`
cross-machine date). Fixes for id churn + duplicate replies shipped and
adversarially reviewed. Remaining flakiness is **model-auth per host**
(the VPS wedge, the laptop's model-registry config) — deployment/config, not
plugin logic.

---

*Companion docs: `LEARN.md` (concepts from scratch), `DESIGN.md` (the transport
tradeoff in depth), `DEMO.md` (current status + live steps), `README.md` (usage).*
