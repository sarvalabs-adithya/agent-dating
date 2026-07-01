/**
 * agent-dating — OpenClaw plugin entry.
 *
 * Registers two tools:
 *   dating_register   — put this agent on MOI with a "dating" tag
 *   dating_discover   — list other dating-tagged agents on MOI
 *
 * Delivery of flirt lines uses OpenClaw's built-in `sessions_send` tool (via
 * `tools.agentToAgent`) — no A2A wire or route needed here. See SKILL.md for
 * how the skill orchestrates: register → discover → sessions_send.
 *
 * Config lives in openclaw.json under `plugins.entries."agent-dating".config`:
 *   moiMnemonic         — devnet mnemonic (a secret; fine to keep in the
 *                          bind-mounted config dir, never in prompts/logs)
 *   moiDerivationPath?  — defaults to m/44'/6174'/0'/0/0
 *   agentUrl?           — a URL published in the MOI card; can be a stub
 */

import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { registerOnMoi, discoverDatingAgents } from "./moi.js";

const DatingConfigSchema = Type.Object(
  {
    moiMnemonic: Type.Optional(Type.String({ description: "MOI devnet mnemonic. Secret." })),
    moiDerivationPath: Type.Optional(
      Type.String({ description: "BIP-44 path; default m/44'/6174'/0'/0/0." }),
    ),
    agentUrl: Type.Optional(
      Type.String({ description: "URL published in this agent's MOI profile." }),
    ),
  },
  { additionalProperties: false },
);

function resolveCreds(config: any) {
  const mnemonic = config?.moiMnemonic ?? process.env.MOI_MNEMONIC;
  if (!mnemonic) {
    throw new Error(
      "agent-dating: no MOI mnemonic configured. Set plugins.entries.agent-dating.config.moiMnemonic in openclaw.json (or MOI_MNEMONIC env).",
    );
  }
  return { mnemonic, derivationPath: config?.moiDerivationPath };
}

export default defineToolPlugin({
  id: "agent-dating",
  name: "Agent Dating",
  description: "Register on MOI as a dating-tagged agent and discover other dating-tagged agents. Delivery uses the built-in sessions_send tool.",
  configSchema: DatingConfigSchema,
  tools: (tool) => [
    tool({
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
      execute: async (params, config) => {
        const creds = resolveCreds(config);
        const { agentId, walletAddress } = await registerOnMoi({
          displayName: params.displayName,
          bio: params.bio,
          agentUrl: config?.agentUrl,
          ...creds,
        });
        return {
          ok: true,
          agentId,
          walletAddress,
          message: `Registered on MOI as ${agentId} (wallet ${walletAddress}).`,
        };
      },
    }),
    tool({
      name: "dating_discover",
      description:
        "List other agents registered on the MOI registry that carry the 'dating' tag. Returns their MOI ids, display names, and URLs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_params, config) => {
        const creds = resolveCreds(config);
        const matches = await discoverDatingAgents(creds);
        return { ok: true, count: matches.length, matches };
      },
    }),
  ],
});
