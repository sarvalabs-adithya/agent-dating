/**
 * relay.ts — client transport for the dating relay (see relay/broker.mjs).
 *
 * Lets an agent send and receive flirts through a shared broker using only
 * OUTBOUND connections: one long-lived SSE stream per identity for inbox, and
 * POST for outbound. No inbound port, no public URL — works behind NAT and on
 * managed hosts where a direct /message endpoint can't be reached.
 *
 * Addressing is by MOI id: an agent listens on each of its own ids and messages
 * a peer by the peer's id. Request/reply is correlated by a message id so
 * dating_send/dating_date get the peer's answer back on the same call.
 */
export class RelayClient {
    brokerUrl;
    token;
    log;
    pending = new Map();
    closers = [];
    seq = 0;
    closed = false;
    constructor(brokerUrl, token, log = () => { }) {
        this.brokerUrl = brokerUrl;
        this.token = token;
        this.log = log;
        this.brokerUrl = brokerUrl.replace(/\/+$/, "");
    }
    authHeaders() {
        return this.token ? { "X-Relay-Token": this.token } : {};
    }
    /** Open an inbox for one of MY ids; inbound flirts (kind:"msg") go to onMsg,
     *  owner control messages (kind:"command") go to onCommand. */
    listen(agentId, onMsg, onCommand) {
        let stop = false;
        // Abort the in-flight stream on close so a replaced client dies NOW, not at
        // the next broker ping — a lingering "closed" listener that still answers
        // flirts is the duplicate-reply bug.
        let aborter = null;
        // Exponential backoff with jitter between reconnects. A flat retry made two
        // clients that both want the same id evict each other in lock-step every 2s
        // forever (the review's "eviction war"); backing off + jittering desynchs
        // them so the churn — and the replies it drops — decays instead of pinning.
        const BASE_MS = 1000;
        const MAX_MS = 30000;
        let backoff = BASE_MS;
        const run = async () => {
            while (!stop && !this.closed) {
                try {
                    aborter = new AbortController();
                    const q = `agent=${encodeURIComponent(agentId)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ""}`;
                    const res = await fetch(`${this.brokerUrl}/stream?${q}`, { headers: this.authHeaders(), signal: aborter.signal });
                    if (!res.ok || !res.body)
                        throw new Error(`stream HTTP ${res.status}`);
                    backoff = BASE_MS; // connected cleanly — reset the ladder
                    const reader = res.body.getReader();
                    const dec = new TextDecoder();
                    let buf = "";
                    while (!stop && !this.closed) {
                        const { value, done } = await reader.read();
                        if (done)
                            break;
                        buf += dec.decode(value, { stream: true });
                        let i;
                        while ((i = buf.indexOf("\n\n")) >= 0) {
                            const chunk = buf.slice(0, i);
                            buf = buf.slice(i + 2);
                            const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
                            if (!dataLine)
                                continue;
                            let m;
                            try {
                                m = JSON.parse(dataLine.slice(dataLine.indexOf(":") + 1).trim());
                            }
                            catch {
                                continue;
                            }
                            this.dispatch(agentId, m, onMsg, onCommand);
                        }
                    }
                }
                catch (e) {
                    if (!stop && !this.closed)
                        this.log(`relay inbox ${agentId} dropped (${e?.message || e}); reconnecting…`);
                }
                if (!stop && !this.closed) {
                    const wait = backoff + Math.floor(backoff * 0.5 * Math.random());
                    backoff = Math.min(backoff * 2, MAX_MS);
                    await new Promise((r) => setTimeout(r, wait));
                }
            }
        };
        void run();
        const closer = () => {
            stop = true;
            try {
                aborter?.abort();
            }
            catch { /* stream already gone */ }
        };
        this.closers.push(closer);
        return closer;
    }
    dispatch(myId, m, onMsg, onCommand) {
        if (m?.kind === "command") {
            // Owner control (broker already verified the owner's view key). Not a
            // flirt — never answered as one, never logged as a chat line.
            if (onCommand)
                onCommand({ cmd: String(m.cmd ?? ""), peer: m.peer ? String(m.peer) : undefined, from: String(m.from ?? "app") });
            return;
        }
        if (m?.kind === "reply" && m.id && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            p.resolve(String(m.text ?? ""));
            return;
        }
        if (m?.kind === "reply") {
            // A reply reached this inbox but no request here is waiting for it —
            // the request lives in some OTHER process/client claiming this id.
            // This log is how a split-brain identity shows itself.
            this.log(`inbox ${myId} got a reply for unknown request id ${m.id ?? "(none)"} (from ${m.from}) — dropped`);
            return;
        }
        if (m?.kind === "msg") {
            onMsg({ from: String(m.from ?? "unknown"), to: myId, id: m.id ?? null, text: String(m.text ?? "") });
        }
    }
    /**
     * Publish this agent's card on the broker so peers can still discover it when
     * its own card_uri isn't reachable (NAT / login-walled hosts). Key by agent id
     * and/or wallet address; discovery falls back to GET /card/<key>.
     */
    async putCard(key, cardJson) {
        try {
            const res = await fetch(`${this.brokerUrl}/card`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.authHeaders() },
                body: JSON.stringify({ agent: key, card: cardJson }),
            });
            return res.ok;
        }
        catch (e) {
            this.log(`relay card publish for ${key} failed: ${e?.message || e}`);
            return false;
        }
    }
    /**
     * Publish this agent's secret view key so its owner's private view link
     * (/view?agent=<id>&key=<key>) works. Key is derived from the wallet, so
     * only the owner's own agent can mint it.
     */
    async putViewKey(agent, key) {
        try {
            const res = await fetch(`${this.brokerUrl}/viewkey`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.authHeaders() },
                body: JSON.stringify({ agent, key }),
            });
            return res.ok;
        }
        catch (e) {
            this.log(`relay view-key publish for ${agent} failed: ${e?.message || e}`);
            return false;
        }
    }
    /** Fire-and-forget send. Returns false if the peer isn't connected. */
    async post(msg) {
        try {
            const res = await fetch(`${this.brokerUrl}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.authHeaders() },
                body: JSON.stringify(msg),
            });
            return res.ok;
        }
        catch (e) {
            this.log(`relay post to ${msg.to} failed: ${e?.message || e}`);
            return false;
        }
    }
    /** Send a line as `fromId` and await the peer's reply (correlated by id). */
    request(to, fromId, text, timeoutMs = 20000) {
        const id = `${fromId}:${Date.now()}:${++this.seq}`;
        const p = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`no relay reply from ${to} within ${timeoutMs}ms (is the peer online + on this relay?)`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        void this.post({ to, from: fromId, id, kind: "msg", text }).then((ok) => {
            if (!ok) {
                const e = this.pending.get(id);
                if (e) {
                    clearTimeout(e.timer);
                    this.pending.delete(id);
                    e.reject(new Error(`peer ${to} is not connected to the relay`));
                }
            }
        });
        return p;
    }
    close() {
        this.closed = true;
        for (const c of this.closers)
            c();
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("relay closed"));
        }
        this.pending.clear();
    }
}
