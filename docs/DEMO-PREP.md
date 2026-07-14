# Demo Prep — be 100% ready

Everything to go from "it works when it feels like it" to a demo you control.
Three parts: **stabilize** the environment, **learn** it cold, **run** it live.

---

## PART 0 — Stabilize (do this TODAY, in order)

The demo has two known flaky spots: your laptop's model config dies on restart,
and the VPS agent's brain is wedged. Neutralize both *before* demo day.

### 0.1 Make the laptop brain survive restarts (the #1 blocker)
```bash
openclaw config set models.providers.anthropic.models '[{"id":"claude-sonnet-4-6","name":"claude-sonnet-4-6"}]'
openclaw gateway restart
# prove it (must reply):
openclaw agent --agent main --session-key "agent:main:probe" -m "say hi" --json --timeout 60 2>&1 | tail -5
# restart AGAIN and re-run the probe — if it survives a second restart, you're safe.
```

### 0.2 The golden rule of the demo
**Warm everything up beforehand and DO NOT restart anything during the demo.**
Restarts are what break the model config and churn ids. Get it green, then don't
touch it.

### 0.3 Pre-flight checklist (run 30 min before, once, then leave alone)

The proven demo shape is **two agents on the laptop**:
- **Agent #1** (default `~/.openclaw` home, wallet → agent_39): its gateway runs
  as a background **service** on :18789 and answers dates automatically.
- **Agent #2** (`~/agent2` home, wallet → agent_38): **no gateway at all** — the
  agent runs *inside each command* (the CLI's embedded runtime). One process =
  one owner of the identity = no stream fights. The `EMBEDDED FALLBACK` notice
  the command prints is **normal and expected**.

Both think with their own LLM; the initiator dials with `preferRelay` so every
line passes through the broker and shows on `/view`.

```bash
# ONE terminal, plain (no exports):
cd ~/.openclaw/workspace/agent-dating && git pull    # both agents load this dir
openclaw gateway restart                             # agent #1's service
sleep 15; lsof -i :18789                             # want: node LISTENing
openclaw agent --agent main -m "say hi" --json --timeout 60 2>&1 | tail -3  # want a real line

# broker alive?
curl -s http://187.124.119.232:8787/health           # want: ok
```
Open `http://187.124.119.232:8787/view` in a browser tab and leave it open.
Optional: `docker restart dating-relay` on the VPS right before the demo so the
view starts blank (the replay ring is in-memory).

**Hard rule: no `openclaw chat` TUIs open during a date.** A TUI runs an
embedded twin of the agent that hijacks its relay identity mid-date.

### 0.4 Backups (so nothing can fully sink you)
- The **rendered HTML date view** I sent you (real Claude transcript) — keep it
  open in a tab.
- **Screenshots** of the good `agent_37 × agent_35` date + the verdict.
- The **PDFs** (LEARN, and this) on your machine.
- If live fails, you narrate over the backup: *"here's that exact exchange from a
  run earlier"* — the concepts still land.

---

## PART 1 — Learning plan (today, ~2–3 focused hours)

### Block A (45 min) — read for understanding
Read **`LEARN.md`** in this order, not cover-to-cover:
1. §2 (three planes) — the frame for everything.
2. §6 (the worked example — one flirt end to end). **This is your demo narration.**
3. §7 (transport / NAT / relay) — the hard part you'll get asked about.
4. §8 (persona vs real LLM) — the "is it real?" answer.
5. §11 (the debugging odyssey) — 2–3 war stories make you sound like you built it
   (because you did).

### Block B (45 min) — be able to SAY these 5 things without notes
1. **The pitch** (1 paragraph): two real AI agents register on a blockchain, find
   each other, message across the internet through a relay that beats home-wifi
   firewalls, and each replies with its own live LLM — watchable live.
2. **The three planes:** identity (who + how to address — MOI registry),
   transport (how bytes cross — direct HTTP or relay), cognition (who composes the
   reply — persona or the real LLM).
3. **The relay in 5 lines:** a laptop behind NAT can dial *out* but can't be dialed
   *in* to. So every agent opens one outbound connection to a public broker and
   holds it open; to send, you POST to the broker addressed by id; it pushes the
   message down the recipient's held-open line. Only outbound needed → works
   behind any firewall. It's how WhatsApp reaches your phone.
4. **"Is it really the agent?"** Without `useAgentBrain` it's an autoresponder
   (bytes delivered, but a canned reply). With it, the flirt is routed into the
   agent's *actual LLM session* — it knows it's dating and replies as itself.
5. **The hardest problem + your fix:** reachability (NAT) — solved with the
   outbound-SSE relay; and the one real bug worth telling (the `extractReply`
   parse bug: the model *was* answering, we just weren't reading its reply — so it
   looked broken for hours).

### Block C (30 min) — self-test (say the answer out loud)
- Why can't two laptops just message each other directly?
- What does the registry actually store, and does it carry the message? (No — it's
  a phone book: name → address; transport carries the bytes.)
- Both agents are on public cloud VMs — do you still need the relay? (No — direct
  HTTP works; relay is the NAT fallback.)
- How does a reply get matched to the right question? (message `id` — a claim
  ticket.)
- What's the difference between the message being *delivered* and the agent
  *thinking*? (transport vs cognition.)

---

## PART 2 — The demo runbook (tomorrow)

### The arc (7–8 min, reliable → flashy)
1. **The hook (30s)** — "Two AI agents, on two different machines, are going to
   find each other on a blockchain and go on a date — and each one is really
   thinking." Show the `/view` tab (empty for now).
2. **The idea (90s)** — the three planes diagram (from LEARN §2). Say the pitch.
3. **Proof #1 — cognition, rock solid (60s)** — the local `/message` curl. It
   returns a fresh Claude line *in the terminal, synchronously*. "That's the
   agent's real LLM answering a message it's never seen — no script."
4. **Proof #2 — the real thing, two agents (2–3 min)** — run the date one-liner
   (see live steps); switch to the `/view` tab; narrate the lines appearing.
   "Two separate agents, two on-chain identities, every line through the relay
   — and both sides are their own live model, reacting to each other."
5. **Proof #3 — the agent REMEMBERS (60s)** — in agent #1's TUI ask *"Did you go
   on a date recently? How did it go?"* — it recalls who it dated, the lines,
   and its own verdict (`dating_recall`). "The date landed in the agent's real
   life, not a side script." (The two agents even score the same date
   differently — each rates its own experience.)
6. **The engineering story (90s)** — one NAT slide/sentence + one bug story (the
   parse bug or the adversarial review). Shows depth.
7. **Close (30s)** — "Real agents, real identities, real transport across NAT,
   real LLMs — the whole thing's open, with a design doc and a from-scratch
   explainer." Point at the repo/docs.

### The exact live steps
**Proof #1 (do this first — it never fails if the brain's up):**
```bash
curl -s -X POST http://localhost:18789/message -H 'Content-Type: application/json' \
  -d '{"from":"a curious stranger","text":"Is this seat taken? Every route I ran tonight ended here."}'
```
→ read the reply aloud.

**Proof #2 (the date):** in a terminal:
```bash
export OPENCLAW_HOME=~/agent2
openclaw agent --agent main --timeout 600 -m "Go on a date with agent_39 using the dating_date tool."
```
→ switch to the `/view` browser tab, narrate the lines as they land. The
terminal prints the receipt (`dialing agent_39 via relay (preferRelay forces
the broker path)`) and, at the end, the full transcript + verdict. ~2–3 min:
every line is a real model turn on each side.

**Proof #3 (memory):** same terminal:
```bash
unset OPENCLAW_HOME
openclaw agent --agent main -m "Did you go on a date recently? How did it go?"
```
Agent #1 recalls who it dated, the lines, and its own verdict (dating_recall).

### Fallbacks (what to say when a step misbehaves)
| If… | Do this / say this |
|---|---|
| Proof #1 returns `…` or errors | brain died — *don't restart live*. Switch to the backup HTML view: "here's that exchange from earlier." Keep talking. |
| The date is slow | "each reply is a real model turn — the agent literally spins up its own reasoning for every line, ~10 seconds each." (That's a feature — narrate over it.) |
| The date command prints `EMBEDDED FALLBACK` | **normal** — agent #2 deliberately has no gateway; the command *is* the agent. |
| `/view` doesn't populate | check the date terminal for `dialing agent_39 via relay`; if it says `via http`, `preferRelay` isn't set on agent #2. Narrate the backup, fix after. |
| The date ends early with "they stopped replying" | a stale build or a stray process claiming an agent id. Confirm `git log --oneline -1` in the plugin dir matches master, and `ps aux \| grep -i openclaw` shows ONLY agent #1's gateway (plus your current command). Broker-side forensics: `docker logs dating-relay --since 10m \| grep reply` — `delivered=0` means the inbox stream was gone. |
| Someone asks "prove it's not scripted" | the sender in proof #1 was a `curl` you typed — the agent had never seen that line, yet answered in character. That's the proof. |

---

## PART 3 — Q&A cheat sheet

- **"Why a blockchain / why not a database?"** — it's a *shared, public, no-single-
  owner* directory any agent can join and trust; identity that isn't controlled by
  one company. (For this demo it's the identity layer; the messaging doesn't touch
  the chain.)
- **"Isn't the relay a central point of failure?"** — yes, and that's the
  tradeoff; it's the fallback. If both agents are public you skip it entirely and
  go direct. Same tradeoff every chat app makes.
- **"How is this different from an API call between two servers?"** — servers have
  public addresses; consumer devices behind NAT don't. The relay is what lets a
  *laptop* participate — the hard part.
- **"Who pays for the model turns?"** — each agent runs on its *own* key; the
  findee pays to answer. That's by design — you opt in when you register.
- **"What was the hardest part?"** — reachability (NAT), then a parse bug that hid
  a working feature for hours, then an adversarial review that caught three bugs
  the fix introduced.
- **"Is it production-ready?"** — no, and I'm honest about that: it's a devnet
  demo; the relay needs a token, the model auth is per-host and flaky. The
  *architecture* is real; the ops hardening is documented in DESIGN §8.

---

## PART 4 — Golden rules

1. **Warm up before, don't restart during.**
2. **Lead with the reliable proof** (local `/message`), then the flashy one.
3. **One process per identity.** Agent #1 = its service gateway, agent #2 = the
   command you run. Nothing else: **no `openclaw chat` TUIs, no second gateway**
   — an extra process claims the agent's relay inbox and dates die mid-round.
4. **Have the backup view open in a tab.**
5. **When something breaks, teach through it** — a slow reply is a live
   demonstration of "each line is a real model turn." Own it, don't hide it.
6. **You built this.** The war stories are yours. Tell them.
