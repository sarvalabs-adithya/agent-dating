/**
 * agent-dating — OpenClaw plugin entry (Phase 3 — cross-machine A2A).
 *
 * Registers three tools + two public HTTP routes:
 *   tools:
 *     dating_register   — put this agent on MOI with a "dating" tag
 *     dating_discover   — list other dating-tagged agents on MOI
 *     dating_send       — send one flirt line to a peer over A2A, get its reply
 *   routes (this agent's A2A face, reachable by peers):
 *     GET  /.well-known/agent-card.json  — A2A discovery document
 *     POST /a2a/rpc                       — JSON-RPC "SendMessage" inbox
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

// VERIFY: definePluginEntry export path + register(api) surface vs live SDK.
import { definePluginEntry } from "openclaw/plugin-sdk";
import { Type } from "typebox";
import { registerOnMoi, discoverDatingAgents, resolvePeerUrl } from "./moi.js";
import {
  buildAgentCard,
  parseSendMessageText,
  makeReply,
  makeError,
  sendA2A,
} from "./a2a.js";
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
  },
  { additionalProperties: false },
);

interface DatingConfig {
  moiMnemonic?: string;
  moiDerivationPath?: string;
  agentUrl?: string;
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
  configSchema: DatingConfigSchema,
  register(api: any) {
    // VERIFY: how the plugin reads its resolved config. Using api.config with
    // an env fallback; confirm against the live plugin api.
    const config = (): DatingConfig => (api.config ?? {}) as DatingConfig;

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

    api.registerTool({
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

    api.registerTool({
      name: "dating_discover",
      description:
        "List other agents registered on the MOI registry that carry the 'dating' tag. Returns their MOI ids, display names, and A2A URLs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const creds = resolveCreds();
        const matches = await discoverDatingAgents(creds);
        return { ok: true, count: matches.length, matches };
      },
    });

    api.registerTool({
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

        const reply = await sendA2A(peerUrl, params.message, nextMessageId("out"));

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

    api.registerTool({
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

    // Inbox: receive a peer's line, reply in character.
    api.registerHttpRoute({
      path: "/a2a/rpc",
      auth: "plugin", // MVP: any A2A caller accepted (see README auth-hardening)
      match: "exact",
      handler: async (req: any, res: any) => {
        const body = await readJsonBody(req);
        const parsed = parseSendMessageText(body);
        res.setHeader("Content-Type", "application/json");
        if (!parsed) {
          res.statusCode = 400;
          res.end(JSON.stringify(makeError(null, -32600, "Invalid Request: expected SendMessage")));
          return true;
        }

        // Generate this agent's reply line.
        //
        // VERIFY: the "right" implementation routes `parsed.text` into this
        // gateway's local agent session so the agent's own LLM loop (with its
        // SOUL/persona) answers. That dispatch API is unconfirmed against the
        // live gateway. Until confirmed we answer with the ported flirt brain
        // (src/flirt.ts) directly — same persona rules, and it makes the A2A
        // wire genuinely functional end-to-end for the two-gateway smoke test.
        const history: Turn[] = [{ who: "them", line: parsed.text }];
        const line = await nextFlirtLine(history);

        // Log both sides so THIS gateway's chat view shows the date from the
        // receiving agent's perspective (peer's line in, our line out).
        await ensureMeta("Date");
        await appendChatEvent({ type: "msg", speaker: "peer", name: "Date", line: parsed.text, at: now() });
        await appendChatEvent({ type: "msg", speaker: "self", name: selfName(), line, at: now() });

        res.statusCode = 200;
        res.end(JSON.stringify(makeReply(parsed.id, line, nextMessageId("in"))));
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
