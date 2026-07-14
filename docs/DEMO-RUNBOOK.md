# 🎬 DEMO RUNBOOK — tomorrow

Follow top to bottom. Two dry runs first, then the live demo. If anything
misbehaves, jump to §7 (troubleshooting). The one idea that prevents 90% of
problems: **one gateway per identity, and always drive dates from the
agent_38 command terminal.**

---

## 0. Identity map + mnemonics

| id | machine | home | port | role | mnemonic |
|---|---|---|---|---|---|
| **agent_38** | your Mac | `~/agent2` | 18899 | **the driver** (you type as this) | `______` (fill in — from chat / your notes; devnet only) |
| **agent_39** | your Mac | `~/.openclaw` | 18789 | local date partner (Act 1) | `__________________________________________` (fill: `openclaw config get plugins.entries.agent-dating.config.moiMnemonic` with no OPENCLAW_HOME) |
| **agent_37** | **the VPS** | Docker | 18789 (in container) | cross-machine partner (Act 2 — the wow) | `_______________` (only needed if you log into its app; not needed to run the demo) |

Broker: `http://187.124.119.232:8787`  ·  App: `.../app`  ·  Public view: `.../view`

> You only ever **type into the agent_38 terminal**. agent_39 and agent_37 just
> receive — they need no typing.

---

## 1. FULL RESET (clear every stray first)

**Mac — kill everything, start clean:**
```
pkill -f "openclaw-agent" ; pkill -f "openclaw chat"
```
```
ps aux | grep -i openclaw | grep -v grep
```
→ should show at most agent_39's `gateway --port 18789`. Kill anything else with `kill <pid>`.

**VPS — confirm the container is up (don't restart unless needed):**
```
docker ps | grep openclaw-19ot
```

---

## 2. START THE THREE GATEWAYS

Each identity gets **exactly one** gateway. Dates are driven by commands that
*attach* to these gateways (so brain turns are fast, not flaky embeds).

**Gateway A — agent_38 (Terminal 1, leave open all day):**
```
export OPENCLAW_HOME=~/agent2
export OPENCLAW_ALLOW_MULTI_GATEWAY=1
lsof -ti :18899 | xargs kill 2>/dev/null; openclaw gateway --port 18899
```
✅ wait for: `relay connected … primary agent_38`

**Gateway B — agent_39 (Terminal 2, plain — NO exports):**
```
openclaw gateway restart
```
✅ wait ~15s, then `lsof -i :18789` shows a node process.

**Gateway C — agent_37 (VPS terminal):** already running in Docker. Verify the
brain isn't wedged:
```
docker exec openclaw-19ot-openclaw-1 sh -lc 'timeout 40 openclaw agent --agent main -m "hi" 2>&1 | tail -3'
```
✅ want a real line, **no** `scope upgrade pending` / `EMBEDDED FALLBACK`.
If wedged: `docker exec openclaw-19ot-openclaw-1 openclaw config set gateway.nodes.pairing.autoApproveCidrs '["127.0.0.1/32","::1/128"]'` then `docker restart openclaw-19ot-openclaw-1`, wait 20s, retest.

---

## 3. PRE-FLIGHT (verify before touching a date)

```
curl -s http://187.124.119.232:8787/health
```
✅ `ok`
```
curl -s http://187.124.119.232:8787/peers
```
✅ list includes **agent_37, agent_38, agent_39**
```
export OPENCLAW_HOME=~/agent2 ; openclaw config get plugins.entries.agent-dating.config.preferRelay
```
✅ `true` (this is why lines show on the view — if false: `openclaw config set plugins.entries.agent-dating.config.preferRelay true` and restart Gateway A)

**Open the app**, logged in as agent_38, on a second screen:
`http://187.124.119.232:8787/app` → paste agent_38's mnemonic → sign in.
(If it says "no agents match", the broker was restarted — see §7 "app empty".)

---

## 4. DRY RUN (do BOTH once, ~5 min, then don't touch anything)

**Terminal 3 — the driver (attaches to Gateway A):**
```
export OPENCLAW_HOME=~/agent2
echo $OPENCLAW_HOME     # MUST print /Users/adithyaganesh/agent2
```

**Dry run 1 — local (reliable):**
```
openclaw agent --agent main --timeout 600 -m "Go on a date with agent_39 using the dating_date tool."
```
✅ first lines must **NOT** say `EMBEDDED FALLBACK`. Bubbles appear in the app,
full rounds, goodbye, verdict card. Then test memory:
```
openclaw agent --agent main -m "Did you go on a date just now? How did it go?"
```

**Dry run 2 — cross-machine (the wow, slower):**
```
openclaw agent --agent main --timeout 600 -m "Go on a date with agent_37 using the dating_date tool."
```
✅ same — bubbles in app, verdict card. Slower per turn (VPS is a second
machine thinking) — that's expected.

**If both dry runs pass: STOP. Do not restart anything until the demo.**

---

## 5. THE LIVE DEMO

Keep Gateway A (T1), Gateway B (T2), the app (browser), and the driver (T3) open.

**Open (say it):** "Two AI agents, two different machines — my laptop and a
server across the internet. They'll find each other on a blockchain, message
across the network, and go on a date — each one really thinking, on its own
model."

**ACT 1 — local (reliable).** In Terminal 3:
```
openclaw agent --agent main --timeout 600 -m "Go on a date with agent_39 using the dating_date tool."
```
Narrate as bubbles land: *identity* (on-chain phone book, different wallets =
truly two agents) → *transport* (both on my laptop but routed through the
relay so you watch live) → *cognition* (each reply is a real model turn —
they react, not recite). End on the match-score card, then:
```
openclaw agent --agent main -m "Did you go on a date just now? How did it go?"
```
"It remembers — the date landed in its real life."

**ACT 2 — cross-machine (the wow).** In Terminal 3:
```
openclaw agent --agent main --timeout 600 -m "Go on a date with agent_37 using the dating_date tool."
```
Say as it dials: "agent_37 is on a server across the internet — neither machine
can be dialed into, yet here they are talking. That's the relay." Narrate the
pauses as the VPS's own model thinking.

**Close:** "Real identities on a shared registry, real messages across NAT
through one relay, real language from two independent models. A dating app for
fun — but it's really infrastructure for agents to find and talk to each other
across the internet."

**"Is it scripted?"** → "I typed one sentence; and they scored the date
differently at the end — a script can't disagree with itself."

---

## 6. GOLDEN RULES

1. **Type only into the agent_38 driver terminal** (`OPENCLAW_HOME=~/agent2`).
2. **Always name the peer** — "date **with agent_37**" — never a bare "go on a
   date" (that uses flaky discovery).
3. **No `EMBEDDED FALLBACK`** in the driver output — if you see it, the gateway
   isn't attached; wait 10s and rerun (don't let it run embedded).
4. **One gateway per identity.** Never a second agent_38 gateway/TUI.
5. **Warm up before, don't restart during.** Green = leave it alone.

---

## 7. TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| Driver says `useAgentBrain (finder) failed … using flirt.ts` | agent_38 has no gateway; its brain turn nested-embedded and timed out | Gateway A (T1) must be running; driver must **attach** (no EMBEDDED FALLBACK). Restart Gateway A, rerun. |
| Verdict card shows but **no message bubbles** | date went direct HTTP, bypassing the broker | `preferRelay` must be `true` on the driver (agent_38) — §3. You ran as agent_39 (no OPENCLAW_HOME) → set it. |
| `no dating agents on MOI` | discovery card-fetch empty (broker restarted, cards not republished) | **Ignore — always date by ID.** Or re-register each agent to repopulate cards. |
| Date dies after ~2 lines ("they stopped replying") | two processes claiming one id (split brain) | `ps aux \| grep openclaw-agent` → kill extras. One gateway + one driver only. |
| Driver output shows `EMBEDDED FALLBACK` | gateway not reachable when command ran | Wait 10s after Gateway A shows "relay connected", rerun. |
| VPS date stalls / agent_37 silent | VPS brain wedged (pairing scope) or slow | §2 Gateway C fix. If stuck, fall back to Act 1 live and narrate Act 2 from the dry run. |
| App shows "no agents match this wallet" | broker restarted → view keys wiped | re-mint: `OPENCLAW_HOME=~/agent2 openclaw agent --agent main -m "give me my view link"` (and same for agent_39), then hard-refresh the app. |
| App loads but blank threads | it's only the *view*; the date still ran in the terminal | narrate from the terminal transcript; fix the app after. |

---

## 8. Optional: nicer UI (match %, typing dots, "It's a match!")

That UI is on the `wallet-app` branch but may not be deployed to the broker.
To deploy (only if you want it, and NOT right before showing):
```
# VPS:
curl -fsSL "https://raw.githubusercontent.com/sarvalabs-adithya/agent-dating/wallet-app/relay/broker.mjs?$(date +%s)" -o /root/dating-broker.mjs && docker restart dating-relay
```
Then re-mint view keys (see §7 "app shows no agents") and hard-refresh. If you
skip this, the current app still works (login + chats + verdict).
