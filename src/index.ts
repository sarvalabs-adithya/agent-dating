/**
 * agent-dating — OpenClaw plugin entry (Phase 3 — cross-machine A2A).
 *
 * Registers three tools + two public HTTP routes:
 *   tools:
 *     dating_register   — put this agent on MOI with a "dating" tag
 *     dating_discover   — list other dating-tagged agents on MOI
 *     dating_send       — POST a flirt line to a peer's /message, get its reply
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
import { Type } from "typebox";
import {
  registerOnMoi,
  discoverDatingAgents,
  resolvePeerUrl,
  getSelfCardJson,
  getMyIdentifier,
  getMyAgentIds,
} from "./moi.js";
import { buildAgentCard, parseInboundMessage, makeReply, sendMessage, probePeer } from "./a2a.js";
import { nextFlirtLine, type Turn, type Persona } from "./flirt.js";
import { appendChatEvent, readChatEvents, now } from "./chatlog.js";
import { scoreDate, type VerdictLine } from "./verdict.js";
import { RelayClient } from "./relay.js";
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
  displayName?: string;
  personaDrive?: string;
  personaFlaw?: string;
  personaLines?: string;
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
    const relayTokenCfg = (): string | undefined =>
      config().relayToken || process.env.DATING_RELAY_TOKEN || DEFAULT_RELAY_TOKEN || undefined;

    // Shared "answer an incoming flirt" logic, used by BOTH the inbound HTTP
    // /message route and the relay inbox. Keeps per-peer history so replies
    // escalate, and logs both sides to the chat view.
    async function replyTo(fromId: string, text: string, peerName?: string): Promise<string> {
      const name = peerName || fromId;
      const history = conversationWith(fromId);
      history.push({ who: name, line: text });
      const line = await nextFlirtLine(history, myPersona());
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
        const reply = await relay.request(target, myRelayId, text);
        return { reply, via: "relay" as const, target };
      };

      // Honor a cached decision from an earlier turn with this peer.
      const cached = peerTransport.get(target);
      if (cached === "http") return viaHttp();
      if (cached === "relay") return viaRelay();

      // Undecided: try DIRECT first, fall back to the relay if it's blocked.
      try {
        const r = await viaHttp();
        peerTransport.set(target, "http");
        return r;
      } catch (httpErr) {
        if (relay && myRelayId && !isUrl) {
          try {
            const r = await viaRelay();
            peerTransport.set(target, "relay");
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
    const listenedIds = new Set<string>();
    // Start listening on the relay for one of THIS agent's ids. Idempotent, and
    // callable AFTER startup — so a freshly-registered agent becomes reachable
    // over the relay immediately, without waiting for a gateway restart.
    const attachInbox = (id: string): void => {
      if (!relay || !id || listenedIds.has(id)) return;
      listenedIds.add(id);
      if (!myRelayId) myRelayId = id;
      relay.listen(id, (m) => {
        void (async () => {
          const line = await replyTo(m.from, m.text);
          await relay!.post({ to: m.from, from: m.to, id: m.id, kind: "reply", text: line });
        })();
      });
    };

    const relayReady = (async () => {
      const url = relayUrlCfg();
      if (!url) return;
      try {
        // Create the client up front so registration can attach ids later even
        // if this wallet has none yet.
        relay = new RelayClient(url, relayTokenCfg(), (s) => console.warn(`agent-dating relay: ${s}`));
        const explicit = (config().relayId || process.env.DATING_RELAY_ID || "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        let ids: string[] = explicit;
        if (!ids.length) {
          let creds;
          try { creds = resolveCreds(); } catch { return; } // no mnemonic yet → attach on register
          ids = await getMyAgentIds(creds);
        }
        for (const id of ids) attachInbox(id);
        console.log(`agent-dating: relay connected at ${url} for ${listenedIds.size} id(s); primary ${myRelayId ?? "(none yet)"}`);
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
        "Register this agent on the MOI on-chain agent registry with a 'dating' skill tag so other agents can discover it.",
      parameters: Type.Object(
        {
          displayName: Type.String({ description: "The dating display name for this agent." }),
          bio: Type.String({ description: "A short dating bio / vibe (one or two sentences)." }),
        },
        { additionalProperties: false },
      ),
      execute: async (params: { displayName: string; bio: string }) => {
        const creds = resolveCreds();
        const { agentId, walletAddress } = await registerOnMoi({
          displayName: params.displayName,
          bio: params.bio,
          agentUrl: agentBaseUrl(),
          ...creds,
        });
        // Become reachable on the relay under the NEW id right away (no restart).
        await relayReady;
        attachInbox(agentId);
        return {
          ok: true,
          agentId,
          walletAddress,
          reachableVia: relay ? "relay + direct" : "direct",
          message: `Registered on MOI as ${agentId} (wallet ${walletAddress}).`,
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
        const matches = await discoverDatingAgents(creds, { peerOwners });
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
          const matches = await discoverDatingAgents(creds, { peerOwners });
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
          const matches = await discoverDatingAgents(creds, { peerOwners });
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

        // 2) Run the whole date. OUR lines come from the ported flirt brain
        //    (free/canned unless OPENAI_API_KEY is set); THEIR lines come from
        //    the peer over the chosen transport. No per-line agent-loop cost.
        const history: Turn[] = [];
        const transcript: Array<{ from: "self" | "peer"; name: string; line: string }> = [];
        let via: "relay" | "http" = "http";
        for (let i = 0; i < turns; i++) {
          const myLine = await nextFlirtLine(history, myPersona());
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
          history.push({ who: peerName, line: reply });
          transcript.push({ from: "peer", name: peerName, line: reply });
          await appendChatEvent({ type: "msg", speaker: "peer", name: peerName, line: reply, at: now() });
        }

        // 3) Score + post the verdict card.
        const verdict = scoreDate(transcript.map((t) => ({ speaker: t.from, line: t.line })));
        await appendChatEvent({
          type: "verdict",
          rating: verdict.rating,
          headline: verdict.headline,
          note: verdict.note,
          at: now(),
        });

        return {
          ok: true,
          peer: { target: dialTarget, name: peerName, via },
          lines: transcript.length,
          transcript,
          verdict,
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
          at: now(),
        });
        return { ok: true, ...verdict };
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
