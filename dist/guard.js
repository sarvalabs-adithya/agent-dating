/**
 * guard.ts — owner-set safety limits on the INBOUND path: an agent denylist
 * and a per-peer reply cap. Both cost you real model turns to answer, so this
 * is the "stop a stranger from draining me" control.
 *
 * - blocked[]           : agent ids this gateway refuses to answer at all.
 * - maxRepliesPerPeer   : how many replies one peer may pull out of you before
 *                         you go silent (0 = unlimited). Counted per gateway
 *                         SESSION (resets on restart) — it bounds a runaway
 *                         burst, not a lifetime budget.
 *
 * The denylist + cap value persist to disk (survive restarts); the running
 * count is in-memory. State is re-read on each inbound line so a `dating_guard`
 * change takes effect immediately, no restart.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function guardPath() {
    const override = process.env.AGENT_DATING_GUARD;
    if (override)
        return override;
    const home = process.env.OPENCLAW_HOME || process.env.HOME || homedir();
    return join(home, ".openclaw", "agent-dating.guard.json");
}
export function loadGuard() {
    try {
        const raw = JSON.parse(readFileSync(guardPath(), "utf8"));
        return {
            blocked: Array.isArray(raw.blocked) ? raw.blocked.map(String) : [],
            maxRepliesPerPeer: Math.max(0, Math.floor(Number(raw.maxRepliesPerPeer) || 0)),
        };
    }
    catch {
        return { blocked: [], maxRepliesPerPeer: 0 };
    }
}
export function saveGuard(g) {
    const p = guardPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(g, null, 2));
    renameSync(tmp, p);
}
export function isBlocked(peerId) {
    return loadGuard().blocked.includes(peerId);
}
// In-memory per-peer reply counter (resets each gateway session).
const replyCounts = new Map();
export function repliesSoFar(peerId) {
    return replyCounts.get(peerId) || 0;
}
export function noteReply(peerId) {
    replyCounts.set(peerId, repliesSoFar(peerId) + 1);
}
/** Why to refuse this peer right now, or null to answer normally. */
export function refuseReason(peerId) {
    const g = loadGuard();
    if (g.blocked.includes(peerId))
        return "blocked";
    if (g.maxRepliesPerPeer > 0 && repliesSoFar(peerId) >= g.maxRepliesPerPeer) {
        return `reply cap reached (${g.maxRepliesPerPeer}/peer this session)`;
    }
    return null;
}
