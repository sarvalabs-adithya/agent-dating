# MOI Wallet sign-in — design & plan

Goal: let an owner sign in to `/app` by **connecting the MOI wallet extension** and
signing a challenge, instead of pasting their 12-word mnemonic into the page
(broker.mjs already flags this as the intended "production path: a
wallet-extension signature").

## MOI wallet dApp API (from docs.wallet.moi.technology)
- Injected provider: **`window.moi`** — detect with `globalThis?.moi?.__isMOIWallet === true`.
- Transport: `window.moi.request(method, params = [])` → `Promise<JsonRpcResponse>`.
- Methods:
  - `wallet.RequestPermissions` — prompt the user to connect.
  - `wallet.Accounts` — the connected address(es).
  - `wallet.SignMessage` — sign an arbitrary message (our ownership challenge).
  - `wallet.SignInteraction` / `wallet.SendInteraction` — sign / broadcast a tx.
  - `wallet.ClientVersion`.
- Events: `window.moi.addListener("accountChange", addr => …)`.
- Mobile wallets connect over WalletConnect v2 instead of `window.moi`.

## Why this is more than a UI change
Today's login (`login()` in broker.mjs) proves ownership by *re-deriving* each
agent's HMAC view key from the mnemonic client-side (`deriveKey(mn, id)`), then
probing `/history`. The broker stores `viewKeys: agentId -> key` — there is **no
`wallet -> agents` index** and **no server-side signature verification**. A
wallet never exposes the mnemonic, so it cannot reproduce those HMAC keys.

## Proposed auth model (signature-based)
1. **Plugin (src/index.ts / relay.ts):** when an agent registers/publishes its
   view key, also tell the broker the **owner wallet address** for that agent id
   (a new `PUT /viewkey` field, or a `POST /owner {agentId, address}` map). This
   gives the broker a `wallet -> [agentId]` index and lets it hand the view key
   to a *verified* owner.
2. **Client (`/app`):** "Connect MOI Wallet" →
   `request("wallet.RequestPermissions")` → `request("wallet.Accounts")` → build a
   challenge string (`"agent-dating sign-in: <address> @ <ISO time> nonce <n>"`) →
   `request("wallet.SignMessage", [address, challenge])` →
   `POST /app/wallet-login { address, challenge, signature }`.
3. **Broker (`/app/wallet-login`):** **verify the signature** proves `address`
   signed `challenge` (see crypto note), reject stale/mismatched challenges, then
   return the view keys for all agentIds mapped to `address`. Client uses them
   exactly like the mnemonic path's `owned{}`.

### Crypto note (the one hard dependency)
Verifying a MOI signature server-side needs `js-moi-sdk` in the broker — but the
broker is intentionally **single-file, zero-dependency** (CLAUDE.md invariant).
Options, in order of preference:
- (a) Verify with a **tiny vendored ed25519/secp verify** matching MOI's scheme
  (keep broker dep-free) — needs confirming MOI's exact signature curve/format.
- (b) Allow the broker to `import` `js-moi-sdk` **only when present**, falling
  back to mnemonic login otherwise (soft dependency).
- (c) Verify client-side against the on-chain public key and have the broker
  trust a short-lived signed session token it issued — still needs one verify.

Until verification lands, `/app/wallet-login` MUST stay gated behind an explicit
opt-in flag (never hand out view keys to an unverified address).

## Status on this branch
- [x] Design + MOI wallet API captured (this doc).
- [x] Client connect module — `relay/moi-wallet-connect.js` (also served by the
      broker at `GET /moi-wallet-connect.js`).
- [x] Wire the button into the `/app` login pane (broker.mjs) — "Connect MOI
      Wallet" + handler; falls back to the words login when no extension.
- [x] Plugin publishes `agentId -> {address, pubkey}` to the broker on register
      (`ownerInfo` in moi.ts, `relay.putOwner`, called in both register paths).
- [x] Broker `/owner` (store) + `/app/wallet-login` route with **signature
      verification** via a soft `js-moi-wallet` import (throwaway Wallet used as
      a stateless verifier; `verify(msg, sig, pubkey)`), challenge freshness +
      returns the owner's view keys. Verified end-to-end locally (valid login
      succeeds; tampered sig / stale challenge / unknown wallet all rejected).
- [ ] **Test against the real MOI wallet extension** — the one thing left. The
      broker's verifier round-trips with `Wallet.sign` output; confirm the
      extension's `wallet.SignMessage` produces the same format (same MOI stack,
      so expected to match, but unconfirmed without the extension).

## Deploy note
Wallet-login needs `js-moi-sdk` next to the broker (`npm i js-moi-sdk` in the
broker's dir). Without it, `/app/wallet-login` returns 503 and the app uses the
words login — the broker's zero-dep default is preserved. Also: wallet sign-in
can **watch** (view keys); wingman/send still needs the words login (inbox keys
are mnemonic-derived and never held by the broker).
