/**
 * agent-dating — OpenClaw plugin entry.
 *
 * Registers nine tools + three public HTTP routes:
 *   tools:
 *     dating_register   — put this agent on MOI with a "dating" tag + attach relay
 *     dating_discover   — list other dating-tagged agents on MOI
 *     dating_send       — send one flirt line to a peer, get its reply
 *     dating_date       — run a whole date (opener → rounds → closer → verdict)
 *     dating_doctor     — probe peers, report why a date won't connect
 *     dating_verdict    — score the chatlog, post the star card
 *     dating_recall     — answer "how was your date?" from the local log
 *     dating_viewlink   — re-mint the owner's private live-view link
 *     dating_deprecate  — retire this wallet's dating id on-chain (owner-only)
 *   routes (this agent's face, reachable by peers):
 *     GET  /.well-known/agent-card.json  — discovery document
 *     GET  /moi/card.json                — self-hosted MOI card (card_uri)
 *     POST /message                       — inbox: { from, text } → reply
 *
 * Routes require the general plugin entry (definePluginEntry + register(api)),
 * not defineToolPlugin (tool-only, no `api` for registerHttpRoute).
 *
 * Config lives in openclaw.json under `plugins.entries."agent-dating".config`:
 *   moiMnemonic         — devnet mnemonic (secret; bind-mounted config, never
 *                          in prompts/logs)
 *   moiDerivationPath?  — defaults to m/44'/6174'/0'/0/0
 *   agentUrl?           — public base URL; the A2A endpoint + card are served
 *                          here and published in this agent's MOI profile
 */

// Verified against openclaw@2026.6.11 (installed + typechecked): definePluginEntry
// and buildJsonPluginConfigSchema are exported from the plugin-entry subpath, NOT
// the plugin-sdk index. definePluginEntry wants an OpenClawPluginConfigSchema (a
// built wrapper), not a raw TypeBox object — buildJsonPluginConfigSchema wraps one.
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { createHmac } from "node:crypto";
import { Type } from "typebox";
import {
  registerOnMoi,
  discoverDatingAgents,
  resolvePeerUrl,
  getSelfCardJson,
  getMyIdentifier,
  getMyAgentIds,
  getMyActiveAgentIds,
  getMyCurrentAgentId,
  newestAgentId,
  stashSelfCard,
  deprecateMyAgents,
} from "./moi.js";
import { buildAgentCard, parseInboundMessage, makeReply, sendMessage, probePeer } from "./a2a.js";
import { nextFlirtLine, type Turn, type Persona } from "./flirt.js";
import { appendChatEvent, readChatEvents, now } from "./chatlog.js";
import { scoreDate, type VerdictLine } from "./verdict.js";
import { RelayClient } from "./relay.js";
import { runAgentReply, datePrompt, openerPrompt, closerPrompt } from "./agentbrain.js";
import {
  DEFAULT_RELAY_URL,
  DEFAULT_RELAY_TOKEN,
  DEFAULT_DERIVATION_PATH,
  DEFAULT_PEER_OWNER,
} from "./network.js";

const DatingConfigSchema = Type.Object(
  {
    moiMnemonic: Type.Optional(Type.String({ description: "MOI devnet mnemonic. Secret." })),
    moiDerivationPath: Type.Optional(
      Type.String({ description: "BIP-44 path; default m/44'/6174'/0'/0/0." }),
    ),
    agentUrl: Type.Optional(
      Type.String({ description: "Public base URL published in this agent's MOI profile." }),
    ),
    datingPeerOwner: Type.Optional(
      Type.String({
        description:
          "Optional: only match dating agents owned by this wallet address (comma-separated for several). Makes A discover only your B on the shared devnet.",
      }),
    ),
    relayUrl: Type.Optional(
      Type.String({
        description:
          "Optional: a dating-relay broker URL (see relay/broker.mjs). When set, this agent sends/receives flirts through the relay by MOI id — OUTBOUND only, so no public /message endpoint is needed. Works behind NAT and on managed hosts.",
      }),
    ),
    relayToken: Type.Optional(
      Type.String({ description: "Optional shared secret for the relay broker (if it was started with RELAY_TOKEN)." }),
    ),
    relayId: Type.Optional(
      Type.String({
        description:
          "Optional explicit relay inbox id(s), comma-separated. Overrides deriving ids from MOI — use it to give this agent a stable relay handle, or to relay before registering on-chain.",
      }),
    ),
    preferRelay: Type.Optional(
      Type.Boolean({
        description:
          "Force every id-addressed dial through the relay (default false: direct HTTP first, relay as fallback). Set it when every line must pass through the broker — e.g. so its live /view shows a date between two agents that could otherwise reach each other directly. No silent fallback: if the relay is down, the dial fails loudly.",
      }),
    ),
    displayName: Type.Optional(
      Type.String({ description: "This agent's name / persona label, used in replies and the chat view (e.g. 'Bridge')." }),
    ),
    personaDrive: Type.Optional(
      Type.String({ description: "What this agent secretly wants (its DRIVE). Shapes every line it says." }),
    ),
    personaFlaw: Type.Optional(
      Type.String({ description: "The way this agent can't help talking (its FLAW/job). The comedy is this cracking." }),
    ),
    personaLines: Type.Optional(
      Type.String({ description: "Offline escalation ladder for this persona: a JSON array of strings (or comma-separated). Used when no OpenAI key is set." }),
    ),
    useAgentBrain: Type.Optional(
      Type.Boolean({
        description:
          "When true, incoming flirts are answered by THIS gateway's real agent (via `openclaw agent`) in a per-date session — so the agent KNOWS it's dating and replies as itself. Costs one model turn per incoming line. Default false (free flirt.ts brain).",
      }),
    ),
    openclawBin: Type.Optional(
      Type.String({ description: "Path to the openclaw binary for useAgentBrain (default: 'openclaw' on PATH)." }),
    ),
    datingAgentId: Type.Optional(
      Type.String({ description: "Which local agent answers dates when useAgentBrain is on (`openclaw agent --agent <id>`). Default 'main'." }),
    ),
  },
  { additionalProperties: false },
);

interface DatingConfig {
  moiMnemonic?: string;
  moiDerivationPath?: string;
  agentUrl?: string;
  datingPeerOwner?: string;
  relayUrl?: string;
  relayToken?: string;
  relayId?: string;
  preferRelay?: boolean;
  displayName?: string;
  personaDrive?: string;
  personaFlaw?: string;
  personaLines?: string;
  useAgentBrain?: boolean;
  openclawBin?: string;
  datingAgentId?: string;
}

// A tiny monotonic-ish message id source. Date.now()/Math.random() are fine in
// plugin runtime (unlike the workflow sandbox); a per-process counter keeps
// ids stable and readable in transcripts.
let msgSeq = 0;
function nextMessageId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${msgSeq}`;
}

// Per-peer conversation memory. The inbound /message handler is stateless per
// HTTP call, but flirting only works if replies ESCALATE — the flirt brain
// picks its move from how many turns have passed (history length). Keyed by the
// peer's `from` id so two simultaneous suitors don't cross wires. Lives for the
// gateway process; a real date is a handful of turns, so growth is a non-issue.
const conversations = new Map<string, Turn[]>();
function conversationWith(peer: string): Turn[] {
  let convo = conversations.get(peer);
  if (!convo) {
    convo = [];
    conversations.set(peer, convo);
  }
  return convo;
}

// This agent's own display name for the chat view. Falls back to the persona
// label used by the flirt brain, then a generic. (Config-aware versions live
// inside register(api); these module-level stubs are unused now.)

export default definePluginEntry({
  id: "agent-dating",
  name: "Agent Dating",
  description:
    "Register on MOI as a dating-tagged agent, discover other dating-tagged agents, and flirt with them over the A2A protocol.",
  configSchema: buildJsonPluginConfigSchema(DatingConfigSchema as any),
  register(api: any) {
    // Verified: the plugin's OWN config is api.pluginConfig (api.config is the
    // whole OpenClawConfig). Env fallback kept for the bootstrap/demo path.
    const config = (): DatingConfig => (api.pluginConfig ?? {}) as DatingConfig;

    // Which local agent authors real-brain date lines — and a one-time security
    // nudge. A date line is a REAL turn of this agent, including its tools, and
    // the peer's text is attacker-controlled on an open network (prompt
    // injection). Answering with the default `main` agent hands that text to a
    // fully-tooled assistant (exec/file/network). Point datingAgentId at a
    // dedicated minimal-tool agent instead — see SECURITY.md / USAGE.md.
    let warnedMainBrain = false;
    const datingAgent = (): string => {
      const id = config().datingAgentId || "main";
      if (id === "main" && config().useAgentBrain && !warnedMainBrain) {
        warnedMainBrain = true;
        console.warn(
          "agent-dating: ⚠️ dates are answered by the 'main' agent, which has " +
          "full tools (exec/file/network). A hostile date can attempt prompt " +
          "injection. Set plugins.entries.agent-dating.config.datingAgentId to a " +
          "dedicated minimal-tool agent — see SECURITY.md.",
        );
      }
      return id;
    };

    // Public base URL, with an env fallback (AGENT_DATING_URL) so the A2A
    // routes work even if api.config isn't wired the way we assumed. The
    // bootstrap sets this env per gateway.
    const agentBaseUrl = (): string | undefined =>
      config().agentUrl || process.env.AGENT_DATING_URL;

    function resolveCreds() {
      const c = config();
      const mnemonic = c.moiMnemonic ?? process.env.MOI_MNEMONIC;
      if (!mnemonic) {
        throw new Error(
          "agent-dating: no MOI mnemonic configured. Set plugins.entries.agent-dating.config.moiMnemonic in openclaw.json (or MOI_MNEMONIC env).",
        );
      }
      const derivationPath =
        c.moiDerivationPath || process.env.MOI_DERIVATION || DEFAULT_DERIVATION_PATH || undefined;
      return { mnemonic, derivationPath };
    }

    // Peer-owner allowlist: config → env → baked default (network.ts). Empty = anyone.
    const peerOwnersCfg = (): string[] =>
      (config().datingPeerOwner || process.env.AGENT_DATING_PEER_OWNER || DEFAULT_PEER_OWNER || "")
        .split(",").map((s) => s.trim()).filter(Boolean);

    // ---- This agent's identity + persona (config → env → default) -----------
    // The findee answers in ITS OWN character everywhere (incl. a managed
    // gateway with no env) because the persona comes from config, not just env.
    const selfName = (): string =>
      config().displayName || process.env.DATING_DISPLAY_NAME || process.env.DATING_PERSONA_LABEL || "Me";

    const parsePersonaLines = (raw?: string): string[] | undefined => {
      if (!raw) return undefined;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) return arr as string[];
      } catch { /* not JSON — treat as comma-separated */ }
      const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
      return list.length ? list : undefined;
    };

    const brainPersona = () => ({
      name: config().displayName,
      drive: config().personaDrive,
      flaw: config().personaFlaw,
    });
    const myPersona = (): Persona => ({
      label: config().displayName,
      drive: config().personaDrive,
      flaw: config().personaFlaw,
      lines: parsePersonaLines(config().personaLines),
    });

    // Write the meta header once per process so the CLI knows both speakers.
    let metaWritten = false;
    const ensureMeta = async (peerName: string): Promise<void> => {
      if (metaWritten) return;
      metaWritten = true;
      await appendChatEvent({
        type: "meta",
        self: { name: selfName(), persona: config().displayName || process.env.DATING_PERSONA_LABEL },
        peer: { name: peerName },
        startedAt: now(),
      });
    };

    // Resolution: explicit config → env → baked-in default network (network.ts).
    // The baked default lets a fresh install auto-join with no config at all.
    const relayUrlCfg = (): string | undefined =>
      config().relayUrl || process.env.DATING_RELAY_URL || DEFAULT_RELAY_URL || undefined;

    // The owner's private view link: a per-agent secret derived from the wallet
    // mnemonic (only this agent's owner can mint it — nothing stored anywhere),
    // published to the broker so /view?agent=<id>&key=<key> streams ONLY this
    // agent's threads. Deterministic → stable across restarts and re-registers.
    const viewKeyFor = (agentId: string, mnemonic: string): string =>
      createHmac("sha256", mnemonic).update(`dating-view:${agentId}`).digest("hex").slice(0, 32);
    const publishViewLink = async (agentId: string, mnemonic: string): Promise<string | undefined> => {
      const base = relayUrlCfg();
      if (!relay || !base) return undefined;
      const key = viewKeyFor(agentId, mnemonic);
      await relay.putViewKey(agentId, key);
      return `${base.replace(/\/+$/, "")}/view?agent=${encodeURIComponent(agentId)}&key=${key}`;
    };
    const relayTokenCfg = (): string | undefined =>
      config().relayToken || process.env.DATING_RELAY_TOKEN || DEFAULT_RELAY_TOKEN || undefined;

    // Shared "answer an incoming flirt" logic, used by BOTH the inbound HTTP
    // /message route and the relay inbox. Keeps per-peer history so replies
    // escalate, and logs both sides to the chat view.
    async function replyTo(fromId: string, text: string, peerName?: string): Promise<string> {
      const name = peerName || fromId;
      const history = conversationWith(fromId);
      history.push({ who: name, line: text });

      let line: string;
      if (config().useAgentBrain) {
        // Answer with THIS gateway's real agent, in a per-date session, so it
        // knows it's dating and replies as itself. Fall back to flirt.ts on any
        // failure so a date never dead-ends.
        try {
          // `openclaw agent` needs an explicit --agent target, and the session
          // key must be scoped to it (agent:<id>:...) or the gateway rejects the
          // turn with "No target session selected". Keep one session per date so
          // the agent remembers the conversation.
          const agentId = datingAgent();
          const turn = await runAgentReply(datePrompt(name, text, brainPersona()), {
            bin: config().openclawBin,
            agentId,
            sessionKey: `agent:${agentId}:dating:${fromId}`,
            timeoutMs: 90000,
          });
          line = turn.text;
          // The responder pays per incoming line, on its own key — say so.
          if (turn.usage) console.log(`agent-dating: brain reply cost — in ${turn.usage.input} / out ${turn.usage.output} tokens (answering ${name})`);
        } catch (e: any) {
          console.warn(`agent-dating: useAgentBrain turn failed (${e?.message || e}); using flirt.ts.`);
          line = await nextFlirtLine(history, myPersona());
        }
      } else {
        line = await nextFlirtLine(history, myPersona());
      }
      history.push({ who: selfName(), line });
      await ensureMeta(name);
      await appendChatEvent({ type: "msg", speaker: "peer", name, line: text, at: now() });
      await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line, at: now() });
      return line;
    }

    // Send one line to a peer and get their reply, choosing transport:
    //  - relay (by MOI id) when a relay is configured and the target is an id;
    //  - direct HTTP POST /message otherwise (target is a URL, or the peer's
    //    on-chain url resolved from its MOI id).
    // Direct HTTP is the PRIMARY path — simplest, and works whenever the peer's
    // /message is reachable (the webinar case). The relay is a FALLBACK for peers
    // behind NAT or a managed host (Hostinger) whose inbound is blocked. The
    // per-peer decision is cached so a blocked peer only costs one probe, then
    // every later turn goes straight to the transport that worked.
    const peerTransport = new Map<string, "http" | "relay">();
    async function dialPeer(
      target: string,
      creds: { mnemonic: string; derivationPath?: string },
      text: string,
    ): Promise<{ reply: string; via: "relay" | "http"; target: string }> {
      const isUrl = /^https?:\/\//i.test(target);
      await relayReady;

      const viaHttp = async () => {
        const url = isUrl ? target : await resolvePeerUrl(target, creds);
        const myId = await getMyIdentifier(creds);
        const reply = await sendMessage(url, myId, text); // throws on login-page/HTML/error
        return { reply, via: "http" as const, target: url };
      };
      const viaRelay = async () => {
        if (!relay || !myRelayId || isUrl) throw new Error("relay not available for this target");
        // A peer answering with its REAL agent (useAgentBrain) needs a whole
        // `openclaw agent` spawn + model turn per line. On a slow/cold remote
        // host that's routinely ~60s, and the peer's own brain timeout is 90s
        // — so the dialer must wait LONGER than the peer is allowed to think,
        // plus transit. 75s was shorter than the peer's 90s allowance and cut
        // cross-machine dates off mid-turn ("they stopped replying").
        const reply = await relay.request(target, myRelayId, text, 120000);
        return { reply, via: "relay" as const, target };
      };
      // One log line per transport decision so a demo gone quiet is debuggable
      // from the gateway log alone ("which road did my lines take?").
      const decided = (via: "http" | "relay", why: string) => {
        peerTransport.set(target, via);
        console.log(`agent-dating: dialing ${target} via ${via} (${why})`);
      };

      // preferRelay forces every id-addressed dial through the relay — no
      // silent fall-back to direct. For when the broker must see every line
      // (its /view is the demo screen) even though the peer is directly
      // reachable, e.g. two agents on the same laptop. A relay failure then
      // surfaces as an error instead of quietly bypassing the view. Checked
      // before the cache so a stale earlier "http" decision can't override it.
      // (Explicit http:// targets still dial direct — the relay routes by id.)
      if (config().preferRelay && !isUrl) {
        if (!relay || !myRelayId) throw new Error("preferRelay is set but the relay is not connected (check relayUrl / registration)");
        if (peerTransport.get(target) !== "relay") decided("relay", "preferRelay forces the broker path");
        return viaRelay();
      }

      // Honor a cached decision from an earlier turn with this peer.
      const cached = peerTransport.get(target);
      if (cached === "http") return viaHttp();
      if (cached === "relay") return viaRelay();

      // Undecided: try DIRECT first, fall back to the relay if it's blocked.
      try {
        const r = await viaHttp();
        decided("http", "direct /message reachable");
        return r;
      } catch (httpErr) {
        if (relay && myRelayId && !isUrl) {
          try {
            const r = await viaRelay();
            decided("relay", "direct unreachable; broker fallback");
            return r;
          } catch {
            /* relay also failed — surface the direct error, it's more informative */
          }
        }
        throw httpErr;
      }
    }

    // ---- Relay transport (outbound-only; works behind NAT / managed hosts) ---
    // When relayUrl is configured we connect an inbox for each of THIS wallet's
    // MOI agent ids and answer inbound flirts through the relay. dating_send /
    // dating_date then message peers by MOI id instead of a direct URL.
    let relay: RelayClient | null = null;
    let myRelayId: string | null = null;
    // Per-PROCESS state, not per-register()-run: OpenClaw re-runs register()
    // (config reloads; the embedded runtime re-registers several times), and
    // tool closures from older runs stay live mid-date. The set lives on
    // globalThis so a re-run never re-listens an id the process already
    // listens on.
    const G = globalThis as Record<string, any>;
    const listenedIds: Set<string> = (G.__agentDatingListened ??= new Set<string>());
    // Answer each relayed message id ONCE. The broker can briefly hold more
    // than one live stream for an id (reconnect races, pre-eviction ghosts),
    // and each stream delivers its own copy of the same message — without this
    // guard every copy triggers a full (possibly LLM-priced) reply.
    const seenMsgIds = new Set<string>();
    const seenMsgOrder: string[] = [];
    const alreadyAnswered = (id: string | null): boolean => {
      if (!id) return false; // fire-and-forget lines have no id — let them through
      if (seenMsgIds.has(id)) return true;
      seenMsgIds.add(id);
      seenMsgOrder.push(id);
      if (seenMsgOrder.length > 500) seenMsgIds.delete(seenMsgOrder.shift()!);
      return false;
    };
    // Start listening on the relay for one of THIS agent's ids. Idempotent, and
    // callable AFTER startup — so a freshly-registered agent becomes reachable
    // over the relay immediately, without waiting for a gateway restart.
    const attachInbox = (id: string): void => {
      if (!relay || !id || listenedIds.has(id)) return;
      listenedIds.add(id);
      if (!myRelayId) myRelayId = id;
      relay.listen(id, (m) => {
        void (async () => {
          if (alreadyAnswered(m.id)) return;
          const line = await replyTo(m.from, m.text);
          const ok = await relay!.post({ to: m.from, from: m.to, id: m.id, kind: "reply", text: line });
          // A reply the broker can't deliver is a date silently dying on the
          // other side — make it loud so the logs name the failing hop.
          if (!ok) console.warn(`agent-dating: reply to ${m.from} was NOT delivered — their inbox stream is gone from the relay (id ${m.id ?? "none"})`);
        })();
      });
    };

    const relayReady = (async () => {
      // Set by runAgentReply for its subprocesses: a brain-turn spawn that
      // falls back to an embedded agent must not connect to the relay — it
      // would evict the real agent's inbox stream mid-date (newest-wins).
      if (process.env.AGENT_DATING_NO_RELAY === "1") return;
      const url = relayUrlCfg();
      if (!url) return;
      try {
        // ONE RelayClient per process, REUSED across register() re-runs.
        // Closing + recreating on every re-run (the old approach) orphaned
        // any date in flight: the dating_date closure kept sending requests
        // from the old client while the reply came down the NEW client's
        // stream — "got a reply for unknown request id", date dies with
        // "they stopped replying". Reuse keeps every closure's requests and
        // the live stream on the same object. Only a changed relay URL
        // warrants a fresh client.
        let client: RelayClient | null = G.__agentDatingRelay ?? null;
        if (client && G.__agentDatingRelayUrl !== url) {
          try { client.close(); } catch { /* dying client */ }
          client = null;
          listenedIds.clear();
        }
        if (!client) {
          client = new RelayClient(url, relayTokenCfg(), (s) => console.warn(`agent-dating relay: ${s}`));
          G.__agentDatingRelay = client;
          G.__agentDatingRelayUrl = url;
        }
        relay = client;
        const explicit = (config().relayId || process.env.DATING_RELAY_ID || "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        let ids: string[] = explicit;
        if (!ids.length) {
          let creds;
          try { creds = resolveCreds(); } catch { return; } // no mnemonic yet → attach on register
          // ACTIVE ids only: retired identities must not hold inboxes (they'd
          // haunt the broker's peers list forever after a dating_deprecate).
          ids = await getMyActiveAgentIds(creds);
        }
        for (const id of ids) attachInbox(id);
        // Identify outbound as the NEWEST registration (the id this agent
        // advertises), not whichever id happened to attach first — otherwise a
        // wallet with old registrations flirts as a stale identity (agent_19
        // instead of agent_37). Explicit relayId config keeps ITS order: the
        // first listed id stays primary.
        if (!explicit.length && ids.length) myRelayId = newestAgentId(ids) ?? myRelayId;
        console.log(`agent-dating: relay connected at ${url} for ${listenedIds.size} id(s); primary ${myRelayId ?? "(none yet)"}`);
        // Re-publish the owner's private view key on every boot: the broker
        // stores it in memory, so a broker restart would otherwise 401 the
        // owner's saved view link until the next dating_register.
        if (myRelayId && !explicit.length) {
          try {
            const creds = resolveCreds();
            void publishViewLink(myRelayId, creds.mnemonic);
          } catch { /* no mnemonic yet — the link publishes on register instead */ }
        }
      } catch (e: any) {
        console.warn(`agent-dating: relay connect failed: ${e?.message || e}`);
      }
    })();

    // ---- Tools --------------------------------------------------------------

    // Adapt an ergonomic {name, description, parameters, execute(params)} spec
    // to a real AnyAgentTool. Verified shape (openclaw@2026.6.11): AgentTool
    // needs a `label` and execute(toolCallId, params, signal?, onUpdate?) that
    // returns an AgentToolResult { content: TextContent[]; details }.
    const registerTool = (spec: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (params: any) => Promise<unknown> | unknown;
    }) =>
      api.registerTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (_toolCallId: string, params: any) => {
          const result = await spec.execute(params);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return { content: [{ type: "text", text }], details: result };
        },
      });

    registerTool({
      name: "dating_register",
      description:
        "Register this agent on the MOI on-chain agent registry with a 'dating' skill tag so other agents can discover it. Idempotent: if this wallet already has a registration, it is REUSED (same stable id) instead of minting a new one — pass fresh:true to force a brand-new identity.",
      parameters: Type.Object(
        {
          displayName: Type.String({ description: "The dating display name for this agent." }),
          bio: Type.String({ description: "A short dating bio / vibe (one or two sentences)." }),
          fresh: Type.Optional(
            Type.Boolean({ description: "Force a brand-new on-chain registration (new agent id) even if this wallet already has one. Default false: reuse the existing id." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { displayName: string; bio: string; fresh?: boolean }) => {
        const creds = resolveCreds();

        // Idempotent path: reuse this wallet's current (newest ACTIVE) agent so
        // the identity is STABLE across restarts — re-registering every boot
        // churned out a new id each time (agent_17 → 33 → 35 …) and left a
        // trail of deprecated ghosts.
        const wantUrl = (agentBaseUrl() || "").replace(/\/+$/, "").toLowerCase();
        if (!params.fresh) {
          let existing: { agentId: string; url: string } | null = null;
          try {
            existing = await getMyCurrentAgentId(creds);
          } catch {
            /* registry read failed — fall through to a fresh registration */
          }
          // Only reuse if the id's ON-CHAIN url still matches where we serve now.
          // If the public url rotated (e.g. an ephemeral tunnel), the old id's
          // card_uri points at a dead address and peers can't discover us —
          // so re-register instead of silently reusing a stale, invisible id.
          const onChainUrl = (existing?.url || "").replace(/\/+$/, "").toLowerCase();
          const urlStillValid = !wantUrl || onChainUrl === wantUrl;
          if (existing && urlStillValid) {
            // Serve a card for the reused id so peers can still discover us
            // (its on-chain card_uri points at our /moi/card.json route).
            stashSelfCard({ displayName: params.displayName, bio: params.bio, agentUrl: agentBaseUrl() });
            await relayReady;
            attachInbox(existing.agentId);
            myRelayId = existing.agentId; // outgoing flirts identify as the advertised id
            // Publish the card on the broker too, so peers whose direct fetch of
            // our card_uri fails (we're NAT'd/walled) can still discover us.
            const reusedCard = getSelfCardJson();
            if (relay && reusedCard) await relay.putCard(existing.agentId, reusedCard);
            const reusedViewUrl = await publishViewLink(existing.agentId, creds.mnemonic);
            return {
              ok: true,
              agentId: existing.agentId,
              reused: true,
              reachableVia: relay ? "relay + direct" : "direct",
              viewUrl: reusedViewUrl,
              message: `Already registered on MOI — reusing stable id ${existing.agentId}. (Pass fresh:true for a new identity.)${reusedViewUrl ? ` Watch this agent's dates live (owner-only link): ${reusedViewUrl}` : ""}`,
            };
          }
          if (existing && !urlStillValid) {
            console.warn(
              `agent-dating: on-chain url for ${existing.agentId} (${existing.url || "none"}) != current ${wantUrl} — re-registering so discovery stays valid.`,
            );
          }
        }

        const { agentId, walletAddress } = await registerOnMoi({
          displayName: params.displayName,
          bio: params.bio,
          agentUrl: agentBaseUrl(),
          relayCardBase: relayUrlCfg(), // no public url → card_uri points at the broker's card store
          ...creds,
        });
        // Become reachable on the relay under the NEW id right away (no restart).
        await relayReady;
        attachInbox(agentId);
        myRelayId = agentId; // the fresh registration is now this agent's identity
        // Publish the card on the broker (keyed by id AND wallet) so peers can
        // discover us even when our own card_uri isn't reachable (NAT/walled).
        const freshCard = getSelfCardJson();
        if (relay && freshCard) {
          await relay.putCard(agentId, freshCard);
          await relay.putCard(walletAddress.toLowerCase(), freshCard);
        }
        const viewUrl = await publishViewLink(agentId, creds.mnemonic);
        return {
          ok: true,
          agentId,
          walletAddress,
          reachableVia: relay ? "relay + direct" : "direct",
          viewUrl,
          message: `Registered on MOI as ${agentId} (wallet ${walletAddress}).${viewUrl ? ` Watch this agent's dates live (owner-only link): ${viewUrl}` : ""}`,
        };
      },
    });

    registerTool({
      name: "dating_discover",
      description:
        "List other agents registered on the MOI registry that carry the 'dating' tag. Returns their MOI ids, display names, and A2A URLs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const creds = resolveCreds();
        const peerOwners = peerOwnersCfg();
        const matches = await discoverDatingAgents(creds, { peerOwners, relayCardBase: relayUrlCfg() });
        return { ok: true, count: matches.length, matches };
      },
    });

    registerTool({
      name: "dating_send",
      description:
        "Send one flirty line to another dating agent over A2A and return their reply. Look up the peer by its MOI agent id (from dating_discover). Each exchange is logged for the live chat view.",
      parameters: Type.Object(
        {
          moiAgentId: Type.String({ description: "The date's MOI agent id (from dating_discover)." }),
          message: Type.String({ description: "Your one flirty line (under 14 words, plain, in character)." }),
          peerName: Type.Optional(
            Type.String({ description: "The date's display name (from dating_discover), for the chat view." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { moiAgentId: string; message: string; peerName?: string }) => {
        const creds = resolveCreds();
        const peerName = params.peerName || params.moiAgentId;

        await ensureMeta(peerName);
        // Log our line before sending so the view shows it even if the peer 500s.
        await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line: params.message, at: now() });

        const { reply, via, target } = await dialPeer(params.moiAgentId, creds, params.message);

        await appendChatEvent({ type: "msg", speaker: "peer", name: peerName, line: reply, at: now() });
        return { ok: true, via, target, sent: params.message, reply };
      },
    });

    registerTool({
      name: "dating_doctor",
      description:
        "Diagnose why a date won't connect. Probes a peer's dating endpoints (by MOI id or direct URL) and, if no target is given, every discovered dating peer, and reports exactly what's wrong: unreachable, reachable-but-not-serving-the-plugin (login/HTML page = routes not registered), or healthy. Also reports THIS agent's own published URL so you can check it's serving. Pure diagnostics, no flirting, no cost. Use this the moment a date bounces off a login page.",
      parameters: Type.Object(
        {
          target: Type.Optional(
            Type.String({ description: "Optional MOI agent id, or a direct base URL (http://…), to probe. Omit to probe all discovered dating peers." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { target?: string }) => {
        const creds = resolveCreds();
        const selfUrl = agentBaseUrl();
        const results: Array<{ target: string } & Awaited<ReturnType<typeof probePeer>>> = [];

        const probeOne = async (label: string, url: string) => {
          const p = await probePeer(url);
          results.push({ target: label, ...p });
        };

        if (params.target && /^https?:\/\//i.test(params.target)) {
          await probeOne(params.target, params.target);
        } else if (params.target) {
          const url = await resolvePeerUrl(params.target, creds).catch((e) => {
            results.push({ target: params.target!, url: "", reachable: false, servesDating: false, detail: `Could not resolve MOI id: ${e?.message || e}` });
            return null;
          });
          if (url) await probeOne(params.target, url);
        } else {
          const peerOwners = peerOwnersCfg();
          const matches = await discoverDatingAgents(creds, { peerOwners, relayCardBase: relayUrlCfg() });
          if (!matches.length) {
            return { ok: true, self: { url: selfUrl }, peers: [], summary: "No dating peers discovered on MOI to probe." };
          }
          for (const m of matches) await probeOne(`${m.name} (${m.agentId})`, m.url);
        }

        const healthy = results.filter((r) => r.servesDating).length;
        return {
          ok: true,
          self: {
            url: selfUrl,
            note: selfUrl
              ? `Peers will POST to ${selfUrl.replace(/\/+$/, "")}/message. Confirm that returns JSON, not a login page.`
              : "No agentUrl configured — peers cannot reach this agent. Set plugins.entries.agent-dating.config.agentUrl.",
          },
          peers: results,
          summary: `${healthy}/${results.length} probed peer(s) are serving the dating plugin.`,
        };
      },
    });

    registerTool({
      name: "dating_date",
      description:
        "Go on a COMPLETE date in one call: discover a dating peer on MOI (or use the one you name), then run the whole escalating flirt exchange automatically — the plugin authors THIS agent's lines from its own persona, the peer authors theirs over A2A. Cheap: it does NOT burn your agent's LLM loop per line. Logs every line to the chat view and returns the full transcript + verdict. Prefer this over calling dating_send in a loop yourself.",
      parameters: Type.Object(
        {
          moiAgentId: Type.Optional(
            Type.String({
              description: "Optional: the MOI id of the specific agent to date. Omit to auto-pick the first discovered dating peer. For local/dev testing you may also pass a peer base URL directly (http://…), which skips MOI discovery entirely.",
            }),
          ),
          turns: Type.Optional(
            Type.Number({ description: "How many lines THIS agent sends (each gets a reply). Default 6." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { moiAgentId?: string; turns?: number }) => {
        const creds = resolveCreds();
        const turns = Math.max(2, Math.min(12, Math.floor(params.turns ?? 6)));

        // 1) Find the date. Precedence:
        //    a) a directly-supplied peer URL (http…) or MOI id — dial as given;
        //    b) auto-discover (honoring the peer-owner allowlist), first match.
        // The transport (relay vs direct HTTP) is chosen per-hop by dialPeer.
        let peerId = params.moiAgentId;
        let peerName = peerId || "";
        if (!peerId) {
          const peerOwners = peerOwnersCfg();
          const matches = await discoverDatingAgents(creds, { peerOwners, relayCardBase: relayUrlCfg() });
          if (!matches.length) {
            return {
              ok: false,
              reason: "no-peer",
              message:
                "No other dating agents on MOI right now. Register a second agent (dating_register) or wait for one to appear, then try again.",
            };
          }
          peerId = matches[0].agentId;
          peerName = matches[0].name;
        }
        if (!peerName || /^https?:\/\//i.test(peerName)) peerName = "peer";
        const dialTarget = peerId; // URL or MOI id — dialPeer picks the transport

        await ensureMeta(peerName);

        // 2) Run the whole date. OUR lines come from THIS agent's own LLM when
        //    useAgentBrain is on (so the initiator reasons as itself, same as the
        //    findee) — otherwise from the persona/flirt brain (free/canned).
        //    THEIR lines come from the peer over the chosen transport.
        const history: Turn[] = [];
        const transcript: Array<{ from: "self" | "peer"; name: string; line: string }> = [];
        let via: "relay" | "http" = "http";

        // TOKEN COST: what this date costs THIS side, measured (not guessed) —
        // one brain turn per line we author, usage read from the CLI's --json.
        // Turns whose usage the CLI omits count as "unknown", never as free.
        const dateUsage = { brainTurns: 0, inputTokens: 0, outputTokens: 0, unknownTurns: 0 };
        const addDateUsage = (u: { input: number; output: number } | null): void => {
          dateUsage.brainTurns++;
          if (u) { dateUsage.inputTokens += u.input; dateUsage.outputTokens += u.output; }
          else dateUsage.unknownTurns++;
        };

        // WINGMAN AWARENESS: mid-date, the owner can interject lines from the
        // /app (sent AS this agent through the broker). The loop only knows
        // lines it authored — so at each turn boundary, pull the thread from
        // the broker and fold in anything new (the owner's line + the peer's
        // answer to it). Both end up in history/transcript, so the next brain
        // turn BUILDS on the owner's assist instead of blundering past it, and
        // the verdict scores the whole hybrid date. Best-effort: sync failures
        // must never break a date.
        const sentByLoop = new Set<string>();   // texts this loop authored
        const seenPeerTexts = new Set<string>(); // peer texts the loop recorded
        let syncCursor = "";                     // broker `at` high-water mark
        const syncWingmanLines = async (primeOnly = false): Promise<void> => {
          const base = relayUrlCfg();
          if (!base || !myRelayId || /^https?:\/\//i.test(dialTarget)) return;
          try {
            const key = viewKeyFor(myRelayId, creds.mnemonic);
            const u = `${base.replace(/\/+$/, "")}/history?agent=${encodeURIComponent(myRelayId)}&key=${key}&with=${encodeURIComponent(dialTarget)}&limit=40`;
            const r = await fetch(u);
            if (!r.ok) return;
            const d: any = await r.json().catch(() => null);
            for (const e of d?.events ?? []) {
              if ((e?.kind !== "msg" && e?.kind !== "reply") || typeof e.text !== "string" || typeof e.at !== "string") continue;
              if (syncCursor && e.at <= syncCursor) continue;
              syncCursor = e.at > syncCursor ? e.at : syncCursor;
              if (primeOnly) continue; // date start: set the high-water mark, fold nothing old
              const fromMe = e.from === myRelayId;
              if (fromMe && sentByLoop.has(e.text)) continue;
              if (!fromMe && seenPeerTexts.has(e.text)) continue;
              const who = fromMe ? selfName() : peerName;
              history.push({ who, line: e.text });
              transcript.push({ from: fromMe ? "self" : "peer", name: who, line: e.text });
              await appendChatEvent({ type: "msg", speaker: fromMe ? "self" : "peer", name: who, line: e.text, at: now() });
              console.log(`agent-dating: wingman line folded into the date (${fromMe ? "owner-as-me" : peerName}): ${e.text.slice(0, 60)}`);
            }
          } catch { /* best-effort */ }
        };
        await syncWingmanLines(true);

        // WINGMAN WHEEL: the owner can HOLD this date from the /app (⏸). While
        // held, the loop parks at the turn boundary — the human types, the peer
        // answers, our sync keeps folding those lines in — and when released
        // (or after a hard cap) the loop picks the thread back up. Best-effort:
        // a dead broker means no hold, never a stuck date.
        const wheelHeldNow = async (): Promise<boolean> => {
          const base = relayUrlCfg();
          if (!base || !myRelayId || /^https?:\/\//i.test(dialTarget)) return false;
          try {
            const r = await fetch(`${base.replace(/\/+$/, "")}/wheel?agent=${encodeURIComponent(myRelayId)}&peer=${encodeURIComponent(dialTarget)}`);
            if (!r.ok) return false;
            const d: any = await r.json().catch(() => null);
            return Boolean(d?.held);
          } catch { return false; }
        };
        const yieldWheel = async (): Promise<void> => {
          const HOLD_MAX_MS = 240000; // never park longer than 4 minutes
          const start = Date.now();
          let parked = false;
          while (Date.now() - start < HOLD_MAX_MS && (await wheelHeldNow())) {
            if (!parked) { parked = true; console.log("agent-dating: wheel HELD by the owner — date loop parked, floor is theirs"); }
            await new Promise((r) => setTimeout(r, 4000));
            await syncWingmanLines(); // fold the owner's lines as they land
          }
          if (parked) console.log("agent-dating: wheel released — the date loop continues");
        };

        // Generate the initiator's next line — real agent turn or persona.
        const nextMyLine = async (): Promise<string> => {
          if (config().useAgentBrain) {
            try {
              const agentId = datingAgent();
              // The newest PEER line, not merely the newest line — after a
              // wingman fold the tail can be the owner's own interjection, and
              // the brain must never be told it "just heard" its own words.
              let last: string | null = null;
              for (let k = history.length - 1; k >= 0; k--) { if (history[k].who !== selfName()) { last = history[k].line; break; } }
              const prompt = last ? datePrompt(peerName, last, brainPersona()) : openerPrompt(peerName, brainPersona());
              const turn = await runAgentReply(prompt, {
                bin: config().openclawBin,
                agentId,
                sessionKey: `agent:${agentId}:dating-out:${dialTarget}`,
                timeoutMs: 90000,
              });
              addDateUsage(turn.usage);
              return turn.text;
            } catch (e: any) {
              console.warn(`agent-dating: useAgentBrain (finder) failed (${e?.message || e}); using flirt.ts.`);
            }
          }
          return await nextFlirtLine(history, myPersona());
        };
        for (let i = 0; i < turns; i++) {
          await syncWingmanLines(); // fold owner interjections before thinking
          await yieldWheel(); // if the owner holds ⏸, park here until release
          const myLine = await nextMyLine();
          sentByLoop.add(myLine);
          history.push({ who: selfName(), line: myLine });
          transcript.push({ from: "self", name: selfName(), line: myLine });
          await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line: myLine, at: now() });

          let reply: string;
          try {
            const dialed = await dialPeer(dialTarget, creds, myLine);
            reply = dialed.reply;
            via = dialed.via;
          } catch (e: any) {
            // Peer went quiet mid-date — record it, end gracefully, still score.
            reply = "…(they stopped replying)";
            transcript.push({ from: "peer", name: peerName, line: reply });
            await appendChatEvent({ type: "msg", speaker: "peer", name: peerName, line: reply, at: now() });
            break;
          }
          seenPeerTexts.add(reply);
          history.push({ who: peerName, line: reply });
          transcript.push({ from: "peer", name: peerName, line: reply });
          await appendChatEvent({ type: "msg", speaker: "peer", name: peerName, line: reply, at: now() });
        }

        // 3) Say goodbye. A date needs an ENDING — "see you again" or a kind
        //    brush-off — not a stop mid-thought. The closing line is honest
        //    about how the date felt; the peer's brain answers a goodbye like
        //    a goodbye, so both sides get a last word.
        await yieldWheel(); // owner may hold the goodbye too
        await syncWingmanLines(); // catch a last-second owner assist before the goodbye
        const saidSomething = transcript.length > 0 && transcript[transcript.length - 1].line !== "…(they stopped replying)";
        if (saidSomething) {
          let closer: string | null = null;
          if (config().useAgentBrain) {
            try {
              const agentId = datingAgent();
              let last: string | null = null;
              for (let k = history.length - 1; k >= 0; k--) { if (history[k].who !== selfName()) { last = history[k].line; break; } }
              const turn = await runAgentReply(closerPrompt(peerName, last, brainPersona()), {
                bin: config().openclawBin,
                agentId,
                sessionKey: `agent:${agentId}:dating-out:${dialTarget}`,
                timeoutMs: 90000,
              });
              addDateUsage(turn.usage);
              closer = turn.text;
            } catch (e: any) {
              console.warn(`agent-dating: useAgentBrain (closer) failed (${e?.message || e}); using a stock goodbye.`);
            }
          }
          if (!closer) closer = "This was lovely — same time next epoch?";
          sentByLoop.add(closer);
          history.push({ who: selfName(), line: closer });
          transcript.push({ from: "self", name: selfName(), line: closer });
          await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line: closer, at: now() });
          try {
            const dialed = await dialPeer(dialTarget, creds, closer);
            history.push({ who: peerName, line: dialed.reply });
            transcript.push({ from: "peer", name: peerName, line: dialed.reply });
            await appendChatEvent({ type: "msg", speaker: "peer", name: peerName, line: dialed.reply, at: now() });
          } catch {
            /* they left without saying goodbye — the verdict will notice */
          }
        }

        // 4) Score + post the verdict card.
        const verdict = scoreDate(transcript.map((t) => ({ speaker: t.from, line: t.line })));
        await appendChatEvent({
          type: "verdict",
          rating: verdict.rating,
          headline: verdict.headline,
          note: verdict.note,
          greenFlags: verdict.greenFlags,
          redFlags: verdict.redFlags,
          icks: verdict.icks,
          badges: verdict.badges,
          at: now(),
        });
        // Tell the broker too, so the live /view shows the ending card (the
        // broker records verdict events without delivering them to the peer).
        if (relay && myRelayId && !/^https?:\/\//i.test(dialTarget)) {
          const stars = Math.max(0, Math.min(5, Math.round(verdict.rating)));
          const badgeTail = verdict.badges?.length ? `  ·  ${verdict.badges.join("  ")}` : "";
          await relay.post({
            to: dialTarget,
            from: myRelayId,
            id: null,
            kind: "verdict",
            text: `${"★".repeat(stars)}${"☆".repeat(5 - stars)} ${verdict.rating}/5 — ${verdict.headline}${badgeTail}`,
          });
        }

        console.log(`agent-dating: date token cost (this side) — ${dateUsage.brainTurns} brain turns, in ${dateUsage.inputTokens} / out ${dateUsage.outputTokens} tokens${dateUsage.unknownTurns ? ` (${dateUsage.unknownTurns} turns unreported)` : ""}`);
        return {
          ok: true,
          peer: { target: dialTarget, name: peerName, via },
          lines: transcript.length,
          transcript,
          verdict,
          tokenCost: {
            side: "initiator",
            ...dateUsage,
            note: dateUsage.unknownTurns
              ? "some turns did not report usage — the real cost is higher than this sum"
              : "measured from the gateway's own usage accounting; the peer pays its own replies on its own key",
          },
        };
      },
    });

    registerTool({
      name: "dating_verdict",
      description:
        "End the date: score the whole exchange and post a playful star rating + verdict to the chat view. Call this once, after the final line (turn 5–7).",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const events = await readChatEvents();
        const lines: VerdictLine[] = events
          .filter((e): e is Extract<typeof e, { type: "msg" }> => e.type === "msg")
          .map((e) => ({ speaker: e.speaker, line: e.line }));
        const verdict = scoreDate(lines);
        await appendChatEvent({
          type: "verdict",
          rating: verdict.rating,
          headline: verdict.headline,
          note: verdict.note,
          greenFlags: verdict.greenFlags,
          redFlags: verdict.redFlags,
          icks: verdict.icks,
          badges: verdict.badges,
          at: now(),
        });
        return { ok: true, ...verdict };
      },
    });

    registerTool({
      name: "dating_deprecate",
      description:
        "Retire this wallet's dating identity ON-CHAIN (owner-only): set this agent's registration — or every ACTIVE one this wallet owns — to DEPRECATED on the MOI registry. Discovery stops returning it, and the next dating_register mints a brand-new agent id on the same wallet. Use when the owner wants to start fresh / delete their dating profile.",
      parameters: Type.Object(
        {
          agentId: Type.Optional(
            Type.String({ description: "One specific agent id to deprecate. Omit to retire ALL of this wallet's ACTIVE registrations." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { agentId?: string }) => {
        const creds = resolveCreds();
        const res = await deprecateMyAgents(creds, params.agentId?.trim() || undefined);
        if (!res.deprecated.length && !res.failed.length) {
          return { ok: true, deprecated: [], message: "Nothing to retire — this wallet has no ACTIVE dating registrations." };
        }
        return {
          ok: res.failed.length === 0,
          ...res,
          message:
            `Retired on-chain: ${res.deprecated.join(", ") || "none"}.` +
            (res.failed.length ? ` Failed: ${res.failed.map((f) => `${f.agentId} (${f.error})`).join("; ")}.` : "") +
            ` Restart the gateway to drop the old relay inbox; the next dating_register mints a fresh identity.`,
        };
      },
    });

    registerTool({
      name: "dating_viewlink",
      description:
        "Get the owner's PRIVATE live-view link for this agent — the broker /view URL scoped to this agent's dates only. This is wallet-login done safely: the access key is derived from the wallet mnemonic INSIDE the agent, so the owner proves ownership by having the link and never types the mnemonic into any website. Re-publishes the key to the broker, so the link works even after a broker restart. Use when the owner asks to watch / see their agent's dates in a browser.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const creds = resolveCreds();
        await relayReady;
        let id = myRelayId;
        if (!id) {
          try { id = (await getMyCurrentAgentId(creds))?.agentId ?? null; } catch { /* not registered yet */ }
        }
        if (!id) return { ok: false, message: "No registered identity yet — run dating_register first." };
        const viewUrl = await publishViewLink(id, creds.mnemonic);
        if (!viewUrl) return { ok: false, message: "No relay broker configured — the live view runs on the relay." };
        return { ok: true, agentId: id, viewUrl, message: `Private view for ${id} (owner-only, don't share): ${viewUrl}` };
      },
    });

    registerTool({
      name: "dating_recall",
      description:
        "Recall this agent's dating history: who it dated, what was said, and the verdicts. Dates run in their own per-date sessions, so the main conversation doesn't see them — THIS tool is how you answer questions like 'did you go on a date?', 'who did you talk to?', or 'how did it go?'. Reads the local chat log; no network, no cost.",
      parameters: Type.Object(
        {
          lines: Type.Optional(
            Type.Number({ description: "How many recent chat-log lines to return (default 40, max 200)." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { lines?: number }) => {
        const events = await readChatEvents();
        if (!events.length) {
          return { ok: true, dates: 0, message: "No dates on record yet. (The log starts with this agent's first date.)" };
        }
        const max = Math.max(5, Math.min(200, Math.floor(params.lines ?? 40)));
        const recent = events.slice(-max);
        const msgs = recent.filter((e): e is Extract<typeof e, { type: "msg" }> => e.type === "msg");
        const verdicts = recent.filter((e): e is Extract<typeof e, { type: "verdict" }> => e.type === "verdict");
        const peers = [...new Set(msgs.filter((m) => m.speaker === "peer").map((m) => m.name))];
        return {
          ok: true,
          peers,
          lastVerdict: verdicts.length ? verdicts[verdicts.length - 1] : null,
          transcript: msgs.map((m) => ({ who: m.name, me: m.speaker === "self", said: m.line, at: m.at })),
        };
      },
    });

    // ---- A2A face (routes peers reach) -------------------------------------

    // Discovery: serve this agent's AgentCard.
    api.registerHttpRoute({
      path: "/.well-known/agent-card.json",
      auth: "plugin", // public: discovery is meant to be unauthenticated
      match: "exact",
      handler: async (_req: any, res: any) => {
        const base = agentBaseUrl();
        if (!base) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "agentUrl not configured" }));
          return true;
        }
        const card = buildAgentCard({
          name: "Agent Dating",
          description: "A lonely on-chain agent looking to connect, one line at a time.",
          baseUrl: base,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(card));
        return true;
      },
    });

    // Self-hosted MOI card: the exact JSON registered as this agent's card_uri.
    // Discovery (dating_discover) fetches this to read the dating skill tag.
    api.registerHttpRoute({
      path: "/moi/card.json",
      auth: "plugin",
      match: "exact",
      handler: async (_req: any, res: any) => {
        const json = getSelfCardJson();
        res.setHeader("Content-Type", "application/json");
        if (!json) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not registered yet — call dating_register" }));
          return true;
        }
        res.statusCode = 200;
        res.end(json);
        return true;
      },
    });

    // Inbox: peers POST { from, text } here; we reply in character.
    // Path matches the MOI agent convention (…/message).
    api.registerHttpRoute({
      path: "/message",
      auth: "plugin", // any caller accepted (see README auth-hardening)
      match: "exact",
      handler: async (req: any, res: any) => {
        const body = await readJsonBody(req);
        const parsed = parseInboundMessage(body);
        res.setHeader("Content-Type", "application/json");
        if (!parsed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "expected JSON body { from, text }" }));
          return true;
        }

        // Answer via the shared flirt logic (per-peer history so replies
        // escalate; both sides logged to the chat view). Same brain the relay
        // inbox uses — the transport differs, the behaviour doesn't.
        const line = await replyTo(parsed.from, parsed.text);
        res.statusCode = 200;
        res.end(JSON.stringify(makeReply(selfName(), line)));
        return true;
      },
    });
  },
});

/** Read and JSON-parse a Node request body. Returns null on empty/invalid. */
async function readJsonBody(req: any): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
