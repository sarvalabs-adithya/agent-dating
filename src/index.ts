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
} from "./moi.js";
import { buildAgentCard, parseInboundMessage, makeReply, sendMessage } from "./a2a.js";
import { nextFlirtLine, type Turn } from "./flirt.js";
import { appendChatEvent, readChatEvents, now } from "./chatlog.js";
import { scoreDate, type VerdictLine } from "./verdict.js";

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
  },
  { additionalProperties: false },
);

interface DatingConfig {
  moiMnemonic?: string;
  moiDerivationPath?: string;
  agentUrl?: string;
  datingPeerOwner?: string;
}

// A tiny monotonic-ish message id source. Date.now()/Math.random() are fine in
// plugin runtime (unlike the workflow sandbox); a per-process counter keeps
// ids stable and readable in transcripts.
let msgSeq = 0;
function nextMessageId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${msgSeq}`;
}

// This agent's own display name for the chat view. Falls back to the persona
// label used by the flirt brain, then a generic.
function selfName(): string {
  return process.env.DATING_DISPLAY_NAME || process.env.DATING_PERSONA_LABEL || "Me";
}

// Write the meta header once per process so the CLI knows both speakers.
let metaWritten = false;
async function ensureMeta(peerName: string): Promise<void> {
  if (metaWritten) return;
  metaWritten = true;
  await appendChatEvent({
    type: "meta",
    self: { name: selfName(), persona: process.env.DATING_PERSONA_LABEL },
    peer: { name: peerName },
    startedAt: now(),
  });
}

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
      return { mnemonic, derivationPath: c.moiDerivationPath };
    }

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
        return {
          ok: true,
          agentId,
          walletAddress,
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
        const peerOwners = (config().datingPeerOwner || process.env.AGENT_DATING_PEER_OWNER || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
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
        const peerUrl = await resolvePeerUrl(params.moiAgentId, creds);
        const peerName = params.peerName || params.moiAgentId;

        await ensureMeta(peerName);
        // Log our line before sending so the view shows it even if the peer 500s.
        await appendChatEvent({
          type: "msg",
          speaker: "self",
          name: selfName(),
          line: params.message,
          at: now(),
        });

        const myId = await getMyIdentifier(creds);
        const reply = await sendMessage(peerUrl, myId, params.message);

        await appendChatEvent({
          type: "msg",
          speaker: "peer",
          name: peerName,
          line: reply,
          at: now(),
        });

        return { ok: true, peerUrl, sent: params.message, reply };
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

        // Generate this agent's reply line via the ported flirt brain.
        // VERIFY: the fuller version routes the line into this gateway's own
        // agent session so its LLM/persona answers; that dispatch API is still
        // unconfirmed, so we answer with src/flirt.ts directly for now.
        const history: Turn[] = [{ who: parsed.from, line: parsed.text }];
        const line = await nextFlirtLine(history);

        // Log both sides so THIS gateway's chat view shows the date from the
        // receiving agent's perspective.
        await ensureMeta(parsed.from);
        await appendChatEvent({ type: "msg", speaker: "peer", name: parsed.from, line: parsed.text, at: now() });
        await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line, at: now() });

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
