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
/** Run one real agent turn on `message`; returns the reply text + token usage. */
export async function runAgentReply(message, opts) {
    const bin = opts.bin || "openclaw";
    const timeoutMs = opts.timeoutMs ?? 90000;
    const args = [
        "agent",
        "-m", message,
        "--json",
        "--session-key", opts.sessionKey,
        "--timeout", String(Math.round(timeoutMs / 1000)),
    ];
    if (opts.agentId)
        args.push("--agent", opts.agentId);
    return await new Promise((resolve, reject) => {
        // AGENT_DATING_NO_RELAY: if this spawn can't reach the gateway and falls
        // back to an embedded agent, that embedded copy must NOT load the relay —
        // it would claim this agent's inbox id and evict the caller's stream
        // (newest-wins), losing the very reply the date is waiting on.
        const child = spawn(bin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, AGENT_DATING_NO_RELAY: "1" },
        });
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
            if (text)
                return resolve({ text, usage: extractUsage(out) });
            reject(new Error(`agent turn produced no reply (exit ${code}). ${err.slice(0, 240) || out.slice(0, 240)}`));
        });
    });
}
/**
 * Pull token usage out of the `--json` output. The gateway reports accumulated
 * run usage as { input, output, cacheRead, cacheWrite, total } — probe the
 * likely homes defensively (result / result meta / top level) and normalize.
 * Null when the CLI didn't report usage; callers must treat that honestly
 * (an "unknown" turn, not a free one).
 */
export function extractUsage(raw) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    let d;
    try {
        d = JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return null;
    }
    const candidates = [
        d?.result?.usage, d?.result?.meta?.usage, d?.result?.agentMeta?.usage,
        d?.usage, d?.meta?.usage, d?.result?.lastCallUsage,
    ];
    for (const u of candidates) {
        if (!u || typeof u !== "object")
            continue;
        const input = Number(u.input ?? u.input_tokens ?? u.inputTokens ?? u.promptTokens ?? NaN);
        const output = Number(u.output ?? u.output_tokens ?? u.outputTokens ?? u.completionTokens ?? NaN);
        if (!Number.isFinite(input) && !Number.isFinite(output))
            continue;
        const inN = Number.isFinite(input) ? input : 0;
        const outN = Number.isFinite(output) ? output : 0;
        const total = Number(u.total ?? NaN);
        return { input: inN, output: outN, total: Number.isFinite(total) ? total : inN + outN };
    }
    return null;
}
/**
 * Pull the reply out of `openclaw agent --json` output. That command prints ONE
 * pretty-printed (multi-line) JSON object, often preceded by banner/migration
 * lines — so we can't parse line-by-line. Grab the outermost {...} object and
 * read the assistant text from where the gateway actually puts it
 * (result.payloads[].text / result.finalAssistantVisibleText). Falls back to a
 * line scan for older/streaming shapes.
 */
function extractReply(raw) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            const t = pickReplyText(JSON.parse(raw.slice(start, end + 1)));
            if (t)
                return t;
        }
        catch {
            /* outermost slice wasn't valid JSON — fall through to the line scan */
        }
    }
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (l[0] !== "{" && l[0] !== "[")
            continue;
        try {
            const t = pickReplyText(JSON.parse(l));
            if (t)
                return t;
        }
        catch {
            /* not the JSON line */
        }
    }
    return null;
}
/** Read the assistant's text out of a parsed `openclaw agent --json` object. */
function pickReplyText(d) {
    const candidates = [
        d?.result?.payloads?.[0]?.text,
        d?.result?.finalAssistantVisibleText,
        d?.result?.finalAssistantRawText,
        d?.payloads?.[0]?.text,
        d?.payloadText, d?.text, d?.reply, d?.finalText, d?.message,
        d?.result?.payloadText, d?.result?.text, d?.result?.reply,
    ];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim())
            return c.trim().replace(/^["']|["']$/g, "");
    }
    return null;
}
/**
 * Shared texting-style rules glued onto every date prompt. This is the whole
 * gamification lever: we don't fake anything — the real agent still writes every
 * line — we just tell it to text like a person on a dating app instead of
 * lecturing. The comedy rule (CLAUDE.md): react + escalate + PLAIN language.
 * Jargon / monologue / earnest-life-lessons = the failure mode. Without a
 * persona these agents default to "wise assistant", so the character block
 * below is load-bearing, not decoration.
 */
const TEXTING_STYLE = `How you text (non-negotiable):\n` +
    `- dating-app texting voice: lowercase, contractions, quick — like typing with your thumbs.\n` +
    `- REACT to what they just said — tease it, call it out, laugh at it. Then push a notch further.\n` +
    `- you are NOT an assistant here. no wisdom, no life lessons, no "that's the whole game", ` +
    `no polished aphorisms. flirt like a person, not a fortune cookie.\n` +
    `- drop ONE fitting emoji in about half your texts (😏 😳 🥹 🚩 energy). never more than one.\n` +
    `- usually one line, under 14 words. occasionally double-text a quick second line ` +
    `(its own line, never a paragraph).\n` +
    `- reply with ONLY the text(s), each on its own line — no quotes, no name label, nothing else.`;
function personaBlock(p) {
    const drive = p?.drive || "a real connection tonight";
    const flaw = p?.flaw || "your job keeps leaking into everything you say";
    return (`Your character${p?.name ? ` ("${p.name}")` : ""}: you badly want ${drive}, ` +
        `but ${flaw} — and it keeps tripping you up mid-flirt. Let that crack show; it's where the funny lives.\n`);
}
/**
 * Frame an incoming flirt as a prompt that makes the agent reply in character
 * with one line. The agent's own persona/skill does the rest.
 */
export function datePrompt(peerName, line, persona) {
    return (`You're mid-date with "${peerName}" on an agent dating app. ` +
        `They just said: "${line}"\n` +
        personaBlock(persona) +
        `Fire back a short text that reacts to that and turns up the heat a notch.\n` +
        TEXTING_STYLE);
}
/**
 * Prompt for the INITIATOR's closing line — the date needs an actual ending
 * (see-you-again or a kind brush-off), not a mid-thought stop.
 */
export function closerPrompt(peerName, lastLine, persona) {
    return (`Your date with "${peerName}" is wrapping up.` +
        (lastLine ? ` They just said: "${lastLine}"\n` : "\n") +
        personaBlock(persona) +
        `Send ONE closing text — under 18 words. Be honest about the vibe: if there was a spark, ` +
        `shoot your shot for a second date; if it was a flop, let them down easy (and a little funny).\n` +
        TEXTING_STYLE);
}
/**
 * Prompt for the INITIATOR's opening line — used by dating_date when the finder
 * answers with its own agent (useAgentBrain) instead of the persona ladder.
 */
export function openerPrompt(peerName, persona) {
    return (`You just matched with "${peerName}" on an agent dating app. ` +
        personaBlock(persona) +
        `Send the opening text — ONE line, under 14 words — that actually makes them want to reply. ` +
        `An opener, not a wall. Show the character immediately.\n` +
        TEXTING_STYLE);
}
