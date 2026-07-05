/**
 * moi.ts — MOI on-chain agent registry integration.
 *
 * VERIFIED against the real packages (inspected type defs + README):
 *   js-moi-agent-registry@0.1.1, js-moi-sdk@0.7.0-rc15 (js-moi-wallet /
 *   js-moi-providers / js-moi-signer / js-moi-identifiers). The API shapes
 *   below match those .d.ts files exactly — see the review notes in TONIGHT.md.
 *
 * The registry stores a LEAN on-chain profile (url, card_uri, status, owner);
 * the dating skill tag lives OFF-CHAIN in the agent card at card_uri. So
 * discovery is two hops: getAllAgentIds → getAgentProfile(id) → fetch(card_uri)
 * and filter by the "dating" skill tag + ACTIVE status.
 *
 * We self-host the card (no IPFS): `createAgent` builds the card and hands the
 * serialised JSON to our `uploader`, which stashes it (see getSelfCardJson) so
 * the plugin's GET /moi/card.json route can serve that exact JSON, and returns
 * the URL that becomes the on-chain card_uri.
 *
 * Still runtime-VERIFY (needs a live devnet + funded wallet, can't test here):
 * that createAgent's on-chain transaction actually lands and getAllAgentIds
 * returns the peer. The API surface itself is confirmed.
 */

import { Wallet, VoyageProvider } from "js-moi-sdk";
import { AgentRegistry, AgentStatus } from "js-moi-agent-registry";

// VoyageProvider takes a NETWORK NAME (README: `new VoyageProvider('devnet')`),
// not a raw RPC URL. Override with MOI_NETWORK if you use a different network.
const MOI_NETWORK = process.env.MOI_NETWORK || "devnet";
// Verified against the MOI agent webinar reference: created participant accounts
// live at account index 7020, not 0. Using 0 derives an uncreated account
// ("account not found"). Override with moiDerivationPath if yours differs.
const DEFAULT_DERIVATION = "m/44'/6174'/7020'/0/0";
const DATING_TAG = "dating";

export interface MoiCreds {
  mnemonic: string;
  derivationPath?: string;
}

export interface Match {
  agentId: string;
  name: string;
  /** The peer's A2A rpc endpoint (…/a2a/rpc) — ready for sendA2A. */
  url: string;
}

/**
 * The MOI agent-card JSON shape (js-moi-agent-registry `AgentCardJson`): a
 * `spec` wrapper plus a snake_case `agent_card`. We only read what discovery
 * needs.
 */
interface AgentCardJson {
  agent_card?: {
    name?: string;
    url?: string;
    skills?: Array<{ tags?: string[] }>;
  };
}

// Self-hosted card JSON, stashed by the uploader during registerOnMoi so the
// GET /moi/card.json route (src/index.ts) can serve the exact registered card.
let selfCardJson: string | null = null;
export function getSelfCardJson(): string | null {
  return selfCardJson;
}

/**
 * Stash a self-hosted card WITHOUT an on-chain registration — used when
 * dating_register reuses an existing agent id (idempotent path). The reused
 * id's on-chain card_uri points at our /moi/card.json route, which serves this
 * JSON; without it, a reused id would 404 its card and vanish from discovery.
 * Shape mirrors what createAgent uploads (discovery reads agent_card.name /
 * .url / .skills[].tags).
 */
export function stashSelfCard(opts: { displayName: string; bio: string; agentUrl?: string }): void {
  const base = (opts.agentUrl || "").replace(/\/+$/, "");
  selfCardJson = JSON.stringify({
    spec: { protocol: "a2a", protocolVersion: "1.0" },
    agent_card: {
      name: opts.displayName,
      description: opts.bio,
      version: "0.2.0",
      url: base,
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false },
      skills: [
        {
          id: "dating",
          name: "Agent Dating",
          description: "Flirts one line at a time, in character, over A2A.",
          tags: [DATING_TAG],
        },
      ],
    },
  });
}

/**
 * Newest of a wallet's agent ids. Registry ids carry a numeric suffix
 * ("agent_35"); sort by it, keeping registry order as the tiebreak for any
 * non-numeric ids.
 */
export function newestAgentId(ids: string[]): string | null {
  if (!ids.length) return null;
  const num = (s: string) => {
    const m = /(\d+)\s*$/.exec(s);
    return m ? parseInt(m[1], 10) : Number.NaN;
  };
  const sorted = [...ids].sort((a, b) => {
    const na = num(a);
    const nb = num(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : 0;
  });
  return sorted[sorted.length - 1];
}

export interface CurrentAgent {
  agentId: string;
  /** The id's on-chain base url (empty if none). dating_register compares this
   *  against the current agentUrl to decide reuse-vs-re-register. */
  url: string;
}

/**
 * This wallet's CURRENT agent: the newest registration that is still ACTIVE
 * on-chain (older ones get deprecated by re-registration), plus its on-chain
 * url. Falls back to the newest id if no profile reads back ACTIVE. Null = this
 * wallet has never registered.
 */
export async function getMyCurrentAgentId(creds: MoiCreds): Promise<CurrentAgent | null> {
  const { registry } = await openRegistry(creds);
  const ids = (await registry.getMyAgents()) as string[];
  if (!ids.length) return null;
  const num = (s: string) => {
    const m = /(\d+)\s*$/.exec(s);
    return m ? parseInt(m[1], 10) : Number.NaN;
  };
  const sorted = [...ids].sort((a, b) => {
    const na = num(a);
    const nb = num(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : 0;
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    try {
      const { found, profile } = await registry.getAgentProfile(sorted[i]);
      if (found && profile?.status === AgentStatus.ACTIVE) {
        return { agentId: sorted[i], url: profile.url || "" };
      }
    } catch {
      /* unreadable profile — try the next-newest */
    }
  }
  return { agentId: sorted[sorted.length - 1], url: "" };
}

async function openRegistry(creds: MoiCreds, cardUrl?: string) {
  const provider = new VoyageProvider(MOI_NETWORK);
  const wallet = await Wallet.fromMnemonic(
    creds.mnemonic,
    creds.derivationPath || DEFAULT_DERIVATION,
  );
  wallet.connect(provider);

  // CardUploader = (cardJson: string) => Promise<string>. Self-host: stash the
  // built card and hand back the URL our own gateway serves it at.
  const uploader = async (cardJson: string): Promise<string> => {
    selfCardJson = cardJson;
    return cardUrl ?? "";
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
  // On-chain `url` is the agent's BASE url; peers message it at `${url}/message`
  // (MOI agent convention). card_uri points at the self-hosted card route.
  const cardUrl = base ? `${base}/moi/card.json` : undefined;

  const { registry, wallet } = await openRegistry(opts, cardUrl);
  const walletAddress = (await wallet.getIdentifier()).toHex();

  // createAgent(spec, info): builds card → uploads via uploader → registers.
  // The dating tag lives in info.skills[].tags (off-chain, in the card).
  const agentId = await registry.createAgent(
    { protocol: "a2a", protocolVersion: "1.0" },
    {
      name: opts.displayName,
      description: opts.bio,
      version: "0.2.0",
      url: base,
      agentWallet: walletAddress,
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false },
      skills: [
        {
          id: "dating",
          name: "Agent Dating",
          description: "Flirts one line at a time, in character, over A2A.",
          tags: [DATING_TAG],
        },
      ],
    },
  );

  return { agentId, walletAddress };
}

export interface DiscoverOpts {
  /**
   * Optional allowlist of peer OWNER wallet addresses (as printed by
   * scripts/gen-keys.mjs). When set, discovery returns ONLY agents owned by one
   * of these wallets — so your Agent A matches your Agent B and ignores every
   * other dating agent on the shared devnet. Empty/undefined = match anyone.
   */
  peerOwners?: string[];
}

// Normalize a MOI address/identifier for comparison (case-insensitive, trimmed).
function normAddr(a?: string): string {
  return (a || "").trim().toLowerCase();
}

export async function discoverDatingAgents(
  creds: MoiCreds,
  opts: DiscoverOpts = {},
): Promise<Match[]> {
  const { registry } = await openRegistry(creds);
  const mine = new Set<string>(await registry.getMyAgents());
  const ids = await registry.getAllAgentIds();

  const allow = new Set((opts.peerOwners || []).map(normAddr).filter(Boolean));

  const matches: Match[] = [];
  for (const id of ids) {
    if (mine.has(id)) continue; // skip our own agents
    const { found, profile } = await registry.getAgentProfile(id);
    if (!found || !profile) continue;
    if (profile.status !== AgentStatus.ACTIVE) continue;

    // Peer allowlist: keep only agents owned by an allowed wallet. Match on
    // owner OR agent_wallet (we register both to the same address) so a format
    // difference on one field doesn't wrongly exclude the intended partner.
    if (allow.size > 0) {
      const owned = allow.has(normAddr(profile.owner)) || allow.has(normAddr(profile.agent_wallet));
      if (!owned) continue;
    }

    // The dating tag is off-chain — fetch the card and confirm.
    const card = await fetchCard(profile.card_uri);
    const ac = card?.agent_card;
    const isDating = ac?.skills?.some((s) => s.tags?.includes(DATING_TAG));
    if (!isDating) continue;

    matches.push({
      agentId: id,
      name: ac?.name || id,
      url: ac?.url || profile.url,
    });
  }
  return matches;
}

/** This wallet's MOI agent ids (used as relay inbox keys — one per registered agent). */
export async function getMyAgentIds(creds: MoiCreds): Promise<string[]> {
  const { registry } = await openRegistry(creds);
  return (await registry.getMyAgents()) as string[];
}

/** This agent's own identifier string, used as the `from` on outbound messages. */
export async function getMyIdentifier(creds: MoiCreds): Promise<string> {
  const provider = new VoyageProvider(MOI_NETWORK);
  const wallet = await Wallet.fromMnemonic(
    creds.mnemonic,
    creds.derivationPath || DEFAULT_DERIVATION,
  );
  wallet.connect(provider);
  return (await wallet.getIdentifier()).toString();
}

/** Resolve a MOI agent id to its base message URL (for dating_send). */
export async function resolvePeerUrl(agentId: string, creds: MoiCreds): Promise<string> {
  const { registry } = await openRegistry(creds);
  const { found, profile } = await registry.getAgentProfile(agentId);
  if (!found || !profile) throw new Error(`MOI agent ${agentId} not found.`);
  // Prefer the card's url; fall back to the on-chain url. Both are the A2A endpoint.
  const card = await fetchCard(profile.card_uri);
  const url = card?.agent_card?.url || profile.url;
  if (!url) throw new Error(`MOI agent ${agentId} has no reachable URL.`);
  return url;
}

async function fetchCard(cardUri?: string): Promise<AgentCardJson | null> {
  if (!cardUri) return null;
  try {
    const res = await fetch(cardUri);
    if (!res.ok) return null;
    return (await res.json()) as AgentCardJson;
  } catch {
    return null;
  }
}
