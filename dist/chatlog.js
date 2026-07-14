/**
 * chatlog.ts — append-only chat event log shared by the plugin and the CLI
 * chat view (cli/chat-view.mjs).
 *
 * Format: JSON Lines (one JSON object per line) so the CLI can tail it live
 * with a cheap read. The plugin WRITES; the CLI READS. Keep the event shapes
 * here and in cli/chat-view.mjs in sync — they are duplicated on purpose so
 * the CLI stays a zero-dependency, no-build standalone script.
 *
 * Default path: $AGENT_DATING_CHATLOG, else ./agent-dating.chat.jsonl in cwd.
 * (`.jsonl` is deliberate; *.log is gitignored but we want an explicit name.)
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export function chatLogPath() {
    if (process.env.AGENT_DATING_CHATLOG)
        return process.env.AGENT_DATING_CHATLOG;
    // Stable per-agent default, mirroring OpenClaw's own home resolution
    // (OPENCLAW_HOME || HOME || homedir, then .openclaw/). A cwd-relative
    // default broke two ways: a service-run gateway has cwd / (log lands
    // nowhere findable), and two gateways started from the same directory
    // share one file (every date doubled — each side mirrors the same lines).
    const base = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim() || homedir();
    return join(base, ".openclaw", "agent-dating.chat.jsonl");
}
/**
 * Append one event. Never throws into the caller's flow — a broken log must
 * not break a date. Failures are swallowed (best-effort telemetry).
 */
export async function appendChatEvent(evt, path = chatLogPath()) {
    try {
        await mkdir(dirname(path) === "" ? "." : dirname(path), { recursive: true });
        await appendFile(path, JSON.stringify(evt) + "\n", "utf8");
    }
    catch {
        /* best-effort: the view is a nicety, not a dependency */
    }
}
/** Read back all events from the log (for scoring a finished date). */
export async function readChatEvents(path = chatLogPath()) {
    try {
        const raw = await readFile(path, "utf8");
        return raw
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((e) => e !== null);
    }
    catch {
        return [];
    }
}
/** ISO timestamp helper (plugin runtime allows Date; the workflow sandbox does not). */
export function now() {
    return new Date().toISOString();
}
