#!/usr/bin/env node
/**
 * gen-keys.mjs — generate the two DEVNET wallets the demo needs.
 *
 *   node scripts/gen-keys.mjs
 *
 * Generates a fresh BIP-39 mnemonic for Agent A and Agent B, writes them into
 * .env (only into EMPTY AGENT_*_MOI_MNEMONIC slots — never overwrites a key you
 * already set), and prints each derived wallet ADDRESS so you know what to fund
 * at the devnet faucet. The mnemonics themselves are written to .env and NOT
 * printed, so they don't leak into your scrollback.
 *
 * DEVNET ONLY. Do not reuse these on any network with real value.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { generateMnemonic, validateMnemonic, Wallet } from "js-moi-sdk";

const ENV = ".env";
const DERIVATION = process.env.MOI_DERIVATION_PATH || "m/44'/6174'/0'/0/0";

if (!existsSync(ENV)) {
  if (existsSync(".env.example")) {
    copyFileSync(".env.example", ENV);
    console.log("• created .env from .env.example");
  } else {
    console.error("No .env or .env.example found — run from the repo root.");
    process.exit(1);
  }
}

let env = readFileSync(ENV, "utf8");

function currentValue(key) {
  const m = env.match(new RegExp(`^${key}=(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\n]*))$`, "m"));
  return (m && (m[1] ?? m[2] ?? m[3]) || "").trim();
}

function setValue(key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  env = re.test(env) ? env.replace(re, line) : env + `\n${line}\n`;
}

async function ensureAgent(key, label) {
  const existing = currentValue(key);
  // Keep ONLY if it's already a real BIP-39 mnemonic. Empty, the .env.example
  // placeholder, or anything invalid → generate a fresh one.
  let mnemonic;
  if (existing && validateMnemonic(existing)) {
    mnemonic = existing;
    console.log(`• ${label}: keeping existing valid mnemonic in ${key}`);
  } else {
    mnemonic = generateMnemonic();
    setValue(key, mnemonic);
    console.log(`• ${label}: generated a new devnet mnemonic → ${key}`);
  }

  const wallet = await Wallet.fromMnemonic(mnemonic, DERIVATION);
  const address = (await wallet.getIdentifier()).toHex();
  return { label, address };
}

const a = await ensureAgent("AGENT_A_MOI_MNEMONIC", "Agent A");
const b = await ensureAgent("AGENT_B_MOI_MNEMONIC", "Agent B");

writeFileSync(ENV, env);

console.log("\nWrote mnemonics to .env (gitignored; phrases not printed).");
console.log("\nFund these two DEVNET addresses at the MOI faucet before dating_register:");
console.log(`  ${a.label}: ${a.address}`);
console.log(`  ${b.label}: ${b.address}`);
console.log("\n(Faucet: MOI Voyage explorer / devnet faucet channel.)");
