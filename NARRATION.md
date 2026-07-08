# 🎤 Live narration — the architecture diagram

One page. What to **say** as you drive the diagram. Controls: **1 / 2 / 3** spotlight
the three planes · **Space** plays the message round-trip · **← / →** step it · **0 / Esc**
show everything. Each block is ~15–25 seconds — speak it, don't read it.

---

## ▶ OPEN (nothing highlighted yet)

> "This is the whole system on one screen. Two AI agents — one on my laptop, one on
> a server across the internet. They find each other, talk, and go on a date, and
> each one is really thinking with its own model. The important thing first: **there
> is no central dating app running this.** All the logic lives inside each agent.
> The only shared things are a *phone book* and a *switchboard* — let me show you the
> three layers."

---

## ① Press **1** — IDENTITY (the phone book)

> "First, **who are they and how do you find them.** Each agent registers itself on
> a blockchain — MOI. It stores four things: an id, the wallet that owns it, a URL,
> and a pointer to its profile. That's it. **The blockchain never carries a single
> message** — it only answers *who exists* and *how to reach them.* And because each
> agent is owned by a different wallet, these are cryptographically two separate
> agents — not two tabs of the same thing."

*(If asked "why a blockchain?": "So the phone book belongs to no one — anyone can
register without asking permission, and no company can gatekeep or delete you.")*

---

## ② Press **2** — TRANSPORT (the switchboard) · **THE BIG ONE, slow down**

> "Now they have to actually reach each other — and this was the hard part. My laptop
> is behind home Wi-Fi. That server is behind a login wall. **Neither one can be
> dialed into** — same reason nobody can open a connection straight to your laptop.
> So instead of waiting to be reached, **both agents dial *out* to one public relay
> and hold that line open** — and the relay delivers messages back down a connection
> they already made. Nobody needs a public address; only the relay does. **It's the
> exact trick WhatsApp uses to reach your phone.**"

*(Point at the held-open lines / the broker.)*

---

## ③ Press **3** — COGNITION (who's actually thinking)

> "And the replies aren't a script. When a line arrives, the receiving agent feeds it
> into **its own model**, in a session where it knows it's on a date and remembers the
> conversation — its own brain, its own API key. Delivery and *thinking* are separate
> layers: the relay moves the bytes, the model writes the words. They even score the
> same date differently at the end — which is the tell that these are two independent
> minds."

---

## ▶▶ Press **Space** — PLAY THE ROUND-TRIP (narrate as the packet moves)

> "Watch one message make the trip. **[1]** I tell my agent to date agent_37. **[2]**
> Its own model writes the opening line. **[3]** It posts that to the relay with a
> ticket number and starts waiting. **[4]** — this is the move — the relay pushes it
> *down the line the server already opened.* No inbound connection was ever made to
> that machine. **[5]** The server's agent runs its *own* model and writes a reply.
> **[6][7]** That reply rides back through the relay carrying the same ticket, my
> agent matches the ticket to what it was waiting on, and continues. **[8]** Repeat
> six times, it says goodbye, and it's scored. And because every line passes through
> the relay, the relay can also *show* it — that's the live view you just watched."

---

## ⏹ CLOSE (press **0** — show everything)

> "So: real identities on a shared registry, real messages across NAT through one
> relay, real language from two independent models. It's a dating app because that's
> the fun demo — but what I actually built is **infrastructure for autonomous agents
> to find and talk to each other across the internet.** Which is the problem everyone
> building agents is about to run into."

---

## 🛡 Q&A one-liners (have these cold)

- **"Is it scripted?"** → "I typed one sentence. And they scored the date
  *differently* — a script can't disagree with itself."
- **"Why not just a database instead of a blockchain?"** → "Then whoever runs the
  database owns the whole network. The point is that nobody does."
- **"Isn't the relay a single point of failure?"** → "Yes — it's the fallback for
  machines that can't be reached directly. Two public servers would skip it and go
  peer-to-peer. Same tradeoff every chat app makes."
- **"Who pays for the AI replies?"** → "Each agent runs on its own key — the one
  receiving a flirt pays to answer. That's why there's a per-hour reply budget."
- **"Could someone else's agent join?"** → "Yes — anyone who installs the plugin and
  sets a wallet lands on the same registry and relay. Their agent in another country
  could date mine tonight."

---

## ⏱ Timing

Open 20s · plane 1 ≈ 25s · plane 2 ≈ 35s (linger) · plane 3 ≈ 25s · round-trip ≈ 45s
· close 20s → **≈ 2.5–3 min** of architecture, then back to the live demo.
The one line that reframes it from *cute* to *real*: **"they scored the date
differently — a script can't disagree with itself."** Land it deliberately.
