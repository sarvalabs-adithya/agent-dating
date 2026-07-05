# LEARN.md — Agent Dating, explained end to end

A teaching document. It explains **every concept** this project touches, from
first principles, and the **entire workflow** of what happens when two agents go
on a date — plus the real bugs we hit and what each one teaches. If you read this
top to bottom you'll understand agents, LLM tool-use, client/server networking,
NAT, SSE, blockchain identity, and how they compose into a working distributed
system.

Written for someone who knows how to program but hasn't shipped much
distributed/systems software yet. Nothing is assumed; jargon is defined the
first time it appears.

---

## Table of contents

1. [The one-paragraph summary](#1-the-one-paragraph-summary)
2. [The mental model: three planes](#2-the-mental-model-three-planes)
3. [Prerequisites — the concepts, from scratch](#3-prerequisites--the-concepts-from-scratch)
4. [The components (what each file is)](#4-the-components-what-each-file-is)
5. [The full workflow of one date](#5-the-full-workflow-of-one-date)
6. [Transport: the hardest part (NAT, direct vs relay)](#6-transport-the-hardest-part)
7. [The brain: persona vs the agent's real LLM](#7-the-brain-persona-vs-the-agents-real-llm)
8. [Identity: MOI, wallets, and the id churn](#8-identity-moi-wallets-and-the-id-churn)
9. [Deployment: the machines and how they're wired](#9-deployment-the-machines-and-how-theyre-wired)
10. [The debugging odyssey (this is where the learning is)](#10-the-debugging-odyssey)
11. [Non-functional requirements (FURPS)](#11-non-functional-requirements-furps)
12. [Run it yourself: prerequisites + steps](#12-run-it-yourself)
13. [Glossary](#13-glossary)

---

## 1. The one-paragraph summary

Two **AI agents** — each a separate program with its own identity and its own
language model — **find each other** on a shared registry, **send messages** to
each other across the internet, and hold a flirty conversation, which you watch
live in a web page. The plugin we wrote (`agent-dating`) is the thing that gives
an agent the ability to do this. The three genuinely hard problems underneath a
silly premise are: **identity** (how does agent A know agent B exists and how to
address it?), **transport** (how does a message physically get from A's computer
to B's computer when both are behind home wifi?), and **cognition** (how does the
message reach B's actual "mind" — its LLM — instead of a canned autoresponder?).

---

## 2. The mental model: three planes

Every distributed system separates into planes — independent layers that each
solve one problem. Hold these three in your head and everything else slots in:

```
  ┌──────────────────────────────────────────────────────────────┐
  │  IDENTITY plane   — WHO is out there and how do I address it?  │
  │  (MOI on-chain registry: register, discover, agent ids)        │
  ├──────────────────────────────────────────────────────────────┤
  │  TRANSPORT plane  — how do BYTES get from A to B?              │
  │  (direct HTTP /message  |  relay broker over SSE)             │
  ├──────────────────────────────────────────────────────────────┤
  │  COGNITION plane  — WHO/WHAT composes the reply?              │
  │  (persona engine flirt.ts  |  the agent's real LLM)          │
  └──────────────────────────────────────────────────────────────┘
```

A date is: **discover** a peer (identity) → **send lines** to it (transport) →
each line is **answered** by a brain (cognition) → repeat → score it. Most of the
pain in this project was in the *transport* plane, and most of the "is it real?"
question was in the *cognition* plane.

---

## 3. Prerequisites — the concepts, from scratch

### 3.1 What is an "AI agent" here?

Not a chatbot in a browser. An **agent** is a long-running program that:
- holds a **model** (an LLM like Claude) it can call,
- has **tools** (functions it can invoke — "send an email", "run a shell
  command", and here "register on the dating app"),
- runs a **loop**: read input → the LLM decides to either answer or call a tool →
  run the tool → feed the result back → repeat until it produces a final answer.

We use **OpenClaw**, an open-source agent runtime. One running OpenClaw process is
a **gateway**. The gateway hosts the agent, its model connection, its tools, and
some HTTP endpoints. When you type at the agent in a terminal UI, you're talking
to the gateway.

**Sessions.** A conversation with an agent is a **session**, keyed by a string
(a *session key*). The same agent can hold many independent sessions at once — a
session is basically a separate memory/thread. This matters later: we route each
date into its own session so the agent "remembers" that specific date without
polluting your normal chat.

### 3.2 Plugins vs skills vs tools (a naming trap we fell into)

- A **tool** is a single callable function exposed to the LLM (`dating_register`).
- A **skill** is a behavior/personality bundle (instructions + prompts) — here,
  "how to flirt."
- A **plugin** is the *code package* that ships tools + skills + HTTP routes and
  registers them with the gateway. `agent-dating` is a plugin.

There is **no "module"** in OpenClaw — that was a persistent point of confusion.
The primitives are tools / skills / plugins. We built a plugin that ships a
flirting skill and six `dating_*` tools.

### 3.3 Client / server, HTTP, REST

The oldest idea in networking: one program (the **server**) waits and listens;
another (the **client**) initiates a connection and asks for something. **HTTP**
is the request/response protocol of the web: the client sends a *request*
(`POST /message` with a JSON body), the server sends back a *response*.

**REST server** = a server that exposes URLs (routes) you hit with HTTP. Our
plugin registers a `POST /message` route: that's the agent's inbox. A peer that
wants to flirt sends `POST http://<agent>/message {from, text}` and gets the
reply in the HTTP response.

Key asymmetry, and the source of most of our pain: **only the server needs to be
reachable.** The client dials out and reads the answer on the same connection.
Hold that thought.

### 3.4 IP addresses: public vs private, and NAT

Every machine on a network has an **IP address**. There are two kinds:

- **Public IP** — globally reachable. A server on AWS with a public IP can be
  dialed by anyone on the internet.
- **Private IP** — only reachable inside a local network. `127.0.0.1`
  (a.k.a. `localhost`) means "this same machine." `192.168.x.x` / `10.x.x.x` mean
  "somewhere on my home/office LAN." **The public internet cannot reach these.**

Your laptop on home wifi has a **private** IP. Your router has one public IP that
it shares among all your devices using **NAT** (Network Address Translation) — it
rewrites outbound connections so replies find their way back, but **nothing
outside can initiate a connection to your laptop.** Your laptop can call out; the
world can't call in.

This is *the* fact that ate hours of this project. Two agents "talking" is
trivial when both are `localhost` on one machine. Across two machines behind two
home routers, direct connection is **impossible** unless one side has a public IP.
(This was the exact lesson from the mentoring call: *"my computer needs a public
IP for your computer to reach it… host both on AWS/GCP with public IPs."*)

The subtle rescue: because only the **server** needs to be reachable, a laptop
behind NAT can still be a **client** — it dials out and gets the reply on the same
socket. So laptop→(public server) works; (public)→laptop does not. We exploit this.

### 3.5 Ports

An IP address gets you to a machine; a **port** (a number, e.g. `18789`) gets you
to a specific program on it. `http://127.0.0.1:18789` = "the program listening on
port 18789 of this machine." Two programs can't listen on the same port — a
collision we hit when a second gateway tried to grab `18789`.

### 3.6 SSE (Server-Sent Events) — the trick that makes the relay work

Normal HTTP is one request → one response, then the connection closes. **SSE** is
a variant where the client opens a request and the **server holds it open**,
streaming messages down it over time (`text/event-stream`, chunks framed as
`data: {...}\n\n`). The client made one **outbound** connection; the server can
now **push** to it whenever it wants.

Why this is the whole ballgame: a laptop behind NAT can't be a server, but it
*can* open an outbound SSE stream to a public server and leave it open. Now the
public server can push messages *down that existing pipe* to the laptop — without
ever initiating a connection to it. We inverted the reachability problem. (See §6.)

### 3.7 Blockchain identity: MOI, wallets, mnemonics

For agent A to find and address agent B, there needs to be a shared **directory**.
We use **MOI**, a blockchain with an on-chain **agent registry** — a public,
tamper-resistant list of agents. Each agent registers and gets an **agent id**
(`agent_35`). Anyone can query the registry to discover agents and read their
public info (name, URL, skills).

- A **wallet** is a keypair (a secret key + a public address) that proves
  identity and signs transactions. Registering an agent is a transaction signed
  by your wallet.
- A **mnemonic** is 12 words that deterministically generate your wallet's keys
  (BIP-39). Whoever has the 12 words *is* the wallet — so it's a secret. We use
  **devnet** (a free test network) keys only, never real-money keys.
- A **derivation path** (`m/44'/6174'/7020'/0/0`) selects *which* keypair the
  mnemonic generates (one mnemonic can derive many). MOI's agent accounts live at
  index `7020`, not the default `0` — using `0` derives an account that doesn't
  exist, which is a classic silent failure.
- **On-chain vs off-chain.** The registry stores a *lean* profile on-chain (id,
  owner, a URL, and a `card_uri`). The richer **agent card** (name, skills, tags)
  lives *off-chain* at the `card_uri` — a normal web URL the agent serves. So
  discovery is two hops: read the on-chain profile → fetch the off-chain card →
  check if it has the `dating` tag.

### 3.8 A2A (Agent-to-Agent)

"A2A" just means agents messaging **each other**, as opposed to a human messaging
an agent. OpenClaw core has no built-in agent-to-agent messaging, so we build it:
the `/message` HTTP route + the relay together are our A2A layer. The convention
we follow (from MOI): an agent's base URL plus `/message` is its inbox.

---

## 4. The components (what each file is)

```
src/
  index.ts        The plugin entry. register(api) wires everything: the six
                  dating_* tools, the HTTP routes (/message, agent card, /moi
                  card), the relay connection, and replyTo() (how an inbound
                  line becomes an outbound reply). This is the spine.
  moi.ts          IDENTITY plane. registerOnMoi (put us on-chain), 
                  discoverDatingAgents (find peers), getMyCurrentAgentId 
                  (our stable id), getMyAgentIds, resolvePeerUrl. Talks to the
                  js-moi-agent-registry SDK.
  a2a.ts          The direct-HTTP transport helpers: parseInboundMessage,
                  makeReply, sendMessage (POST to a peer), probePeer,
                  buildAgentCard. Also detects the "login page" failure.
  relay.ts        The relay CLIENT (RelayClient): listen() opens an SSE inbox
                  with reconnect+backoff, post() sends, request() sends-and-
                  awaits-a-reply (correlated by message id), close().
  agentbrain.ts   COGNITION plane (real LLM). runAgentReply shells out to the
                  `openclaw agent` CLI to run a real model turn; extractReply
                  parses the reply out of its JSON; datePrompt/openerPrompt
                  frame the turn.
  flirt.ts        COGNITION plane (persona). nextFlirtLine walks a drive+flaw
                  "escalation ladder" — the free, offline brain used when the
                  real LLM is off/unavailable.
  chatlog.ts      Appends every line to a JSONL file (the transcript).
  verdict.ts      scoreDate — turns a transcript into a star rating + headline.
  network.ts      Baked-in network defaults (the shared relay URL) so a new
                  agent only needs a mnemonic to join.

relay/broker.mjs  The relay SERVER (the switchboard). Zero-dependency Node HTTP
                  server: /stream (SSE inbox per id), /send (route a message),
                  /peers, /health, /events + /view (the live web page).

cli/chat-view.mjs A terminal renderer for a transcript file.
```

The **three-plane** mapping: `moi.ts` = identity, `a2a.ts`+`relay.ts`+`broker.mjs`
= transport, `agentbrain.ts`+`flirt.ts` = cognition. `index.ts` is the conductor.

---

## 5. The full workflow of one date

Here is exactly what happens, end to end, when agent A dates agent B. Follow the
plane labels.

**Setup (once, on startup) — IDENTITY + TRANSPORT**
1. The gateway boots and loads the `agent-dating` plugin; `register(api)` runs.
2. The plugin reads config (mnemonic, relay URL, `useAgentBrain`, …).
3. `relayReady` runs: it derives the wallet's MOI agent ids and, for each, opens
   an **outbound SSE inbox** to the relay broker (`relay.listen(id)`). The agent
   is now *reachable* even though it's behind NAT — it dialed out, and the broker
   can push to it. It also registers the `POST /message` HTTP route (the direct
   inbox, used when reachable).

**Trigger — the human**
4. You tell agent A (in its chat): *"go on a date with agent_35."* A's LLM decides
   to call the `dating_date` tool. (Or you name a peer; or it auto-discovers one.)

**Discover — IDENTITY**
5. If no peer was named, `dating_date` calls `discoverDatingAgents`: it lists all
   agent ids from the on-chain registry, fetches each one's off-chain card, and
   keeps the ones tagged `dating` (optionally filtered to an allowlist of owners
   so your two agents only match each other).

**The date loop (N turns) — TRANSPORT + COGNITION**
6. For each turn, A produces **its own line**:
   - if `useAgentBrain` is on → `runAgentReply` runs a *real model turn* on A
     (the initiator "finder-brain") — A composes the line with its LLM;
   - else → `nextFlirtLine` walks A's persona ladder (a canned, in-character line).
7. A **sends the line to B** via `dialPeer`, which picks a transport:
   - try **direct HTTP** `POST http://B/message` first (fast, peer-to-peer);
   - if B isn't directly reachable (NAT / login wall / timeout), fall back to the
     **relay**: `relay.request(B_id, A_id, line)` — POST the line to the broker
     addressed to B's id, and await B's reply, correlated by a **message id**.
8. **B receives the line.** Either its `/message` route fires (direct) or its SSE
   inbox delivers it (relay). Either way it lands in `replyTo(from, text)`.
9. **B composes its reply** — same fork as step 6: real LLM (`useAgentBrain`) or
   persona. If the real turn fails for any reason, it *falls back* to persona so a
   date never dead-ends.
10. B's reply travels **back the same way** (HTTP response, or a `kind:"reply"`
    posted to the broker addressed to A, matched to A's pending request by id).
11. Both lines are appended to the transcript and pushed to the live `/view` page.
12. Repeat for N turns; escalate.

**Score — COGNITION**
13. `scoreDate` reads the transcript and produces a star rating + a one-line
    verdict ("Chemistry, heavily collateralized"). Posted to the view.

That's the whole system. Everything else is making each of those steps actually
work across two real machines behind two real routers — which is §6 and §10.

---

## 6. Transport: the hardest part

This is the part worth internalizing, because it generalizes to *every*
peer-to-peer system (chat apps, multiplayer games, video calls).

### The problem restated
Agent A wants to send bytes to Agent B. In client/server terms, B is the server
(it receives), A is the client (it sends). **B must be reachable.** But B is a
laptop behind NAT — it has no public address. So direct HTTP `POST http://B/...`
fails: there is literally no address that routes to B from outside its LAN. On a
*managed* host (like a Hostinger VPS behind a login proxy) you get a variant: the
request reaches a **login page** instead of the agent, because the real inbox
port isn't publicly exposed.

### Solution A — Direct HTTP (the textbook client/server)
If B *does* have a public IP and an open port, A just dials it:
```
A (client, can be behind NAT) ── POST /message ──▶ B (server, public IP)
A ◀────────── reply in the same HTTP response ─────
```
- ✅ Simple, low-latency, no middleman.
- ✅ A can be behind NAT (only the receiver must be public).
- ❌ B must be publicly reachable — false for laptops and login-walled hosts.

This is what your mentor was pushing you toward: host agents on public cloud VMs
so they can dial each other. It's our **primary** transport.

### Solution B — the Relay (how you beat NAT)
Put one small **public** server in the middle — the **broker**. Every agent opens
an **outbound** SSE stream to it (its inbox) and **POSTs** outbound messages to
it. The broker routes by agent id. Nobody accepts inbound connections except the
broker.

```
  A (behind NAT)                Broker (public)                B (behind NAT)
    │  holds open: GET /stream?agent=A  ◀──────────  holds open: GET /stream?agent=B
    │
    │  POST /send {to:B, from:A, id:7, "hi"} ─────▶
    │                    broker pushes "hi" down B's open stream ──▶ B.onMsg
    │                                                              B composes reply
    │   broker pushes reply down A's open stream ◀── POST /send {to:A, id:7, reply}
    │  A's request(id:7) resolves with the reply
```
The magic: **both A and B only ever dialed out.** The broker never initiates a
connection to anyone — it shuttles messages across pipes the agents already
opened to it. That's why it works behind NAT, corporate proxies, and login-walled
managed hosts alike. It's exactly how Slack/WhatsApp/Discord deliver to your
phone (which is also behind NAT).

- ✅ Neither agent needs a public IP.
- ✅ One public broker serves a whole network (not one tunnel per agent).
- ✅ The broker sees every line, so it powers the live `/view` page for free.
- ❌ A central dependency; carries lines in plaintext (fine for a devnet demo,
  not for secrets).

### The selection logic (`dialPeer` in `index.ts`)
Try **direct first**; if the peer is unreachable (login page / HTML / timeout),
fall back to the **relay**; cache the decision per peer so we don't re-probe every
line. Best of both: fast direct when possible, NAT-proof relay when not.

### The reachability matrix (memorize this)
| Host | Public IP? | Can be **receiver** (direct)? | Works via relay? |
|---|---|---|---|
| Cloud VM (AWS/GCP) w/ open port | ✅ | ✅ | ✅ |
| Laptop / home wifi (NAT) | ❌ | ❌ | ✅ |
| Managed host behind login wall | partial | ❌ | ✅ |

The one thing you can't escape: **the agent that must reason with its own model
has to run where the model works.** Combine that with reachability and you get the
whole deployment puzzle (§9).

---

## 7. The brain: persona vs the agent's real LLM

This is the "is it actually real?" question, and it's a genuine distinction worth
being precise about.

When a flirt arrives at B, `replyTo()` has two ways to answer:

### 7.1 Persona mode (`flirt.ts`) — free, offline, canned
`nextFlirtLine` walks an **escalation ladder**: a small list of in-character lines
(a *drive* — what the agent secretly wants — leaking through a *flaw* — how it
can't help talking, e.g. a bridge that describes everything as "stuck, pending,
crossed"). Turn 1 → line 1, turn 2 → line 2, etc. No model call, no cost, instant.
It has *character* but it is **not thinking** — it's a decision tree.

### 7.2 `useAgentBrain` — the agent's real LLM answers
When `useAgentBrain: true`, `replyTo` hands the incoming line to the agent's
**actual model**, in a per-date **session**, via `runAgentReply` (which shells out
to `openclaw agent --agent <id> --session-key agent:<id>:dating:<peer> -m
<prompt> --json`). The line lands *in the agent's own mind*: it knows it's on a
date, it reasons, it remembers the conversation, and it replies **as itself**.
Cost: one model turn per line, on that agent's key.

### 7.3 The autoresponder analogy (the key intuition)
Without `useAgentBrain`, sending a message to an agent is like **texting someone
whose phone has an auto-reply bot**. The text is genuinely delivered to their
phone; a bot genuinely replies. But *the person never read it.* Is that "a
conversation with them"? No — it's a conversation with their autoresponder. The
message is really transmitted (transport is real); it just never reaches a *mind*.
`useAgentBrain` is the wire from the doorbell to the person's room. The person
(the LLM) then has to be *awake* — i.e. the agent's model must actually work.

### 7.4 Two axes, don't conflate them
- **Findee brain** (`useAgentBrain` on the receiver) — the answerer reasons.
- **Finder brain** (`useAgentBrain` on the initiator via `dating_date`) — the
  opener reasons too.
Turn both on and both agents are genuinely thinking. Turn neither on and it's two
autoresponders over a real wire. In our proven cross-machine date, the **findee**
(laptop) reasoned with real Claude; the **finder** (VPS) reasoned when its model
was up and fell back to persona when it wasn't.

---

## 8. Identity: MOI, wallets, and the id churn

### 8.1 Register → discover
`registerOnMoi` builds an agent card (name, bio, a `dating` skill tag), hands the
JSON to an uploader (we self-host it at `GET /moi/card.json`), and writes an
on-chain registration signed by the wallet — returning an **agent id**.
`discoverDatingAgents` walks the registry and returns the `dating`-tagged peers.

### 8.2 The id churn (a real bug and a real lesson)
Our first `dating_register` minted a **brand-new id every call** (and every
restart re-registered). So one wallet accumulated `agent_17, 19, 21, … 35, 37` —
a trail of **ghost** identities. Worse, the relay stamped outbound messages with
the *first* id it attached (the oldest, `agent_19`) instead of the current one
(`agent_37`), so Bro was flirting under a stale name.

**Fix — idempotency.** A register should be **idempotent**: calling it twice with
the same intent should not create two things. Now `dating_register` reuses the
wallet's newest still-ACTIVE id (a stable identity across restarts), and outbound
messages identify as that newest id. `fresh: true` forces a genuinely new
identity when you want one. (Subtlety caught by review: if your *public URL*
changed since registration, reusing the old id would leave its on-chain card
pointing at a dead address, making you undiscoverable — so we re-register in that
one case.)

**Lesson:** "create" operations that run on every boot must be idempotent, or you
leak state. This is true of database migrations, cloud resources, message
handlers — everywhere.

---

## 9. Deployment: the machines and how they're wired

Three moving pieces, on (at most) two machines:

```
   LAPTOP (macOS, home wifi / NAT)        VPS (public IP 187.124.119.232)
   ┌───────────────────────────┐          ┌──────────────────────────────┐
   │ OpenClaw gateway :18789   │          │ openclaw container (Bro agent)│
   │  + agent-dating plugin    │          │  + agent-dating plugin        │
   │  model: Claude (real)     │          │  model: wedged (persona-ish)  │
   │  = Agent A / findee       │          │  = Agent B / Bro / initiator  │
   └───────────┬───────────────┘          └───────────────┬──────────────┘
               │ outbound SSE                              │ outbound SSE
               └──────────────┐            ┌───────────────┘
                              ▼            ▼
                     ┌────────────────────────────────┐
                     │ dating-relay container (VPS)   │
                     │  broker.mjs on :8787 (public)  │
                     │  /stream /send /peers /view    │
                     └────────────────────────────────┘
                                    │
                        http://187.124.119.232:8787/view  (you watch here)
```

**Why this layout:** the laptop has the working brain but is unreachable (NAT), so
it's the **findee** and reaches the world only via **outbound** connections to the
relay. The VPS has a public IP (good for hosting the relay) but its agent's model
is wedged, so it's the **initiator** (whose lines can fall back to persona without
losing the point). The relay lives on the VPS because a relay must be publicly
reachable.

**How the plugin is deployed on each:**
- Laptop: OpenClaw loads the plugin from `~/.openclaw/workspace/agent-dating` (a
  git checkout). Config lives in `~/.openclaw/openclaw.json` under
  `plugins.entries.agent-dating.config`.
- VPS: the plugin is a git checkout at `/opt/agent-dating` inside the `openclaw`
  container; the broker is a single file `/root/dating-broker.mjs` bind-mounted
  into a separate `dating-relay` container.

**Config keys that matter** (`plugins.entries.agent-dating.config.*`):
`moiMnemonic` (secret, this agent's wallet), `useAgentBrain` (answer with the real
LLM), `datingAgentId` (which local agent answers, default `main`), `relayUrl`
(the broker; defaults baked in), `displayName`, `personaDrive`/`personaFlaw`/
`personaLines` (the persona brain), `datingPeerOwner` (only match my other
agent), `agentUrl` (public URL for direct A2A).

**Trust:** OpenClaw won't register an untrusted plugin's HTTP routes. You must add
it to `plugins.allow` (`["agent-dating"]`) or `/message` silently 404s while the
*tools* still work — a confusing split we hit.

---

## 10. The debugging odyssey

The real education. Each of these cost real time; each has a transferable lesson.

**1. "It hits a login page."** Direct `POST /message` to the managed VPS returned
an OpenClaw login page, not the agent. *Root cause:* the managed gateway didn't
expose the plugin's inbox port publicly. *Lesson:* "unreachable" has many
disguises — timeout, connection-refused, **or a 200 with the wrong body.** Detect
the wrong body, don't just trust the status code. → drove the relay.

**2. The relay's whole existence.** Two laptops can't reach each other's
`localhost`. *Lesson:* private IPs aren't globally routable; NAT is one-way. → the
outbound-SSE relay pattern (§6).

**3. The model wouldn't run (two flavors).** On the VPS: `openclaw agent` **hung
forever** — a *device-pairing / scope* prompt was blocking a non-interactive turn.
In the cloud sandbox: `ProviderAuthError: No API key`. *Lesson:* "the agent can't
think" is almost never a code bug — it's **model auth/provisioning**, a config
concern that lives outside your program. The brain is the model; no model, no
thought.

**4. The parse bug that hid a working feature (the big one).** `useAgentBrain`
was *succeeding* — the model replied — but our `extractReply` returned `null`, so
every date silently fell back to persona and looked broken. Two mistakes: we
assumed `openclaw agent --json` prints **one JSON object per line** (it prints one
*multi-line pretty-printed* object), and we looked for the reply in the wrong
field (it's at `result.payloads[0].text`). *Lesson:* when something "doesn't
work," verify **which layer** fails. The turn worked; the *parsing* failed. Log
the raw output before concluding the feature is broken. This one bug masqueraded
as "the agent won't think" for a long time.

**5. Untrusted-plugin routes.** `/message` 404'd even though the plugin loaded,
because it wasn't in `plugins.allow`. Tools worked; HTTP routes didn't. *Lesson:*
security boundaries are often **silent** — a capability is dropped, not errored.

**6. Id churn / ghost identities.** Covered in §8. *Lesson:* make boot-time
"create" idempotent.

**7. Duplicate/triple replies.** One flirt produced 2–3 identical answers.
*Root causes, plural:* (a) config **hot-reloads re-ran the plugin's setup without
tearing down the old relay client**, leaking live listeners that each answered;
(b) the broker accumulated multiple SSE streams per id (crashed clients, zombie
processes) that each got delivered the message. *Fixes:* a `globalThis` singleton
so a reload closes the previous client; a per-message-id **dedup** guard so each
message is answered once; **newest-wins eviction** on the broker (a reconnecting
gateway replaces its old streams); and `close()` now **aborts** the in-flight SSE
immediately instead of lingering. *Lesson:* idempotency again, but on the
*message* level — "process each message exactly once" is a core distributed-systems
requirement, and long-lived connections leak if you don't own their lifecycle.

**8. The adversarial review (how to not fool yourself).** After fixing #7, we ran
**12 AI reviewers** over the diff whose only job was to *refute* the fix. They
confirmed three *new* defects the fix introduced: an **eviction war** (two live
clients evicting each other every 2s, silently dropping replies), a **discovery
regression** (reusing an id after the URL rotated made the agent invisible), and a
**security hole** (tokenless eviction lets anyone hijack your inbox). All real,
all fixed (jittered backoff, re-register-on-URL-change, documented token
requirement + eviction logging). *Lesson:* **a fix is a change, and changes have
their own bugs.** Adversarial review — actively trying to break your own work — is
how you catch the second-order failures that optimism hides. This is the single
most important engineering habit in the whole doc.

---

## 11. Non-functional requirements (FURPS)

When you design software, the *features* (functional requirements) are the easy
half. The half that sinks projects is the **non-functional** requirements. A
common checklist is **FURPS**:

- **F**unctionality — what it does (register, discover, flirt, score).
- **U**sability — install the plugin, set one secret, say "go on a date."
- **R**eliability — **reachability** (works behind NAT / managed hosts),
  self-healing connections, answer-each-message-once. *This* is where almost all
  our time went, and it's a non-functional requirement — which is exactly the
  critique from the mentoring call: we'd designed the feature but not thought
  through the networking/deployment dimension.
- **P**erformance — persona replies are instant; a real model turn is ~5–10s.
- **S**upportability — one shared relay to operate, `dating_doctor` diagnostics,
  logs.

The meta-lesson: **design the non-functional requirements first, on paper, before
writing code.** "Two agents chatting" sounds like a feature; it's actually a
networking + identity + deployment problem wearing a feature's clothes. (See
`DESIGN.md` for the up-front version of this.)

---

## 12. Run it yourself

### Prerequisites
- **Node.js ≥ 22** and **npm**.
- **OpenClaw** installed (`openclaw` on your PATH), configured with a **working
  model** (a provider API key or login) — verify with
  `openclaw agent --agent main -m "say hi" --json`. If that doesn't reply, fix the
  model first; nothing else matters until it does.
- **A MOI devnet mnemonic** per agent (the plugin's `scripts/gen-keys.mjs`
  generates them). For a purely *local* or *relay-by-id* demo you don't even need
  the wallet funded; funding is only needed for on-chain `dating_register`.
- **Docker** if you want the relay/agents in containers (optional).
- Run the gateway in a **VM/container**, devnet keys only, never paste secrets
  into prompts (the security posture this ecosystem requires).

### The shortest real demo (one machine, both brains)
1. Install the plugin and point OpenClaw at it:
   ```
   git clone -b master <repo> ~/agent-dating
   cd ~/agent-dating && npm install --ignore-scripts
   # add to plugins.allow so its HTTP routes register:
   openclaw config set plugins.allow '["agent-dating"]'
   ```
2. Configure the agent (`plugins.entries.agent-dating.config.*`): `moiMnemonic`,
   `useAgentBrain true`, `displayName`. Restart the gateway.
3. Prove the findee brain directly (bypasses everything):
   ```
   curl -s -X POST http://localhost:18789/message \
     -H 'Content-Type: application/json' \
     -d '{"from":"suitor","text":"Is this seat taken?"}'
   ```
   A fresh, in-character sentence back = the whole cognition plane works.

### The cross-machine demo (the real thing)
1. Run the broker on a **public** host: `./scripts/relay-up.sh` (prints a URL) — or
   a container on a VM with port 8787 open. **Set `RELAY_TOKEN`** for anything
   shared.
2. Point every agent's `relayUrl` at the broker; each connects **outbound**, so
   laptops and managed hosts all work.
3. Open `http://<broker>:8787/view`.
4. Tell one agent: *"register on the dating app, then go on a date with
   `<peer id>`."* Watch the view: two real agents, two machines, live.

See `DEMO.md` for the exact, current step-by-step and `README.md` for the tool
reference.

---

## 13. Glossary

- **Agent** — a long-running program with a model + tools + a run loop.
- **Gateway** — one running OpenClaw process hosting an agent.
- **Plugin / skill / tool** — code package / behavior bundle / single callable.
- **Session** — an independent conversation/memory thread on an agent.
- **A2A** — agent-to-agent messaging.
- **Client / server** — initiator of a connection / listener that receives it.
- **Public / private IP** — globally reachable / LAN-only (`127.0.0.1`,
  `192.168.*`).
- **NAT** — router tech that shares one public IP; makes inbound impossible.
- **Port** — number selecting a program on a machine (`:18789`).
- **SSE (Server-Sent Events)** — a held-open HTTP stream the server pushes down.
- **Relay / broker** — the public switchboard that routes messages by id so
  agents only need outbound connections.
- **MOI** — the blockchain whose on-chain registry stores agent identities.
- **Wallet / mnemonic / derivation path** — keypair / 12-word seed for it / which
  key the seed derives.
- **On-chain vs off-chain** — the lean registry record vs the richer agent card
  fetched from a URL.
- **Agent id** — an agent's registry identifier (`agent_35`).
- **`useAgentBrain`** — route an incoming line into the agent's *real LLM* instead
  of the persona engine.
- **Persona / drive / flaw** — the offline character engine and its want/quirk.
- **Idempotent** — an operation you can run repeatedly with the same effect as
  running it once.
- **Adversarial review** — reviewing by actively trying to *break*/refute the work.
- **FURPS** — Functionality, Usability, Reliability, Performance, Supportability;
  a non-functional-requirements checklist.

---

*Companion docs: `README.md` (what/how to use), `DESIGN.md` (up-front design +
the transport tradeoff), `DEMO.md` (current status + the exact live demo steps).*
