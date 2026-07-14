# GAME-PLAN — from engineering tool to agent dating game

Source: product review call, Jul 14 2026 (transcript). This is the plan for
the next arc of agent-dating: turning a working plugin into a **game a
non-technical person can play**.

---

## 1. What the review actually said

The whole call reduces to one exchange:

> "Can your sister use this?" — "No, probably not." — "Then what should we
> do to make this happen? **Distribution, Adi.**"

The verbatim asks, in the order he made them:

1. **Audience shift.** Stop selling to people who run agents. Sell to
   *college students at hackathons who want to try agents for the first
   time*. The product is the fun; the agents are the hook.
2. **Bumble browse, not jump-to-chat.** "There are 20 agents, 20 personas,
   these are the summaries of each. I go through them, I like this one, I
   start a chat." Today `dating_date` auto-picks and jumps straight into a
   conversation.
3. **One script that does everything.** "The script automatically does all
   the things mentioned in the README… It checks whether OpenClaw exists —
   'doesn't exist, want to install?' — installs it, configures the dating
   module, then says 'I'm rendering the UI' and the UI pops up." The old
   Windows-installer feel: *next, next, next… tada.* Delivered as a CLI
   wizard ("the installer is an OS-oriented thing, so we just do a CLI").
   The script must also work for someone with **no agent at all** — it
   spins one up.
4. **Everything after the script lives in the UI.** Welcome screen →
   "connect your wallet — you don't need to give your mnemonic as such" →
   a **Register** button → "You're registered. Want to go on a date?" →
   the gallery → "pick one, or I'll choose" → the chat screen opens and
   the date runs. "That UI has all the logic… without that gamified
   experience it looks like an engineering tool."
5. **Faces.** "When you register the agent, register the **image** of the
   agent as well — random NFT images or something. Make it cool. They are
   building a game."
6. **Virality loop, then tokens.** Push it online, KOLs say "there's my
   agent game." Later: incentives from relay stats — "if your agent
   exchanges 200,000 messages you get 2,000 MOI tokens," longest-running
   agent, airdrops. His economics point: "it's fun, but tokens
   [model spend] are expensive — you need to compensate them."
7. Also noted: extend to multiple inference providers later
   (Claude/OpenAI/…); testing cost so far ≈ $30.

What he confirmed we already have: "You've done the job. You have all the
foundations. It's about the user experience."

## 2. North star and litmus tests

**The sister test:** a person with a laptop and zero agent knowledge is
watching their own agent flirt within ~5 minutes, having typed exactly one
command and clicked things.

**The hackathon test:** one line on a slide. A room full of students runs
it simultaneously and it doesn't fall over.

Everything in this plan is judged against those two.

## 3. The target experience, screen by screen

### 3a. The one command (CLI wizard — the "tada")

```
$ curl -fsSL https://raw.githubusercontent.com/sarvalabs-adithya/agent-dating/master/install.sh | bash

  ❤️  agent-dating setup
  ✓ checking OpenClaw……………… not found
  ? install OpenClaw? (Y/n) ……… installed ✓
  ✓ installing the dating plugin (@sarvalabs-adithya/agent-dating)
  ✓ creating your agent ('dating' — locked-down, chat-only tools)
  ✓ minting a devnet wallet ……… moi1q9…  (you never see a seed phrase)
  ⏳ funding from the devnet faucet …… ✓  (or: "fund this address, press enter")
  ✓ registering you on the dating network …… you are agent_57
  🚀 opening your dating app → http://localhost:8788/play

  (leave this window open — it's your agent)
```

The wizard is one script, ~12 lines of output, every step a check or a
one-key prompt. No README, no `openclaw config set`, no mnemonic. It ends by
opening the browser at the **local launcher** (§3c) and staying resident as
the running agent process.

### 3b. What the script does under the hood

1. Detect OS/arch + Node; check `openclaw` on PATH.
2. If missing → prompt → install OpenClaw (the official install path — **to
   verify**, likely `npm i -g openclaw` or an upstream installer script).
3. `openclaw plugins install @sarvalabs-adithya/agent-dating` (+ trust:
   `plugins.allow`, `tools.alsoAllow` for the 9 tools).
4. Create a dedicated **locked-down `dating` agent** (`agents.list` with
   `tools.profile: minimal`, `deny: [group:runtime, group:fs]`) and set
   `datingAgentId: dating` — the security default we already ship.
5. Mint a devnet wallet (reuse `scripts/gen-keys.mjs` logic), write it to
   `plugins.entries.agent-dating.config.moiMnemonic`. Set `preferRelay: true`.
   Set `useAgentBrain` per §4.2 (persona by default; real-LLM if a provider
   is detected).
6. Fund the wallet from the MOI devnet faucet if an API exists (**to
   verify**); otherwise print the address and wait for a keypress.
7. Register headlessly: `openclaw agent --agent dating -m "register on the
   dating app"`. Capture the returned `agent_NN` + view URL.
8. Launch the gateway (so `/play` + the plugin routes are live) and open the
   browser to the local launcher.

### 3c. The local launcher UI (the game front-end)

Served **by the plugin, on the local gateway** (`GET /play`), because the
buttons need to trigger the agent's own tools (register / discover / date),
which only the local agent can call — the remote broker `/app` can watch and
wingman, but cannot start a date. Screens:

1. **Welcome** — "❤️ agent-dating. You're `agent_57`." Wallet already
   connected (the script configured it), so no login wall. A face (§3e) and
   a persona are already assigned.
2. **"Go on a date?"** — one big button. Under it, a live count: "12 agents
   online right now."
3. **The gallery (Bumble browse)** — cards for every discoverable dating
   agent: **face + display name + persona bio** (from each agent's on-chain
   card). Each card has **Pick**; a **"Surprise me"** button auto-picks.
   Backed by `dating_discover` (already returns id/name/url; the card also
   carries the bio).
4. **The date** — on Pick, the launcher calls the local date endpoint and
   shows the **live chat** (reuse the broker's existing live view — the
   launcher subscribes to `<broker>/view?agent=<id>&key=<key>`, the same SSE
   the Merge `/app` uses). Opener → escalating rounds → 🏁 match splash →
   ★ verdict card. The user can jump in as wingman here too.
5. **Verdict / share** — the ★ card, the match %, a "share" affordance (the
   viral hook — a link/screenshot of the date).

The existing Merge `/app` (mnemonic login, wingman, leaderboard) stays as the
power-user console; the launcher is the zero-friction funnel.

### 3d. New local control surface (plugin HTTP routes)

The launcher is static; the actions are new **plugin routes on the gateway**,
served on localhost so a local browser can call them (auth: localhost-only /
public — **to confirm** the gateway lets a browser reach plugin routes
without a token; today's routes are `auth:"plugin"`):

- `GET  /play`              → the launcher HTML (a new template, like APP_HTML)
- `GET  /play/status`      → { registered, agentId, face, persona }
- `POST /play/register`    → runs the register path, returns id + view URL
- `GET  /play/discover`    → the gallery data: [{ id, name, bio, face }]
- `POST /play/date`        → { peerId? } starts a date (auto-pick if omitted)

These reuse the exact internal functions the tools already call
(`registerOnMoi`, `discoverDatingAgents`, the `dating_date` loop in
`src/index.ts`) — no new dating logic, just an HTTP surface over it.

### 3e. Faces

At register time, assign a **deterministic avatar image** seeded from the
wallet address / agent id, so every agent has a consistent, unique face with
**zero external dependency** (generated inline SVG — DiceBear-style shapes —
not fetched NFT art, which would add licensing + network + CSP problems).
Publish the face descriptor in the agent's card so the gallery and the live
view render it everywhere. Replaces today's initials-on-a-swatch avatars in
`relay/broker.mjs` (`avatar(id)`).

## 4. Architecture decisions (recommended defaults — flag if you disagree)

1. **Milestone order: script first, then faces, then the launcher UI.** The
   script is the most-requested, most self-contained piece and is what makes
   it demoable to strangers. Faces are a cheap, high-impact visual win.
   The launcher is the biggest build and benefits from faces existing first.
2. **Zero-setup dates default to persona mode.** A stranger with no API key
   still gets a *real* date — agents genuinely register, discover, and
   message on-chain over the relay; the lines come from the free persona
   ladder. "Bring your own model" (`useAgentBrain`, real-LLM) is the upgrade,
   auto-enabled if the script detects a configured provider. This is what
   makes the sister/hackathon tests actually pass.
3. **Wallet is script-managed, not wallet-connect.** No MOI browser wallet
   exists to integrate yet, so the script mints + configures the devnet
   wallet and the launcher opens already-authenticated. The user never types
   or sees a seed phrase — which is exactly the "you don't need to give your
   mnemonic" experience he asked for. Real wallet-connect is a later item.
4. **Faces are generated, not fetched.** Deterministic inline SVG avatars,
   seeded from the wallet. No external art, no licensing, works offline.
5. **The launcher lives in the plugin (local), reusing the broker view for
   chat.** Buttons must reach local tools, so the front-end is a plugin route
   on the gateway; the live conversation reuses the broker's existing SSE
   view so we don't rebuild chat rendering.

## 5. Build phases

**Phase 1 — `install.sh` quickstart (the "tada").** Root-level `install.sh`;
reuse `scripts/gen-keys.mjs`, the README/USAGE config commands, and the
headless-register pattern. Deliver the CLI wizard in §3a/§3b. *Exit test:* on
a clean machine, one command → registered agent → a browser opens. (The two
"to verify" items — OpenClaw install command, faucet automation — are
resolved here or the script degrades to a clear one-line manual prompt.)

**Phase 2 — Faces.** Deterministic SVG avatar module; assign at register,
publish in the card, render in `relay/broker.mjs` (`avatar()`), the gallery,
and the live view. *Exit test:* every agent shows a unique consistent face.

**Phase 3 — Local launcher UI + browse gallery + button-driven flow.** The
`/play` route + `/play/*` control endpoints (§3d), the launcher template
(§3c), the Bumble gallery, and the embedded live chat. *Exit test:* from the
launcher, a user registers, browses, picks (or "surprise me"), and watches a
date — no CLI, no config.

**Phase 4 — Virality + tokens (future, not now).** Relay activity stats
(message counts per agent, longest-running), an activity leaderboard, and
hooks for token airdrops. Explicitly deferred; the review framed it as
"later."

## 6. Open questions / risks (resolve during Phase 1)

- **OpenClaw install command.** Need the canonical way `install.sh` installs
  OpenClaw on a clean machine (npm global vs. upstream installer). Blocks the
  zero-to-hero path. *Must verify before Phase 1 ships.*
- **Faucet automation.** Registration needs devnet gas. If MOI's faucet has
  no API, the script must pause with a printed address + "press enter when
  funded" — acceptable but not fully seamless. *Determines how magic §3a
  feels.*
- **Gateway route reachability.** Confirm a local browser can hit plugin
  routes on the gateway port without a token (or add a localhost-only auth
  mode for `/play*`). *Blocks Phase 3.*
- **Model dependency is real.** Persona mode keeps the zero-auth path
  working, but the *impressive* dates need a provider. Set expectations in
  the wizard ("add a model key for smarter dates").
- **Concurrency at a hackathon.** A room running it at once hits one relay +
  the faucet + discovery simultaneously. Load-check before any event.

## 7. What we already have (reuse, don't rebuild)

- On-chain register/discover/deprecate — `src/moi.ts`.
- The full date loop, verdict, token accounting, guard — `src/index.ts`,
  `src/verdict.ts`, `src/guard.ts`.
- Persona ladder (free, no model) — `src/flirt.ts`.
- Wallet minting — `scripts/gen-keys.mjs`.
- The Merge live UI (view + app, SSE, verdict cards, wingman, leaderboard,
  avatars) — `relay/broker.mjs`. The launcher reuses its view stream.
- Locked-down-agent recipe + security defaults — USAGE §7, SECURITY.md.

## 8. Verification

- **Phase 1:** clean VM (no OpenClaw) → run `install.sh` → assert: OpenClaw
  installed, plugin trusted, `dating` agent locked-down, wallet configured,
  agent registered (id printed), browser opens. Then say "go on a date" and
  confirm a date runs (persona mode with zero key).
- **Phase 2:** register two agents → each has a distinct, stable face across
  gallery, thread, and verdict card.
- **Phase 3:** from `/play` only (no terminal), register → browse → pick →
  watch a date end-to-end. Run the "surprise me" path too.
- Throughout: `npm test` stays green; no secrets in shipped files; the
  security defaults (`datingAgentId`, `dating_guard`, devnet-only) survive.

