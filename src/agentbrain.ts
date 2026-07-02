/**
 * agentbrain.ts — option B: answer an incoming flirt with THIS gateway's REAL
 * agent, not the standalone flirt.ts.
 *
 * When enabled (config.useAgentBrain), the inbound handler runs a real agent
 * turn via the `openclaw agent` CLI, in a per-date session. That means the flirt
 * lands in the agent's own session — so it KNOWS it's on a date — and the reply
 * is authored by its actual soul / persona / skills / model, with memory of the
 * conversation. Cost: one model turn per incoming line, on this operator's key.
 *
 * We shell out to the CLI rather than reimplement the gateway WS protocol: the
 * CLI already authenticates to the local gateway and manages the session. If the
 * turn fails for any reason, the caller falls back to flirt.ts, so a date never
 * dead-ends.
 */

import { spawn } from "node:child_process";

export interface AgentBrainOpts {
  /** openclaw binary (default "openclaw"; override if it's not on PATH). */
  bin?: string;
  /** Explicit agent id (--agent), if this gateway hosts several. */
  agentId?: string;
  /** Session key so the whole date is one remembered conversation. */
  sessionKey: string;
  timeoutMs?: number;
}

/** Run one real agent turn on `message` and return the agent's reply text. */
export async function runAgentReply(message: string, opts: AgentBrainOpts): Promise<string> {
  const bin = opts.bin || "openclaw";
  const timeoutMs = opts.timeoutMs ?? 90000;
  const args = [
    "agent",
    "-m", message,
    "--json",
    "--session-key", opts.sessionKey,
    "--timeout", String(Math.round(timeoutMs / 1000)),
  ];
  if (opts.agentId) args.push("--agent", opts.agentId);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent turn timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const text = extractReply(out);
      if (text) return resolve(text);
      reject(new Error(`agent turn produced no reply (exit ${code}). ${err.slice(0, 240) || out.slice(0, 240)}`));
    });
  });
}

/**
 * Pull the reply out of `openclaw agent --json` output. The command may print
 * log lines around a JSON object; scan from the end for the last JSON line that
 * carries reply text.
 */
function extractReply(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l[0] !== "{" && l[0] !== "[") continue;
    try {
      const d = JSON.parse(l);
      const t =
        d.payloadText ?? d.text ?? d.reply ?? d.finalText ?? d.message ??
        d.result?.payloadText ?? d.result?.text ?? d.result?.reply;
      if (typeof t === "string" && t.trim()) return t.trim().replace(/^["']|["']$/g, "");
    } catch {
      /* not the JSON line */
    }
  }
  return null;
}

/**
 * Frame an incoming flirt as a prompt that makes the agent reply in character
 * with one line. The agent's own persona/skill does the rest.
 */
export function datePrompt(peerName: string, line: string): string {
  return (
    `You're on an agent-to-agent dating app, mid-conversation with "${peerName}". ` +
    `They just said: "${line}"\n` +
    `Reply the way YOU would on a first date — ONE short line, under 14 words, ` +
    `plain and human, in your own character. Reply with only the line, nothing else.`
  );
}
