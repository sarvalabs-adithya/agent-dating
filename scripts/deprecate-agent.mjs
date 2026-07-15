#!/usr/bin/env node
/**
 * deprecate-agent.mjs — retire a dating agent ON-CHAIN, standalone.
 *
 * A tiny ops tool that does the same thing as the plugin's dating_deprecate
 * tool (registry.setAgentStatus(id, DEPRECATED)) but WITHOUT OpenClaw — just
 * the MOI SDK. Use it to clean up a stale registration whose gateway you can't
 * easily bring online. Discovery (ours + anyone else's that honours status)
 * stops returning the id once it's DEPRECATED.
 *
 * Removing an agent from the web app is a SEPARATE, broker-side action (the
 * app's Retire button / POST /forget); this script only touches the chain.
 *
 * Usage:
 *   MOI_MNEMONIC="word word …" node scripts/deprecate-agent.mjs <agent-id>
 *   MOI_MNEMONIC="word word …" node scripts/deprecate-agent.mjs --all
 *
 *   <agent-id>   retire exactly this id (e.g. agent_42). Safe: other agents
 *                this wallet owns are untouched.
 *   --all        retire EVERY still-ACTIVE id this wallet owns (careful).
 *
 * The mnemonic is read from the MOI_MNEMONIC env var ONLY — never passed on the
 * command line, so it can't leak into shell history or the process list. It
 * must be the wallet that OWNS the agent; the tx signs with it. Devnet keys
 * only. Optional env: MOI_DERIVATION (default m/44'/6174'/7020'/0/0),
 * MOI_NETWORK (default "devnet").
 */
import { Wallet, VoyageProvider } from "js-moi-sdk";
import { AgentRegistry, AgentStatus } from "js-moi-agent-registry";

const DEFAULT_DERIVATION = "m/44'/6174'/7020'/0/0";

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

const arg = (process.argv[2] || "").trim();
if (!arg || arg === "-h" || arg === "--help") {
  console.log(
    "\n  Retire a dating agent on-chain (devnet).\n\n" +
      '  MOI_MNEMONIC="…" node scripts/deprecate-agent.mjs <agent-id>\n' +
      '  MOI_MNEMONIC="…" node scripts/deprecate-agent.mjs --all\n\n' +
      "  The mnemonic comes from the MOI_MNEMONIC env var (never argv).\n" +
      "  It must own the agent. Removing it from the web app is separate\n" +
      "  (the app's Retire button / POST /forget).\n",
  );
  process.exit(arg ? 0 : 1);
}

const mnemonic = (process.env.MOI_MNEMONIC || "").trim();
if (!mnemonic || mnemonic.split(/\s+/).length < 12) {
  die('set MOI_MNEMONIC to the owning wallet\'s 12+ word phrase, e.g.\n    MOI_MNEMONIC="word word …" node scripts/deprecate-agent.mjs agent_42');
}

const all = arg === "--all";
const target = all ? null : arg;

const provider = new VoyageProvider(process.env.MOI_NETWORK || "devnet");
const wallet = await Wallet.fromMnemonic(
  mnemonic,
  process.env.MOI_DERIVATION || DEFAULT_DERIVATION,
);
wallet.connect(provider);

// The registry needs an uploader even though deprecation never uploads a card.
const uploader = async () => "";
const registry = await AgentRegistry.init({ wallet, uploader });

const owner = (await wallet.getIdentifier()).toHex();
console.log(`\n  wallet:  ${owner}`);

// Resolve targets. For --all, only still-ACTIVE ids (skip already-retired).
let targets;
if (target) {
  targets = [target];
} else {
  const ids = (await registry.getMyAgents()) || [];
  targets = [];
  for (const id of ids) {
    try {
      const { found, profile } = await registry.getAgentProfile(id);
      if (found && profile?.status === AgentStatus.ACTIVE) targets.push(id);
    } catch {
      /* unreadable profile — leave it be */
    }
  }
  if (!targets.length) {
    console.log("\n  Nothing to retire — this wallet has no ACTIVE registrations.\n");
    process.exit(0);
  }
}

console.log(`  retiring: ${targets.join(", ")}\n`);

const deprecated = [];
const failed = [];
for (const id of targets) {
  try {
    process.stdout.write(`  · ${id} … `);
    await registry.setAgentStatus(id, AgentStatus.DEPRECATED);
    deprecated.push(id);
    console.log("DEPRECATED ✓");
  } catch (e) {
    failed.push({ id, error: e?.message || String(e) });
    console.log(`failed ✗ (${e?.message || e})`);
  }
}

console.log(
  `\n  Done. retired=[${deprecated.join(", ") || "none"}]` +
    (failed.length ? ` failed=[${failed.map((f) => f.id).join(", ")}]` : "") +
    "\n  Discovery stops returning these. (App visibility is separate: use the" +
    "\n  app's Retire button / POST /forget.)\n",
);
process.exit(failed.length ? 2 : 0);
