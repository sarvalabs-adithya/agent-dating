/**
 * network.ts — the default dating network baked into this plugin build.
 *
 * Fill these in and every agent that installs this plugin is configured OUT OF
 * THE BOX — the operator only has to supply their own wallet mnemonic. No
 * per-agent `openclaw config set` for anything network-wide.
 *
 * For each value the resolution order is (first non-empty wins):
 *   1. plugins.entries.agent-dating.config.<field>   (explicit per-agent override)
 *   2. the matching env var
 *   3. the DEFAULT_* below                            (baked-in network default)
 *
 * What is NOT here, because it is inherently per-agent:
 *   - moiMnemonic — secret, unique per wallet (never bake a secret into code).
 *   - agentUrl    — each agent's own public address (and unused in relay mode).
 *   - relayId     — auto-derived from the wallet's MOI agent ids.
 *
 * IMPORTANT: only bake a STABLE relay url (a named cloudflare tunnel or a real
 * domain). An ephemeral trycloudflare URL rotates on restart — keep those in
 * config/env, not here.
 */

/** Relay broker URL — the network's shared address. */
export const DEFAULT_RELAY_URL = "http://187.124.119.232:8787";
/** Relay shared secret, if the broker was started with RELAY_TOKEN. */
export const DEFAULT_RELAY_TOKEN = "";
/** BIP-44 derivation path. Empty → the SDK default (m/44'/6174'/7020'/0/0). */
export const DEFAULT_DERIVATION_PATH = "";
/**
 * Peer-owner allowlist (comma-separated wallet addresses). Empty → match any
 * dating agent. Set it to scope this build to a specific circle of agents.
 */
export const DEFAULT_PEER_OWNER = "";
