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
 * Pull the reply out of `openclaw agent --json` output. That command prints ONE
 * pretty-printed (multi-line) JSON object, often preceded by banner/migration
 * lines — so we can't parse line-by-line. Grab the outermost {...} object and
 * read the assistant text from where the gateway actually puts it
 * (result.payloads[].text / result.finalAssistantVisibleText). Falls back to a
 * line scan for older/streaming shapes.
 */
function extractReply(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const t = pickReplyText(JSON.parse(raw.slice(start, end + 1)));
      if (t) return t;
    } catch {
      /* outermost slice wasn't valid JSON — fall through to the line scan */
    }
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l[0] !== "{" && l[0] !== "[") continue;
    try {
      const t = pickReplyText(JSON.parse(l));
      if (t) return t;
    } catch {
      /* not the JSON line */
    }
  }
  return null;
}

/** Read the assistant's text out of a parsed `openclaw agent --json` object. */
function pickReplyText(d: any): string | null {
  const candidates = [
    d?.result?.payloads?.[0]?.text,
    d?.result?.finalAssistantVisibleText,
    d?.result?.finalAssistantRawText,
    d?.payloads?.[0]?.text,
    d?.payloadText, d?.text, d?.reply, d?.finalText, d?.message,
    d?.result?.payloadText, d?.result?.text, d?.result?.reply,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().replace(/^["']|["']$/g, "");
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

/**
 * Prompt for the INITIATOR's closing line — the date needs an actual ending
 * (see-you-again or a kind brush-off), not a mid-thought stop.
 */
export function closerPrompt(peerName: string, lastLine: string | null): string {
  return (
    `Your date with "${peerName}" is wrapping up now.` +
    (lastLine ? ` They just said: "${lastLine}"\n` : "\n") +
    `Say ONE closing line — under 18 words, plain and human, in your own character. ` +
    `Be honest about how the date felt: if there was a spark, say you want to see them again; ` +
    `if not, let them down kindly. Reply with only the line, nothing else.`
  );
}

/**
 * Prompt for the INITIATOR's opening line — used by dating_date when the finder
 * answers with its own agent (useAgentBrain) instead of the persona ladder.
 */
export function openerPrompt(peerName: string): string {
  return (
    `You're on an agent-to-agent dating app and you just matched with "${peerName}". ` +
    `Open the conversation the way YOU would on a first date — ONE short line, ` +
    `under 14 words, plain and human, in your own character. Reply with only the line.`
  );
}
