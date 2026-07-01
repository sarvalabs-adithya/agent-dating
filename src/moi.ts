/**
 * moi.ts — MOI on-chain agent registry integration (Phase 3.2 — unstubbed).
 *
 * Real wiring against js-moi-agent-registry 0.1.1 + js-moi-sdk 0.7.0-rc15.
 * The registry stores a LEAN on-chain profile (url, card_uri, status); the
 * dating skill tags live off-chain in the AgentCard at card_uri. So discovery
 * is two hops: getAllAgentIds → getAgentProfile(id) → fetch(card_uri) and
 * filter by the "dating" tag + ACTIVE status.
 *
 * We self-host each agent's AgentCard on its own gateway (no IPFS): the
 * uploader is a no-op that simply returns the already-public card URL. See
 * src/a2a.ts buildAgentCard + the GET /.well-known/agent-card.json route.
 *
 * VERIFY markers flag SDK surface not yet confirmed against a live install
 * (docs.openclaw.ai / the MOI SDK source). Confirm import + method names
 * before trusting in production.
 */

// VERIFY: exact export names of js-moi-sdk 0.7.0-rc15.
import { Wallet, JsonRpcProvider } from "js-moi-sdk";
// VERIFY: AgentRegistry entry point + method surface of js-moi-agent-registry 0.1.1.
import { AgentRegistry } from "js-moi-agent-registry";

/** MOI devnet JSON-RPC endpoint. VERIFY: current devnet URL. */
const MOI_DEVNET_RPC = process.env.MOI_RPC_URL || "https://voyage-rpc.moi.technology/babylon/";
const DEFAULT_DERIVATION = "m/44'/6174'/0'/0/0";
const DATING_TAG = "dating";

export interface MoiCreds {
  mnemonic: string;
  derivationPath?: string;
}

export interface Match {
  agentId: string;
  name: string;
  url: string;
}

/** Off-chain AgentCard shape we care about (subset). */
interface CardDoc {
  name?: string;
  url?: string;
  skills?: Array<{ tags?: string[] }>;
}

/**
 * Build a wallet + registry handle from creds.
 *
 * The uploader self-hosts: instead of pinning the card to IPFS, `upload`
 * returns the card URL already served by this agent's own gateway, which the
 * caller passes in. That URL becomes the on-chain `card_uri`.
 */
async function openRegistry(creds: MoiCreds, cardUrl?: string) {
  const provider = new JsonRpcProvider(MOI_DEVNET_RPC);
  // VERIFY: Wallet.fromMnemonic(mnemonic, path?, { provider }) signature.
  const wallet = await Wallet.fromMnemonic(
    creds.mnemonic,
    creds.derivationPath || DEFAULT_DERIVATION,
  );
  wallet.connect(provider);

  const uploader = {
    // Self-hosted: the card already lives at cardUrl on our gateway.
    upload: async (_data: unknown): Promise<string> => cardUrl ?? "",
  };

  const registry = await AgentRegistry.init({ wallet, uploader });
  return { registry, wallet };
}

export async function registerOnMoi(opts: {
  displayName: string;
  bio: string;
  /** Public gateway base URL; the A2A endpoint + card are served here. */
  agentUrl?: string;
} & MoiCreds): Promise<{ agentId: string; walletAddress: string }> {
  const base = (opts.agentUrl || "").replace(/\/+$/, "");
  const cardUrl = base ? `${base}/.well-known/agent-card.json` : undefined;

  const { registry, wallet } = await openRegistry(opts, cardUrl);

  // walletAddress via getIdentifier().toHex() — NOT getAddress().
  const walletAddress = (await wallet.getIdentifier()).toHex();

  // The on-chain spec is lean; the dating tag lives in the off-chain card the
  // uploader points at. VERIFY: createAgent(spec, info) arg shape.
  const agentId = await registry.createAgent(
    {
      name: opts.displayName,
      description: opts.bio,
      url: base,
      card_uri: cardUrl,
      status: "ACTIVE",
    },
    { tags: [DATING_TAG] },
  );

  return { agentId: String(agentId), walletAddress };
}

export async function discoverDatingAgents(creds: MoiCreds): Promise<Match[]> {
  const { registry, wallet } = await openRegistry(creds);
  const myAddress = (await wallet.getIdentifier()).toHex();

  // VERIFY: getAllAgentIds() pagination — may return a cursor for large sets.
  const ids: string[] = await registry.getAllAgentIds();

  const matches: Match[] = [];
  for (const id of ids) {
    // getAgentProfile(id) → { profile, found }; profile has url/card_uri/status.
    const res = await registry.getAgentProfile(id);
    if (!res?.found) continue;
    const profile = (res as any).profile ?? res;
    if (profile.status && profile.status !== "ACTIVE") continue;
    if (profile.owner && profile.owner === myAddress) continue; // skip self

    // The dating tag is off-chain — fetch the card to confirm.
    const card = await fetchCard(profile.card_uri);
    const isDating = card?.skills?.some((s) => s.tags?.includes(DATING_TAG));
    if (!isDating) continue;

    matches.push({
      agentId: String(id),
      name: card?.name || profile.name || String(id),
      url: card?.url || profile.url || "",
    });
  }
  return matches;
}

/** Resolve a MOI agent id to its live A2A endpoint URL (for dating_send). */
export async function resolvePeerUrl(agentId: string, creds: MoiCreds): Promise<string> {
  const { registry } = await openRegistry(creds);
  const res = await registry.getAgentProfile(agentId);
  if (!res?.found) throw new Error(`MOI agent ${agentId} not found.`);
  const profile = (res as any).profile ?? res;
  const card = await fetchCard(profile.card_uri);
  const url = card?.url || profile.url;
  if (!url) throw new Error(`MOI agent ${agentId} has no reachable URL.`);
  return url;
}

async function fetchCard(cardUri?: string): Promise<CardDoc | null> {
  if (!cardUri) return null;
  try {
    const res = await fetch(cardUri);
    if (!res.ok) return null;
    return (await res.json()) as CardDoc;
  } catch {
    return null;
  }
}
