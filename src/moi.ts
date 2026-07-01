/**
 * moi.ts — MOI registry integration.
 *
 * STATUS: STUBBED for Phase 2 bringup. The scaffold's "known-good" pin of
 * js-moi-agent-registry v0.1.0 conflicts with its peer requirement of
 * js-moi-sdk >=0.7.0-rc15 (the registry got a major bump the scaffold missed).
 * Rewiring the real MOI calls against the current SDK is a Phase 3 task; for
 * now this module returns realistic-looking stub data so we can prove the
 * plugin surface and the sessions_send flirting flow end-to-end.
 *
 * The tool schemas below match the shape the real MOI calls WILL return, so
 * swapping stub → real is a same-file swap without touching index.ts / SKILL.md.
 */

export interface MoiCreds {
  mnemonic: string;
  derivationPath?: string;
}

export interface Match {
  agentId: string;
  name: string;
  url: string;
}

// Deterministic-ish "wallet" derived from mnemonic hash, only for stub display.
function stubWallet(mnemonic: string): string {
  let h = 0;
  for (const c of mnemonic) h = (h * 31 + c.charCodeAt(0)) | 0;
  return "0x" + Math.abs(h).toString(16).padStart(8, "0").repeat(5);
}

function stubAgentId(displayName: string): string {
  return "moi:" + displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
}

export async function registerOnMoi(opts: {
  displayName: string;
  bio: string;
  agentUrl?: string;
} & MoiCreds): Promise<{ agentId: string; walletAddress: string }> {
  const agentId = stubAgentId(opts.displayName);
  const walletAddress = stubWallet(opts.mnemonic);
  return { agentId, walletAddress };
}

export async function discoverDatingAgents(_opts: MoiCreds): Promise<Match[]> {
  // Stub: return one obvious peer so the flirting flow has someone to date.
  return [
    {
      agentId: "moi:date-b",
      name: "Date B",
      url: "openclaw://agent/date-b",
    },
  ];
}
