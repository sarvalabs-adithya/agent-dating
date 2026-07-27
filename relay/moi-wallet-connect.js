/**
 * moi-wallet-connect.js — client-side MOI wallet sign-in for /app.
 *
 * Implements the connect + ownership-challenge flow from
 * docs.wallet.moi.technology using the injected `window.moi` provider. Kept as a
 * standalone module (not inlined in broker.mjs's HTML template literals, which
 * forbid backticks/${}) so it can be reviewed and unit-reasoned on its own, then
 * served/inlined once the broker `/app/wallet-login` route (see MOI-WALLET-PLAN.md)
 * is ready.
 *
 * Exposes window.moiWallet = { available, connect, onAccountChange }.
 */
(function () {
  "use strict";

  // The extension injects a read-only window.moi with __isMOIWallet === true.
  function available() {
    return !!(globalThis && globalThis.moi && globalThis.moi.__isMOIWallet === true);
  }

  function unwrap(resp) {
    // window.moi.request resolves a JSON-RPC envelope; tolerate both shapes.
    if (resp && typeof resp === "object" && "result" in resp) {
      if (resp.error) throw new Error(resp.error.message || "wallet error");
      return resp.result;
    }
    return resp;
  }

  async function rpc(method, params) {
    if (!available()) throw new Error("MOI wallet not detected");
    return unwrap(await globalThis.moi.request(method, params || []));
  }

  // A signed challenge that proves the connected address controls the wallet.
  // Includes a timestamp + nonce so the broker can reject stale/replayed logins.
  function buildChallenge(address) {
    var nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    var iso = new Date().toISOString();
    return "agent-dating sign-in\naddress: " + address + "\ntime: " + iso + "\nnonce: " + nonce;
  }

  /**
   * Full connect flow: request permission, read the account, sign the challenge.
   * Returns { address, challenge, signature } — POST this to /app/wallet-login,
   * which verifies the signature and returns the owner's agents' view keys.
   */
  async function connect() {
    if (!available()) {
      throw new Error("MOI wallet extension not found. Install it, or use the mnemonic login.");
    }
    await rpc("wallet.RequestPermissions", []);
    var accounts = await rpc("wallet.Accounts", []);
    var address = Array.isArray(accounts) ? accounts[0] : accounts;
    if (!address) throw new Error("No account returned by the wallet.");

    var challenge = buildChallenge(address);
    var signature = await rpc("wallet.SignMessage", [address, challenge]);
    return { address: address, challenge: challenge, signature: signature };
  }

  function onAccountChange(cb) {
    if (available() && typeof globalThis.moi.addListener === "function") {
      globalThis.moi.addListener("accountChange", cb);
    }
  }

  globalThis.moiWallet = { available: available, connect: connect, onAccountChange: onAccountChange, rpc: rpc };
})();
