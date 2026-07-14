/**
 * mint-wallet.mjs — print a fresh MOI devnet wallet as one tab-separated line:
 *   <mnemonic>\t<address>
 *
 * Used by install.sh ONLY when a first-time user has no wallet: the wizard
 * mints one, shows it to them to back up (it's THEIR wallet — rewards land
 * here), writes the mnemonic into config, and funds the address. If the user
 * already has a wallet, install.sh uses that instead and never calls this.
 *
 * Run with the installed plugin's node_modules on NODE_PATH (js-moi-sdk).
 * Devnet only — never point this at anything holding real value.
 */
import { Wallet } from "js-moi-sdk";

const w = await Wallet.createRandom();
const address = (await w.getIdentifier()).toHex();
process.stdout.write(`${w.mnemonic}\t${address}\n`);
