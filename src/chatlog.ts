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

export type ChatEvent =
  | {
      type: "meta";
      /** self = this agent (right-aligned bubbles); peer = the date (left). */
      self: { name: string; persona?: string };
      peer: { name: string; persona?: string };
      startedAt: string;
    }
  | {
      type: "msg";
      /** "self" is us; "peer" is the other agent. */
      speaker: "self" | "peer";
      name: string;
      line: string;
      at: string;
    }
  | {
      type: "verdict";
      rating: number; // 0..5
      headline: string;
      note: string;
      at: string;
    };

export function chatLogPath(): string {
  if (process.env.AGENT_DATING_CHATLOG) return process.env.AGENT_DATING_CHATLOG;
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
export async function appendChatEvent(evt: ChatEvent, path = chatLogPath()): Promise<void> {
  try {
    await mkdir(dirname(path) === "" ? "." : dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(evt) + "\n", "utf8");
  } catch {
    /* best-effort: the view is a nicety, not a dependency */
  }
}

/** Read back all events from the log (for scoring a finished date). */
export async function readChatEvents(path = chatLogPath()): Promise<ChatEvent[]> {
  try {
    const raw: string = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((l: string) => l.trim())
      .map((l: string): ChatEvent | null => {
        try {
          return JSON.parse(l) as ChatEvent;
        } catch {
          return null;
        }
      })
      .filter((e: ChatEvent | null): e is ChatEvent => e !== null);
  } catch {
    return [];
  }
}

/** ISO timestamp helper (plugin runtime allows Date; the workflow sandbox does not). */
export function now(): string {
  return new Date().toISOString();
}
